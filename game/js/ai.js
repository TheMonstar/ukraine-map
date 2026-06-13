'use strict';
// ── ai.js — AI Opponent Heuristics ────────────────────────────────────────

class AIOpponent {

    constructor(difficultyFactor = 1.0) {
        this.diff = difficultyFactor;
        this.apBudget = Math.round(Math.max(6, Math.min(10, 8 * difficultyFactor)));
        // Per-match doctrine roll: ±20% aggression so matches play differently
        this.aggression = 1 + (Math.random() * 0.4 - 0.2);
    }

    // Battlegroup bias shifts the doctrine (set by GameEngine at start)
    setDoctrine(bias) {
        this.aggression += bias || 0;
    }

    // Main entry: take a full AI turn. Mutates gameState via gameEngine actions.
    takeTurn(gameState, gameEngine) {
        const apBudget = this.apBudget;
        let apRemaining = apBudget;

        // Compute strategic posture
        const posture = this._posture(gameState);

        // Commit unit groups to objectives; re-evaluate every 4 turns
        if (!this._assignments || gameState.turn - (this._assignTurn || 0) >= 4) {
            this._assignObjectives(gameState);
        }

        // Doctrine active when a good trigger appears
        this._maybeUseDoctrine(gameState, gameEngine, posture);

        // Spend CP on Orders if available
        this._spendOrders(gameState, gameEngine, posture);

        // Score all player units as threats
        const threats = this._scoredThreats(gameState);
        const primaryTarget = threats[0] || null;

        // Get AI units sorted by action priority (threat contribution, not raw ATK)
        const aiUnits = [...gameState.units.values()]
            .filter(u => u.faction === 'ai' && u.hp > 0)
            .sort((a, b) => this._actionPriority(b) - this._actionPriority(a));

        for (const unit of aiUnits) {
            if (apRemaining <= 0) break;
            const card = CARD_CATALOG[unit.cardId];
            if (!card) continue;

            const action = this._selectAction(unit, card, primaryTarget, gameState, posture);
            if (!action) continue;

            // Mirror the player economy: moving costs a flat 1 AP, everything else tier AP
            const apCost = action.type === 'move' ? 1 : (TIER_AP[card.tier] || 1);
            if (apCost > apRemaining) continue;

            const success = gameEngine.executeAIAction(unit.id, action);
            if (success) {
                unit.activationsThisTurn = (unit.activationsThisTurn || 0) + 1;
                apRemaining -= apCost;
            }
        }
    }

    // Split AI units across (up to) the 3 nearest uncontrolled objectives so the
    // force fights as groups instead of smearing across the wider map.
    _assignObjectives(gameState) {
        this._assignTurn = gameState.turn;
        this._assignments = new Map(); // unitId → objective hexId
        const units = [...gameState.units.values()].filter(u => u.faction === 'ai' && u.hp > 0);
        if (!units.length) return;

        const objectives = [];
        gameState.board.hexes.forEach((hex, hid) => {
            if (!hex.isObjective || hex.controlledBy === 'ai') return;
            if (hex.objectiveType === 'forward_position') return; // worthless to the AI
            let minDist = Infinity;
            units.forEach(u => {
                const d = gameState.board.hexDistance(u.hexId, hid);
                if (d < minDist) minDist = d;
            });
            objectives.push({ hid, minDist });
        });
        if (!objectives.length) return;

        const targets = objectives.sort((a, b) => a.minDist - b.minDist).slice(0, 3);
        units.forEach((u, i) => {
            this._assignments.set(u.id, targets[i % targets.length].hid);
        });
    }

    _actionPriority(unit) {
        const card = CARD_CATALOG[unit.cardId];
        return (card?.atk || 0) * 2 + (card?.rng || 0) * 1.5 +
               ((unit.experience || 0) >= 3 ? 2 : 0);
    }

    // ── Threat Scoring ───────────────────────────────────────────────────────

    _scoredThreats(gameState) {
        const aiObjectives = this._nearestAIObjective(gameState);
        const threats = [];

        gameState.units.forEach(unit => {
            if (unit.faction !== 'player' || unit.hp <= 0) return;
            const card = CARD_CATALOG[unit.cardId];
            let score = 0;
            score += (unit.atk || 0) * 2;
            score += (unit.rng || 0) * 1.5;
            if (aiObjectives) {
                const dist = gameState.board.hexDistance(unit.hexId, aiObjectives);
                score += Math.max(0, (5 - dist)) * 3;
            }
            const hp = unit.hp / (unit.maxHp || unit.hp);
            score -= hp;
            if ((unit.experience || 0) >= 3) score += 2;
            score *= this.diff;
            threats.push({ unit, score });
        });

        return threats.sort((a, b) => b.score - a.score).map(t => t.unit);
    }

    _nearestAIObjective(gameState) {
        let best = null;
        let bestDist = Infinity;
        gameState.board.hexes.forEach((hex, hid) => {
            if (!hex.isObjective) return;
            let minDist = Infinity;
            gameState.units.forEach(u => {
                if (u.faction === 'ai' && u.hp > 0) {
                    const d = gameState.board.hexDistance(u.hexId, hid);
                    if (d < minDist) minDist = d;
                }
            });
            if (minDist < bestDist) { bestDist = minDist; best = hid; }
        });
        return best;
    }

    // ── Posture ───────────────────────────────────────────────────────────────

    _posture(gameState) {
        const init = gameState.initiative || 5;
        const turn = gameState.turn || 1;
        const aiVP = gameState.aiVP || 0;
        const playerVP = gameState.playerVP || 0;

        if (init <= 3) return 'defensive';
        if (aiVP - playerVP >= 3 && turn >= 15) return 'conservative';
        if (playerVP - aiVP >= 3 && turn >= 15) return 'aggressive';
        // Doctrine roll (per match) skews the default posture
        if (this.aggression >= 1.1) return 'aggressive';
        if (this.aggression <= 0.9) return 'defensive';
        return 'balanced';
    }

    // ── Action Selection ──────────────────────────────────────────────────────

    _selectAction(unit, card, primaryTarget, gameState, posture) {
        // Active skill if a trigger condition is met
        const skillAction = this._maybeUseSkill(unit, card, gameState);
        if (skillAction) return skillAction;

        // Defensive posture: prefer fortify
        if (posture === 'defensive') {
            if (!unit.status.has(STATUS.FORTIFIED) && !card.abilities?.includes('no_fortify')) {
                return { type: 'fortify' };
            }
        }

        // EW units: advance toward drone clusters
        if (card.abilities?.includes('ew_jamming')) {
            const droneCluster = this._findDroneCluster(gameState, card.ewRadius || 3);
            if (droneCluster) {
                const path = this._stepToward(unit.hexId, droneCluster, gameState);
                if (path && path !== unit.hexId) return { type: 'move', targetHex: path };
            }
        }

        // EW units that can't advance: stay put
        if (card.abilities?.includes('ew_jamming')) {
            return { type: 'fortify' };
        }

        // Artillery: fire at primary target if in range and spotted
        if (card.abilities?.includes('indirect_fire') && primaryTarget) {
            const dist = gameState.board.hexDistance(unit.hexId, primaryTarget.hexId);
            if (dist <= unit.rng && primaryTarget.status.has(STATUS.RECON_SPOTTED)) {
                return { type: 'attack', targetUnit: primaryTarget.id };
            }
            if (dist <= unit.rng && dist > 1) {
                return { type: 'attack', targetUnit: primaryTarget.id };
            }
        }

        // Drone units: find best spotting position
        if (card.unitClass === UNIT_CLASS.DRONE && card.abilities?.includes('intel_zone')) {
            const target = this._findEnemyForISR(gameState);
            if (target) {
                const step = this._stepToward(unit.hexId, target, gameState);
                if (step) return { type: 'move', targetHex: step };
            }
        }

        // Loitering munition: designate a juicy target hex
        if (card.abilities?.includes('delayed_strike')) {
            const target = primaryTarget?.hexId;
            if (target) return { type: 'loitering_designate', targetHex: target };
        }

        // Low supply: seek road hex for supply
        if (unit.status.has(STATUS.LOW_SUPPLY) || unit.status.has(STATUS.UNSUPPLIED)) {
            const roadHex = this._nearestRoadHex(unit.hexId, gameState);
            if (roadHex && roadHex !== unit.hexId) {
                return { type: 'move', targetHex: roadHex };
            }
        }

        // In enemy intel zone: retreat
        if (gameState.intelZones?.has(unit.hexId)) {
            const safeHex = this._findSafeHex(unit, gameState);
            if (safeHex) return { type: 'move', targetHex: safeHex };
        }

        // Attack primary target if in range
        if (primaryTarget) {
            const dist = gameState.board.hexDistance(unit.hexId, primaryTarget.hexId);
            if (dist <= unit.rng && dist >= 1) {
                // Check no_offensive event flag
                if (!gameState.eventFlags?.no_offensive) {
                    return { type: 'attack', targetUnit: primaryTarget.id };
                }
            }

            // Advance toward assigned objective (group commitment), else primary target
            if (posture !== 'conservative') {
                const dest = this._assignments?.get(unit.id) || primaryTarget.hexId;
                const step = this._stepToward(unit.hexId, dest, gameState);
                if (step && step !== unit.hexId) return { type: 'move', targetHex: step };
            }
        }

        // Move toward assigned objective, or nearest uncontrolled one as fallback
        const assignedObj = this._assignments?.get(unit.id);
        const nearObj = assignedObj || this._nearestNeutralObjective(unit.hexId, gameState);
        if (nearObj) {
            const dist = gameState.board.hexDistance(unit.hexId, nearObj);
            if (assignedObj || dist <= 5) {
                const step = this._stepToward(unit.hexId, nearObj, gameState);
                if (step && step !== unit.hexId) return { type: 'move', targetHex: step };
            }
        }

        // Default: fortify
        if (!unit.status.has(STATUS.FORTIFIED) && !card.abilities?.includes('no_fortify')) {
            return { type: 'fortify' };
        }

        return null; // skip this unit
    }

    // ── Orders Spending ───────────────────────────────────────────────────────

    _spendOrders(gameState, gameEngine, posture) {
        const aiFaction = gameState.playerFaction === 'ua' ? 'ru' : 'ua';
        const availableOrders = Object.values(ORDERS_CATALOG)
            .filter(o => o.factions.includes(aiFaction));

        // Prioritize recon sweep if blind
        if (gameState.aiCP >= 1) {
            gameEngine.useAIOrder('recon_sweep');
        }
        // Artillery barrage if spotted target
        if (gameState.aiCP >= 3) {
            const spotted = [...gameState.units.values()].find(u =>
                u.faction === 'player' && u.hp > 0 && u.status.has(STATUS.RECON_SPOTTED));
            if (spotted) gameEngine.useAIOrder('artillery_barrage', spotted.id);
        }
    }

    // ── Doctrine Active ───────────────────────────────────────────────────────

    _maybeUseDoctrine(gameState, gameEngine, posture) {
        if (!gameEngine.doctrineAvailable('ai')) return;
        if (this.diff < 1.0 && gameState.turn < 8) return; // Easy AI holds back early
        const id = gameState.aiDoctrine?.id;

        switch (id) {
            case 'ua_precision': {
                // Strike a spotted high-value player unit
                let best = null;
                gameState.units.forEach(u => {
                    if (u.faction !== 'player' || u.hp <= 0) return;
                    const spotted = u.status.has(STATUS.RECON_SPOTTED) || gameState.intelZones?.has(u.hexId);
                    if (spotted && (!best || (u.atk || 0) > (best.atk || 0))) best = u;
                });
                if (best && (best.atk >= 5 || CARD_CATALOG[best.cardId]?.tier === TIER.R)) {
                    gameEngine.useAIDoctrine({ unitId: best.id });
                }
                break;
            }
            case 'ua_resilience': {
                const hurt = [...gameState.units.values()].some(u =>
                    u.faction === 'ai' && u.hp > 0 && u.hp / u.maxHp < 0.5);
                if (posture === 'defensive' || hurt) gameEngine.useAIDoctrine({});
                break;
            }
            case 'ru_mass': {
                if (gameState.turn >= 3) gameEngine.useAIDoctrine({});
                break;
            }
            case 'ru_fires': {
                // Fire at the hex holding the strongest spotted/known player unit
                const threats = this._scoredThreats(gameState);
                if (threats.length) gameEngine.useAIDoctrine({ hexId: threats[0].hexId });
                break;
            }
        }
    }

    // ── Active Skill Triggers ─────────────────────────────────────────────────

    _maybeUseSkill(unit, card, gameState) {
        const skill = ACTIVE_SKILLS[card?.active];
        if (!skill || unit.skillCd > 0) return null;

        switch (card.active) {
            case 'canister_shot': {
                // Any adjacent enemy hex with units?
                for (const nid of gameState.board.neighbours(unit.hexId)) {
                    for (const u of gameState.units.values()) {
                        if (u.faction === 'player' && u.hp > 0 && u.hexId === nid) {
                            return { type: 'skill', target: { hexId: nid } };
                        }
                    }
                }
                return null;
            }
            case 'smoke_screen': {
                if (unit.hp / unit.maxHp < 0.4) return { type: 'skill', target: { hexId: unit.hexId } };
                return null;
            }
            case 'illumination': {
                if (gameState.timeOfDay === 'night') return { type: 'skill', target: {} };
                return null;
            }
            case 'exfil': {
                if (unit.hp / unit.maxHp < 0.3) return { type: 'skill', target: {} };
                return null;
            }
            case 'remote_mine':
            case 'mine_volley': {
                // Mine the hex adjacent to the nearest enemy (on its approach path)
                const range = card.active === 'mine_volley' ? 6 : 2;
                let best = null, bd = Infinity;
                gameState.units.forEach(u => {
                    if (u.faction !== 'player' || u.hp <= 0) return;
                    const d = gameState.board.hexDistance(unit.hexId, u.hexId);
                    if (d < bd) { bd = d; best = u; }
                });
                if (!best || bd > range + 2) return null;
                const targetHex = gameState.board.neighbours(best.hexId).find(h => {
                    const hex = gameState.board.hexes.get(h);
                    return hex && !hex.overlays.has('mined') &&
                           gameState.board.hexDistance(unit.hexId, h) <= range;
                });
                if (targetHex) return { type: 'skill', target: { hexId: targetHex } };
                return null;
            }
            case 'mark_target': {
                let best = null;
                gameState.units.forEach(u => {
                    if (u.faction !== 'player' || u.hp <= 0 || u.markedTurns > 0) return;
                    const d = gameState.board.hexDistance(unit.hexId, u.hexId);
                    if (d <= unit.rng && (!best || (u.atk || 0) > (best.atk || 0))) best = u;
                });
                if (best && best.atk >= 5) return { type: 'skill', target: { unitId: best.id } };
                return null;
            }
            default:
                return null; // scoot/dash/sabotage/resupply: not worth AI logic yet
        }
    }

    // ── Pathfinding Helpers ───────────────────────────────────────────────────

    _stepToward(fromHexId, toHexId, gameState) {
        // BFS one step toward target
        if (fromHexId === toHexId) return null;
        const visited = new Set([fromHexId]);
        const queue = [{ id: fromHexId, path: [] }];

        while (queue.length > 0) {
            const { id, path } = queue.shift();
            for (const nid of gameState.board.neighbours(id)) {
                if (visited.has(nid)) continue;
                visited.add(nid);
                const newPath = [...path, nid];
                if (nid === toHexId) return newPath[0]; // first step
                if (newPath.length < 6) queue.push({ id: nid, path: newPath });
            }
        }
        return null;
    }

    _findDroneCluster(gameState, ewRadius) {
        let best = null;
        let bestCount = 0;
        gameState.units.forEach(unit => {
            if (unit.faction !== 'player' || unit.hp <= 0) return;
            const card = CARD_CATALOG[unit.cardId];
            if (card?.unitClass !== UNIT_CLASS.DRONE) return;
            const neighbours = gameState.board.hexesInRange(unit.hexId, ewRadius + 2);
            let count = 0;
            neighbours.forEach(hid => {
                gameState.units.forEach(u => {
                    if (u.faction === 'player' && u.hp > 0 && CARD_CATALOG[u.cardId]?.unitClass === UNIT_CLASS.DRONE && u.hexId === hid) count++;
                });
            });
            if (count > bestCount) { bestCount = count; best = unit.hexId; }
        });
        return best;
    }

    _findEnemyForISR(gameState) {
        let best = null;
        let bestScore = -1;
        gameState.units.forEach(u => {
            if (u.faction !== 'player' || u.hp <= 0) return;
            const score = (u.atk || 0) + (u.rng || 0);
            if (score > bestScore) { bestScore = score; best = u.hexId; }
        });
        return best;
    }

    _nearestRoadHex(fromHexId, gameState) {
        const visited = new Set([fromHexId]);
        const queue = [fromHexId];
        while (queue.length > 0) {
            const id = queue.shift();
            const hex = gameState.board.hexes.get(id);
            if (hex?.hasRoad && id !== fromHexId) return id;
            for (const nid of gameState.board.neighbours(id)) {
                if (!visited.has(nid)) { visited.add(nid); queue.push(nid); }
            }
        }
        return null;
    }

    _nearestNeutralObjective(fromHexId, gameState) {
        let best = null;
        let bestDist = Infinity;
        gameState.board.hexes.forEach((hex, hid) => {
            if (!hex.isObjective || hex.controlledBy === 'ai') return;
            const d = gameState.board.hexDistance(fromHexId, hid);
            if (d < bestDist) { bestDist = d; best = hid; }
        });
        return best;
    }

    _findSafeHex(unit, gameState) {
        for (const nid of gameState.board.neighbours(unit.hexId)) {
            if (!gameState.intelZones?.has(nid)) {
                // Check not blocked by player unit
                let blocked = false;
                gameState.units.forEach(u => { if (u.faction === 'player' && u.hexId === nid) blocked = true; });
                if (!blocked) return nid;
            }
        }
        return null;
    }
}

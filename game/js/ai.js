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

    // Full AI turn in one shot (used by headless sims). The UI drives the same
    // logic one action at a time via beginTurn()/nextAction() so it's watchable.
    takeTurn(gameState, gameEngine) {
        this.beginTurn(gameState, gameEngine);
        while (this.nextAction(gameState, gameEngine)) { /* step until done */ }
    }

    // Strategic setup for the turn (posture, goal, doctrine, orders, objectives).
    beginTurn(gameState, gameEngine) {
        this._apRemaining = this.apBudget;
        this._turnIdx = 0;

        this._goal = this._strategicGoal(gameState, gameEngine);
        this._curPosture = this._posture(gameState);

        // Commit unit groups to objectives; re-evaluate every 4 turns or on a
        // goal change (a new goal wants different targets).
        if (!this._assignments || gameState.turn - (this._assignTurn || 0) >= 4 || this._goal !== this._assignGoal) {
            this._assignObjectives(gameState);
            this._assignGoal = this._goal;
        }

        this._maybeUseDoctrine(gameState, gameEngine, this._curPosture);
        this._spendOrders(gameState, gameEngine, this._curPosture);

        this._turnUnits = [...gameState.units.values()]
            .filter(u => u.faction === 'ai' && u.hp > 0)
            .sort((a, b) => this._actionPriority(b) - this._actionPriority(a));
    }

    // Execute ONE unit's action. Returns a descriptor, or null when the turn is
    // done. Recomputes the primary target each step (state changed last action).
    nextAction(gameState, gameEngine) {
        if (this._apRemaining <= 0) return null;
        const threats = this._scoredThreats(gameState);
        const primaryTarget = threats[0] || null;

        while (this._turnIdx < this._turnUnits.length) {
            const unit = this._turnUnits[this._turnIdx];
            this._turnIdx++;
            if (!unit || unit.hp <= 0) continue;
            const card = CARD_CATALOG[unit.cardId];
            if (!card) continue;

            const action = this._selectAction(unit, card, primaryTarget, gameState, this._curPosture);
            if (!action) continue;

            const apCost = action.type === 'move' ? 1 : (TIER_AP[card.tier] || 1);
            if (apCost > this._apRemaining) continue;

            if (gameEngine.executeAIAction(unit.id, action)) {
                unit.activationsThisTurn = (unit.activationsThisTurn || 0) + 1;
                this._apRemaining -= apCost;
                return { unitId: unit.id, action };
            }
        }
        return null;
    }

    // What is the AI racing toward this turn? Uses the engine's win-condition
    // progress so the AI actually plays the 4 victory paths.
    _strategicGoal(gameState, gameEngine) {
        const vp = gameEngine.victoryProgress?.();
        if (!vp) return 'balanced';
        const me = vp.ai, foe = vp.player;

        // The player is one step from a win → drop everything and disrupt.
        if (foe.holdStreak >= 2 || foe.breakthroughWin || foe.rimHeld >= 2 ||
            (foe.foeStartValue >= 16 && foe.foeValue <= Math.ceil(foe.foeStartValue * 0.4))) {
            return 'counter';
        }
        // Faction temperament: RU presses/breaks through (mass, tempo); UA holds
        // and fights from cover (precision, elastic defence). Playing to your
        // strength is smarter — and keeps the two sides balanced.
        const ru = gameState.aiFaction === 'ru';

        // Enemy nearly destroyed → finish them.
        if (me.foeStartValue >= 16 && me.foeValue <= Math.ceil(me.foeStartValue * 0.4)) return 'press';
        // Close to a Hold win → garrison what we have (UA leans into this earlier).
        if (me.objNeed > 0 && me.objHeld >= me.objNeed - (ru ? 1 : 0)) return 'hold';
        // Penetration lane → breakthrough is an RU specialty.
        if (ru && me.rimHeld >= 1) return 'breakthrough';
        return 'balanced';
    }

    // Split AI units across (up to) the 3 nearest uncontrolled objectives so the
    // force fights as groups instead of smearing across the wider map.
    _assignObjectives(gameState) {
        this._assignTurn = gameState.turn;
        this._assignments = new Map(); // unitId → objective hexId
        const units = [...gameState.units.values()].filter(u => u.faction === 'ai' && u.hp > 0);
        if (!units.length) return;
        const goal = this._goal || 'balanced';

        // Breakthrough: detach the two fastest units toward the player rear rim.
        let strikers = [];
        if (goal === 'breakthrough') {
            const rim = gameState.rearHexIds?.player || [];
            if (rim.length) {
                strikers = [...units].sort((a, b) =>
                    (CARD_CATALOG[b.cardId]?.mov || 0) - (CARD_CATALOG[a.cardId]?.mov || 0)).slice(0, 2);
                strikers.forEach(u => {
                    let best = rim[0], bd = Infinity;
                    rim.forEach(h => { const d = gameState.board.hexDistance(u.hexId, h); if (d < bd) { bd = d; best = h; } });
                    this._assignments.set(u.id, best);
                });
            }
        }

        // Candidate objectives. When holding/countering, also target objectives the
        // player controls (incl. their forward positions) so the AI contests them.
        const contesting = goal === 'hold' || goal === 'counter';
        const objectives = [];
        gameState.board.hexes.forEach((hex, hid) => {
            if (!hex.isObjective || hex.controlledBy === 'ai') return;
            if (hex.objectiveType === 'forward_position' && !contesting) return;
            let minDist = Infinity;
            units.forEach(u => {
                const d = gameState.board.hexDistance(u.hexId, hid);
                if (d < minDist) minDist = d;
            });
            objectives.push({ hid, minDist, enemyHeld: hex.controlledBy === 'player' });
        });
        if (!objectives.length) return;

        // Prefer enemy-held objectives when contesting, else nearest.
        objectives.sort((a, b) =>
            (contesting ? (b.enemyHeld - a.enemyHeld) : 0) || (a.minDist - b.minDist));
        const targets = objectives.slice(0, 3);
        units.forEach((u, i) => {
            if (this._assignments.has(u.id)) return; // already a striker
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
            // The AI can only target player units it can actually see — a hidden
            // sniper/DRG in a hide is invisible until it moves or opens fire.
            if (!gameState.board.isVisibleTo(unit, 'ai', gameState)) return;
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
        // Strategic goal biases the default posture
        if (this._goal === 'hold' || this._goal === 'counter') return 'defensive';
        if (this._goal === 'press' || this._goal === 'breakthrough') return 'aggressive';
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

        // Hold goal: a unit already sitting on one of our objectives garrisons it
        // (attack from cover if possible, else fortify) instead of wandering off.
        if (this._goal === 'hold') {
            const here = gameState.board.hexes.get(unit.hexId);
            if (here?.isObjective && here.controlledBy === 'ai' && here.objectiveType !== 'forward_position') {
                if (primaryTarget) {
                    const d = gameState.board.hexDistance(unit.hexId, primaryTarget.hexId);
                    if (d >= 1 && d <= unit.rng && !gameState.eventFlags?.no_offensive) {
                        return { type: 'attack', targetUnit: primaryTarget.id };
                    }
                }
                if (!unit.status.has(STATUS.FORTIFIED) && !card.abilities?.includes('no_fortify')) {
                    return { type: 'fortify' };
                }
            }
        }

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

        // Press/breakthrough: rather than fortify, keep advancing on the nearest
        // enemy so the AI actually closes for the kill / the rear.
        if ((this._goal === 'press' || this._goal === 'breakthrough') && primaryTarget) {
            const step = this._stepToward(unit.hexId, primaryTarget.hexId, gameState);
            if (step && step !== unit.hexId) return { type: 'move', targetHex: step };
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

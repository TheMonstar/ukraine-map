'use strict';
// ── game-engine.js — FRONTLINE Game State Machine ────────────────────────

const MAX_TURNS = 24;
const TURN_SECONDS = 30;
const TOTAL_RP = 36;
const MAX_CP = 10;
const AP_PER_TURN = 8;
const MOVE_AP_COST = 1; // moving costs a flat 1 AP regardless of unit tier
const AI_STEP_MS = 220; // pacing between AI actions (+ render ≈ 0.8s net) so the turn is watchable

class GameEngine {
    constructor() {
        this.board = new HexBoard();
        this.terrainLoader = new TerrainLoader();
        this.combat = new CombatResolver(this.board);
        this.eventDeck = new EventDeck();
        this.ai = null;

        this.state = null;
        this.onStateChange = null;  // callback → GameUI.render()
        this.onVeteranPromotion = null; // callback(unit, type)
        this.onEventFlip = null;    // callback(card)
        this.onLog = null;          // callback(msg)
        this.onVictory = null;      // callback(result)
        this.onPlayerTurnStart = null; // callback() — fires when a new player turn begins (turn 2+)
    }

    // ── Initialization ────────────────────────────────────────────────────────

    async startGame(options) {
        const { playerFaction, difficulty, centerLat, centerLng, battlegroup, doctrine, headless } = options;
        const aiFaction = playerFaction === 'ua' ? 'ru' : 'ua';

        this.headless = !!headless; // sim mode: no Leaflet, no async AI turn, procedural terrain
        this.ai = new AIOpponent(difficulty);

        // Generate board
        this.board.generate(centerLat, centerLng);
        await this.terrainLoader.classifyAll(this.board, { forceProcedural: this.headless });

        // Split the board along the real front (synthetic in headless sims),
        // then place spawn bands on each side of the line
        await this.terrainLoader.classifyFront(this.board, { forceProcedural: this.headless });
        const { playerHexes, aiHexes } = this.board.getSpawnHexIds(playerFaction);

        // Assign forward positions as objectives
        this._flagForwardPositions(playerFaction);

        // Weather & time roll
        const weather = this._rollWeather();
        const timeOfDay = this._rollTimeOfDay();

        // Event deck
        this.eventDeck.build();

        // Build decks from battlegroups (+2 random reserve cards each)
        const playerBuild = buildBattlegroupDeck(playerFaction, battlegroup);
        const playerDeck = playerBuild.cards;
        const aiBuild = buildBattlegroupDeck(aiFaction, null);
        const aiDeckIds = aiBuild.cards;
        this.ai.setDoctrine(aiBuild.battlegroup.aggressionBias || 0);

        // Commander doctrines: player picks at setup, AI follows its battlegroup
        const playerDoctrineDef = DOCTRINES[playerFaction].find(d => d.id === doctrine) || DOCTRINES[playerFaction][0];
        const aiDoctrineDef = this._aiDoctrineFor(aiFaction, aiBuild.battlegroup.id);
        const mkDoctrine = def => ({ id: def.id, charges: def.charges, cooldown: def.cooldown, lastUsedTurn: -99 });

        this.state = {
            turn: 1,
            phase: 'deploy',       // 'deploy' | 'player_action' | 'ai_action' | 'end'
            activePhase: 'player',
            playerFaction,
            aiFaction,
            playerDeck,            // card ids available to player
            aiDeckIds,
            units: new Map(),
            playerRP: TOTAL_RP,
            aiRP: TOTAL_RP,
            playerCP: 0,
            aiCP: 0,
            playerAP: AP_PER_TURN,
            playerVP: 0,
            aiVP: 0,
            initiative: 5,
            weather,
            timeOfDay,
            spawnHexIds: { playerHexes, aiHexes },
            rearHexIds: {
                player: this.board.getRearHexIds(playerFaction),
                ai: this.board.getRearHexIds(aiFaction)
            },
            selectedUnit: null,
            selectedHex: null,
            moveRange: null,
            grindRange: null,
            attackRange: null,
            ewZones: new Map(),
            intelZones: new Map(),
            mudTurns: 0,
            eventFlags: {},
            playerDoctrine: mkDoctrine(playerDoctrineDef),
            aiDoctrine: mkDoctrine(aiDoctrineDef),
            playerBattlegroup: playerBuild.battlegroup.name,
            aiBattlegroup: aiBuild.battlegroup.name,
            breakthroughAwarded: { player: false, ai: false },
            startForce: { player: 0, ai: 0 },  // for the attrition win condition
            holdStreak: { player: 0, ai: 0 },  // consecutive turns holding the objectives
            fallenUnits: [],   // { hexId, name, faction, turn } — death markers on the map
            orderCooldowns: {},
            orderUsedOncePerMatch: new Set(),
            freeCommonDeploy: 0,
            freeOrderUse: 0,
            freeAirAssaultDeploy: false,
            board: this.board,
            log: []
        };

        // Deploy AI units automatically
        this._deployAIUnits();

        this._log(`Battlegroups: you — ${playerBuild.battlegroup.name}, enemy — ${aiBuild.battlegroup.name}`);
        if (this.board.frontNote) this._log(`⚠ ${this.board.frontNote}`);

        // Do NOT notify here — ui.js calls initLeafletMap() after startGame() returns,
        // then triggers _renderAll() manually. Notifying here would call render() before
        // the Leaflet map instance exists, causing addLayer errors.
        return this.state;
    }

    _aiDoctrineFor(aiFaction, battlegroupId) {
        const pool = DOCTRINES[aiFaction];
        if (aiFaction === 'ru') {
            return pool.find(d => d.id === (battlegroupId === 'ru_fires_group' ? 'ru_fires' : 'ru_mass'));
        }
        return pool.find(d => d.id === (battlegroupId === 'ua_drone_war' ? 'ua_precision' : 'ua_resilience'));
    }

    _rollWeather() {
        const r = Math.random();
        if (r < 0.40) return 'clear';
        if (r < 0.60) return 'overcast';
        if (r < 0.85) return 'rain';
        return 'storm';
    }

    _rollTimeOfDay() {
        const r = Math.random();
        if (r < 0.55) return 'day';
        if (r < 0.80) return 'dusk';
        return 'night';
    }

    // Forward positions: enemy-side hexes deep behind the front (≥ 4 hexes) —
    // the player's offensive objectives
    // A scarce set (≤3) of deep enemy-rear objectives — the player's offensive
    // targets. Spread by greedy farthest-point so they aren't clustered.
    _flagForwardPositions(playerFaction) {
        const enemySide = playerFaction === 'ua' ? 'ru' : 'ua';
        const dist = this.board.frontDistances();
        const deep = [...this.board.hexes.values()]
            .filter(h => h.side === enemySide && !h.isObjective && (dist.get(h.id) ?? 99) >= 4)
            .sort((a, b) => (dist.get(b.id) ?? 0) - (dist.get(a.id) ?? 0));
        if (!deep.length) return;

        const d2 = (a, b) => (a.centroid[0] - b.centroid[0]) ** 2 + (a.centroid[1] - b.centroid[1]) ** 2;
        const chosen = [deep[0]]; // deepest
        while (chosen.length < 3 && chosen.length < deep.length) {
            let best = null, bestSep = -1;
            for (const h of deep) {
                if (chosen.includes(h)) continue;
                const sep = Math.min(...chosen.map(s => d2(h, s)));
                if (sep > bestSep) { bestSep = sep; best = h; }
            }
            if (!best) break;
            chosen.push(best);
        }
        chosen.forEach(h => { h.isObjective = true; h.objectiveType = 'forward_position'; });
    }

    // ── Deployment Phase ──────────────────────────────────────────────────────

    deployPlayerUnit(cardId, hexId) {
        const s = this.state;
        if (s.phase !== 'deploy') return { ok: false, error: 'Not in deploy phase' };

        const card = CARD_CATALOG[cardId];
        if (!card) return { ok: false, error: 'Unknown card' };
        if (!s.playerDeck.includes(cardId)) return { ok: false, error: 'Card not in deck' };
        if (s.playerRP < card.rp) return { ok: false, error: 'Insufficient RP' };

        // Validate hex is in player spawn zone (or air assault anywhere)
        const hex = this.board.hexes.get(hexId);
        if (!hex) return { ok: false, error: 'Invalid hex' };

        const isAirAssault = card.abilities?.includes('air_insert');
        const inSpawn = s.spawnHexIds.playerHexes.includes(hexId);

        if (!isAirAssault && !inSpawn) {
            return { ok: false, error: 'Must deploy in spawn zone' };
        }

        // Stack limit
        if (this.combat.stackLimitReached(hexId, 'player', s)) {
            return { ok: false, error: 'Hex at stack limit' };
        }

        const unit = this._createUnit(cardId, 'player', hexId);
        s.units.set(unit.id, unit);

        // Remove from deck (one use per card instance)
        const idx = s.playerDeck.indexOf(cardId);
        if (idx !== -1) s.playerDeck.splice(idx, 1);

        s.playerRP -= card.rp;
        this._log(`Deployed ${card.name} at ${hexId}`);
        this._notify();
        return { ok: true, unit };
    }

    // One-click "recommended army": greedily place the player's remaining deck
    // into the spawn band (reuses deployPlayerUnit for RP/deck/stack/validation).
    autoDeployPlayer() {
        const s = this.state;
        if (s.phase !== 'deploy') return 0;
        const hexPool = [...s.spawnHexIds.playerHexes].sort(() => Math.random() - 0.5);
        let placed = 0, hexIdx = 0, guard = 0;
        for (const cardId of [...s.playerDeck]) {
            const card = CARD_CATALOG[cardId];
            if (!card || s.playerRP < card.rp) continue;
            // find a non-full spawn hex
            let target = null;
            for (let i = 0; i < hexPool.length; i++) {
                const hid = hexPool[(hexIdx + i) % hexPool.length];
                if (hid && !this.combat.stackLimitReached(hid, 'player', s)) { target = hid; hexIdx += i + 1; break; }
            }
            if (!target) break;
            if (this.deployPlayerUnit(cardId, target).ok) placed++;
            if (++guard > 200) break;
        }
        return placed;
    }

    _deployAIUnits() {
        const s = this.state;
        let aiRP = TOTAL_RP;
        const deckCopy = [...s.aiDeckIds];
        const hexPool = [...s.spawnHexIds.aiHexes];

        // Shuffle for variety
        deckCopy.sort(() => Math.random() - 0.5);
        hexPool.sort(() => Math.random() - 0.5);

        let hexIdx = 0;
        for (const cardId of deckCopy) {
            const card = CARD_CATALOG[cardId];
            if (!card || aiRP < card.rp) continue;
            const hexId = hexPool[hexIdx % hexPool.length];
            if (!hexId) break;

            if (!this.combat.stackLimitReached(hexId, 'ai', s)) {
                const unit = this._createUnit(cardId, 'ai', hexId);
                s.units.set(unit.id, unit);
                aiRP -= card.rp;
                hexIdx++;
            }
        }
        // Convert remaining AI RP to CP (2:1); UA gets +3 CP (NATO C2 network)
        const aiC2Bonus = s.aiFaction === 'ua' ? 5 : 0;
        s.aiCP = Math.min(MAX_CP, Math.floor((TOTAL_RP - aiRP) / 2) + aiC2Bonus);
    }

    finishDeployment() {
        const s = this.state;
        if (s.phase !== 'deploy') return;
        // Convert remaining RP → CP; UA gets +3 CP (NATO C2 network)
        const c2Bonus = s.playerFaction === 'ua' ? 5 : 0;
        s.playerCP = Math.min(MAX_CP, Math.floor(s.playerRP / 2) + c2Bonus);
        s.playerRP = 0;
        s.phase = 'player_action';
        s.playerAP = AP_PER_TURN;
        // Record starting force VALUE (sum of unit RP) for the attrition win.
        // Headcount let losing cheap infantry/drones "shatter" an intact armor
        // force — value reflects how much real combat power you've actually lost.
        const forceValue = f => [...s.units.values()]
            .filter(u => u.faction === f && u.hp > 0)
            .reduce((sum, u) => sum + (CARD_CATALOG[u.cardId]?.rp || 1), 0);
        s.startForce.player = forceValue('player');
        s.startForce.ai = forceValue('ai');
        this._startTurn();
        this._notify();
    }

    // ── Turn Management ───────────────────────────────────────────────────────

    _startTurn() {
        const s = this.state;

        // Update EW zones
        if (!s.eventFlags?.ew_suspended) {
            s.ewZones = this.board.computeEWZones(s);
            this._applyEWEffects();
        } else {
            s.ewZones = new Map();
        }

        // Update intel zones
        s.intelZones = this.board.computeIntelZones(s);

        // Update supply traces
        this._updateSupply();

        // Tick mud
        if (s.mudTurns > 0) s.mudTurns--;

        // Tick interdicted hexes
        this.board.hexes.forEach(hex => {
            if (hex.interdictedTurns > 0) hex.interdictedTurns--;
        });

        // Reset IGLA intercept flags + tick skill cooldowns
        s.units.forEach(u => {
            u.iglaInterceptUsed = false;
            if (u.skillCd > 0) u.skillCd--;
        });

        // Tick skill hex effects
        this.board.hexes.forEach(hex => {
            if (hex.smokeTurns > 0) hex.smokeTurns--;
            if (hex.illuminatedTurns > 0) hex.illuminatedTurns--;
        });

        // Aura passives, re-evaluated each turn:
        // Defensive Depth — adjacent friendlies dig in (free Overwatch).
        s.units.forEach(u => {
            if (u.hp <= 0 || !CARD_CATALOG[u.cardId]?.abilities?.includes('defensive_depth')) return;
            this.board.neighbours(u.hexId).forEach(nid => {
                s.units.forEach(f => {
                    if (f.faction === u.faction && f.hp > 0 && f.hexId === nid) f.status.add(STATUS.OVERWATCH);
                });
            });
        });
        // HQ Action — a player HQ unit grants one CP-free Order this turn.
        if ([...s.units.values()].some(u => u.faction === 'player' && u.hp > 0 &&
            CARD_CATALOG[u.cardId]?.abilities?.includes('hq_action'))) {
            s.freeOrderUse = Math.max(s.freeOrderUse || 0, 1);
        }

        // Flip event card at start of player action phase
        if (s.phase === 'player_action') {
            const card = this.eventDeck.flipCard();
            if (card) {
                this.eventDeck.applyEffect(card, s);
                if (this.onEventFlip) this.onEventFlip(card);
            }
        }

        // Loitering munition countdown
        this.board.hexes.forEach((hex, hid) => {
            if (hex.loiteringCountdown > 0) {
                hex.loiteringCountdown--;
                if (hex.loiteringCountdown === 0) {
                    this._triggerLoiteringStrike(hid);
                }
            }
        });

        // Order cooldowns
        Object.keys(s.orderCooldowns).forEach(k => {
            s.orderCooldowns[k]--;
            if (s.orderCooldowns[k] <= 0) delete s.orderCooldowns[k];
        });

        this._log(`Turn ${s.turn} begins — ${s.weather} / ${s.timeOfDay}`);
    }

    _applyEWEffects() {
        const s = this.state;
        // Drone range penalty
        s.units.forEach(unit => {
            const card = CARD_CATALOG[unit.cardId];
            if (!card || unit.hp <= 0) return;
            if (s.ewZones.has(unit.hexId)) {
                const ewFactions = s.ewZones.get(unit.hexId);
                const enemyFaction = unit.faction === 'player' ? 'ai' : 'player';
                if (ewFactions.has(enemyFaction)) {
                    if (card.unitClass === UNIT_CLASS.DRONE) {
                        unit.status.add(STATUS.EW_SUPPRESSED);
                    }
                }
            } else {
                unit.status.delete(STATUS.EW_SUPPRESSED);
            }
        });

        // Comms disruption: count RU EW units alive → reduce UA Orders CP
        let ruEWCount = 0;
        s.units.forEach(u => {
            if (u.faction === 'ai' && u.hp > 0 && CARD_CATALOG[u.cardId]?.abilities?.includes('comms_disruption')) ruEWCount++;
        });
        if (ruEWCount > 0) {
            // Check Starlink passive
            const hasStarlink = [...s.units.values()].some(u =>
                u.faction === 'player' && u.hp > 0 && CARD_CATALOG[u.cardId]?.abilities?.includes('starlink_passive'));
            if (hasStarlink && !s.starlinkConsumed) {
                s.starlinkConsumed = true;
                this._log('Starlink passive absorbed comms disruption');
            } else {
                const penalty = Math.min(s.playerCP, ruEWCount);
                s.playerCP = Math.max(0, s.playerCP - penalty);
                this._log(`EW comms disruption: −${penalty} player CP`);
            }
        }
    }

    _updateSupply() {
        const s = this.state;
        s.units.forEach(unit => {
            if (unit.hp <= 0) return;
            const card = CARD_CATALOG[unit.cardId];
            // Commanders don't need supply
            if (card?.tier === TIER.X) return;

            // DEPOT units extend supply for neighbours (handled in BFS)
            const status = this.board.computeSupplyTrace(unit.hexId, unit.faction, s);
            unit.status.delete(STATUS.LOW_SUPPLY);
            unit.status.delete(STATUS.UNSUPPLIED);
            if (status === 'low_supply') unit.status.add(STATUS.LOW_SUPPLY);
            if (status === 'unsupplied') unit.status.add(STATUS.UNSUPPLIED);
        });
    }

    // ── Player Actions ────────────────────────────────────────────────────────

    moveUnit(unitId, targetHexId) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false, error: 'Not player action phase' };

        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player' || unit.hp <= 0) return { ok: false, error: 'Invalid unit' };

        const card = CARD_CATALOG[unit.cardId];
        if (s.playerAP < 1) return { ok: false, error: 'Not enough AP' };

        // A single move reaches up to MOV terrain-weighted points, but can never
        // cost more AP than remain — so total movement per turn is bounded by AP.
        const movBudget = Math.min(unit.mov + this._carryLift(unit), s.playerAP) + (s.eventFlags?.move_cost_plus1 ? -1 : 0);
        const reachable = this.board.reachableHexes(unit.hexId, movBudget, card.unitClass, 'player', s, card.abilities);

        // AP cost = real distance: the terrain-weighted movement-point cost of the
        // chosen hex. Grinding across hard/impassable terrain costs all remaining AP.
        let apCost;
        if (reachable.has(targetHexId)) {
            apCost = Math.max(1, reachable.get(targetHexId));
        } else if (this.board.escapeHexes(unit.hexId, 'player', s, reachable).has(targetHexId)) {
            apCost = s.playerAP;
        } else {
            return { ok: false, error: 'Target out of movement range' };
        }

        // Mine entry
        const targetHex = this.board.hexes.get(targetHexId);
        if (targetHex?.overlays.has('mined') && !card.abilities?.includes('mine_immune_first')) {
            const dmg = (card.unitClass === UNIT_CLASS.TRACKED || card.unitClass === UNIT_CLASS.WHEELED) ? 6 : 3;
            unit.hp = Math.max(0, unit.hp - dmg);
            unit.status.add(STATUS.SUPPRESSED);
            this._log(`Mine triggered: ${card.name} takes ${dmg} damage`);
            this.board.showAreaEffect([targetHexId], 1400, '#ff6600', 0.5); // mine reveals the hex
        }

        // Move
        unit.hexId = targetHexId;
        unit.movedThisTurn = true; // tracked for stealth_stationary visibility
        unit.status.delete(STATUS.FORTIFIED);
        unit.status.delete(STATUS.OVERWATCH);
        unit.activationsThisTurn++;
        s.playerAP -= apCost;

        // Rapid reposition bonus for UA
        if (card.abilities?.includes('rapid_reposition') && targetHex?.controlledBy === 'player') {
            // Already baked into movement in reachableHexes
        }

        s.selectedUnit = null;
        s.moveRange = null;
        s.grindRange = null;
        s.attackRange = null;

        this._checkOverwatchTriggers(unit, targetHexId);
        this._checkAntiAirTriggers(unit, targetHexId);
        this._checkBreakthrough(unit);
        this._notify();
        return { ok: true };
    }

    // Recon drones "attack" by performing a spotting pass, not dealing damage
    reconReveal(droneId) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false, error: 'Not player action phase' };
        const drone = s.units.get(droneId);
        if (!drone || drone.faction !== 'player' || drone.hp <= 0) return { ok: false, error: 'Invalid drone' };
        const card = CARD_CATALOG[drone.cardId];
        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false, error: 'Not enough AP' };

        // EW jamming cuts drone range
        const ewActive = s.ewZones?.has(drone.hexId) && s.ewZones.get(drone.hexId).has('ai');
        if (ewActive) return { ok: false, error: 'Drone jammed by enemy EW — cannot operate in this area' };

        const droneRng = Math.max(1, drone.rng - (s.eventFlags?.drone_rng_minus1 ? 1 : 0));
        let spotted = 0;
        const spottedNames = [];

        s.units.forEach(unit => {
            if (unit.faction !== 'ai' || unit.hp <= 0) return;
            const dist = this.board.hexDistance(drone.hexId, unit.hexId);
            const uCard = CARD_CATALOG[unit.cardId];
            // Recon reveals everything in range — size no longer shrinks detection.
            // Only stationary stealth units (hides) stay invisible.
            const stealthy = uCard?.abilities?.includes('stealth_stationary') && !unit.movedThisTurn;
            const detectRange = stealthy ? 0 : droneRng;

            if (dist <= detectRange) {
                unit.status.add(STATUS.RECON_SPOTTED);
                unit.reconSpottedTurns = this._spotTurns('player');
                spotted++;
                spottedNames.push(uCard?.name || unit.displayName);
            }
        });

        s.playerAP -= apCost;
        drone.activationsThisTurn++;
        drone.movedThisTurn = true;
        s.selectedUnit = null;
        s.moveRange = null;
        s.grindRange = null;
        s.attackRange = null;

        // Immediately extend the intel zone so the map updates now (not next turn)
        const coverHexes = [drone.hexId, ...this.board.hexesInRange(drone.hexId, droneRng)];
        coverHexes.forEach(hid => {
            if (!s.intelZones.has(hid)) s.intelZones.set(hid, 'player');
        });

        // Arty spotter: flag covered hexes so artillery gets bonus this turn
        if (card.abilities?.includes('arty_spotter') || card.abilities?.includes('arty_relay')) {
            coverHexes.forEach(hid => s.artySpotterHexes?.add(hid));
            if (!s.artySpotterHexes) {
                s.artySpotterHexes = new Set(coverHexes);
            } else {
                coverHexes.forEach(hid => s.artySpotterHexes.add(hid));
            }
        }

        // Flash the covered area in teal to show what the drone can now see
        this.board.showAreaEffect(coverHexes, 1500, '#00bcd4', 0.2);

        const msg = spotted > 0
            ? `Recon pass: ${spotted} unit(s) spotted — ${spottedNames.join(', ')}`
            : 'Recon pass complete — no units detected (enemy may be in cover or using stealth)';
        this._log(msg);
        if (this.onLog) this.onLog(msg);

        this._notify();
        return { ok: true, spotted, msg };
    }

    attackUnit(attackerId, defenderHexId) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false, error: 'Not player action phase' };
        if (s.eventFlags?.no_offensive) return { ok: false, error: 'Ceasefire: no offensive actions' };

        const attacker = s.units.get(attackerId);
        if (!attacker || attacker.faction !== 'player' || attacker.hp <= 0) return { ok: false, error: 'Invalid attacker' };

        // Redirect recon drones to reveal pass
        const attackerCard = CARD_CATALOG[attacker.cardId];
        if (attackerCard?.abilities?.includes('recon_reveal')) {
            return this.reconReveal(attackerId);
        }

        const card = CARD_CATALOG[attacker.cardId];
        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false, error: 'Not enough AP' };

        // Indirect-fire units (artillery, mortar, MLRS) can fire blind at any
        // in-range hex — they don't need a visible enemy. Everyone else needs a
        // target on the hex.
        const isIndirect = card.abilities?.includes('indirect_fire');
        const targets = this.combat.unitsOnHex(defenderHexId, s).filter(u => u.faction === 'ai');
        if (targets.length === 0 && !isIndirect) return { ok: false, error: 'No enemy on target hex' };
        const defender = targets[0]; // may be undefined for a blind indirect shot

        // EW jamming grounds drones — explain it instead of a generic range error
        if (attacker.status.has(STATUS.EW_SUPPRESSED)) {
            return { ok: false, error: 'Jammed by enemy EW (purple zone) — move out before attacking' };
        }

        // Range check
        const dist = this.board.hexDistance(attacker.hexId, defenderHexId);
        let effectiveRng = attacker.rng;
        if (s.eventFlags?.drone_rng_minus1 && card.unitClass === UNIT_CLASS.DRONE) effectiveRng = Math.max(0, effectiveRng - 1);
        if (dist > effectiveRng) return { ok: false, error: 'Target out of range' };
        if (dist === 0 && effectiveRng > 0) return { ok: false, error: 'Cannot attack own hex (use range > 0)' };
        if (card.abilities?.includes('setup_req') && attacker.movedThisTurn) return { ok: false, error: 'Mortar must not move before firing' };

        // Settle attack restriction
        const defHex = this.board.hexes.get(defenderHexId);
        if (s.eventFlags?.no_settle_attack && defHex?.terrainType?.startsWith('settlement')) {
            return { ok: false, error: 'Civilian corridor: no settlement attacks' };
        }

        // Smoke blocks direct ranged attacks; indirect fire arcs over it
        if (defHex?.smokeTurns > 0 && dist > 1 && !isIndirect) {
            return { ok: false, error: 'Target obscured by smoke — only adjacent attacks possible' };
        }

        // Blind indirect fire onto an empty hex — shell lands, AP spent, no effect
        if (!defender) {
            s.playerAP -= apCost;
            attacker.activationsThisTurn++;
            this.board.showAreaEffect([defenderHexId], 1400, '#ff6600', 0.4);
            this._log(`${card.name}: indirect fire on ${defenderHexId} — rounds land on empty ground`);
            s.selectedUnit = null;
            s.moveRange = null;
            s.grindRange = null;
            s.attackRange = null;
            this._notify();
            return { ok: true, blind: true, empty: true };
        }

        // FPV intercept
        if (card.abilities?.includes('interceptable')) {
            const intercept = this.combat.tryIGLAIntercept(attacker, defenderHexId, s);
            if (intercept.intercepted) {
                attacker.hp = 0;
                s.playerAP -= apCost;
                this._log(`${card.name} intercepted by enemy IGLA!`);
                this._notify();
                return { ok: true, intercepted: true };
            }
        }

        const result = this.combat.resolveAttack(attacker, defender, s);
        s.playerAP -= apCost;
        attacker.activationsThisTurn++;

        // Opening fire breaks a stealth unit's concealment — it's now spotted.
        if (card.abilities?.includes('stealth_stationary') && !attacker.status.has(STATUS.RECON_SPOTTED)) {
            attacker.status.add(STATUS.RECON_SPOTTED);
            attacker.reconSpottedTurns = this._spotTurns(attacker.faction);
        }

        // Indirect fire that connects reveals what it hit (incl. hidden units)
        if (isIndirect && result.damage > 0 && !defender.status.has(STATUS.RECON_SPOTTED)) {
            defender.status.add(STATUS.RECON_SPOTTED);
            defender.reconSpottedTurns = this._spotTurns('player');
        }

        result.log.forEach(l => this._log(l));

        // Rapid/Double fire: a free second volley at the same target (MLRS / arty regiment)
        if (defender.hp > 0 && (card.abilities?.includes('rapid_fire') || card.abilities?.includes('double_fire'))) {
            const r2 = this.combat.resolveAttack(attacker, defender, s);
            r2.log.forEach(l => this._log(l));
        }

        // Veteran promotion
        const promoResult = this.combat.checkVeteranPromotion(attacker, defender);
        if (promoResult && this.onVeteranPromotion) {
            this.onVeteranPromotion(promoResult);
        }

        // Engagement count → veteran level 3
        const engPromo = this.combat.promoteFromEngagements(attacker);
        if (engPromo && this.onVeteranPromotion) {
            this.onVeteranPromotion(engPromo);
        }

        // Kill VP
        if (defender.hp <= 0) {
            const defCard = CARD_CATALOG[defender.cardId];
            const vp = DESTROY_VP[defCard?.tier] || 0;
            if (vp > 0) {
                s.playerVP += vp;
                this._log(`+${vp} VP for destroying ${defCard.name}`);
            }
            // Initiative
            s.initiative = Math.min(10, s.initiative + 1);

            // Assault Tempo: a kill refunds 1 AP (max 2/turn)
            if (CARD_CATALOG[attacker.cardId]?.abilities?.includes('assault_tempo') && (attacker._tempoAP || 0) < 2) {
                attacker._tempoAP = (attacker._tempoAP || 0) + 1;
                s.playerAP = Math.min(AP_PER_TURN, s.playerAP + 1);
                this._log('Assault tempo: +1 AP');
            }

            this._checkVictory();
        }

        // Wave spawn (Wave Assault Regt)
        this._checkWaveSpawn(attacker);

        s.selectedUnit = null;
        s.moveRange = null;
        s.grindRange = null;
        s.attackRange = null;

        this._notify();
        return { ok: true, result };
    }

    fortifyUnit(unitId) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false };

        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player' || unit.hp <= 0) return { ok: false };

        const card = CARD_CATALOG[unit.cardId];
        if (card.abilities?.includes('no_fortify')) return { ok: false, error: 'Cannot fortify' };

        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false };

        unit.status.add(STATUS.FORTIFIED);
        unit.status.add(STATUS.OVERWATCH);
        s.playerAP -= apCost;
        unit.activationsThisTurn++;

        s.selectedUnit = null;
        this._notify();
        return { ok: true };
    }

    // ── Active Skills ─────────────────────────────────────────────────────────

    // target: { hexId?, unitId? } depending on the skill's target type
    useUnitSkill(unitId, target = {}) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false, error: 'Not player action phase' };
        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player' || unit.hp <= 0) return { ok: false, error: 'Invalid unit' };

        const card = CARD_CATALOG[unit.cardId];
        const skill = ACTIVE_SKILLS[card?.active];
        if (!skill) return { ok: false, error: 'Unit has no active skill' };
        if (unit.skillCd > 0) return { ok: false, error: `${skill.name} on cooldown (${unit.skillCd} turns)` };
        if (s.playerAP < skill.apCost) return { ok: false, error: 'Not enough AP' };

        const res = this._executeSkill(unit, card, skill, target, 'player');
        if (!res.ok) return res;

        unit.skillCd = skill.cooldown;
        s.playerAP -= skill.apCost;
        this._notify();
        return res;
    }

    _skillRange(unit, skill) {
        if (skill.range === 'rng') return unit.rng;
        if (skill.range === 'mov') return unit.mov;
        return skill.range || 1;
    }

    _executeSkill(unit, card, skill, target, faction) {
        const s = this.state;
        const enemyFaction = faction === 'player' ? 'ai' : 'player';
        const skillId = card.active;

        switch (skillId) {
            case 'canister_shot': {
                const hex = this.board.hexes.get(target.hexId);
                if (!hex) return { ok: false, error: 'No target hex' };
                if (this.board.hexDistance(unit.hexId, target.hexId) !== 1) {
                    return { ok: false, error: 'Canister Shot needs an adjacent hex' };
                }
                let total = 0;
                s.units.forEach(u => {
                    if (u.hexId === target.hexId && u.faction === enemyFaction && u.hp > 0) {
                        const roll = this.combat._rollDice(2, 4, this.combat._saveTarget(u, hex, null, s));
                        u.hp = Math.max(0, u.hp - roll.damage);
                        total += roll.damage;
                        if (u.hp <= 0) this._awardKillVP(u, faction);
                    }
                });
                this.board.showAreaEffect([target.hexId], 1200);
                this._log(`Canister Shot: ${total} dmg on ${target.hexId}`);
                this._checkVictory();
                return { ok: true };
            }

            case 'mark_target': {
                const foe = s.units.get(target.unitId);
                if (!foe || foe.faction !== enemyFaction || foe.hp <= 0) return { ok: false, error: 'No target' };
                if (this.board.hexDistance(unit.hexId, foe.hexId) > this._skillRange(unit, skill)) {
                    return { ok: false, error: 'Target out of range' };
                }
                foe.markedTurns = 2;
                foe.status.add(STATUS.MARKED);
                foe.status.add(STATUS.RECON_SPOTTED);
                foe.reconSpottedTurns = this._spotTurns(faction);
                this._log(`Mark Target: ${foe.displayName} marked (−1 save, spotted)`);
                return { ok: true };
            }

            case 'smoke_screen': {
                const hexId = target.hexId || unit.hexId;
                const hex = this.board.hexes.get(hexId);
                if (!hex) return { ok: false, error: 'No target hex' };
                const d = this.board.hexDistance(unit.hexId, hexId);
                if (d > 1) return { ok: false, error: 'Smoke must be own or adjacent hex' };
                hex.smokeTurns = 1;
                this.board.showAreaEffect([hexId], 1200, '#9aa6b2', 0.45);
                this._log(`Smoke Screen on ${hexId}`);
                return { ok: true };
            }

            case 'illumination': {
                const hexes = [unit.hexId, ...this.board.hexesInRange(unit.hexId, 3)];
                hexes.forEach(hid => {
                    const h = this.board.hexes.get(hid);
                    if (h) h.illuminatedTurns = 1;
                });
                this.board.showAreaEffect(hexes, 1200, '#ffe16b', 0.2);
                this._log('Illumination: night penalty negated in radius 3');
                return { ok: true };
            }

            case 'scoot':
            case 'rapid_dash': {
                const maxRange = this._skillRange(unit, skill);
                const reachable = this.board.reachableHexes(unit.hexId, maxRange, card.unitClass, faction, s, card.abilities);
                if (!target.hexId || !reachable.has(target.hexId)) {
                    return { ok: false, error: 'Target out of range' };
                }
                if (this.combat.stackLimitReached(target.hexId, faction, s)) {
                    return { ok: false, error: 'Hex at stack limit' };
                }
                unit.hexId = target.hexId;
                unit.movedThisTurn = true;
                unit.status.delete(STATUS.FORTIFIED);
                unit.status.delete(STATUS.OVERWATCH);
                this._checkOverwatchTriggers(unit, target.hexId);
                this._checkBreakthrough(unit);
                this._log(`${skill.name}: ${unit.displayName} repositioned`);
                return { ok: true };
            }

            case 'exfil': {
                const spawnIds = faction === 'player' ? s.spawnHexIds.playerHexes : s.spawnHexIds.aiHexes;
                const open = spawnIds.filter(hid => !this.combat.stackLimitReached(hid, faction, s));
                if (!open.length) return { ok: false, error: 'No free spawn hex' };
                unit.hexId = open[Math.floor(Math.random() * open.length)];
                unit.movedThisTurn = true;
                unit.status.delete(STATUS.FORTIFIED);
                unit.status.delete(STATUS.OVERWATCH);
                this._log(`Exfil: ${unit.displayName} withdrew to the rear`);
                return { ok: true };
            }

            case 'sabotage': {
                const foe = s.units.get(target.unitId);
                if (!foe || foe.faction !== enemyFaction || foe.hp <= 0) return { ok: false, error: 'No target' };
                if (this.board.hexDistance(unit.hexId, foe.hexId) > 1) {
                    return { ok: false, error: 'Sabotage needs an adjacent target' };
                }
                const foeCard = CARD_CATALOG[foe.cardId];
                if (!foeCard?.abilities?.includes('ew_jamming') && !foeCard?.abilities?.includes('can_depot')) {
                    return { ok: false, error: 'Target must be an EW or DEPOT-capable unit' };
                }
                foe.sabotagedTurns = 2;
                foe.inDepot = false;
                this.combat._applySuppress(foe);
                this._log(`Sabotage: ${foe.displayName} disabled for 2 turns`);
                return { ok: true };
            }

            case 'remote_mine':
            case 'mine_volley': {
                const hex = this.board.hexes.get(target.hexId);
                if (!hex) return { ok: false, error: 'No target hex' };
                if (this.board.hexDistance(unit.hexId, target.hexId) > this._skillRange(unit, skill)) {
                    return { ok: false, error: 'Target out of range' };
                }
                hex.overlays.add('mined');
                const minedHexes = [target.hexId];
                if (skillId === 'mine_volley') {
                    const extra = this.board.neighbours(target.hexId)
                        .find(nid => !this.board.hexes.get(nid)?.overlays.has('mined'));
                    if (extra) {
                        this.board.hexes.get(extra).overlays.add('mined');
                        minedHexes.push(extra);
                    }
                }
                this.board.showAreaEffect(minedHexes, 1200, '#e74c3c', 0.35);
                this._log(`${skill.name}: ${minedHexes.length} hex(es) mined`);
                return { ok: true };
            }

            case 'field_resupply': {
                const ally = s.units.get(target.unitId);
                if (!ally || ally.faction !== faction || ally.hp <= 0) return { ok: false, error: 'No friendly target' };
                if (this.board.hexDistance(unit.hexId, ally.hexId) > 1) {
                    return { ok: false, error: 'Target must be adjacent' };
                }
                ally.hp = Math.min(ally.maxHp, ally.hp + 2);
                ally.status.delete(STATUS.SUPPRESSED);
                this._log(`Field Resupply: ${ally.displayName} +2 HP`);
                return { ok: true };
            }

            default:
                return { ok: false, error: 'Unknown skill' };
        }
    }

    _spotTurns(faction) {
        const d = faction === 'player' ? this.state.playerDoctrine : this.state.aiDoctrine;
        return d?.id === 'ua_precision' ? 3 : 2;
    }

    activateDepot(unitId) {
        const s = this.state;
        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player') return { ok: false };

        const card = CARD_CATALOG[unit.cardId];
        if (!card.abilities?.includes('can_depot')) return { ok: false };

        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false };

        unit.inDepot = !unit.inDepot;
        s.playerAP -= apCost;
        this._notify();
        return { ok: true };
    }

    designateLoitering(unitId, targetHexId) {
        const s = this.state;
        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player') return { ok: false };

        const card = CARD_CATALOG[unit.cardId];
        if (!card.abilities?.includes('delayed_strike')) return { ok: false };

        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false };

        // Check not EW jammed
        const targetHex = this.board.hexes.get(targetHexId);
        if (s.ewZones.has(targetHexId)) {
            const ew = s.ewZones.get(targetHexId);
            if (ew.has('ai')) {
                this._log('Loitering munition jammed by EW!');
                unit.hp = 0;
                s.playerAP -= apCost;
                this._notify();
                return { ok: false, error: 'Jammed' };
            }
        }

        targetHex.loiteringCountdown = 2;
        targetHex.loiteringOwner = 'player';
        targetHex.loiteringAtk = card.atk;
        targetHex.loiteringJammable = card.abilities?.includes('jammable');
        unit.hp = 0; // consumed on designation
        s.playerAP -= apCost;
        this._log(`Loitering munition designated at ${targetHexId}, strikes in 2 turns`);
        this._notify();
        return { ok: true };
    }

    useOrder(orderId, targetUnitId, targetHexId) {
        const s = this.state;
        if (s.phase !== 'player_action') return { ok: false };

        const order = ORDERS_CATALOG[orderId];
        if (!order) return { ok: false };
        if (!order.factions.includes(s.playerFaction)) return { ok: false, error: 'Not available for your faction' };

        const cpCost = s.freeOrderUse > 0 ? 0 : order.cp;
        if (s.playerCP < cpCost) return { ok: false, error: 'Not enough CP' };
        if (order.cooldown && s.orderCooldowns[orderId] > 0) return { ok: false, error: 'Order on cooldown' };
        if (order.oncePerMatch && s.orderUsedOncePerMatch.has(orderId)) return { ok: false, error: 'Already used this match' };

        const result = this._executeOrder(orderId, order, targetUnitId, targetHexId, 'player');

        if (result.ok) {
            if (s.freeOrderUse > 0) s.freeOrderUse--;
            else s.playerCP -= cpCost;
            if (order.cooldown) s.orderCooldowns[orderId] = order.cooldown;
            if (order.oncePerMatch) s.orderUsedOncePerMatch.add(orderId);
        }

        this._notify();
        return result;
    }

    // ── Commander Doctrine ────────────────────────────────────────────────────

    doctrineDef(side) {
        const s = this.state;
        const d = side === 'player' ? s.playerDoctrine : s.aiDoctrine;
        const faction = side === 'player' ? s.playerFaction : s.aiFaction;
        return { state: d, def: DOCTRINES[faction].find(x => x.id === d.id) };
    }

    doctrineAvailable(side) {
        const { state: d, def } = this.doctrineDef(side);
        if (!d || !def) return false;
        return d.charges > 0 && this.state.turn - d.lastUsedTurn >= def.cooldown;
    }

    // Player doctrine active. Untargeted doctrines fire immediately; targeted
    // ones return { needTarget: 'unit'|'hex' } and the UI routes the next click
    // to executeDoctrineTarget().
    usePlayerDoctrine() {
        if (!this.doctrineAvailable('player')) {
            return { ok: false, error: 'Doctrine active not available (charges/cooldown)' };
        }
        const { def } = this.doctrineDef('player');
        if (def.target !== 'none') return { ok: true, needTarget: def.target };
        return this.executeDoctrineTarget({});
    }

    executeDoctrineTarget(target) {
        const res = this._executeDoctrineActive('player', target);
        if (res.ok) {
            const { state: d } = this.doctrineDef('player');
            d.charges--;
            d.lastUsedTurn = this.state.turn;
        }
        this._notify();
        return res;
    }

    useAIDoctrine(target = {}) {
        if (!this.doctrineAvailable('ai')) return false;
        const res = this._executeDoctrineActive('ai', target);
        if (res.ok) {
            const { state: d } = this.doctrineDef('ai');
            d.charges--;
            d.lastUsedTurn = this.state.turn;
        }
        return res.ok;
    }

    _executeDoctrineActive(side, target) {
        const s = this.state;
        const { def } = this.doctrineDef(side);
        const enemySide = side === 'player' ? 'ai' : 'player';

        switch (def.id) {
            case 'ua_precision': {
                const foe = s.units.get(target.unitId);
                if (!foe || foe.faction !== enemySide || foe.hp <= 0) return { ok: false, error: 'No target' };
                if (!foe.status.has(STATUS.RECON_SPOTTED) && !s.intelZones.has(foe.hexId)) {
                    return { ok: false, error: 'Target not spotted — requires ISR' };
                }
                const roll = this.combat._rollDice(4, 4, 7);
                foe.hp = Math.max(0, foe.hp - roll.damage);
                this._log(`Precision Strike: ${foe.displayName} takes ${roll.damage} dmg`);
                if (foe.hp <= 0) {
                    this._awardKillVP(foe, side);
                    this._checkVictory();
                }
                return { ok: true };
            }

            case 'ua_resilience': {
                let count = 0;
                s.units.forEach(u => {
                    if (u.faction === side && u.hp > 0 && count < 3 &&
                        !u.status.has(STATUS.FORTIFIED) &&
                        !CARD_CATALOG[u.cardId]?.abilities?.includes('no_fortify')) {
                        u.status.add(STATUS.FORTIFIED);
                        u.status.add(STATUS.OVERWATCH);
                        count++;
                    }
                });
                this._log(`Rapid Fortification: ${count} units fortified`);
                return { ok: true };
            }

            case 'ru_mass': {
                // Mobilization arrives from the rear, not at the line
                const hexPool = (side === 'player' ? s.rearHexIds.player : s.rearHexIds.ai) ||
                                (side === 'player' ? s.spawnHexIds.playerHexes : s.spawnHexIds.aiHexes);
                for (let i = 0; i < 2; i++) {
                    const open = hexPool.filter(hid => !this.combat.stackLimitReached(hid, side, s));
                    if (!open.length) break;
                    const hexId = open[Math.floor(Math.random() * open.length)];
                    const tokenId = `${side}_wave_${Date.now()}_${i}`;
                    s.units.set(tokenId, this._createUnit('ru_assault', side, hexId, { hp: 2, atk: 2 }));
                }
                this._log('Mobilization Wave: 2 Assault Groups deployed in the rear');
                return { ok: true };
            }

            case 'ru_fires': {
                const hex = this.board.hexes.get(target.hexId);
                if (!hex) return { ok: false, error: 'No target hex' };
                const area = [target.hexId, ...this.board.neighbours(target.hexId)];
                area.forEach((hid, idx) => {
                    const h = this.board.hexes.get(hid);
                    s.units.forEach(u => {
                        if (u.hexId === hid && u.faction === enemySide && u.hp > 0) {
                            const roll = this.combat._rollDice(idx === 0 ? 4 : 2, 4, this.combat._saveTarget(u, h, null, s));
                            u.hp = Math.max(0, u.hp - roll.damage);
                            if (u.hp <= 0) this._awardKillVP(u, side);
                        }
                    });
                });
                this.board.showAreaEffect(area, 1800);
                this._log(`Fire Mission on ${target.hexId}`);
                this._checkVictory();
                return { ok: true };
            }

            default:
                return { ok: false, error: 'Unknown doctrine' };
        }
    }

    // ── AI Action Execution (called from AIOpponent) ──────────────────────────

    executeAIAction(unitId, action) {
        const s = this.state;
        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'ai' || unit.hp <= 0) return false;

        switch (action.type) {
            case 'move': {
                const card = CARD_CATALOG[unit.cardId];
                const targetHex = this.board.hexes.get(action.targetHex);
                if (!targetHex) return false;
                // Check stack limit
                if (this.combat.stackLimitReached(action.targetHex, 'ai', s)) return false;
                // Mine entry
                if (targetHex.overlays.has('mined') && !card.abilities?.includes('mine_immune_first')) {
                    const dmg = (card.unitClass === UNIT_CLASS.TRACKED || card.unitClass === UNIT_CLASS.WHEELED) ? 6 : 3;
                    unit.hp = Math.max(0, unit.hp - dmg);
                    unit.status.add(STATUS.SUPPRESSED);
                    unit.status.add(STATUS.RECON_SPOTTED);   // mine reveals the advancing unit
                    unit.reconSpottedTurns = this._spotTurns('player');
                    this.board.showAreaEffect([action.targetHex], 1400, '#ff6600', 0.5);
                    this._log(`Mine triggered: ${card.name} takes ${dmg} damage`);
                    if (unit.hp <= 0) return true;
                }
                unit.hexId = action.targetHex;
                unit.status.delete(STATUS.FORTIFIED);
                unit.status.delete(STATUS.OVERWATCH);
                this._checkOverwatchTriggers(unit, action.targetHex);
                this._checkAntiAirTriggers(unit, action.targetHex);
                this._checkBreakthrough(unit);
                return true;
            }
            case 'attack': {
                const target = s.units.get(action.targetUnit);
                if (!target || target.faction !== 'player' || target.hp <= 0) return false;

                const dist = this.board.hexDistance(unit.hexId, target.hexId);
                if (dist > unit.rng || unit.status.has(STATUS.EW_SUPPRESSED)) return false;
                if (s.eventFlags?.no_offensive) return false;
                const tHex = this.board.hexes.get(target.hexId);
                if (tHex?.smokeTurns > 0 && dist > 1) return false;

                const result = this.combat.resolveAttack(unit, target, s);

                // Rapid/Double fire: a free second volley at the same target.
                if (target.hp > 0 && (CARD_CATALOG[unit.cardId]?.abilities?.includes('rapid_fire') ||
                    CARD_CATALOG[unit.cardId]?.abilities?.includes('double_fire'))) {
                    this.combat.resolveAttack(unit, target, s);
                }

                // Opening fire breaks an AI stealth unit's concealment.
                const aCard = CARD_CATALOG[unit.cardId];
                if (aCard?.abilities?.includes('stealth_stationary') && !unit.status.has(STATUS.RECON_SPOTTED)) {
                    unit.status.add(STATUS.RECON_SPOTTED);
                    unit.reconSpottedTurns = this._spotTurns('ai');
                }

                // Make enemy fire visible: log line + flash on the target hex
                if (result.missed) {
                    this._log(`🔻 ${unit.displayName} fires at ${target.displayName} — missed`);
                } else {
                    const diceLine = result.log.find(l => l.includes('dice →'));
                    this._log(`🔻 ${unit.displayName} attacks ${target.displayName} — ${diceLine ? diceLine.split(/: (.+)/)[1] : result.damage + ' dmg'}`);
                }
                this.board.showAreaEffect([target.hexId], 1600, '#ff5544', 0.45);

                if (target.hp <= 0) {
                    const vp = DESTROY_VP[CARD_CATALOG[target.cardId]?.tier] || 0;
                    s.aiVP += vp;
                    s.initiative = Math.max(0, s.initiative - 1);
                    if (vp > 0) this._log(`Enemy +${vp} VP for destroying ${target.displayName}`);
                    // Assault Tempo: a kill refunds the AI 1 action point (max 2/turn)
                    if (CARD_CATALOG[unit.cardId]?.abilities?.includes('assault_tempo') && (unit._tempoAP || 0) < 2) {
                        unit._tempoAP = (unit._tempoAP || 0) + 1;
                        if (this.ai) this.ai._apRemaining = (this.ai._apRemaining || 0) + 1;
                    }
                    this._checkVictory();
                }
                this._checkWaveSpawn(unit);
                return true;
            }
            case 'fortify': {
                const card = CARD_CATALOG[unit.cardId];
                if (card?.abilities?.includes('no_fortify')) return false;
                unit.status.add(STATUS.FORTIFIED);
                unit.status.add(STATUS.OVERWATCH);
                return true;
            }
            case 'loitering_designate': {
                const targetHex = this.board.hexes.get(action.targetHex);
                if (!targetHex) return false;
                targetHex.loiteringCountdown = 2;
                targetHex.loiteringOwner = 'ai';
                targetHex.loiteringAtk = CARD_CATALOG[unit.cardId]?.atk || 4;
                targetHex.loiteringJammable = CARD_CATALOG[unit.cardId]?.abilities?.includes('jammable');
                unit.hp = 0;
                return true;
            }
            case 'skill': {
                const card = CARD_CATALOG[unit.cardId];
                const skill = ACTIVE_SKILLS[card?.active];
                if (!skill || unit.skillCd > 0) return false;
                const res = this._executeSkill(unit, card, skill, action.target || {}, 'ai');
                if (res.ok) unit.skillCd = skill.cooldown;
                return res.ok;
            }
            default: return false;
        }
    }

    useAIOrder(orderId, targetUnitId) {
        const s = this.state;
        const order = ORDERS_CATALOG[orderId];
        if (!order || s.aiCP < order.cp) return false;
        if (order.cooldown && s.orderCooldowns[`ai_${orderId}`] > 0) return false;

        this._executeOrder(orderId, order, targetUnitId, null, 'ai');
        s.aiCP -= order.cp;
        if (order.cooldown) s.orderCooldowns[`ai_${orderId}`] = order.cooldown;
        return true;
    }

    // ── Order Execution ───────────────────────────────────────────────────────

    _executeOrder(orderId, order, targetUnitId, targetHexId, forFaction) {
        const s = this.state;
        const enemyFaction = forFaction === 'player' ? 'ai' : 'player';

        switch (orderId) {
            case 'artillery_barrage': {
                const target = s.units.get(targetUnitId);
                if (!target) return { ok: false };
                const isSpotted = target.status.has(STATUS.RECON_SPOTTED) || s.intelZones.has(target.hexId);
                const baseAtk = isSpotted ? 6 : 4;
                const toHit = [target.hexId, ...this.board.neighbours(target.hexId)];
                toHit.forEach(hid => {
                    s.units.forEach(u => {
                        if (u.faction === enemyFaction && u.hexId === hid && u.hp > 0) {
                            const def = isSpotted ? 0 : (u.def || 0);
                            u.hp = Math.max(0, u.hp - Math.max(0, baseAtk - def));
                            if (u.hp <= 0) this._awardKillVP(u, forFaction);
                        }
                    });
                });
                this.board.showAreaEffect(toHit, 1800);
                this._checkVictory();
                this._log(`Artillery Barrage on ${target.hexId}: ${baseAtk} ATK${isSpotted ? ' (spotted, DEF ignored)' : ''}`);
                return { ok: true };
            }

            case 'recon_sweep': {
                const turns = this._spotTurns(forFaction);
                s.units.forEach(u => {
                    if (u.faction === enemyFaction && u.hp > 0) {
                        u.status.add(STATUS.RECON_SPOTTED);
                        u.reconSpottedTurns = turns;
                    }
                });
                this._log(`Recon Sweep: all enemies Recon-spotted for ${turns} turns`);
                return { ok: true };
            }

            case 'supply_run': {
                const target = s.units.get(targetUnitId);
                if (!target || target.faction !== forFaction) return { ok: false };
                target.hp = Math.min(target.maxHp, target.hp + (target.hexId && this.board.hexes.get(target.hexId)?.terrainType?.startsWith('settlement') ? 5 : 3));
                target.status.delete(STATUS.SUPPRESSED);
                this._log(`Supply Run: ${target.displayName} healed and Suppressed removed`);
                return { ok: true };
            }

            case 'fortify_order': {
                let count = 0;
                s.units.forEach(u => {
                    if (u.faction === forFaction && u.hp > 0 && count < 2) {
                        u.status.add(STATUS.FORTIFIED);
                        u.status.add(STATUS.OVERWATCH);
                        count++;
                    }
                });
                this._log(`Fortify Order: ${count} units fortified`);
                return { ok: true };
            }

            case 'flanking_order': {
                const target = s.units.get(targetUnitId);
                if (!target || target.faction !== forFaction) return { ok: false };
                target.status.add(STATUS.FLANKING);
                this._log(`Flanking Order: ${target.displayName} gets Flanking status`);
                return { ok: true };
            }

            case 'mining_op': {
                let mined = 0;
                const hexPool = targetHexId
                    ? [targetHexId, ...this.board.neighbours(targetHexId)].slice(0, 3)
                    : s.spawnHexIds.playerHexes.slice(0, 3);
                hexPool.forEach(hid => {
                    if (mined < 3) { this.board.hexes.get(hid)?.overlays.add('mined'); mined++; }
                });
                this._log(`Mining Operation: ${mined} hexes mined`);
                return { ok: true };
            }

            case 'elastic_defense': {
                let count = 0;
                s.units.forEach(u => {
                    if (u.faction === forFaction && u.hp > 0 && count < 3) {
                        u.status.add(STATUS.FORTIFIED);
                        count++;
                    }
                });
                return { ok: true };
            }

            case 'human_wave': {
                let count = 0;
                s.units.forEach(u => {
                    if (u.faction === forFaction && u.hp > 0 && CARD_CATALOG[u.cardId]?.unitClass === UNIT_CLASS.INFANTRY && count < 4) {
                        u._humanWaveBonus = true;
                        u.status.delete(STATUS.SUPPRESSED);
                        count++;
                    }
                });
                this._log(`Human Wave Assault: ${count} infantry units boosted`);
                return { ok: true };
            }

            case 'fpv_swarm': {
                // Place 3 FPV tokens
                const nearest = this._nearestPlayerUnit(forFaction, s);
                if (!nearest) return { ok: false };
                const hids = [nearest.hexId, ...this.board.hexesInRange(nearest.hexId, 4)];
                for (let i = 0; i < 3; i++) {
                    const hid = hids[Math.floor(Math.random() * hids.length)];
                    const tokenId = `${forFaction}_fpv_swarm_${Date.now()}_${i}`;
                    s.units.set(tokenId, this._createUnit('ua_fpv', forFaction, hid, { hp: 1, atk: 4, rng: 2 }));
                }
                return { ok: true };
            }

            default:
                return { ok: true }; // unimplemented order → succeed silently
        }
    }

    _nearestPlayerUnit(faction, s) {
        let best = null;
        s.units.forEach(u => { if (u.faction === faction && u.hp > 0) best = u; });
        return best;
    }

    // ── End of Player Turn ───────────────────────────────────────────────────

    endPlayerTurn() {
        const s = this.state;
        if (s.phase !== 'player_action') return;

        this._endOfTurnProcessing('player');
        s.phase = 'ai_action';
        s.activePhase = 'ai';

        this._notify();
        this._runAITurn();
    }

    // Drive the AI turn one action at a time so the player can watch it resolve
    // (headless sims run it synchronously with no delay).
    _runAITurn() {
        const s = this.state;
        this.ai.beginTurn(s, this);
        if (this.headless) {
            while (this.ai.nextAction(s, this)) { /* step to completion */ }
            this._endOfTurnProcessing('ai');
            this._advanceTurn();
            return;
        }
        const step = () => {
            const acted = this.ai.nextAction(s, this);
            if (acted) {
                this._showAIIntent(acted);
                this._notify();
                setTimeout(step, AI_STEP_MS);
            } else {
                this._endOfTurnProcessing('ai');
                this._advanceTurn();
            }
        };
        setTimeout(step, AI_STEP_MS);
    }

    // Make the acted unit's move/attack legible (attacks already flash the target
    // in executeAIAction; here we light up moves and narrate the step).
    _showAIIntent(acted) {
        const s = this.state;
        const unit = s.units.get(acted.unitId);
        const name = unit?.displayName || CARD_CATALOG[unit?.cardId]?.name || 'Enemy';
        if (acted.action.type === 'move' && unit) {
            this.board.showAreaEffect([unit.hexId], 900, '#ff8866', 0.35);
        }
        const verb = acted.action.type === 'attack' ? 'attacks'
            : acted.action.type === 'move' ? 'advances'
            : acted.action.type === 'fortify' ? 'digs in'
            : acted.action.type;
        if (this.onAIStep) this.onAIStep(`Enemy: ${name} ${verb}`);
    }

    _endOfTurnProcessing(faction) {
        const s = this.state;

        // Tick statuses
        s.units.forEach(unit => {
            if (unit.faction === faction || true) { // tick all
                this.combat.tickStatuses(unit, s);
            }
        });

        // Fragile: a unit (recon drone) with an enemy adjacent at end of turn is overrun.
        s.units.forEach(u => {
            if (u.hp <= 0 || !CARD_CATALOG[u.cardId]?.abilities?.includes('fragile')) return;
            const enemyAdj = this.board.neighbours(u.hexId).some(nid =>
                [...s.units.values()].some(e => e.faction !== u.faction && e.hp > 0 && e.hexId === nid));
            if (enemyAdj) { u.hp = 0; this._log(`${u.displayName} (fragile) overrun and destroyed`); }
        });

        // VP scoring + objective-hold streak + alternate win checks — once per
        // full turn, after the AI phase (objective control is fresh).
        if (faction === 'ai') {
            this._scoreVP();
            this._updateHoldStreak();
            this._checkWinConditions();
        }

        // Initiative update: units lost this turn tracked via kills property diff
        // (already updated per-kill)

        // Clear activation counts
        s.units.forEach(u => {
            u.activationsThisTurn = 0;
            u.movedThisTurn = false;
            u._humanWaveBonus = false;
            u._tempoAP = 0;
        });

        // Clear free-use flags
        s.freeOrderUse = 0;
        s.freeAirAssaultDeploy = false;

        // Mud tick
        // (mudTurns ticked in _startTurn)

        this.eventDeck.clearTurnFlags(s);
    }

    _advanceTurn() {
        const s = this.state;

        // Catch eliminations from events/area damage that bypass attack paths
        this._checkVictory();
        if (s.phase === 'end') return;

        // Decisive VP lead ends the match early
        const vpLead = s.playerVP - s.aiVP;
        if (s.turn >= 10 && Math.abs(vpLead) >= 30) {
            this._endGame(vpLead > 0 ? 'player' : 'ai', 'Decisive VP lead');
            return;
        }

        s.turn++;

        if (s.turn > MAX_TURNS) {
            this._endGame();
            return;
        }

        s.phase = 'player_action';
        s.activePhase = 'player';
        s.playerAP = AP_PER_TURN;

        this._startTurn();
        this._notify();
        if (this.onPlayerTurnStart) this.onPlayerTurnStart();
    }

    // ── VP Scoring ────────────────────────────────────────────────────────────

    _scoreVP() {
        const s = this.state;

        // Determine objective control
        this.board.hexes.forEach((hex, hexId) => {
            if (!hex.isObjective) return;

            const playerUnits = [...s.units.values()].filter(u => u.faction === 'player' && u.hexId === hexId && u.hp > 0);
            const aiUnits = [...s.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);

            // Forward positions are contestable: abandoned + enemy adjacent → neutral
            if (hex.objectiveType === 'forward_position' && hex.controlledBy) {
                const ownerOnHex = hex.controlledBy === 'player' ? playerUnits.length : aiUnits.length;
                if (ownerOnHex === 0) {
                    const enemy = hex.controlledBy === 'player' ? 'ai' : 'player';
                    const adj = this.board.neighbours(hexId);
                    const enemyAdjacent = [...s.units.values()].some(u =>
                        u.faction === enemy && u.hp > 0 && adj.includes(u.hexId));
                    if (enemyAdjacent) hex.controlledBy = null;
                }
            }

            if (playerUnits.length > 0 && aiUnits.length === 0) {
                hex.controlledBy = 'player';
            } else if (aiUnits.length > 0 && playerUnits.length === 0) {
                hex.controlledBy = 'ai';
            }
            // Contested: no change

            const vpPerTurn = OBJ_VP[hex.objectiveType] || 1;
            // Forward positions mark the AI rear the player pushes into —
            // the AI earns nothing for garrisoning its own rear.
            if (hex.objectiveType === 'forward_position') {
                if (hex.controlledBy === 'player') s.playerVP += vpPerTurn;
            } else {
                if (hex.controlledBy === 'player') s.playerVP += vpPerTurn;
                if (hex.controlledBy === 'ai') s.aiVP += vpPerTurn;
            }
        });

        // Settlement network bonus
        // (simplified: +1 VP if player controls 3+ settlements)
        const playerSettlements = [...this.board.hexes.values()]
            .filter(h => h.terrainType?.startsWith('settlement') && h.controlledBy === 'player').length;
        if (playerSettlements >= 3) s.playerVP += 2;
        const aiSettlements = [...this.board.hexes.values()]
            .filter(h => h.terrainType?.startsWith('settlement') && h.controlledBy === 'ai').length;
        if (aiSettlements >= 3) s.aiVP += 2;
    }

    // ── Victory Conditions ───────────────────────────────────────────────────

    _checkVictory() {
        const s = this.state;

        // Only end mid-game on total unit elimination — VP decides winner at turn 20
        const playerAlive = [...s.units.values()].filter(u => u.faction === 'player' && u.hp > 0).length;
        const aiAlive = [...s.units.values()].filter(u => u.faction === 'ai' && u.hp > 0).length;

        if (aiAlive === 0) {
            this._endGame('player', 'All enemy units eliminated');
            return;
        }
        if (playerAlive === 0) {
            this._endGame('ai', 'All player units eliminated');
            return;
        }

        // VP lead only ends the game at turn 20 (_advanceTurn → _endGame with no args)
    }

    // Increment/reset each side's consecutive-turns-holding-the-objectives streak.
    _updateHoldStreak() {
        const s = this.state;
        const contested = [...this.board.hexes.values()]
            .filter(h => h.isObjective && h.objectiveType !== 'forward_position');
        if (!contested.length) return;
        const need = Math.max(1, Math.ceil(contested.length * 0.75));
        for (const side of ['player', 'ai']) {
            const held = contested.filter(h => h.controlledBy === side).length;
            if (held >= need) s.holdStreak[side] = (s.holdStreak[side] || 0) + 1;
            else s.holdStreak[side] = 0;
        }
    }

    // Alternate win paths beyond the VP race — checked at the end of each full
    // turn. Symmetric for both sides. Returns true if it ended the game.
    _checkWinConditions() {
        const s = this.state;
        if (s.phase === 'end') return true;
        const p = this.victoryProgress();

        for (const side of ['player', 'ai']) {
            const label = side === 'player' ? '' : 'Enemy ';
            if (p[side].attritionWin)   { this._endGame(side, `${side === 'player' ? 'Enemy' : 'Friendly'} force shattered`); return true; }
            if (p[side].breakthroughWin){ this._endGame(side, `${label}breakthrough — enemy rear seized`); return true; }
            if (p[side].holdWin)        { this._endGame(side, `${label}held the key objectives`); return true; }
        }
        return false;
    }

    // Progress toward every win condition, for the HUD + win checks.
    victoryProgress() {
        const s = this.state;
        const forceValue = f => [...s.units.values()]
            .filter(u => u.faction === f && u.hp > 0)
            .reduce((sum, u) => sum + (CARD_CATALOG[u.cardId]?.rp || 1), 0);
        const groundOn = (faction, hid) => [...s.units.values()].some(u =>
            u.faction === faction && u.hp > 0 && u.hexId === hid &&
            CARD_CATALOG[u.cardId]?.unitClass !== UNIT_CLASS.DRONE);
        const contested = [...this.board.hexes.values()]
            .filter(h => h.isObjective && h.objectiveType !== 'forward_position');
        const holdNeed = Math.max(1, Math.ceil(contested.length * 0.75));

        const out = {};
        for (const side of ['player', 'ai']) {
            const foe = side === 'player' ? 'ai' : 'player';
            const startFoe = s.startForce[foe] || 0;
            const foeValue = forceValue(foe);
            const enemyRim = (foe === 'player' ? s.rearHexIds?.player : s.rearHexIds?.ai) || [];
            const rimHeld = enemyRim.filter(hid => groundOn(side, hid)).length;
            const objHeld = contested.filter(h => h.controlledBy === side).length;
            out[side] = {
                foeValue, foeStartValue: startFoe,
                attritionWin: startFoe >= 16 && foeValue <= Math.ceil(startFoe * 0.25),
                rimHeld, rimNeed: 3, breakthroughWin: rimHeld >= 3,
                objHeld, objNeed: holdNeed, holdStreak: s.holdStreak[side] || 0,
                holdWin: contested.length > 0 && (s.holdStreak[side] || 0) >= 3
            };
        }
        return out;
    }

    _endGame(winner, reason) {
        const s = this.state;
        if (s._gameOver) return;   // one victory screen only
        s._gameOver = true;
        s.phase = 'end';

        const vpDiff = Math.abs(s.playerVP - s.aiVP);
        const label = vpDiff <= 10 ? 'Narrow' : vpDiff <= 30 ? 'Clear' : vpDiff <= 60 ? 'Decisive' : 'Domination';

        if (this.onVictory) {
            this.onVictory({
                winner: winner || (s.playerVP >= s.aiVP ? 'player' : 'ai'),
                reason: reason || `Turn ${MAX_TURNS} reached`,
                playerVP: s.playerVP, aiVP: s.aiVP,
                vpLabel: label
            });
        }
    }

    // ── Unit Factory ─────────────────────────────────────────────────────────

    _createUnit(cardId, faction, hexId, overrides = {}) {
        const card = CARD_CATALOG[cardId];
        const id = `${faction}_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return {
            id,
            cardId,
            faction,
            hexId,
            hp: overrides.hp ?? card.hp,
            maxHp: overrides.hp ?? card.hp,
            atk: overrides.atk ?? card.atk,
            def: card.def,
            mov: card.mov,
            rng: card.rng,
            displayName: card.name,
            realName: null,
            status: new Set(),
            experience: 0,
            statBonus: { atk: 0, def: 0 },
            engagements: 0,
            kills: 0,
            activationsThisTurn: 0,
            reconSpottedTurns: 0,
            ambushReady: card.abilities?.includes('ambush') || false,
            inDepot: false,
            iglaInterceptUsed: false,
            movedThisTurn: false,
            skillCd: 0,
            markedTurns: 0,
            sabotagedTurns: 0
        };
    }

    // ── Misc Helpers ─────────────────────────────────────────────────────────

    _checkOverwatchTriggers(movingUnit, targetHexId) {
        const s = this.state;
        const enemyFaction = movingUnit.faction === 'player' ? 'ai' : 'player';
        s.units.forEach(u => {
            if (u.faction !== enemyFaction || u.hp <= 0 || !u.status.has(STATUS.OVERWATCH)) return;
            const dist = this.board.hexDistance(u.hexId, targetHexId);
            if (dist <= u.rng) {
                // Trigger overwatch
                const atkVal = Math.max(0, u.atk - 1);
                const defVal = movingUnit.def;
                const dmg = Math.max(1, atkVal - defVal);
                movingUnit.hp = Math.max(0, movingUnit.hp - dmg);
                u.status.delete(STATUS.OVERWATCH);
                this._log(`Overwatch: ${u.displayName} fires at ${movingUnit.displayName} for ${dmg} dmg`);

                // Breakthrough: tank ignores overwatch (handled by not calling this for tank attacks)
            }
        });
    }

    // Anti-air reaction: an enemy drone moving into the range of an IGLA/ZU-23
    // (anti_air_reaction) draws a free shot — unless a friendly recon_shield
    // umbrella is nearby. Called when a DRONE moves.
    _checkAntiAirTriggers(drone, hexId) {
        const s = this.state;
        if (CARD_CATALOG[drone.cardId]?.unitClass !== UNIT_CLASS.DRONE || drone.hp <= 0) return;
        const shielded = [...s.units.values()].some(u => u.faction === drone.faction && u.hp > 0 &&
            CARD_CATALOG[u.cardId]?.abilities?.includes('recon_shield') &&
            this.board.hexDistance(u.hexId, hexId) <= 5);
        if (shielded) return;
        for (const u of s.units.values()) {
            if (u.faction === drone.faction || u.hp <= 0) continue;
            if (!CARD_CATALOG[u.cardId]?.abilities?.includes('anti_air_reaction')) continue;
            if (this.board.hexDistance(u.hexId, hexId) <= u.rng) {
                const dmg = this._rollAA(u);
                drone.hp = Math.max(0, drone.hp - dmg);
                this._log(`Anti-air: ${u.displayName} fires at ${drone.displayName} for ${dmg} dmg`);
                break; // one reaction per move
            }
        }
    }

    _rollAA(unit) {
        // Aircraft get no terrain save: simple atk-vs-4+ dice (reuse combat roller)
        return this.combat._rollDice(Math.max(0, unit.atk), 4, 7).damage;
    }

    // Mechanized lift: infantry beside a friendly carrier/transport (BTR/IFV)
    // ride forward — +1 MOV. (Activates the carrier/transport abilities without
    // a load/unload UI: the vehicle's value is moving infantry faster.)
    _carryLift(unit) {
        if (CARD_CATALOG[unit.cardId]?.unitClass !== UNIT_CLASS.INFANTRY) return 0;
        const adj = this.board.neighbours(unit.hexId);
        const lifted = [...this.state.units.values()].some(u => u.faction === unit.faction && u.hp > 0 &&
            adj.includes(u.hexId) &&
            (CARD_CATALOG[u.cardId]?.abilities?.includes('carrier') ||
             CARD_CATALOG[u.cardId]?.abilities?.includes('transport')));
        return lifted ? 1 : 0;
    }

    // One-time +2 VP for the first ground unit to enter the enemy rear (board
    // rim on their side — the spawn bands sit at the front and don't count)
    _checkBreakthrough(unit) {
        const s = this.state;
        if (s.breakthroughAwarded[unit.faction]) return;
        const card = CARD_CATALOG[unit.cardId];
        if (card?.unitClass === UNIT_CLASS.DRONE) return;
        const enemyHexes = unit.faction === 'player' ? s.rearHexIds.ai : s.rearHexIds.player;
        if (!enemyHexes?.includes(unit.hexId)) return;
        s.breakthroughAwarded[unit.faction] = true;
        if (unit.faction === 'player') s.playerVP += 2; else s.aiVP += 2;
        this._log(`Breakthrough! ${unit.displayName} entered the enemy rear (+2 VP)`);
    }

    _checkWaveSpawn(unit) {
        const card = CARD_CATALOG[unit.cardId];
        if (!card?.abilities?.includes('wave_spawn') || unit.hp <= 0) return;

        const s = this.state;
        const spawnHex = this.board.neighbours(unit.hexId)
            .find(hid => {
                const h = this.board.hexes.get(hid);
                return h && !this.combat.stackLimitReached(hid, unit.faction, s);
            });

        if (spawnHex) {
            const tokenId = `${unit.faction}_wave_token_${Date.now()}`;
            s.units.set(tokenId, this._createUnit('ru_assault', unit.faction, spawnHex, { hp: 2, atk: 1 }));
            this._log('Wave Assault: 1 Assault Group token spawned');
        }
    }

    _triggerLoiteringStrike(hexId) {
        const s = this.state;
        const hex = this.board.hexes.get(hexId);
        if (!hex) return;

        const atk = hex.loiteringAtk || 4;
        const ownerFaction = hex.loiteringOwner || 'player';
        const enemyFaction = ownerFaction === 'player' ? 'ai' : 'player';

        // Jammable: enemy EW that moved over the target during the countdown
        // cancels the strike (Switchblade lost the link).
        if (hex.loiteringJammable && s.ewZones?.get(hexId)?.has(enemyFaction)) {
            hex.loiteringCountdown = 0; hex.loiteringOwner = null; hex.loiteringJammable = false;
            this._log(`Loitering strike at ${hexId} jammed by EW — link lost`);
            return;
        }

        s.units.forEach(u => {
            if (u.faction === enemyFaction && u.hexId === hexId && u.hp > 0) {
                u.hp = Math.max(0, u.hp - atk);
                this._log(`Loitering strike on ${hexId}: ${u.displayName} takes ${atk} dmg`);
                if (u.hp <= 0) this._awardKillVP(u, ownerFaction);
            }
        });

        hex.loiteringCountdown = 0;
        hex.loiteringOwner = null;
        this._checkVictory();
    }

    _awardKillVP(killedUnit, killerFaction) {
        const s = this.state;
        const vp = DESTROY_VP[CARD_CATALOG[killedUnit.cardId]?.tier] || 0;
        if (vp <= 0) return;
        if (killerFaction === 'player') s.playerVP += vp; else s.aiVP += vp;
        this._log(`+${vp} VP for destroying ${killedUnit.displayName}`);
    }

    _log(msg) {
        if (this.state) this.state.log.push(msg);
        if (this.onLog) this.onLog(msg);
    }

    // Record where units died (any damage path) so the map can mark the spot
    _recordNewDeaths() {
        const s = this.state;
        if (!s) return;
        s.units.forEach(u => {
            if (u.hp <= 0 && !u._deathRecorded) {
                u._deathRecorded = true;
                s.fallenUnits.push({ hexId: u.hexId, name: u.displayName, faction: u.faction, turn: s.turn });
                this._log(`☠ ${u.faction === 'player' ? 'Lost' : 'Enemy lost'}: ${u.displayName}`);
            }
        });
    }

    _notify() {
        this._recordNewDeaths();
        if (this.onStateChange) this.onStateChange(this.state);
    }

    selectUnit(unitId, forceSelect = false) {
        const s = this.state;
        if (!forceSelect && s.selectedUnit === unitId) {
            // Deselect
            s.selectedUnit = null;
            s.moveRange = null;
            s.grindRange = null;
            s.attackRange = null;
            this._notify();
            return;
        }

        const unit = s.units.get(unitId);
        if (!unit || unit.hp <= 0) return;

        s.selectedUnit = unitId;
        const card = CARD_CATALOG[unit.cardId];

        if (unit.faction === 'player' && s.phase === 'player_action') {
            // Highlight only hexes the unit can both reach (MOV) and afford (AP);
            // labels show the AP cost of each reachable hex.
            const movBudget = Math.min(unit.mov + this._carryLift(unit), s.playerAP);
            const reachable = this.board.reachableHexes(unit.hexId, movBudget, card.unitClass, 'player', s, card.abilities);
            s.moveRange = reachable;
            s.grindRange = this.board.escapeHexes(unit.hexId, 'player', s, reachable);

            // Compute attack range (hex ring)
            let rng = unit.rng;
            if (unit.status.has(STATUS.EW_SUPPRESSED)) rng = 0;
            if (s.eventFlags?.drone_rng_minus1 && card.unitClass === UNIT_CLASS.DRONE) rng = Math.max(0, rng - 1);
            const attackHexIds = this.board.hexesInRange(unit.hexId, rng);
            s.attackRange = new Map(attackHexIds.map(id => [id, 1]));
        }

        this._notify();
    }

    getAvailableOrderIds() {
        const s = this.state;
        return Object.values(ORDERS_CATALOG)
            .filter(o => o.factions.includes(s.playerFaction))
            .filter(o => !o.oncePerMatch || !s.orderUsedOncePerMatch.has(o.id))
            .filter(o => !o.cooldown || !s.orderCooldowns[o.id])
            .map(o => o.id);
    }
}

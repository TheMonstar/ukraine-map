'use strict';
// ── game-engine.js — FRONTLINE Game State Machine ────────────────────────

const MAX_TURNS = 20;
const TURN_SECONDS = 20;
const TOTAL_RP = 20;
const MAX_CP = 8;
const AP_PER_TURN = 4;

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
    }

    // ── Initialization ────────────────────────────────────────────────────────

    async startGame(options) {
        const { playerFaction, difficulty, centerLat, centerLng } = options;
        const aiFaction = playerFaction === 'ua' ? 'ru' : 'ua';

        this.ai = new AIOpponent(difficulty);

        // Generate board
        this.board.generate(centerLat, centerLng);
        await this.terrainLoader.classifyAll(this.board);

        // Assign spawn zones based on frontline orientation
        const { playerHexes, aiHexes } = this.board.getSpawnHexIds(playerFaction);

        // Assign forward positions as objectives
        this._flagForwardPositions(playerFaction);

        // Weather & time roll
        const weather = this._rollWeather();
        const timeOfDay = this._rollTimeOfDay();

        // Event deck
        this.eventDeck.build();

        // Build decks
        const playerDeck = [...PRESET_DECKS[playerFaction]];
        const aiDeckIds = this.ai.buildAIDeck(aiFaction);

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
            selectedUnit: null,
            selectedHex: null,
            moveRange: null,
            attackRange: null,
            ewZones: new Map(),
            intelZones: new Map(),
            mudTurns: 0,
            eventFlags: {},
            playerCommanderUsed: false,
            aiCommanderUsed: false,
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

        // Do NOT notify here — ui.js calls initLeafletMap() after startGame() returns,
        // then triggers _renderAll() manually. Notifying here would call render() before
        // the Leaflet map instance exists, causing addLayer errors.
        return this.state;
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

    _flagForwardPositions(playerFaction) {
        const hexList = [...this.board.hexes.values()];
        const lats = hexList.map(h => h.centroid[1]);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const latRange = maxLat - minLat;

        hexList.forEach(h => {
            const normLat = (h.centroid[1] - minLat) / latRange;
            // "Forward position" = enemy rear rows
            if (playerFaction === 'ua') {
                if (normLat >= 0.78 && !h.isObjective) {
                    h.isObjective = true;
                    h.objectiveType = 'forward_position';
                }
            } else {
                if (normLat <= 0.22 && !h.isObjective) {
                    h.isObjective = true;
                    h.objectiveType = 'forward_position';
                }
            }
        });
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
        // Convert remaining AI RP to CP (2:1)
        s.aiCP = Math.min(MAX_CP, Math.floor((TOTAL_RP - aiRP) / 2));
    }

    finishDeployment() {
        const s = this.state;
        if (s.phase !== 'deploy') return;
        // Convert remaining RP → CP
        s.playerCP = Math.min(MAX_CP, Math.floor(s.playerRP / 2));
        s.playerRP = 0;
        s.phase = 'player_action';
        s.playerAP = AP_PER_TURN;
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

        // Reset IGLA intercept flags
        s.units.forEach(u => { u.iglaInterceptUsed = false; });

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
        console.log('[MOVE]', unitId, '→', targetHexId, 'phase:', s.phase, 'AP:', s.playerAP);
        if (s.phase !== 'player_action') return { ok: false, error: 'Not player action phase' };

        const unit = s.units.get(unitId);
        if (!unit || unit.faction !== 'player' || unit.hp <= 0) return { ok: false, error: 'Invalid unit' };

        const card = CARD_CATALOG[unit.cardId];
        const apCost = TIER_AP[card.tier];
        if (s.playerAP < apCost) return { ok: false, error: 'Not enough AP' };

        const movBudget = unit.mov + (s.eventFlags?.move_cost_plus1 ? -1 : 0);
        const reachable = this.board.reachableHexes(unit.hexId, movBudget, card.unitClass, 'player', s);
        console.log('[MOVE] unit at', unit.hexId, 'MOV', movBudget, 'reachable:', [...reachable.keys()], 'target in range:', reachable.has(targetHexId));

        if (!reachable.has(targetHexId)) return { ok: false, error: 'Target out of movement range' };

        // Mine entry
        const targetHex = this.board.hexes.get(targetHexId);
        if (targetHex?.overlays.has('mined') && !card.abilities?.includes('mine_immune_first')) {
            const dmg = (card.unitClass === UNIT_CLASS.TRACKED || card.unitClass === UNIT_CLASS.WHEELED) ? 5 : 3;
            unit.hp = Math.max(0, unit.hp - dmg);
            unit.status.add(STATUS.SUPPRESSED);
            this._log(`Mine triggered: ${card.name} takes ${dmg} damage`);
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
        s.attackRange = null;

        this._checkOverwatchTriggers(unit, targetHexId);
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
            const size = uCard?.size ?? 2;
            const stealthy = uCard?.abilities?.includes('stealth_stationary') && !unit.movedThisTurn;

            let detectRange;
            if (stealthy)        detectRange = 0;
            else if (size >= 3)  detectRange = droneRng;
            else if (size === 2) detectRange = Math.max(0, droneRng - 1);
            else                 detectRange = Math.max(0, droneRng - 2);

            if (dist <= detectRange) {
                unit.status.add(STATUS.RECON_SPOTTED);
                unit.reconSpottedTurns = 2;
                spotted++;
                spottedNames.push(uCard?.name || unit.displayName);
            }
        });

        s.playerAP -= apCost;
        drone.activationsThisTurn++;
        drone.movedThisTurn = true;
        s.selectedUnit = null;
        s.moveRange = null;
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

        // Find target on hex
        const targets = this.combat.unitsOnHex(defenderHexId, s).filter(u => u.faction === 'ai');
        if (targets.length === 0) return { ok: false, error: 'No enemy on target hex' };
        const defender = targets[0];

        // Range check
        const dist = this.board.hexDistance(attacker.hexId, defenderHexId);
        let effectiveRng = attacker.rng;
        if (attacker.status.has(STATUS.EW_SUPPRESSED)) effectiveRng = 0;
        if (s.eventFlags?.drone_rng_minus1 && card.unitClass === UNIT_CLASS.DRONE) effectiveRng = Math.max(0, effectiveRng - 1);
        if (dist > effectiveRng) return { ok: false, error: 'Target out of range' };
        if (dist === 0 && effectiveRng > 0) return { ok: false, error: 'Cannot attack own hex (use range > 0)' };
        if (card.abilities?.includes('setup_req') && attacker.movedThisTurn) return { ok: false, error: 'Mortar must not move before firing' };

        // Settle attack restriction
        const defHex = this.board.hexes.get(defenderHexId);
        if (s.eventFlags?.no_settle_attack && defHex?.terrainType?.startsWith('settlement')) {
            return { ok: false, error: 'Civilian corridor: no settlement attacks' };
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

        result.log.forEach(l => this._log(l));

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

            // Tempo Attack (spend 2 extra AP for 1 bonus attack)
            // Handled at UI level: user can optionally choose to use tempo after kill

            this._checkVictory();
        }

        // Wave spawn (Wave Assault Regt)
        this._checkWaveSpawn(attacker);

        s.selectedUnit = null;
        s.moveRange = null;
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

    usePlayerCommander() {
        const s = this.state;
        if (s.playerCommanderUsed) return { ok: false, error: 'Commander already used' };

        const commanderCardId = `${s.playerFaction}_commander`;
        const card = CARD_CATALOG[commanderCardId];
        if (!card) return { ok: false };

        // UA: precision strike on any spotted unit
        if (s.playerFaction === 'ua') {
            // Return {ok: true, needTarget: true} — UI will prompt for target
            return { ok: true, needTarget: true, ability: 'precision_strike_cmd' };
        }
        // RU: place tokens
        if (s.playerFaction === 'ru') {
            for (let i = 0; i < 3; i++) {
                const hexPool = s.spawnHexIds.playerHexes;
                if (!hexPool.length) break;
                const hexId = hexPool[Math.floor(Math.random() * hexPool.length)];
                const tokenId = `player_wave_${Date.now()}_${i}`;
                s.units.set(tokenId, this._createUnit('ru_assault', 'player', hexId, { hp: 1, atk: 1 }));
            }
            s.playerCommanderUsed = true;
            this._log('Commander used: Mass Mobilization — 3 Assault Groups deployed');
            this._notify();
            return { ok: true };
        }
        return { ok: false };
    }

    executePrecisionStrike(targetUnitId) {
        const s = this.state;
        const target = s.units.get(targetUnitId);
        if (!target || target.hp <= 0) return { ok: false };

        // Must be spotted
        if (!target.status.has(STATUS.RECON_SPOTTED) && !s.intelZones.has(target.hexId)) {
            return { ok: false, error: 'Target not spotted — requires active drone ISR' };
        }

        target.hp = Math.max(0, target.hp - 3);
        s.playerCommanderUsed = true;
        this._log(`Commander: Precision Strike — ${CARD_CATALOG[target.cardId]?.name} takes 3 dmg`);

        if (target.hp <= 0) {
            s.playerVP += DESTROY_VP[CARD_CATALOG[target.cardId]?.tier] || 0;
            s.initiative = Math.min(10, s.initiative + 1);
        }

        this._notify();
        return { ok: true };
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
                if (targetHex.overlays.has('mined')) {
                    const dmg = (card.unitClass === UNIT_CLASS.TRACKED) ? 5 : 3;
                    unit.hp = Math.max(0, unit.hp - dmg);
                    if (unit.hp <= 0) return true;
                }
                unit.hexId = action.targetHex;
                unit.status.delete(STATUS.FORTIFIED);
                unit.status.delete(STATUS.OVERWATCH);
                this._checkOverwatchTriggers(unit, action.targetHex);
                return true;
            }
            case 'attack': {
                const target = s.units.get(action.targetUnit);
                if (!target || target.faction !== 'player' || target.hp <= 0) return false;

                const dist = this.board.hexDistance(unit.hexId, target.hexId);
                if (dist > unit.rng || unit.status.has(STATUS.EW_SUPPRESSED)) return false;
                if (s.eventFlags?.no_offensive) return false;

                const result = this.combat.resolveAttack(unit, target, s);

                if (target.hp <= 0) {
                    s.aiVP += DESTROY_VP[CARD_CATALOG[target.cardId]?.tier] || 0;
                    s.initiative = Math.max(0, s.initiative - 1);
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
                unit.hp = 0;
                return true;
            }
            default: return false;
        }
    }

    useAICommander() {
        const s = this.state;
        const aiFaction = s.aiFaction;
        if (aiFaction === 'ru') {
            for (let i = 0; i < 3; i++) {
                const hexPool = s.spawnHexIds.aiHexes;
                if (!hexPool.length) break;
                const hexId = hexPool[Math.floor(Math.random() * hexPool.length)];
                const tokenId = `ai_cmd_${Date.now()}_${i}`;
                s.units.set(tokenId, this._createUnit('ru_assault', 'ai', hexId, { hp: 1, atk: 1 }));
            }
        } else {
            // UA AI precision strike: pick highest threat player unit in intel zone
            let target = null;
            s.units.forEach(u => {
                if (u.faction === 'player' && u.hp > 0 && s.intelZones.has(u.hexId)) {
                    if (!target || u.atk > target.atk) target = u;
                }
            });
            if (target) {
                target.hp = Math.max(0, target.hp - 3);
                if (target.hp <= 0) {
                    s.aiVP += DESTROY_VP[CARD_CATALOG[target.cardId]?.tier] || 0;
                }
            }
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
                        }
                    });
                });
                this.board.showAreaEffect(toHit, 1800);
                this._log(`Artillery Barrage on ${target.hexId}: ${baseAtk} ATK${isSpotted ? ' (spotted, DEF ignored)' : ''}`);
                return { ok: true };
            }

            case 'recon_sweep': {
                s.units.forEach(u => {
                    if (u.faction === enemyFaction && u.hp > 0) {
                        u.status.add(STATUS.RECON_SPOTTED);
                        u.reconSpottedTurns = 2;
                    }
                });
                this._log('Recon Sweep: all enemies Recon-spotted for 2 turns');
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

        // Run AI turn after brief delay (so UI can update)
        setTimeout(() => {
            this.ai.takeTurn(s, this);
            this._endOfTurnProcessing('ai');
            this._advanceTurn();
        }, 400);
    }

    _endOfTurnProcessing(faction) {
        const s = this.state;

        // Tick statuses
        s.units.forEach(unit => {
            if (unit.faction === faction || true) { // tick all
                this.combat.tickStatuses(unit, s);
            }
        });

        // VP scoring
        this._scoreVP();

        // Initiative update: units lost this turn tracked via kills property diff
        // (already updated per-kill)

        // Clear activation counts
        s.units.forEach(u => {
            u.activationsThisTurn = 0;
            u.movedThisTurn = false;
            u._humanWaveBonus = false;
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
    }

    // ── VP Scoring ────────────────────────────────────────────────────────────

    _scoreVP() {
        const s = this.state;

        // Determine objective control
        this.board.hexes.forEach((hex, hexId) => {
            if (!hex.isObjective) return;

            const playerUnits = [...s.units.values()].filter(u => u.faction === 'player' && u.hexId === hexId && u.hp > 0);
            const aiUnits = [...s.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);

            if (playerUnits.length > 0 && aiUnits.length === 0) {
                hex.controlledBy = 'player';
            } else if (aiUnits.length > 0 && playerUnits.length === 0) {
                hex.controlledBy = 'ai';
            }
            // Contested: no change

            const vpPerTurn = OBJ_VP[hex.objectiveType] || 1;
            if (hex.controlledBy === 'player') s.playerVP += vpPerTurn;
            if (hex.controlledBy === 'ai') s.aiVP += vpPerTurn;
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

    _endGame(winner, reason) {
        const s = this.state;
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
            movedThisTurn: false
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

        s.units.forEach(u => {
            if (u.faction === enemyFaction && u.hexId === hexId && u.hp > 0) {
                u.hp = Math.max(0, u.hp - atk);
                this._log(`Loitering strike on ${hexId}: ${u.displayName} takes ${atk} dmg`);
            }
        });

        hex.loiteringCountdown = 0;
        hex.loiteringOwner = null;
    }

    _log(msg) {
        if (this.state) this.state.log.push(msg);
        if (this.onLog) this.onLog(msg);
    }

    _notify() {
        if (this.onStateChange) this.onStateChange(this.state);
    }

    selectUnit(unitId, forceSelect = false) {
        const s = this.state;
        if (!forceSelect && s.selectedUnit === unitId) {
            // Deselect
            s.selectedUnit = null;
            s.moveRange = null;
            s.attackRange = null;
            this._notify();
            return;
        }

        const unit = s.units.get(unitId);
        if (!unit || unit.hp <= 0) return;

        s.selectedUnit = unitId;
        const card = CARD_CATALOG[unit.cardId];

        if (unit.faction === 'player' && s.phase === 'player_action') {
            // Compute movement range
            const movBudget = unit.mov;
            const reachable = this.board.reachableHexes(unit.hexId, movBudget, card.unitClass, 'player', s);
            s.moveRange = reachable;

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

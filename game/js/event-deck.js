'use strict';
// ── event-deck.js — Narrative Event Deck ─────────────────────────────────

class EventDeck {
    constructor() {
        this.deck = [];      // shuffled subset (10 of 20)
        this.pointer = 0;    // next card index
        this.activeFlags = {}; // per-turn flags applied by events
    }

    build() {
        const shuffled = [...EVENT_CARDS].sort(() => Math.random() - 0.5);
        this.deck = shuffled.slice(0, 10);
        this.pointer = 0;
    }

    // Return and advance (called once per game turn, at turn start or end)
    flipCard() {
        if (this.pointer >= this.deck.length) return null;
        return this.deck[this.pointer++];
    }

    peek() {
        return this.deck[this.pointer] || null;
    }

    // Apply event effect to gameState. Returns { log } describing what happened.
    applyEffect(card, gameState) {
        this.activeFlags = {};
        const log = [`EVENT: ${card.name}`];

        switch (card.effect) {
            case 'active_cp_2':
                if (gameState.activePhase === 'player') gameState.playerCP += 2;
                else gameState.aiCP += 2;
                log.push('+2 CP to active player');
                break;

            case 'drone_rng_minus1':
                this.activeFlags.drone_rng_minus1 = true;
                gameState.eventFlags = { ...gameState.eventFlags, drone_rng_minus1: true };
                log.push('All drones −1 RNG this turn');
                break;

            case 'move_cost_plus1':
                gameState.eventFlags = { ...gameState.eventFlags, move_cost_plus1: true };
                log.push('All movement +1 AP cost');
                break;

            case 'place_common_free': {
                // Give active player a free common unit deployment token
                if (gameState.activePhase === 'player') {
                    gameState.freeCommonDeploy = (gameState.freeCommonDeploy || 0) + 1;
                } else {
                    // AI instantly uses it
                    this._aiPlaceFreeCommon(gameState);
                }
                log.push('Free Common unit deployment granted');
                break;
            }

            case 'interdict_road': {
                const roadHexes = [];
                gameState.board.hexes.forEach((hex, hid) => {
                    if (hex.hasRoad) roadHexes.push(hid);
                });
                if (roadHexes.length > 0) {
                    const target = roadHexes[Math.floor(Math.random() * roadHexes.length)];
                    gameState.board.hexes.get(target).interdictedTurns = 3;
                    log.push(`Road hex ${target} interdicted for 3 turns`);
                }
                break;
            }

            case 'reveal_all_brief':
                gameState.eventFlags = { ...gameState.eventFlags, reveal_all: true };
                setTimeout(() => { if (gameState.eventFlags) delete gameState.eventFlags.reveal_all; }, 5000);
                log.push('All units revealed for 5s');
                break;

            case 'mud_2turns':
                gameState.mudTurns = (gameState.mudTurns || 0) + 2;
                log.push('Mud: non-road movement +1 AP for 2 turns');
                break;

            case 'reset_commanders':
                gameState.playerCommanderUsed = false;
                gameState.aiCommanderUsed = false;
                log.push('Both Commander cards re-enabled');
                break;

            case 'ua_free_order':
                if (gameState.playerFaction === 'ua') {
                    gameState.freeOrderUse = (gameState.freeOrderUse || 0) + 1;
                    log.push('UA gets 1 free Order use this turn');
                } else {
                    log.push('Western Resupply: no effect on RU turn');
                }
                break;

            case 'ru_free_token':
                if (gameState.playerFaction === 'ru') {
                    gameState.freeCommonDeploy = (gameState.freeCommonDeploy || 0) + 1;
                } else {
                    this._aiPlaceFreeCommon(gameState);
                }
                log.push('RU Mobilization surge: free Assault Group token');
                break;

            case 'reveal_orders_brief':
                gameState.eventFlags = { ...gameState.eventFlags, reveal_orders: true };
                setTimeout(() => { if (gameState.eventFlags) delete gameState.eventFlags.reveal_orders; }, 5000);
                log.push('Orders hand revealed for 5s');
                break;

            case 'ew_suspend':
                gameState.eventFlags = { ...gameState.eventFlags, ew_suspended: true };
                log.push('EW effects suspended this turn');
                break;

            case 'mutual_arty_fire': {
                // Each side's highest-ATK arty fires at the nearest enemy arty
                this._mutualArtyFire(gameState);
                log.push('Artillery duel resolved');
                break;
            }

            case 'no_settle_attack':
                gameState.eventFlags = { ...gameState.eventFlags, no_settle_attack: true };
                log.push('Settlements cannot be attacked this turn');
                break;

            case 'random_1dmg': {
                const pUnits = [...gameState.units.values()].filter(u => u.faction === 'player' && u.hp > 0);
                const aUnits = [...gameState.units.values()].filter(u => u.faction === 'ai' && u.hp > 0);
                if (pUnits.length > 0) { const u = pUnits[Math.floor(Math.random() * pUnits.length)]; u.hp = Math.max(0, u.hp - 1); log.push(`Friendly fire: ${u.displayName} takes 1 dmg`); }
                if (aUnits.length > 0) { const u = aUnits[Math.floor(Math.random() * aUnits.length)]; u.hp = Math.max(0, u.hp - 1); }
                break;
            }

            case 'destroy_depot': {
                ['player', 'ai'].forEach(faction => {
                    const depots = [...gameState.units.values()].filter(u => u.faction === faction && u.inDepot && u.hp > 0);
                    if (depots.length > 0) {
                        const d = depots[Math.floor(Math.random() * depots.length)];
                        d.hp = 0;
                        log.push(`Logistics strike: ${d.displayName} destroyed`);
                    }
                });
                break;
            }

            case 'ua_airborne_free':
                if (gameState.playerFaction === 'ua') {
                    gameState.freeAirAssaultDeploy = true;
                }
                log.push('UA Night Drop: free Air Assault placement');
                break;

            case 'no_offensive':
                gameState.eventFlags = { ...gameState.eventFlags, no_offensive: true };
                log.push('Ceasefire: no offensive actions this turn');
                break;

            case 'arty_miss_30':
                gameState.eventFlags = { ...gameState.eventFlags, arty_miss_30: true };
                log.push('All artillery +30% miss chance');
                break;

            case 'contested_reset': {
                // Find contested objectives (VP tick differs < 2 turns)
                const objs = [];
                gameState.board.hexes.forEach((hex, hid) => {
                    if (hex.isObjective && hex.controlledBy) objs.push(hid);
                });
                if (objs.length > 0) {
                    const target = objs[Math.floor(Math.random() * objs.length)];
                    gameState.board.hexes.get(target).controlledBy = null;
                    log.push(`Frontline collapse: objective ${target} reverted to neutral`);
                }
                break;
            }

            default:
                log.push(`Effect ${card.effect} — no handler`);
        }

        return { log };
    }

    // Clear per-turn event flags at end of turn
    clearTurnFlags(gameState) {
        if (!gameState.eventFlags) return;
        const keepBetweenTurns = ['mud_2turns']; // handled separately by counter
        delete gameState.eventFlags.drone_rng_minus1;
        delete gameState.eventFlags.move_cost_plus1;
        delete gameState.eventFlags.ew_suspended;
        delete gameState.eventFlags.no_settle_attack;
        delete gameState.eventFlags.no_offensive;
        delete gameState.eventFlags.arty_miss_30;
        delete gameState.eventFlags.reveal_all;
        delete gameState.eventFlags.reveal_orders;
    }

    _aiPlaceFreeCommon(gameState) {
        const aiSpawnHexes = gameState.spawnHexIds.aiHexes;
        if (!aiSpawnHexes.length) return;
        const hexId = aiSpawnHexes[Math.floor(Math.random() * aiSpawnHexes.length)];
        const tokenId = `ai_wave_${Date.now()}`;
        gameState.units.set(tokenId, {
            id: tokenId, faction: 'ai',
            cardId: 'ru_assault',
            hexId, hp: 2, maxHp: 2, atk: 1, def: 0, mov: 2, rng: 1,
            displayName: 'Assault Group',
            status: new Set(), experience: 0, statBonus: { atk: 0, def: 0 },
            engagements: 0, kills: 0, activationsThisTurn: 0,
            reconSpottedTurns: 0, ambushReady: false, inDepot: false,
            iglaInterceptUsed: false
        });
    }

    _mutualArtyFire(gameState) {
        const sides = ['player', 'ai'];
        sides.forEach(faction => {
            const artys = [...gameState.units.values()].filter(u =>
                u.faction === faction && u.hp > 0 &&
                CARD_CATALOG[u.cardId]?.abilities?.includes('indirect_fire')
            ).sort((a, b) => b.atk - a.atk);

            if (!artys.length) return;
            const attacker = artys[0];
            const enemyFaction = faction === 'player' ? 'ai' : 'player';
            const targets = [...gameState.units.values()].filter(u =>
                u.faction === enemyFaction && u.hp > 0 &&
                CARD_CATALOG[u.cardId]?.abilities?.includes('indirect_fire')
            );
            if (!targets.length) return;
            const target = targets[0];
            const dmg = Math.max(1, attacker.atk - target.def);
            target.hp = Math.max(0, target.hp - dmg);
        });
    }
}

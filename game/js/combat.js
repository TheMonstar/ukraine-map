'use strict';
// ── combat.js — Attack Resolution, Status Effects, Veteran XP ────────────

class CombatResolver {

    constructor(board) {
        this.board = board;
    }

    // ── Main Attack ──────────────────────────────────────────────────────────

    // Returns { damage, statusApplied[], log } and mutates units + hexes
    resolveAttack(attacker, defender, gameState) {
        const attackerCard = CARD_CATALOG[attacker.cardId];
        const defenderCard = CARD_CATALOG[defender.cardId];
        const attackerHex = this.board.hexes.get(attacker.hexId);
        const defenderHex = this.board.hexes.get(defender.hexId);
        const log = [];

        let atk = attacker.atk + (attacker.statBonus?.atk || 0);
        let def = defender.def + (defender.statBonus?.def || 0);

        // ── ATK modifiers ──────────────────────────────────────────────────

        // Suppressed attacker
        if (attacker.status.has(STATUS.SUPPRESSED)) {
            atk = Math.max(0, atk - 2);
            log.push('Attacker suppressed −2 ATK');
        }

        // Flanking status on target
        if (defender.status.has(STATUS.FLANKING)) {
            atk += 1;
            log.push('+1 ATK (flanking)');
        }

        // Ambush: ignore DEF entirely
        const hasAmbush = attacker.status.has(STATUS.AMBUSH) || attacker.ambushReady;
        if (hasAmbush) {
            def = 0;
            attacker.ambushReady = false;
            attacker.status.delete(STATUS.AMBUSH);
            log.push('Ambush: DEF ignored');
        }

        // Anti-armor vs tracked
        if (attackerCard?.abilities?.includes('anti_armor') &&
            (defenderCard?.unitClass === UNIT_CLASS.TRACKED || defenderCard?.unitClass === UNIT_CLASS.VEHICLE)) {
            atk += 3;
            log.push('+3 ATK anti-armor');
        }

        // Sniper ignores light forest cover
        if (attackerCard?.abilities?.includes('ignore_light_cover') && defenderHex?.terrainType === 'forest_light') {
            def = Math.max(0, def - 1);
            log.push('Sniper: light cover ignored');
        }

        // Precision fire: ignore terrain DEF if spotted
        if (attackerCard?.abilities?.includes('precision_fire') && defender.status.has(STATUS.RECON_SPOTTED)) {
            const terrainDef = TERRAIN_RULES[defenderHex?.terrainType]?.defMod || 0;
            def = Math.max(0, def - terrainDef);
            log.push('Precision fire: terrain DEF ignored');
        }

        // Pack bonus (RU assault group): +1 ATK if 3+ adjacent friendly inf
        if (attackerCard?.abilities?.includes('pack_bonus')) {
            const adjFriendly = this._countAdjacentFriendlyInf(attacker, gameState);
            if (adjFriendly >= 3) { atk += 1; log.push('+1 ATK pack bonus'); }
        }

        // Night modifier
        const timeBonus = gameState.timeOfDay === 'night' ? -1 : 0;
        if (timeBonus !== 0 && attacker.faction !== 'player') {
            atk += timeBonus;
            log.push(`${timeBonus} ATK night`);
        }

        // Adjacency: Infantry + Armor → armor +1 ATK
        if (attackerCard?.unitClass === UNIT_CLASS.TRACKED) {
            if (this._hasAdjacentClass(attacker, UNIT_CLASS.INFANTRY, attacker.faction, gameState)) {
                atk += 1;
                log.push('+1 ATK infantry+armor adjacency');
            }
        }

        // NATO ammo vs tracked targets
        if (attackerCard?.abilities?.includes('nato_ammo') &&
            defenderCard?.unitClass === UNIT_CLASS.TRACKED) {
            atk += 1;
            log.push('+1 ATK NATO ammo');
        }

        // Artillery miss chance
        if (attackerCard?.unitClass === UNIT_CLASS.VEHICLE &&
            attackerCard?.abilities?.includes('indirect_fire')) {

            let missChance = 0;
            if (attacker.hexId && gameState.ewZones?.has(attacker.hexId)) {
                const ewFactions = gameState.ewZones.get(attacker.hexId);
                const enemyFaction = attacker.faction === 'player' ? 'ai' : 'player';
                if (ewFactions.has(enemyFaction)) missChance += 0.30;
            }
            if (gameState.eventFlags?.arty_miss_30) missChance += 0.30;
            if (gameState.weather === 'rain') missChance += 0.20;
            if (gameState.timeOfDay === 'night') missChance += 0.30;

            if (Math.random() < missChance) {
                log.push(`Artillery MISSED (${Math.round(missChance * 100)}% miss chance)`);
                return { damage: 0, statusApplied: [], log, missed: true };
            }
        }

        // ── DEF modifiers ──────────────────────────────────────────────────

        // Terrain defence
        const terrainDef = TERRAIN_RULES[defenderHex?.terrainType]?.defMod || 0;
        def += terrainDef;

        // Fortified
        const fortBonus = defenderCard?.faction === 'ua' ? 2 : 1;
        if (defender.status.has(STATUS.FORTIFIED)) {
            def += fortBonus;
            log.push(`+${fortBonus} DEF fortified`);
        }

        // Infantry + Armor: inf gets +1 DEF
        if (defenderCard?.unitClass === UNIT_CLASS.INFANTRY) {
            if (this._hasAdjacentClass(defender, UNIT_CLASS.TRACKED, defender.faction, gameState)) {
                def += 1;
                log.push('+1 DEF infantry+armor adjacency');
            }
        }

        // Hull-down on ridgeline (UA tank)
        if (defenderCard?.abilities?.includes('hull_down') && defenderHex?.terrainType === 'ridgeline') {
            def += 2;
            log.push('+2 DEF hull-down');
        }

        // TeroDef home ground on settlement
        if (defenderCard?.abilities?.includes('home_ground') &&
            defenderHex?.terrainType?.startsWith('settlement')) {
            def += 1;
            log.push('+1 DEF home ground');
        }

        // Mech Brigade aura: adjacent UA units +1 DEF
        if (defender.faction === 'player') {
            if (this._hasMechBrigadeAdjacent(defender, gameState)) {
                def += 1;
                log.push('+1 DEF mech brigade aura');
            }
        }

        // Reactive armor (T-90): first incoming ATK halved
        if (defenderCard?.abilities?.includes('reactive_armor') && !defender.status.has(STATUS.REACTIVE_ARMOR_USED)) {
            atk = Math.ceil(atk / 2);
            defender.status.add(STATUS.REACTIVE_ARMOR_USED);
            log.push('Reactive armor: ATK halved');
        }

        // ── Final damage ───────────────────────────────────────────────────

        const damage = Math.max(0, atk - def);
        log.push(`Damage: ${atk}−${def} = ${damage}${damage === 0 ? ' (blocked)' : ''}`);

        // Apply damage
        defender.hp = Math.max(0, defender.hp - damage);
        const statusApplied = [];

        // Sniper suppresses on hit
        if (attackerCard?.abilities?.includes('suppress_on_hit') && damage > 0) {
            this._applySuppress(defender);
            statusApplied.push('suppressed');
            log.push('Suppressed on hit (sniper)');
        }

        // Mine entry damage
        if (defenderHex?.overlays.has('mined') && !defender._mineDamageApplied) {
            const mineDmg = (defenderCard?.unitClass === UNIT_CLASS.TRACKED || defenderCard?.unitClass === UNIT_CLASS.WHEELED) ? 5 : 3;
            defender.hp = Math.max(0, defender.hp - mineDmg);
            this._applySuppress(defender);
            statusApplied.push('mine_suppressed');
            log.push(`Mine: −${mineDmg} HP + Suppressed`);
        }

        // Overwatch trigger on defender: defender fires back if has OVERWATCH
        let overwatchReturn = null;
        if (defender.hp > 0 && defender.status.has(STATUS.OVERWATCH)) {
            // Check if attacker in range
            const dist = this.board.hexDistance(attacker.hexId, defender.hexId);
            if (dist <= defender.rng) {
                defender.status.delete(STATUS.OVERWATCH);
                const owAtk = Math.max(0, defender.atk - 1);
                const owDef = attacker.def + (TERRAIN_RULES[attackerHex?.terrainType]?.defMod || 0);
                const owDmg = Math.max(0, owAtk - owDef);
                attacker.hp = Math.max(0, attacker.hp - owDmg);
                overwatchReturn = owDmg;
                log.push(`Overwatch return fire: ${owDmg} dmg`);
            }
        }

        // Breakthrough: T-72/T-90 ignores Overwatch (already handled — skip)

        // Veteran XP tracking
        if (damage > 0) {
            attacker.engagements = (attacker.engagements || 0) + 1;
            defender.engagements = (defender.engagements || 0) + 1;
        }

        // One-shot: FPV destroyed after attacking
        if (attackerCard?.abilities?.includes('one_shot') && damage > 0) {
            attacker.hp = 0;
            log.push('FPV: one-shot (self-destructs)');
        }

        return { damage, statusApplied, log, overwatchReturn };
    }

    // ── Veteran Promotion ────────────────────────────────────────────────────

    checkVeteranPromotion(unit, killedUnit) {
        if (!killedUnit || killedUnit.hp > 0) return null;
        if (unit.hp <= 0) return null;

        if ((unit.experience || 0) === 0) {
            // First kill → Blooded
            unit.experience = 1;
            unit.kills = (unit.kills || 0) + 1;
            return { type: 'blooded', unit };
        }
        unit.kills = (unit.kills || 0) + 1;
        return null;
    }

    promoteFromEngagements(unit) {
        if ((unit.experience || 0) === 1 && (unit.engagements || 0) >= 4) {
            unit.experience = 3; // Veteran
            return { type: 'veteran', unit };
        }
        return null;
    }

    applyVeteranBonus(unit, statChoice) {
        if (!unit.statBonus) unit.statBonus = { atk: 0, def: 0 };
        if (statChoice === 'atk') { unit.statBonus.atk += 1; unit.atk += 1; }
        if (statChoice === 'def') { unit.statBonus.def += 1; unit.def += 1; }
    }

    applyVeteranName(unit, realName) {
        if (realName && unit.experience >= 3) {
            unit.realName = realName;
        }
    }

    // ── Status Helpers ───────────────────────────────────────────────────────

    _applySuppress(unit) {
        if (unit.status.has(STATUS.SUPPRESSED)) {
            unit.status.add(STATUS.PINNED);
        } else {
            unit.status.add(STATUS.SUPPRESSED);
        }
        unit.status.delete(STATUS.FORTIFIED);
        unit.status.delete(STATUS.OVERWATCH);
    }

    // Called at end of each turn to tick statuses
    tickStatuses(unit, gameState) {
        // Suppressed clears after 1 turn
        if (unit.status.has(STATUS.SUPPRESSED)) {
            unit.status.delete(STATUS.SUPPRESSED);
        }
        // Pinned → Suppressed (one step recovery)
        if (unit.status.has(STATUS.PINNED)) {
            unit.status.delete(STATUS.PINNED);
            unit.status.add(STATUS.SUPPRESSED);
        }
        // Recon-spotted ticks
        if (unit.reconSpottedTurns > 0) {
            unit.reconSpottedTurns--;
            if (unit.reconSpottedTurns === 0) unit.status.delete(STATUS.RECON_SPOTTED);
        }
        // Encircled damage
        if (unit.status.has(STATUS.ENCIRCLED)) {
            unit.hp = Math.max(0, unit.hp - 1);
        }
        // Supply damage
        if (unit.status.has(STATUS.UNSUPPLIED)) {
            unit.hp = Math.max(0, unit.hp - 1);
        }
        // Veteran immune to first SUPPRESSED per turn
        if (unit.experience >= 3 && unit.suppressedCount > 0) {
            unit.suppressedCount = 0;
        }
    }

    // ── Area Attack (MLRS BM-21, ZU-23, Artillery Barrage) ──────────────────

    resolveAreaAttack(attacker, targetHexId, gameState) {
        const card = CARD_CATALOG[attacker.cardId];
        const results = [];
        const hexesToHit = [targetHexId, ...this.board.neighbours(targetHexId)];

        hexesToHit.forEach(hid => {
            gameState.units.forEach(unit => {
                if (unit.hexId === hid && unit.faction !== attacker.faction && unit.hp > 0) {
                    const dmg = Math.max(0, (card.abilities?.includes('area_attack') ? 3 : 4) - unit.def);
                    unit.hp = Math.max(0, unit.hp - dmg);
                    results.push({ unitId: unit.id, damage: dmg });
                }
            });
        });

        // Visual highlight of affected area
        this.board.showAreaEffect(hexesToHit, 1800);

        return results;
    }

    // ── IGLA Intercept ───────────────────────────────────────────────────────

    tryIGLAIntercept(fpvUnit, targetHexId, gameState) {
        // Find enemy IGLA within range of target hex
        const enemyFaction = fpvUnit.faction === 'player' ? 'ai' : 'player';
        for (const unit of gameState.units.values()) {
            if (unit.faction !== enemyFaction || unit.hp <= 0) continue;
            const card = CARD_CATALOG[unit.cardId];
            if (!card?.abilities?.includes('fpv_intercept')) continue;
            if (unit.iglaInterceptUsed) continue;
            const dist = this.board.hexDistance(unit.hexId, targetHexId);
            if (dist <= unit.rng) {
                // Intercept: roll ATK vs FPV (DEF 0)
                const hit = unit.atk > 0 ? Math.random() > 0.35 : false;
                unit.iglaInterceptUsed = true;
                if (hit) {
                    fpvUnit.hp = 0;
                    return { intercepted: true, iglaId: unit.id };
                }
                return { intercepted: false, iglaId: unit.id };
            }
        }
        return { intercepted: false };
    }

    // ── Helper Queries ───────────────────────────────────────────────────────

    _countAdjacentFriendlyInf(unit, gameState) {
        let count = 0;
        const neighbours = this.board.neighbours(unit.hexId);
        gameState.units.forEach(u => {
            if (u.faction === unit.faction && u.hp > 0 && neighbours.includes(u.hexId)) {
                if (CARD_CATALOG[u.cardId]?.unitClass === UNIT_CLASS.INFANTRY) count++;
            }
        });
        return count;
    }

    _hasAdjacentClass(unit, cls, faction, gameState) {
        const neighbours = this.board.neighbours(unit.hexId);
        for (const u of gameState.units.values()) {
            if (u.faction === faction && u.hp > 0 && neighbours.includes(u.hexId)) {
                if (CARD_CATALOG[u.cardId]?.unitClass === cls) return true;
            }
        }
        return false;
    }

    _hasMechBrigadeAdjacent(unit, gameState) {
        const neighbours = this.board.neighbours(unit.hexId);
        for (const u of gameState.units.values()) {
            if (u.faction === unit.faction && u.hp > 0 &&
                u.cardId === 'ua_mech_brigade' &&
                (u.hexId === unit.hexId || neighbours.includes(u.hexId))) return true;
        }
        return false;
    }

    unitsOnHex(hexId, gameState) {
        const result = [];
        gameState.units.forEach(u => { if (u.hexId === hexId && u.hp > 0) result.push(u); });
        return result;
    }

    stackLimitReached(hexId, faction, gameState) {
        const hex = this.board.hexes.get(hexId);
        const limit = (TERRAIN_RULES[hex?.terrainType] || TERRAIN_RULES.open).stackLimit;
        let count = 0;
        gameState.units.forEach(u => { if (u.hexId === hexId && u.faction === faction && u.hp > 0) count++; });
        return count >= limit;
    }
}

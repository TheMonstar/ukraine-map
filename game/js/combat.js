'use strict';
// ── combat.js — Attack Resolution, Status Effects, Veteran XP ────────────

class CombatResolver {

    constructor(board) {
        this.board = board;
    }

    // ── Main Attack ──────────────────────────────────────────────────────────

    // Dice pipeline: roll a d6 per effective ATK point; each die hits on
    // hitTarget+, the defender saves each hit on saveTarget+ (7 = no save).
    // Unsaved hit = 1 HP; a natural 6 that wounds = 2 HP (crit) + Suppressed.
    // Returns { damage, statusApplied[], log, dice } and mutates units + hexes
    resolveAttack(attacker, defender, gameState) {
        const attackerCard = CARD_CATALOG[attacker.cardId];
        const defenderCard = CARD_CATALOG[defender.cardId];
        const attackerHex = this.board.hexes.get(attacker.hexId);
        const defenderHex = this.board.hexes.get(defender.hexId);
        const log = [];

        // Artillery miss chance
        if (attackerCard?.unitClass === UNIT_CLASS.VEHICLE &&
            attackerCard?.abilities?.includes('indirect_fire')) {
            const missChance = this._artilleryMissChance(attacker, gameState);
            if (Math.random() < missChance) {
                log.push(`Artillery MISSED (${Math.round(missChance * 100)}% miss chance)`);
                return { damage: 0, statusApplied: [], log, missed: true };
            }
        }

        const p = this._attackParams(attacker, defender, gameState, { commit: true, log });
        const dice = this._rollDice(p.numDice, p.hitTarget, p.saveTarget);
        const damage = dice.damage;
        log.push(`${attacker.displayName}: ${p.numDice} dice → ${dice.hits} hit${dice.hits === 1 ? '' : 's'} → ${dice.saved} saved → ${damage} dmg${dice.crits ? ` (${dice.crits} crit)` : ''}`);

        defender.hp = Math.max(0, defender.hp - damage);
        const statusApplied = [];

        // Crit suppresses
        if (dice.crits > 0) {
            this._applySuppress(defender);
            statusApplied.push('suppressed');
            log.push('Critical hit: target Suppressed');
        }

        // Suppress on any wound — snipers (suppress_on_hit) and autocannon
        // infantry carriers / motorized (suppressive_fire)
        if ((attackerCard?.abilities?.includes('suppress_on_hit') ||
             attackerCard?.abilities?.includes('suppressive_fire')) && damage > 0 &&
            !statusApplied.includes('suppressed')) {
            this._applySuppress(defender);
            statusApplied.push('suppressed');
            log.push('Suppressed on hit');
        }

        // Area suppression: pin every enemy on the target hex (ZU-23 etc.) on a hit
        if (attackerCard?.abilities?.includes('area_suppression') && dice.hits > 0) {
            this.unitsOnHex(defender.hexId, gameState).forEach(u => {
                if (u.faction !== attacker.faction && u.hp > 0) this._applySuppress(u);
            });
            if (!statusApplied.includes('suppressed')) statusApplied.push('suppressed');
            log.push('Area suppression: hex pinned');
        }

        // Mine entry damage
        if (defenderHex?.overlays.has('mined') && !defender._mineDamageApplied) {
            const mineDmg = (defenderCard?.unitClass === UNIT_CLASS.TRACKED || defenderCard?.unitClass === UNIT_CLASS.WHEELED) ? 5 : 3;
            defender.hp = Math.max(0, defender.hp - mineDmg);
            this._applySuppress(defender);
            statusApplied.push('mine_suppressed');
            log.push(`Mine: −${mineDmg} HP + Suppressed`);
        }

        // Overwatch trigger on defender: same dice pipeline at −1 die
        let overwatchReturn = null;
        if (defender.hp > 0 && defender.status.has(STATUS.OVERWATCH)) {
            const dist = this.board.hexDistance(attacker.hexId, defender.hexId);
            if (dist <= defender.rng) {
                defender.status.delete(STATUS.OVERWATCH);
                const owDice = Math.max(0, defender.atk - 1);
                const owSave = this._saveTarget(attacker, attackerHex, null, gameState);
                const ow = this._rollDice(owDice, 4, owSave);
                attacker.hp = Math.max(0, attacker.hp - ow.damage);
                overwatchReturn = ow.damage;
                log.push(`Overwatch return fire: ${ow.damage} dmg`);
            }
        }

        // Counter-battery: artillery hit by enemy indirect fire returns fire for free
        if (defender.hp > 0 && defenderCard?.abilities?.includes('counter_battery') &&
            attackerCard?.abilities?.includes('indirect_fire')) {
            const cbSave = this._saveTarget(attacker, attackerHex, defenderCard, gameState);
            const cb = this._rollDice(Math.max(0, defender.atk), 4, cbSave);
            attacker.hp = Math.max(0, attacker.hp - cb.damage);
            if (overwatchReturn == null) overwatchReturn = cb.damage;
            log.push(`Counter-battery return fire: ${cb.damage} dmg`);
        }

        // Veteran XP tracking
        if (damage > 0) {
            attacker.engagements = (attacker.engagements || 0) + 1;
            defender.engagements = (defender.engagements || 0) + 1;
        }

        // Balance-sim stats (separate from veteran `kills` counter)
        attacker.damageDealt = (attacker.damageDealt || 0) + damage;
        if (damage > 0 && defender.hp <= 0) {
            attacker.statKills = (attacker.statKills || 0) + 1;
        }

        // One-shot munitions are expended whether or not they connect
        if (attackerCard?.abilities?.includes('one_shot')) {
            attacker.hp = 0;
            log.push('One-shot munition expended');
        }

        return {
            damage, statusApplied, log, overwatchReturn,
            dice: { ...dice, numDice: p.numDice, hitTarget: p.hitTarget, saveTarget: p.saveTarget }
        };
    }

    // Shared attack parameters for resolveAttack (commit: true — consumes
    // ambush, marks reactive armor) and previewAttack (commit: false).
    _attackParams(attacker, defender, gameState, opts = {}) {
        const commit = !!opts.commit;
        const log = opts.log || [];
        const attackerCard = CARD_CATALOG[attacker.cardId];
        const defenderCard = CARD_CATALOG[defender.cardId];
        const defenderHex = this.board.hexes.get(defender.hexId);

        // ── Dice count = effective ATK (bonuses capped at +3, per 1b) ──
        let dice = attacker.atk + (attacker.statBonus?.atk || 0);
        const baseDice = dice;
        if (attackerCard?.abilities?.includes('anti_armor') &&
            (defenderCard?.unitClass === UNIT_CLASS.TRACKED || defenderCard?.unitClass === UNIT_CLASS.VEHICLE)) {
            dice += 2;
            log.push('+2 dice anti-armor');
        }
        if (attackerCard?.abilities?.includes('anti_infantry') &&
            defenderCard?.unitClass === UNIT_CLASS.INFANTRY) {
            dice += 2;
            log.push('+2 dice anti-infantry');
        }
        if (attackerCard?.abilities?.includes('nato_ammo') && defenderCard?.unitClass === UNIT_CLASS.TRACKED) {
            dice += 1;
            log.push('+1 die NATO ammo');
        }
        // Concealed opening shot: a still-hidden stealth unit (sniper) gets +1 die
        if (attackerCard?.abilities?.includes('stealth_stationary') && !attacker.movedThisTurn &&
            !attacker.status.has(STATUS.RECON_SPOTTED)) {
            dice += 1;
            log.push('+1 die concealed shot');
        }
        // Precision optics: +1 die against an ISR-spotted target
        if (attackerCard?.abilities?.includes('precision_optics') && defender.status.has(STATUS.RECON_SPOTTED)) {
            dice += 1;
            log.push('+1 die precision optics');
        }
        // Combined arms: +1 die when supported by an adjacent friendly of a different class
        if (attackerCard?.abilities?.includes('combined_arms') &&
            this._hasAdjacentDifferentClass(attacker, attackerCard.unitClass, gameState)) {
            dice += 1;
            log.push('+1 die combined arms');
        }
        const packThreshold = this._doctrine(attacker, gameState) === 'ru_mass' ? 2 : 3;
        if (attackerCard?.abilities?.includes('pack_bonus') &&
            this._countAdjacentFriendlyInf(attacker, gameState) >= packThreshold) {
            dice += 1;
            log.push('+1 die pack bonus');
        }
        if (attackerCard?.abilities?.includes('wave_bonus')) {
            const waveDice = Math.floor(this._countAdjacentFriendlyInf(attacker, gameState) / 2);
            if (waveDice > 0) { dice += waveDice; log.push(`+${waveDice} dice wave bonus`); }
        }
        if (attackerCard?.unitClass === UNIT_CLASS.INFANTRY &&
            this._hasAdjacentAbility(attacker, 'human_wave_aura', gameState)) {
            dice += 1;
            log.push('+1 die human wave aura');
        }
        if (attacker._humanWaveBonus) {
            dice += 2;
            log.push('+2 dice human wave order');
        }
        if (attackerCard?.unitClass === UNIT_CLASS.TRACKED &&
            this._hasAdjacentClass(attacker, UNIT_CLASS.INFANTRY, attacker.faction, gameState)) {
            dice += 1;
            log.push('+1 die infantry+armor adjacency');
        }
        if (this._hasMechBrigadeAdjacent(attacker, gameState)) {
            dice += 1;
            log.push('+1 die combined arms (Mech Bde)');
        }
        if (attackerCard?.abilities?.includes('indirect_fire') &&
            this._doctrine(attacker, gameState) === 'ru_fires') {
            dice += 1;
            log.push('+1 die fires doctrine');
        }
        dice = Math.min(dice, baseDice + 3);

        // Reactive armor (T-90): first incoming attack each turn at half dice
        if (defenderCard?.abilities?.includes('reactive_armor') && !defender.status.has(STATUS.REACTIVE_ARMOR_USED)) {
            dice = Math.ceil(dice / 2);
            if (commit) {
                defender.status.add(STATUS.REACTIVE_ARMOR_USED);
                log.push('Reactive armor: dice halved');
            }
        }

        // ── To-hit threshold (base 4+) ──
        let hitTarget = 4;
        if ((attacker.experience || 0) >= 3) { hitTarget -= 1; log.push('Veteran: −1 to-hit'); }
        if (defender.status.has(STATUS.FLANKING)) {
            hitTarget -= 1; log.push('Flanked target: −1 to-hit');
            if (attackerCard?.abilities?.includes('flanking_bonus')) {
                hitTarget -= 1; log.push('Flanking bonus: −1 to-hit');
            }
        }
        if (defender.status.has(STATUS.RECON_SPOTTED)) { hitTarget -= 1; log.push('Spotted target: −1 to-hit'); }
        if (attacker.status.has(STATUS.SUPPRESSED)) { hitTarget += 1; log.push('Suppressed attacker: +1 to-hit'); }
        if (gameState.timeOfDay === 'night' && !(defenderHex?.illuminatedTurns > 0)) {
            if (attackerCard?.abilities?.includes('night_hunter')) {
                hitTarget -= 1; log.push('Night hunter: −1 to-hit');
            } else if (attacker.faction !== 'player' && !attackerCard?.abilities?.includes('night_raid')) {
                hitTarget += 1; log.push('Night: +1 to-hit');
            }
        }
        hitTarget = Math.max(2, Math.min(6, hitTarget));

        // ── Save threshold ──
        const hasAmbush = attacker.status.has(STATUS.AMBUSH) || attacker.ambushReady;
        if (commit && hasAmbush) {
            attacker.ambushReady = false;
            attacker.status.delete(STATUS.AMBUSH);
        }
        const precision = attackerCard?.abilities?.includes('precision_fire') &&
                          defender.status.has(STATUS.RECON_SPOTTED);
        let saveTarget;
        if (hasAmbush || precision) {
            saveTarget = 7; // no save
            log.push(hasAmbush ? 'Ambush: no save' : 'Precision fire: no save');
        } else {
            saveTarget = this._saveTarget(defender, defenderHex, attackerCard, gameState);
        }

        return { numDice: Math.max(0, dice), hitTarget, saveTarget };
    }

    // Save target = 7 − (DEF tier + situational bonuses), clamped 2+..6+.
    // Returns 7 when the unit gets no save at all.
    _saveTarget(unit, hex, attackerCard, gameState) {
        const card = CARD_CATALOG[unit.cardId];
        const defBase = unit.def + (unit.statBonus?.def || 0);
        const tier = defBase <= 1 ? 0 : defBase <= 3 ? 1 : defBase <= 5 ? 2 : 3;

        let bonus = TERRAIN_RULES[hex?.terrainType]?.defMod || 0;
        if (attackerCard?.abilities?.includes('ignore_light_cover') && hex?.terrainType === 'forest_light') {
            bonus = Math.max(0, bonus - 1);
        }
        if (unit.status.has(STATUS.FORTIFIED)) bonus += card?.faction === 'ua' ? 2 : 1;
        if (card?.unitClass === UNIT_CLASS.INFANTRY &&
            this._hasAdjacentClass(unit, UNIT_CLASS.TRACKED, unit.faction, gameState)) bonus += 1;
        if (card?.abilities?.includes('hull_down') && hex?.terrainType === 'ridgeline') bonus += 2;
        if (card?.abilities?.includes('home_ground') && hex?.terrainType?.startsWith('settlement')) bonus += 1;
        // Armored: harder for infantry to hurt. Trench DEF: dug in on hard cover.
        // Settlement Hold / Hold the Line: entrenched on built-up / objective ground.
        if (card?.abilities?.includes('armor_class') && attackerCard?.unitClass === UNIT_CLASS.INFANTRY) bonus += 1;
        if (card?.abilities?.includes('trench_def') && unit.status.has(STATUS.FORTIFIED) &&
            (hex?.terrainType?.startsWith('settlement') || hex?.terrainType?.startsWith('forest'))) bonus += 2;
        if (card?.abilities?.includes('settlement_hold') && hex?.terrainType?.startsWith('settlement')) bonus += 1;
        if (card?.abilities?.includes('hold_the_line') && hex?.isObjective) bonus += 1;
        if (this._hasMechBrigadeAdjacent(unit, gameState)) bonus += 1;
        bonus = Math.min(bonus, 3); // cap stacked bonuses, per 1b

        let total = Math.min(tier + bonus, 5);
        if (unit.markedTurns > 0) total -= 1; // Mark Target: −1 save
        if (total <= 0) return 7;
        return Math.max(2, 7 - total);
    }

    _rollDice(numDice, hitTarget, saveTarget) {
        const rolls = [];
        let hits = 0, saved = 0, crits = 0, damage = 0;
        for (let i = 0; i < numDice; i++) {
            const r = 1 + Math.floor(Math.random() * 6);
            rolls.push(r);
            if (r < hitTarget) continue;
            hits++;
            if (r === 6) { crits++; damage += 2; continue; } // crit: pierces the save
            if (saveTarget <= 6) {
                const sv = 1 + Math.floor(Math.random() * 6);
                if (sv >= saveTarget) { saved++; continue; }
            }
            damage += 1;
        }
        return { rolls, hits, saved, crits, damage };
    }

    _artilleryMissChance(attacker, gameState) {
        let missChance = 0;
        if (attacker.hexId && gameState.ewZones?.has(attacker.hexId)) {
            const ewFactions = gameState.ewZones.get(attacker.hexId);
            const enemyFaction = attacker.faction === 'player' ? 'ai' : 'player';
            if (ewFactions.has(enemyFaction)) missChance += 0.30;
        }
        if (gameState.eventFlags?.arty_miss_30) missChance += 0.30;
        if (gameState.weather === 'rain') missChance += 0.20;
        if (gameState.timeOfDay === 'night') missChance += 0.30;
        return Math.min(missChance, 0.50);
    }

    // Analytic odds for the UI preview — no mutation, no rolling.
    // Returns { numDice, hitTarget, saveTarget, hitChance, expDamage, killChance, missChance }
    previewAttack(attacker, defender, gameState) {
        const attackerCard = CARD_CATALOG[attacker.cardId];
        let missChance = 0;
        if (attackerCard?.unitClass === UNIT_CLASS.VEHICLE &&
            attackerCard?.abilities?.includes('indirect_fire')) {
            missChance = this._artilleryMissChance(attacker, gameState);
        }

        const p = this._attackParams(attacker, defender, gameState, { commit: false });
        const pHit = (7 - p.hitTarget) / 6;
        const pWound = p.saveTarget > 6 ? 1 : (p.saveTarget - 1) / 6;
        const p2 = 1 / 6;                                  // natural 6 → 2 dmg, no save
        const p1 = Math.max(0, pHit - 1 / 6) * pWound;     // other hits → 1 dmg
        const p0 = 1 - p1 - p2;

        // Damage distribution over all dice
        let dist = [1];
        for (let i = 0; i < p.numDice; i++) {
            const next = new Array(dist.length + 2).fill(0);
            dist.forEach((pr, dmg) => {
                next[dmg] += pr * p0;
                next[dmg + 1] += pr * p1;
                next[dmg + 2] += pr * p2;
            });
            dist = next;
        }

        const live = 1 - missChance;
        let expDamage = 0, killP = 0;
        dist.forEach((pr, dmg) => {
            expDamage += pr * dmg;
            if (dmg >= defender.hp) killP += pr;
        });

        return {
            numDice: p.numDice, hitTarget: p.hitTarget, saveTarget: p.saveTarget,
            hitChance: live * (1 - Math.pow(1 - pHit * pWound, p.numDice)),
            expDamage: live * expDamage,
            killChance: live * killP,
            missChance
        };
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
        // Pinned → Suppressed (one step recovery; Resilience doctrine: full)
        if (unit.status.has(STATUS.PINNED)) {
            unit.status.delete(STATUS.PINNED);
            if (this._doctrine(unit, gameState) !== 'ua_resilience') {
                unit.status.add(STATUS.SUPPRESSED);
            }
        }
        // Skill status timers
        if (unit.markedTurns > 0) {
            unit.markedTurns--;
            if (unit.markedTurns === 0) unit.status.delete(STATUS.MARKED);
        }
        if (unit.sabotagedTurns > 0) unit.sabotagedTurns--;
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
        // Reactive armor resets each turn (halves first incoming attack per turn)
        unit.status.delete(STATUS.REACTIVE_ARMOR_USED);
    }

    // ── Area Attack (MLRS BM-21, ZU-23, Artillery Barrage) ──────────────────

    resolveAreaAttack(attacker, targetHexId, gameState) {
        const card = CARD_CATALOG[attacker.cardId];
        const results = [];
        const hexesToHit = [targetHexId, ...this.board.neighbours(targetHexId)];
        const numDice = card.abilities?.includes('area_attack') ? 3 : 4;

        hexesToHit.forEach(hid => {
            const hex = this.board.hexes.get(hid);
            gameState.units.forEach(unit => {
                if (unit.hexId === hid && unit.faction !== attacker.faction && unit.hp > 0) {
                    const roll = this._rollDice(numDice, 4, this._saveTarget(unit, hex, null, gameState));
                    unit.hp = Math.max(0, unit.hp - roll.damage);
                    results.push({ unitId: unit.id, damage: roll.damage });
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

    // Active doctrine id for the unit's side, or null
    _doctrine(unit, gameState) {
        if (!gameState) return null;
        const d = unit.faction === 'player' ? gameState.playerDoctrine : gameState.aiDoctrine;
        return d?.id || null;
    }

    _hasAdjacentAbility(unit, ability, gameState) {
        const neighbours = this.board.neighbours(unit.hexId);
        for (const u of gameState.units.values()) {
            if (u.faction === unit.faction && u.hp > 0 && u.id !== unit.id &&
                neighbours.includes(u.hexId) &&
                CARD_CATALOG[u.cardId]?.abilities?.includes(ability)) return true;
        }
        return false;
    }

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

    _hasAdjacentDifferentClass(unit, myClass, gameState) {
        const neighbours = this.board.neighbours(unit.hexId);
        for (const u of gameState.units.values()) {
            const cls = CARD_CATALOG[u.cardId]?.unitClass;
            if (u.faction === unit.faction && u.hp > 0 && u.id !== unit.id &&
                neighbours.includes(u.hexId) && cls && cls !== myClass) return true;
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

// ── Dev balance audit — run FRONTLINE_DEV.damageMatrix() in the console ─────
// Base damage (no terrain/status) of every attacker vs every enemy unit.
// Zeros mark matchups that cannot hurt the target at all.
window.FRONTLINE_DEV = {
    damageMatrix() {
        const rows = [];
        Object.values(CARD_CATALOG).forEach(a => {
            if (a.tier === TIER.X || a.atk <= 0) return;
            const row = { attacker: `${a.faction.toUpperCase()} ${a.name} (ATK ${a.atk})` };
            Object.values(CARD_CATALOG).forEach(d => {
                if (d.tier === TIER.X || d.faction === a.faction) return;
                let atk = a.atk;
                const armored = d.unitClass === UNIT_CLASS.TRACKED || d.unitClass === UNIT_CLASS.VEHICLE;
                if (a.abilities?.includes('anti_armor') && armored) atk += 2;
                if (a.abilities?.includes('nato_ammo') && d.unitClass === UNIT_CLASS.TRACKED) atk += 1;
                row[`${d.name} (DEF ${d.def})`] = Math.max(0, Math.min(atk, a.atk + 3) - d.def);
            });
            rows.push(row);
        });
        console.table(rows);
        return rows;
    },

    // Regression check for the dice pipeline: simulate canonical matchups and
    // compare mean dice damage against the old deterministic ATK−DEF formula.
    // Run FRONTLINE_DEV.simulate() in the console.
    simulate(n = 1000) {
        const matchups = [
            ['ua_fpv', 'ru_tank_72'],
            ['ua_tank', 'ru_assault'],
            ['ua_sniper', 'ru_motorized'],
            ['ru_tank_90', 'ua_ifv'],
            ['ru_assault', 'ua_terodef'],
            ['ua_arty', 'ru_btr']
        ];
        const mkUnit = id => {
            const c = CARD_CATALOG[id];
            return { id, cardId: id, faction: 'sim', hexId: null, hp: c.hp, maxHp: c.hp,
                     atk: c.atk, def: c.def, rng: c.rng, status: new Set(),
                     statBonus: { atk: 0, def: 0 }, experience: 0, ambushReady: false,
                     displayName: c.name };
        };
        const fakeBoard = { hexes: new Map(), neighbours: () => [], hexDistance: () => 2 };
        const resolver = new CombatResolver(fakeBoard);
        const gs = { units: new Map(), timeOfDay: 'day', weather: 'clear', ewZones: new Map(), eventFlags: {} };

        const oldDamage = (aId, dId) => {
            const a = CARD_CATALOG[aId], d = CARD_CATALOG[dId];
            let atk = a.atk;
            const armored = d.unitClass === UNIT_CLASS.TRACKED || d.unitClass === UNIT_CLASS.VEHICLE;
            if (a.abilities?.includes('anti_armor') && armored) atk += 2;
            if (a.abilities?.includes('nato_ammo') && d.unitClass === UNIT_CLASS.TRACKED) atk += 1;
            return Math.max(0, atk - d.def);
        };

        const rows = matchups.map(([aId, dId]) => {
            let total = 0, kills = 0;
            for (let i = 0; i < n; i++) {
                const a = mkUnit(aId), d = mkUnit(dId);
                const r = resolver.resolveAttack(a, d, gs);
                total += r.damage;
                if (d.hp <= 0) kills++;
            }
            const mean = total / n;
            const old = oldDamage(aId, dId);
            return {
                matchup: `${CARD_CATALOG[aId].name} → ${CARD_CATALOG[dId].name}`,
                oldDmg: old,
                meanDiceDmg: +mean.toFixed(2),
                'Δ%': old > 0 ? Math.round((mean - old) / old * 100) : '—',
                'kill%': Math.round(kills / n * 100)
            };
        });
        console.table(rows);
        return rows;
    },

    // AI-vs-AI balance harness: run n headless matches on procedural terrain and
    // report faction winrates plus per-card combat efficiency.
    // Run: await FRONTLINE_DEV.autoBattle(20)
    async autoBattle(n = 10) {
        const cards = {}; // cardId → { deployed, kills, deaths, dmg, rp }
        const factionWins = { ua: 0, ru: 0 };
        let totalTurns = 0;

        const tally = (unit, faction) => {
            const card = CARD_CATALOG[unit.cardId];
            if (!card) return;
            const c = cards[unit.cardId] ||
                (cards[unit.cardId] = { name: card.name, rp: card.rp, deployed: 0, kills: 0, deaths: 0, dmg: 0 });
            c.deployed++;
            c.kills += unit.statKills || 0;
            c.dmg += unit.damageDealt || 0;
            if (unit.hp <= 0) c.deaths++;
        };

        for (let i = 0; i < n; i++) {
            const eng = new GameEngine();
            const playerFaction = Math.random() < 0.5 ? 'ua' : 'ru';
            let outcome = null;
            eng.onVictory = r => { outcome = r; };

            await eng.startGame({
                playerFaction, difficulty: 1.0, headless: true,
                centerLat: 47.8 + Math.random() * 1.2,
                centerLng: 35.5 + Math.random() * 2.5
            });
            const s = eng.state;

            // Greedy deployment for the "player" side
            let hexIdx = 0;
            const spawn = s.spawnHexIds.playerHexes;
            for (const cid of [...s.playerDeck]) {
                if (eng.deployPlayerUnit(cid, spawn[(hexIdx * 2) % spawn.length]).ok) hexIdx++;
            }
            eng.finishDeployment();

            // Greedy player turns until the match ends (AI side runs inside endPlayerTurn)
            let guard = 0;
            while (s.phase === 'player_action' && guard++ < 100) {
                this._driveGreedyPlayer(eng, s);
                eng.endPlayerTurn();
            }

            totalTurns += s.turn;
            const winner = outcome?.winner || (s.playerVP >= s.aiVP ? 'player' : 'ai');
            factionWins[winner === 'player' ? playerFaction : (playerFaction === 'ua' ? 'ru' : 'ua')]++;
            s.units.forEach(u => tally(u, u.faction));
        }

        const rows = Object.values(cards)
            .map(c => ({
                unit: c.name, rp: c.rp, deployed: c.deployed,
                kills: +(c.kills / c.deployed).toFixed(2),
                deathPct: Math.round(c.deaths / c.deployed * 100),
                dmg: +(c.dmg / c.deployed).toFixed(1),
                dmgPerRP: +(c.dmg / c.deployed / Math.max(1, c.rp)).toFixed(2)
            }))
            .sort((a, b) => b.dmgPerRP - a.dmgPerRP);

        const summary = { matches: n, uaWins: factionWins.ua, ruWins: factionWins.ru, avgTurns: +(totalTurns / n).toFixed(1) };
        console.log('autoBattle summary:', summary);
        console.table(rows);
        return { summary, rows };
    },

    // Head-to-head deck check: run each UA battlegroup as the player vs the AI
    // (random RU deck) and report win%. Tests the "armor auto-wins" claim — the
    // armored Mech Fist should land ~45–55%, not dominate.
    // Run: await FRONTLINE_DEV.deckMatchup(20)
    async deckMatchup(n = 20) {
        const decks = ['ua_mech_fist', 'ua_drone_war', 'ua_defensive_line'];
        const results = [];
        for (const bg of decks) {
            let wins = 0, turns = 0;
            for (let i = 0; i < n; i++) {
                const eng = new GameEngine();
                let outcome = null;
                eng.onVictory = r => { outcome = r; };
                await eng.startGame({
                    playerFaction: 'ua', difficulty: 1.0, headless: true, battlegroup: bg,
                    centerLat: 47.8 + Math.random() * 1.2,
                    centerLng: 35.5 + Math.random() * 2.5
                });
                const s = eng.state;
                let hexIdx = 0;
                const spawn = s.spawnHexIds.playerHexes;
                for (const cid of [...s.playerDeck]) {
                    if (eng.deployPlayerUnit(cid, spawn[(hexIdx * 2) % spawn.length]).ok) hexIdx++;
                }
                eng.finishDeployment();
                let guard = 0;
                while (s.phase === 'player_action' && guard++ < 100) {
                    this._driveGreedyPlayer(eng, s);
                    eng.endPlayerTurn();
                }
                const winner = outcome?.winner || (s.playerVP >= s.aiVP ? 'player' : 'ai');
                if (winner === 'player') wins++;
                turns += s.turn;
            }
            results.push({ deck: bg, winPct: Math.round(wins / n * 100), avgTurns: +(turns / n).toFixed(1), matches: n });
        }
        console.table(results);
        return results;
    },

    // Simple greedy routine driving the "player" side in autoBattle:
    // attack the nearest enemy in range, otherwise step toward it.
    // Mirrors the engine AI's order/doctrine usage so the sides are comparable.
    _driveGreedyPlayer(eng, s) {
        // Orders: recon sweep for spotting parity, barrage on spotted targets
        if (s.playerCP >= 1) eng.useOrder('recon_sweep');
        if (s.playerCP >= 3) {
            const spotted = [...s.units.values()].find(u =>
                u.faction === 'ai' && u.hp > 0 && u.status.has(STATUS.RECON_SPOTTED));
            if (spotted) eng.useOrder('artillery_barrage', spotted.id);
        }
        // Doctrine active (untargeted ones fire directly; targeted: best effort)
        if (eng.doctrineAvailable('player')) {
            const { def } = eng.doctrineDef('player');
            if (def.target === 'none') {
                eng.executeDoctrineTarget({});
            } else if (def.target === 'unit') {
                const t = [...s.units.values()].find(u =>
                    u.faction === 'ai' && u.hp > 0 &&
                    (u.status.has(STATUS.RECON_SPOTTED) || s.intelZones.has(u.hexId)));
                if (t) eng.executeDoctrineTarget({ unitId: t.id });
            } else {
                const t = [...s.units.values()].find(u => u.faction === 'ai' && u.hp > 0);
                if (t) eng.executeDoctrineTarget({ hexId: t.hexId });
            }
        }

        const myUnits = [...s.units.values()].filter(u => u.faction === 'player' && u.hp > 0);
        for (const u of myUnits) {
            if (s.playerAP <= 0) break;
            const foes = [...s.units.values()].filter(f => f.faction === 'ai' && f.hp > 0);
            if (!foes.length) break;
            foes.sort((a, b) => eng.board.hexDistance(u.hexId, a.hexId) - eng.board.hexDistance(u.hexId, b.hexId));
            const t = foes[0];
            const d = eng.board.hexDistance(u.hexId, t.hexId);
            const card = CARD_CATALOG[u.cardId];

            // Mine layers drop mines on the approach path
            if ((card?.active === 'remote_mine' || card?.active === 'mine_volley') && u.skillCd === 0) {
                const range = card.active === 'mine_volley' ? 6 : 2;
                if (d <= range + 1) {
                    const toward = eng.board.neighbours(t.hexId).find(h => eng.board.hexDistance(u.hexId, h) <= range);
                    if (toward && eng.useUnitSkill(u.id, { hexId: toward }).ok) continue;
                }
            }

            if (d <= u.rng && d >= 1) {
                eng.attackUnit(u.id, t.hexId);
            } else if (u.mov > 0) {
                const reach = eng.board.reachableHexes(u.hexId, u.mov, card.unitClass, 'player', s, card.abilities);
                // Fall back to a grind escape if no normal move exists, so a unit
                // on hard terrain never stalls the sim.
                const options = reach.size ? [...reach.keys()]
                    : [...eng.board.escapeHexes(u.hexId, 'player', s, reach)];
                let best = null, bd = Infinity;
                options.forEach(hid => {
                    const dd = eng.board.hexDistance(hid, t.hexId);
                    if (dd < bd) { bd = dd; best = hid; }
                });
                if (best && best !== u.hexId) eng.moveUnit(u.id, best);
            }
        }
    }
};

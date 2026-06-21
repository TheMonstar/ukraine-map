'use strict';
// ── cards.js — FRONTLINE Card Catalog ─────────────────────────────────────

const TIER = { C: 'C', U: 'U', R: 'R', X: 'X' };
const TIER_AP = { C: 1, U: 2, R: 3, X: 0 };
const TIER_LABEL = { C: 'Common', U: 'Uncommon', R: 'Rare', X: 'Commander' };

const FACTION = { UA: 'ua', RU: 'ru' };

const UNIT_CLASS = {
    INFANTRY: 'infantry', WHEELED: 'wheeled', TRACKED: 'tracked',
    DRONE: 'drone', VEHICLE: 'vehicle', COMMAND: 'command'
};

// Terrain rules: moveCost, defMod, stackLimit, special flags
const TERRAIN_RULES = {
    open:          { moveCost: 1, defMod: 0, stackLimit: 3 },
    agricultural:  { moveCost: 1, defMod: 0, stackLimit: 3 },
    forest_light:  { moveCost: 2, defMod: 1, stackLimit: 2 },
    forest_dense:  { moveCost: 3, defMod: 2, stackLimit: 1, hidden: true },
    settlement_s1: { moveCost: 2, defMod: 2, stackLimit: 2, isObjective: true, vpPerTurn: 1 },
    settlement_s2: { moveCost: 3, defMod: 3, stackLimit: 3, isObjective: true, vpPerTurn: 2 },
    wetland:       { moveCost: 4, defMod: 0, stackLimit: 1, noWheeled: true },
    industrial:    { moveCost: 2, defMod: 2, stackLimit: 2, canRepair: true },
    ridgeline:     { moveCost: 2, moveCostDown: 1, defMod: 1, stackLimit: 2, overwatchBonus: true }
};

const OVERLAY_RULES = {
    road_motorway: { moveMod: -1 },
    road_paved:    { moveMod: -1 },
    river_minor:   { moveMod: +2 },
    river_major:   { impassable: true },
    bridge:        { cancelsRiver: true },
    mined:         { entryDmgInf: 3, entryDmgVeh: 5, status: 'suppressed' },
    zone_denied:   { entryDmg: 2, artyBonus: 1 },
    interdicted:   { blocksSupply: true },
    fortified_obj: { defMod: 1 }
};

const STATUS = {
    MARKED:        'marked',
    SUPPRESSED:    'suppressed',
    PINNED:        'pinned',
    FORTIFIED:     'fortified',
    OVERWATCH:     'overwatch',
    FLANKING:      'flanking',
    AMBUSH:        'ambush',
    RECON_SPOTTED: 'recon_spotted',
    ENCIRCLED:     'encircled',
    LOW_SUPPLY:    'low_supply',
    UNSUPPLIED:    'unsupplied',
    DEPOT:         'depot',
    EW_SUPPRESSED: 'ew_suppressed',
    ONE_SHOT_USED: 'one_shot_used',
    REACTIVE_ARMOR_USED: 'reactive_armor_used'
};

// ── CARD CATALOG ────────────────────────────────────────────────────────────
// Fields: id, faction, name, tier, unitClass, size, hp, atk, def, mov, rng, rp,
//         abilities[], ewRadius?, desc, iconPath
//
// size: 1 = small (infantry teams, FPV, small drones — hard for recon to detect)
//        2 = medium (wheeled vehicles, squads, medium drones — normal detection)
//        3 = large (tanks, tracked IFVs, artillery, MLRS — always spotted by drones)
//
// stealth_stationary: size-1 units with this ability are invisible to drones if
//                     they did not move this turn (snipers, SF, DRG in hides).
// recon_reveal: unit's "Attack" action performs a recon pass rather than shooting.
//               Enemies are spotted proportional to their size vs drone range.

const CARD_CATALOG = {

    // ═══════════════════ UKRAINE ═══════════════════════════════════════════

    ua_terodef: {
        id: 'ua_terodef', faction: 'ua', name: 'TeroDef Infantry',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 5, atk: 2, def: 2, mov: 2, rng: 1, rp: 3,
        abilities: ['home_ground', 'hold_the_line'],
        iconPath: '../images/ua/icon-3.png',
        desc: 'Territorial defence platoon. +1 DEF in settlements. Cannot be flanked while Fortified — critical for urban defence.'
    },
    ua_fpv: {
        id: 'ua_fpv', faction: 'ua', name: 'FPV Operator',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 5, def: 0, mov: 2, rng: 4, rp: 5,
        abilities: ['one_shot', 'anti_armor', 'interceptable', 'precision_optics'],
        iconPath: '../images/ua/icon-11.png',
        desc: 'Ukrainian FPV drones (DJI converted). Kamikaze strike — destroyed after firing. +2 ATK vs tracked. IGLA can intercept. +1 ATK if target ISR-spotted.'
    },
    ua_recon_drone: {
        id: 'ua_recon_drone', faction: 'ua', name: 'Recon Drone (Mavic)',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 0, def: 0, mov: 5, rng: 8, rp: 3,
        abilities: ['recon_reveal', 'intel_zone', 'arty_spotter', 'fragile'],
        iconPath: '../images/ua/icon-44.png',
        desc: 'DJI Mavic / Autel commercial drone. Attack action = recon pass: reveals every enemy within range 8 (stationary snipers/SF in hides stay hidden). Passive Intel Zone covers its full range. Fragile: dies on any hit.'
    },
    ua_sniper: {
        id: 'ua_sniper', faction: 'ua', name: 'Sniper Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 3, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['ignore_light_cover', 'suppress_on_hit', 'stealth_stationary'],
        active: 'mark_target',
        iconPath: '../images/ua/icon-23.png',
        desc: 'Ukrainian sniper teams (SVD/Barrett). Ignores DEF from light cover. Every hit Suppresses target. Invisible to drones if stationary — set up a hide and stay still.'
    },
    ua_mortar: {
        id: 'ua_mortar', faction: 'ua', name: 'Mortar Team (M120)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 4, def: 1, mov: 2, rng: 5, rp: 5,
        abilities: ['indirect_fire', 'setup_req'],
        active: 'illumination',
        iconPath: '../images/ua/icon-18.png',
        desc: '120mm mortar team. Indirect fire — ignores LoS. Setup required: cannot fire if moved this turn.'
    },
    ua_bike: {
        id: 'ua_bike', faction: 'ua', name: 'Bike Infantry',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 5, rng: 1, rp: 3,
        abilities: ['rapid_reposition'],
        active: 'rapid_dash',
        iconPath: '../images/ua/icon-25.png',
        desc: 'Motorcycle-mounted infantry. Fast repositioning — used for rapid response and flanking approaches. +1 MOV on friendly-controlled hexes.'
    },
    ua_igla: {
        id: 'ua_igla', faction: 'ua', name: 'IGLA Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['anti_air_reaction', 'fpv_intercept', 'recon_shield'],
        iconPath: '../images/ua/icon-46.png',
        desc: 'MANPADS / anti-drone team. Free intercept of 1 FPV per turn. Recon shield: friendly drones within 5 hexes cannot be intercepted. ATK 2 vs ground as last resort.'
    },
    ua_pickup: {
        id: 'ua_pickup', faction: 'ua', name: 'Pickup Technical',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 4, atk: 3, def: 1, mov: 4, rng: 2, rp: 4,
        abilities: ['supply_run', 'can_depot'],
        active: 'field_resupply',
        iconPath: '../images/ua/icon-5.png',
        desc: 'Armed pickup truck (Hilux / Humvee). Supply run: removes Suppressed from adjacent friendlies. DEPOT mode: extends supply +3 hex.'
    },
    ua_drg: {
        id: 'ua_drg', faction: 'ua', name: 'DRG (Recon-Strike)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 5, atk: 4, def: 2, mov: 3, rng: 2, rp: 6,
        abilities: ['mine_layer', 'ambush', 'exfil', 'infiltrate', 'stealth_stationary'],
        active: 'exfil',
        iconPath: '../images/ua/icon-12.png',
        desc: 'Ukrainian recon-strike group. Mine layer: lay mines on move (1 AP). Ambush: first strike ignores DEF. Exfil: retreat to any friendly hex once. Invisible to drones when stationary in hides.'
    },
    ua_ifv: {
        id: 'ua_ifv', faction: 'ua', name: 'IFV (Bradley / Marder)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 10, atk: 6, def: 4, mov: 3, rng: 2, rp: 8,
        abilities: ['anti_infantry', 'combined_arms', 'can_depot', 'transport'],
        active: 'smoke_screen',
        iconPath: '../images/ua/icon-4.png',
        desc: 'M2 Bradley / Marder IFV. 25mm autocannon devastates infantry (+2 dice vs INFANTRY) — but no edge vs armor, so a tank out-trades it. Combined arms: +1 ATK beside a different-class friendly. DEPOT capable. Mechanized lift: adjacent infantry +1 MOV.'
    },
    ua_isr_drone: {
        id: 'ua_isr_drone', faction: 'ua', name: 'ISR Drone (Bayraktar)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 2,
        hp: 3, atk: 2, def: 0, mov: 1, rng: 10, rp: 6,
        abilities: ['permanent_isr', 'recon_reveal', 'arty_relay', 'fragile'],
        iconPath: '../images/ua/icon-45.png',
        desc: 'Bayraktar TB2 / Leleka-100. Permanent ISR: passive Intel Zone covers its full range 10 every turn. Active recon pass reveals every enemy in range. Arty relay: all friendly artillery +1 RNG. Limited MAM missiles (ATK 2). Fragile.'
    },
    ua_tank: {
        id: 'ua_tank', faction: 'ua', name: 'Tank (Leopard 2 / T-64BV)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 12, atk: 7, def: 5, mov: 2, rng: 3, rp: 9,
        abilities: ['hull_down', 'mine_immune_first', 'nato_ammo'],
        active: 'canister_shot',
        iconPath: '../images/ua/icon-1.png',
        desc: 'Leopard 2A4/A6 or upgraded T-64BV. Excellent optics and crew training. Long RNG 3 outranges IFVs and infantry. Hull-down: +2 DEF on ridgeline. First mine ignored. NATO ammo: +1 die vs tracked armor.'
    },
    ua_ew: {
        id: 'ua_ew', faction: 'ua', name: 'EW Unit (Bukovel-AD)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 2,
        hp: 4, atk: 0, def: 1, mov: 1, rng: 0, rp: 6,
        ewRadius: 3,
        abilities: ['ew_jamming', 'starlink_passive'],
        iconPath: '../images/ua/icon-32.png',
        desc: 'Bukovel-AD drone jammer. EW radius 3: drones lose range, artillery accuracy −30%. Starlink passive: first EW comms disruption per match is negated via satellite link.'
    },
    ua_loitering: {
        id: 'ua_loitering', faction: 'ua', name: 'Loitering Munition (Switchblade)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 4, def: 0, mov: 0, rng: 0, rp: 6,
        abilities: ['delayed_strike', 'jammable'],
        iconPath: '../images/ua/icon-11.png',
        desc: 'Switchblade 600 / UJ-22. Designate target hex — strikes for 4 ATK (ignores cover) after 2-turn countdown. Countdown is visible to opponent. Jammable via EW zone.'
    },
    ua_arty: {
        id: 'ua_arty', faction: 'ua', name: 'Artillery (M777 / Caesar)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 6, atk: 7, def: 1, mov: 1, rng: 8, rp: 9,
        abilities: ['precision_fire', 'counter_battery', 'indirect_fire'],
        active: 'scoot',
        iconPath: '../images/ua/icon-18.png',
        desc: 'M777 howitzer / Caesar wheeled SPH. Precision fire: ignores terrain DEF if target ISR-spotted. Shoot & scoot: move 1 hex after firing. Counter-battery: free return fire vs enemy arty. 155mm — ATK 7.'
    },
    ua_sf: {
        id: 'ua_sf', faction: 'ua', name: 'Special Operations (SOF)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 6, atk: 5, def: 3, mov: 3, rng: 2, rp: 7,
        abilities: ['deep_recon', 'exfil', 'ambush', 'stealth_stationary'],
        active: 'sabotage',
        iconPath: '../images/ua/icon-6.png',
        desc: 'Ukraine SOF (SSO). Highly trained, small signature. Deep recon: can enter enemy spawn zone. Sabotage: disable enemy DEPOT/EW (1 AP). Ambush on first strike. Invisible to drones when stationary.'
    },
    ua_vampire: {
        id: 'ua_vampire', faction: 'ua', name: 'Heavy Bomber Drone (Vampire)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 2,
        hp: 3, atk: 5, def: 0, mov: 3, rng: 2, rp: 7,
        abilities: ['anti_armor', 'interceptable', 'night_hunter'],
        iconPath: '../images/ua/icon-11.png',
        desc: 'Vampire / "Baba Yaga" heavy hexacopter. Reusable bomber — drops munitions and returns. +2 ATK vs armor. Night hunter: −1 to-hit at night instead of a penalty. Interceptable.'
    },
    ua_ugv_miner: {
        id: 'ua_ugv_miner', faction: 'ua', name: 'UGV Minelayer (Ratel)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 1,
        hp: 4, atk: 1, def: 1, mov: 3, rng: 0, rp: 5,
        abilities: ['mine_immune_first'],
        active: 'remote_mine',
        iconPath: '../images/ua/icon-55.png',
        desc: 'Ratel ground robot. Remotely mines a hex within 2 every other turn — area denial without exposing infantry. Small and hard to spot.'
    },
    ua_air_assault: {
        id: 'ua_air_assault', faction: 'ua', name: '95th Air Assault Brigade',
        tier: TIER.R, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 9, atk: 6, def: 3, mov: 4, rng: 2, rp: 12,
        abilities: ['air_insert', 'assault_tempo', 'settlement_hold'],
        iconPath: '../images/ua/icon-20.png',
        desc: 'Elite Ukrainian airborne. Air insert: deploy on any non-enemy hex (helo assault). Assault tempo: each kill grants 1 free AP (max 2/turn). Settlement hold: +1 DEF in built-up areas.'
    },
    ua_mech_brigade: {
        id: 'ua_mech_brigade', faction: 'ua', name: 'Mechanized Brigade (54th)',
        tier: TIER.R, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 14, atk: 6, def: 5, mov: 2, rng: 2, rp: 12,
        abilities: ['combined_arms', 'defensive_depth', 'hq_action'],
        iconPath: '../images/ua/icon-31.png',
        desc: 'Full mechanized brigade with Western IFVs. Combined-arms anchor: all adjacent friendlies +1 ATK AND +1 DEF (force multiplier). Defensive depth: anchors the line. HQ action: once/turn uses 1 Order at no CP cost.'
    },
    // ═══════════════════ RUSSIA ════════════════════════════════════════════

    ru_assault: {
        id: 'ru_assault', faction: 'ru', name: 'Assault Infantry (Shtorm-Z)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 3, def: 1, mov: 2, rng: 1, rp: 3,
        abilities: ['wave_bonus', 'pack_bonus'],
        iconPath: '../images/ru/icon-24.png',
        desc: 'Convict assault infantry / Shtorm-Z. Expendable mass — cheap and numerous. Pack bonus: +1 ATK per 2 adjacent friendlies. Benefits from Wave Regiment aura. Losses are expected.'
    },
    ru_motorized: {
        id: 'ru_motorized', faction: 'ru', name: 'Motorized Infantry (BMP)',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 5, atk: 3, def: 2, mov: 3, rng: 1, rp: 4,
        abilities: ['road_bonus', 'suppressive_fire'],
        iconPath: '../images/ru/icon-3.png',
        desc: 'Standard Russian motorized infantry. Road bonus: +1 MOV on roads. Suppressive fire: always applies Suppressed on hit — degrades enemy coordination systematically.'
    },
    ru_fpv: {
        id: 'ru_fpv', faction: 'ru', name: 'FPV Operator',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 4, def: 0, mov: 2, rng: 3, rp: 4,
        abilities: ['one_shot', 'anti_armor', 'interceptable'],
        iconPath: '../images/ru/icon-51.png',
        desc: 'Russian FPV drone teams. Kamikaze strike — destroyed after use. Anti-armor: +2 vs tracked vehicles. Interceptable by IGLA. Slightly shorter range than UA equivalent.'
    },
    ru_bike: {
        id: 'ru_bike', faction: 'ru', name: 'Bike Infantry',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 1,
        hp: 3, atk: 2, def: 0, mov: 6, rng: 1, rp: 3,
        abilities: ['flanking_bonus', 'no_fortify'],
        active: 'rapid_dash',
        iconPath: '../images/ru/icon-6.png',
        desc: 'Russian assault motorcycle infantry — used en masse for rapid flanking. Cannot fortify. Flanking bonus: +2 ATK from the flank. Extremely fast (MOV 6) but fragile.'
    },
    ru_mortar: {
        id: 'ru_mortar', faction: 'ru', name: 'Mortar Team (2B14)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 4, def: 1, mov: 2, rng: 5, rp: 5,
        abilities: ['indirect_fire'],
        active: 'illumination',
        iconPath: '../images/ru/icon-7.png',
        desc: '82mm / 120mm mortar team. Indirect fire — ignores LoS. Illumination negates the night to-hit penalty in a radius.'
    },
    ru_recon: {
        id: 'ru_recon', faction: 'ru', name: 'Recon Drone (Orlan-10)',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 0, def: 0, mov: 4, rng: 7, rp: 3,
        abilities: ['recon_reveal', 'intel_zone', 'fragile'],
        iconPath: '../images/ru/icon-52.png',
        desc: 'Orlan-10 fixed-wing UAV. Attack action = recon pass: reveals every enemy within range 7 (stationary snipers/SF in hides stay hidden). Passive Intel Zone covers its full range. Fragile.'
    },
    ru_igla: {
        id: 'ru_igla', faction: 'ru', name: 'IGLA / Strela Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['anti_air_reaction', 'fpv_intercept'],
        iconPath: '../images/ru/icon-17.png',
        desc: 'IGLA-S / Strela-10 MANPADS. Free FPV intercept once/turn. Anti-air reaction: fires at any drone entering range. Russia deploys these densely — significantly limits UA drone effectiveness.'
    },
    ru_drg: {
        id: 'ru_drg', faction: 'ru', name: 'DRG (Recon Group)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 5, atk: 4, def: 2, mov: 3, rng: 2, rp: 6,
        abilities: ['infiltrate', 'ambush', 'deep_recon', 'stealth_stationary'],
        active: 'exfil',
        iconPath: '../images/ru/icon-19.png',
        desc: 'Russian recon-strike DRG team. Infiltrate: may enter enemy-held hexes. Ambush: first strike ignores DEF. Deep recon. Invisible to drones when stationary — Russia relies on deep reconnaissance.'
    },
    ru_btr: {
        id: 'ru_btr', faction: 'ru', name: 'BTR Battalion (BTR-82A)',
        tier: TIER.U, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 8, atk: 4, def: 3, mov: 4, rng: 2, rp: 7,
        abilities: ['anti_infantry', 'carrier', 'suppressive_fire', 'can_depot'],
        active: 'smoke_screen',
        iconPath: '../images/ru/icon-6.png',
        desc: 'BTR-82A wheeled APC. 30mm autocannon shreds infantry (+2 dice vs INFANTRY) but no edge vs armor. Carrier: adjacent infantry +1 MOV (mechanized lift). Suppressive fire. DEPOT capable. Wheeled — fast on roads, vulnerable in broken terrain.'
    },
    ru_lancet: {
        id: 'ru_lancet', faction: 'ru', name: 'Lancet-3 Loitering',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 5, def: 0, mov: 0, rng: 5, rp: 7,
        abilities: ['delayed_strike', 'anti_armor', 'interceptable'],
        iconPath: '../images/ru/icon-53.png',
        desc: 'Lancet-3 anti-armor loitering munition — Russia\'s most effective drone weapon. Designate hex, strikes for 5 ATK (+2 vs armored) after 2 turns. Interceptable. Most feared by UA forces.'
    },
    ru_tank_72: {
        id: 'ru_tank_72', faction: 'ru', name: 'Tank T-72B3 / T-80',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 10, atk: 7, def: 4, mov: 2, rng: 3, rp: 8,
        abilities: ['breakthrough', 'armor_class', 'mine_immune_first'],
        active: 'canister_shot',
        iconPath: '../images/ru/icon-5.png',
        desc: 'T-72B3 / T-80BV main battle tank. 125mm gun — high ATK, long RNG 3, but older armour (DEF 4). Breakthrough: ignores Overwatch on assault. Mine immune first pass. Russia uses these en masse; losses are high but numbers matter.'
    },
    ru_tank_90: {
        id: 'ru_tank_90', faction: 'ru', name: 'Tank T-90M (Proryv)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 12, atk: 8, def: 5, mov: 2, rng: 3, rp: 9,
        abilities: ['reactive_armor', 'breakthrough', 'armor_class'],
        active: 'canister_shot',
        iconPath: '../images/ru/icon-15.png',
        desc: 'T-90M Proryv — Russia\'s best tank. Kontakt-5 / Relikt ERA: first incoming attack each turn is halved. 125mm 2A46M-4 gun, long RNG 3. Breakthrough. Expensive and scarce; losing one is a strategic event.'
    },
    ru_spetsnaz: {
        id: 'ru_spetsnaz', faction: 'ru', name: 'Spetsnaz / VDV',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 6, atk: 5, def: 3, mov: 3, rng: 2, rp: 7,
        abilities: ['deep_recon', 'night_raid', 'ambush', 'stealth_stationary'],
        active: 'exfil',
        iconPath: '../images/ru/icon-25.png',
        desc: 'Russian Spetsnaz / VDV airborne. Professional soldiers. Deep recon. Night raid: +1 ATK at night. Ambush on first strike. Invisible to drones when stationary — used in covert infiltration.'
    },
    ru_zu23: {
        id: 'ru_zu23', faction: 'ru', name: 'ZU-23-2 / Tunguska',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 2,
        hp: 5, atk: 4, def: 2, mov: 2, rng: 4, rp: 6,
        abilities: ['area_suppression', 'anti_air_reaction'],
        iconPath: '../images/ru/icon-14.png',
        desc: 'ZU-23-2 AA gun / Tunguska system. ATK 4 dual-role vs infantry AND drones. Area suppression hits all units in target hex. Anti-air reaction. Russia fields these extensively for drone defence.'
    },
    ru_ew: {
        id: 'ru_ew', faction: 'ru', name: 'EW Unit (Krasukha-4)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 4, atk: 0, def: 2, mov: 1, rng: 0, rp: 6,
        ewRadius: 4,
        abilities: ['ew_jamming', 'comms_disruption'],
        iconPath: '../images/ru/icon-35.png',
        desc: 'Krasukha-4 EW complex. Massive EW radius 4: all drones lose range, artillery accuracy −30%. Comms disruption: costs UA −1 CP/turn while alive. Russia\'s EW superiority is historically dominant.'
    },
    ru_naval: {
        id: 'ru_naval', faction: 'ru', name: 'Naval Infantry (810th)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 7, atk: 5, def: 3, mov: 2, rng: 2, rp: 7,
        abilities: ['amphibious', 'trench_def', 'assault_tempo'],
        iconPath: '../images/ru/icon-27.png',
        desc: '810th Naval Infantry Brigade — experienced assault unit. Amphibious: crosses rivers freely. Trench DEF: +2 DEF when Fortified in settlement or forest. Assault tempo: each kill = 1 free AP.'
    },
    ru_mlrs: {
        id: 'ru_mlrs', faction: 'ru', name: 'MLRS (BM-21 / BM-30)',
        tier: TIER.U, unitClass: UNIT_CLASS.WHEELED,
        size: 3,
        hp: 5, atk: 5, def: 1, mov: 2, rng: 6, rp: 7,
        abilities: ['area_attack', 'rapid_fire', 'indirect_fire'],
        active: 'scoot',
        iconPath: '../images/ru/icon-12.png',
        desc: 'BM-21 Grad / BM-30 Smerch MLRS. Area attack: hits target hex + all 6 adjacent (3 ATK each). Rapid fire: fire twice per activation. Indirect fire. Devastating area denial — used to saturate positions.'
    },
    ru_heavy_drone: {
        id: 'ru_heavy_drone', faction: 'ru', name: 'Heavy Bomber Drone (Privet-82)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 2,
        hp: 3, atk: 5, def: 0, mov: 3, rng: 2, rp: 7,
        abilities: ['anti_armor', 'interceptable', 'night_hunter'],
        iconPath: '../images/ru/icon-54.png',
        desc: 'Privet-82 heavy bomber drone. Reusable — drops mortar rounds on armor and returns. +2 ATK vs armor. Night hunter: −1 to-hit at night. Interceptable.'
    },
    ru_zemledeliye: {
        id: 'ru_zemledeliye', faction: 'ru', name: 'ISDM Zemledeliye',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 5, atk: 0, def: 1, mov: 1, rng: 6, rp: 7,
        abilities: [],
        active: 'mine_volley',
        iconPath: '../images/ru/icon-2.png',
        desc: 'ISDM Zemledeliye remote mining system. Rockets scatter mines across a hex and its neighbour at up to 6 hexes — shapes the battlefield from the rear.'
    },
    ru_wave_regt: {
        id: 'ru_wave_regt', faction: 'ru', name: 'Wave Assault Regiment',
        tier: TIER.R, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 6, atk: 4, def: 2, mov: 2, rng: 1, rp: 10,
        abilities: ['wave_spawn', 'human_wave_aura'],
        iconPath: '../images/ru/icon-49.png',
        desc: 'Mass assault regiment (ex-Wagner tactics). Wave spawn: generates 1 Assault Group token per turn in adjacent rear hex. Human wave aura: adjacent infantry +1 ATK on all assaults. Attrition warfare incarnate.'
    },
    ru_arty_regt: {
        id: 'ru_arty_regt', faction: 'ru', name: 'Artillery Regiment (2S3 / 2S19)',
        tier: TIER.R, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 8, atk: 6, def: 2, mov: 1, rng: 7, rp: 10,
        abilities: ['barrage_2hex', 'counter_battery', 'double_fire', 'indirect_fire'],
        active: 'scoot',
        iconPath: '../images/ru/icon-21.png',
        desc: '2S3 Akatsiya / 2S19 Msta-S 152mm. Barrage: split fire across 2 hexes per activation. Counter-battery reaction. Double fire: fire twice for 2 AP. Russia\'s fire superiority — artillery accounts for 80% of casualties.'
    }
};

// ── ACTIVE SKILLS ───────────────────────────────────────────────────────────
// One active per unit, referenced from CARD_CATALOG via `active: '<id>'`.
// target: 'hex' | 'unit' | 'self' (self needs no click). range: hexes, or
// 'rng'/'mov' to use the unit's stat. cooldown: full turns between uses.
const ACTIVE_SKILLS = {
    canister_shot: {
        id: 'canister_shot', name: 'Canister Shot', cooldown: 3, apCost: 1, target: 'hex', range: 1,
        desc: '2 dice vs every enemy in an adjacent hex.'
    },
    mark_target: {
        id: 'mark_target', name: 'Mark Target', cooldown: 2, apCost: 1, target: 'unit', range: 'rng',
        desc: 'Mark a visible enemy in range: spotted and −1 save for 2 turns.'
    },
    smoke_screen: {
        id: 'smoke_screen', name: 'Smoke Screen', cooldown: 3, apCost: 1, target: 'hex', range: 1, allowSelf: true,
        desc: 'Smoke on own or adjacent hex: units there cannot be attacked from range >1 this turn.'
    },
    illumination: {
        id: 'illumination', name: 'Illumination', cooldown: 2, apCost: 1, target: 'self',
        desc: 'Illuminate radius 3 for 1 turn: night to-hit penalty negated there.'
    },
    scoot: {
        id: 'scoot', name: 'Shoot & Scoot', cooldown: 2, apCost: 0, target: 'hex', range: 1,
        desc: 'Free 1-hex reposition (no AP).'
    },
    exfil: {
        id: 'exfil', name: 'Exfil', cooldown: 5, apCost: 1, target: 'self',
        desc: 'Redeploy to a random friendly spawn hex.'
    },
    sabotage: {
        id: 'sabotage', name: 'Sabotage', cooldown: 3, apCost: 1, target: 'unit', range: 1,
        desc: 'Disable an adjacent enemy EW/DEPOT unit for 2 turns and Suppress it.'
    },
    rapid_dash: {
        id: 'rapid_dash', name: 'Rapid Dash', cooldown: 3, apCost: 0, target: 'hex', range: 'mov',
        desc: 'Free move up to MOV hexes (no AP).'
    },
    field_resupply: {
        id: 'field_resupply', name: 'Field Resupply', cooldown: 3, apCost: 1, target: 'unit', range: 1,
        desc: 'Adjacent friendly heals 2 HP and loses Suppressed.'
    },
    remote_mine: {
        id: 'remote_mine', name: 'Remote Mine', cooldown: 2, apCost: 1, target: 'hex', range: 2,
        desc: 'Mine a hex within 2 — entering units take damage (vehicles 5) and are Suppressed.'
    },
    mine_volley: {
        id: 'mine_volley', name: 'Mine Volley', cooldown: 3, apCost: 1, target: 'hex', range: 6,
        desc: 'Remotely mine a target hex and one neighbour at up to range 6.'
    }
};

// ── COMMANDER DOCTRINES ─────────────────────────────────────────────────────
// Chosen at setup. Replaces the once-per-match commander button: each doctrine
// is an army-wide passive plus a 3-charge active with a 5-turn cooldown.
const DOCTRINES = {
    ua: [
        {
            id: 'ua_precision', name: 'Precision Doctrine', charges: 3, cooldown: 5,
            passive: 'Recon spotting lasts 3 turns instead of 2.',
            activeName: 'Precision Strike', target: 'unit',
            activeDesc: '4 dice, hit 4+, no save, vs a spotted enemy.'
        },
        {
            id: 'ua_resilience', name: 'Resilience Doctrine', charges: 3, cooldown: 5,
            passive: 'Pinned units recover fully at end of turn.',
            activeName: 'Rapid Fortification', target: 'none',
            activeDesc: 'Instantly Fortify up to 3 of your units.'
        }
    ],
    ru: [
        {
            id: 'ru_mass', name: 'Mass Doctrine', charges: 3, cooldown: 5,
            passive: 'Pack bonus triggers with 2 adjacent infantry instead of 3.',
            activeName: 'Mobilization Wave', target: 'none',
            activeDesc: 'Spawn 2 Assault Group tokens in your rear.'
        },
        {
            id: 'ru_fires', name: 'Fires Doctrine', charges: 3, cooldown: 5,
            passive: 'Artillery and mortars roll +1 die.',
            activeName: 'Fire Mission', target: 'hex',
            activeDesc: '4 dice on a target hex, 2 dice on its neighbours.'
        }
    ]
};

// ── ORDERS CATALOG ──────────────────────────────────────────────────────────
const ORDERS_CATALOG = {
    artillery_barrage: {
        id: 'artillery_barrage', name: 'Artillery Barrage', cp: 3, factions: ['ua', 'ru'], cooldown: 3,
        desc: '4 ATK on hex + adjacent. 6 ATK ignore DEF if Recon-spotted.'
    },
    flanking_order: {
        id: 'flanking_order', name: 'Flanking Order', cp: 2, factions: ['ua', 'ru'],
        desc: '1 unit: MOV×2, gains Flanking on arrival, adjacent attackers +1 ATK.'
    },
    recon_sweep: {
        id: 'recon_sweep', name: 'Recon Sweep', cp: 1, factions: ['ua', 'ru'],
        desc: 'Reveal all enemies within 5 tiles of any friendly. Recon-spotted 2 turns.'
    },
    mining_op: {
        id: 'mining_op', name: 'Mining Operation', cp: 2, factions: ['ua', 'ru'],
        desc: 'Place Mined on ≤3 adjacent tiles. DRG adjacent = 1 extra free mine.'
    },
    supply_run: {
        id: 'supply_run', name: 'Supply Run', cp: 1, factions: ['ua', 'ru'],
        desc: 'Restore 3 HP (5 on settlement). Remove Suppressed from target unit.'
    },
    fortify_order: {
        id: 'fortify_order', name: 'Fortify Order', cp: 2, factions: ['ua', 'ru'],
        desc: 'Instant Fortified on ≤2 friendly units. Free Settlement-Held if on neutral objective.'
    },
    glide_bomb: {
        id: 'glide_bomb', name: 'Glide Bomb (FAB-500)', cp: 4, factions: ['ru'], oncePerMatch: true,
        desc: '10 ATK on any tile; destroys bridge/settlement → Ruins. Once per match.'
    },
    human_wave: {
        id: 'human_wave', name: 'Human Wave Assault', cp: 2, factions: ['ru'],
        desc: '≤4 inf units: +2 ATK, MOV+1, ignore Suppressed this turn.'
    },
    lancet_coords: {
        id: 'lancet_coords', name: 'Lancet Coordinates', cp: 2, factions: ['ru'],
        desc: 'Deploy an extra Lancet Drone (HP 1) anywhere in friendly territory if none on board.'
    },
    fpv_swarm: {
        id: 'fpv_swarm', name: 'FPV Swarm', cp: 3, factions: ['ua'],
        desc: '3 FPV tokens (ATK 4, RNG 2, one-shot) within 4 tiles of friendly, act immediately.'
    },
    mine_belt: {
        id: 'mine_belt', name: 'Mine Belt', cp: 3, factions: ['ua'],
        desc: '6 contiguous Mined tiles within 3 of friendly. Vehicles take 7 dmg instead of 5.'
    },
    western_strike: {
        id: 'western_strike', name: 'Western Strike Package', cp: 4, factions: ['ua'], oncePerMatch: true,
        desc: '12 ATK ignore DEF on Recon-spotted target. Needs active drone nearby. Once per match.'
    },
    elastic_defense: {
        id: 'elastic_defense', name: 'Elastic Defense', cp: 2, factions: ['ua'],
        desc: '≤3 units: free move 2 tiles + instant Fortified. Fortification kept even if retreating.'
    }
};

// ── EVENT CARDS ─────────────────────────────────────────────────────────────
const EVENT_CARDS = [
    { id: 'depot_spotted',   name: 'Artillery Depot Spotted',  effect: 'active_cp_2',        desc: 'Active player gains +2 CP.' },
    { id: 'drone_interf',    name: 'Drone Interference Zone',  effect: 'drone_rng_minus1',    desc: 'All drones −1 RNG this turn.' },
    { id: 'storm_front',     name: 'Storm Front',               effect: 'move_cost_plus1',     desc: 'Movement +1 AP cost this turn.' },
    { id: 'reinforcement',   name: 'Reinforcement Window',      effect: 'place_common_free',   desc: 'Active player places 1 Common unit in rear hex free.' },
    { id: 'road_cut',        name: 'Road Cut',                  effect: 'interdict_road',      desc: 'A random road hex becomes INTERDICTED for 3 turns.' },
    { id: 'recon_flight',    name: 'Recon Flight',              effect: 'reveal_all_brief',    desc: 'Both players see all units for 5 seconds.' },
    { id: 'mud_season',      name: 'Mud Season',                effect: 'mud_2turns',          desc: 'All non-road movement +1 AP for 2 turns.' },
    { id: 'cmd_resolve',     name: "Commander's Resolve",       effect: 'reset_commanders',    desc: 'Both doctrines regain 1 active charge.' },
    { id: 'w_resupply',      name: 'Western Resupply',          effect: 'ua_free_order',       desc: 'UA: 1 free Order this turn. RU turn: no effect.' },
    { id: 'mob_surge',       name: 'Mobilization Surge',        effect: 'ru_free_token',       desc: 'RU: 1 free Assault Group token placed in rear.' },
    { id: 'intel_leak',      name: 'Intelligence Leak',         effect: 'reveal_orders_brief', desc: 'Opponent sees your Orders hand for 5 seconds.' },
    { id: 'elec_silence',    name: 'Electronic Silence',        effect: 'ew_suspend',          desc: 'All EW effects suspended this turn.' },
    { id: 'arty_duel',       name: 'Artillery Duel',            effect: 'mutual_arty_fire',    desc: 'Each side\'s nearest artillery fires at the other.' },
    { id: 'civ_corridor',    name: 'Civilian Corridor',         effect: 'no_settle_attack',    desc: 'No settlement can be attacked this turn.' },
    { id: 'friendly_fire',   name: 'Friendly Fire',             effect: 'random_1dmg',         desc: 'A random unit on each side takes 1 damage (no DEF).' },
    { id: 'logistics_hit',   name: 'Logistics Strike',          effect: 'destroy_depot',       desc: 'A random DEPOT unit on each side is destroyed.' },
    { id: 'night_drop',      name: 'Night Drop',                effect: 'ua_airborne_free',    desc: 'UA may place 1 Air Assault unit on any valid hex free.' },
    { id: 'ceasefire',       name: 'Ceasefire Window',          effect: 'no_offensive',        desc: 'No offensive actions this turn. Movement and fortify OK.' },
    { id: 'arty_alert',      name: 'Precision Strike Alert',    effect: 'arty_miss_30',        desc: 'All artillery has +30% miss chance this turn.' },
    { id: 'fl_collapse',     name: 'Frontline Collapse',        effect: 'contested_reset',     desc: 'One random contested objective reverts to neutral.' }
];

const DESTROY_VP = { C: 1, U: 2, R: 4, X: 0 };

const OBJ_VP = {
    settlement_s1: 1,
    settlement_s2: 2,
    road_junction: 1,
    bridge: 2,
    key_position: 2,
    forward_position: 2
};

// ── BATTLEGROUPS ─────────────────────────────────────────────────────────────
// Themed selectable decks. Player picks one at setup; AI picks at random.
// aggressionBias seeds the AI posture (positive = more aggressive).
const BATTLEGROUPS = {
    ua: [
        {
            id: 'ua_mech_fist', name: 'Mech Fist', aggressionBias: 0.15,
            desc: 'Armored push — tanks and IFVs with infantry support',
            cards: ['ua_terodef', 'ua_terodef', 'ua_ifv', 'ua_tank', 'ua_mech_brigade',
                    'ua_fpv', 'ua_recon_drone', 'ua_mortar', 'ua_igla', 'ua_pickup', 'ua_bike', 'ua_sf']
        },
        {
            id: 'ua_drone_war', name: 'Drone War', aggressionBias: 0,
            desc: 'ISR and precision strikes — drones, artillery, EW',
            cards: ['ua_fpv', 'ua_fpv', 'ua_vampire', 'ua_recon_drone', 'ua_recon_drone', 'ua_isr_drone',
                    'ua_loitering', 'ua_arty', 'ua_ew', 'ua_sniper', 'ua_igla', 'ua_drg', 'ua_terodef']
        },
        {
            id: 'ua_defensive_line', name: 'Defensive Line', aggressionBias: -0.15,
            desc: 'Hold ground — entrenched infantry, mines, counter-fire',
            cards: ['ua_terodef', 'ua_terodef', 'ua_terodef', 'ua_sniper', 'ua_mortar', 'ua_igla',
                    'ua_ew', 'ua_drg', 'ua_ugv_miner', 'ua_ifv', 'ua_arty', 'ua_air_assault']
        }
    ],
    ru: [
        {
            id: 'ru_armor_spearhead', name: 'Armor Spearhead', aggressionBias: 0.15,
            desc: 'Tank columns with mechanized infantry — breakthrough doctrine',
            cards: ['ru_tank_72', 'ru_tank_72', 'ru_tank_90', 'ru_btr', 'ru_motorized', 'ru_motorized',
                    'ru_heavy_drone', 'ru_fpv', 'ru_recon', 'ru_igla', 'ru_spetsnaz', 'ru_assault', 'ru_assault']
        },
        {
            id: 'ru_mass_assault', name: 'Mass Assault', aggressionBias: 0.15,
            desc: 'Wave attacks — expendable infantry mass and tempo',
            cards: ['ru_assault', 'ru_assault', 'ru_assault', 'ru_assault', 'ru_motorized', 'ru_motorized',
                    'ru_bike', 'ru_bike', 'ru_wave_regt', 'ru_mortar', 'ru_btr', 'ru_recon', 'ru_igla']
        },
        {
            id: 'ru_fires_group', name: 'Fires Group', aggressionBias: -0.15,
            desc: 'Artillery superiority — fires, drones and area denial',
            cards: ['ru_arty_regt', 'ru_mlrs', 'ru_mlrs', 'ru_zemledeliye', 'ru_mortar', 'ru_mortar', 'ru_recon', 'ru_recon',
                    'ru_lancet', 'ru_ew', 'ru_zu23', 'ru_motorized', 'ru_assault']
        }
    ]
};

// Build a deck from a battlegroup (random battlegroup if id is null/unknown),
// plus 2 random reserve cards drawn from the rest of the faction catalog.
function buildBattlegroupDeck(faction, battlegroupId) {
    const groups = BATTLEGROUPS[faction];
    const bg = groups.find(g => g.id === battlegroupId) ||
               groups[Math.floor(Math.random() * groups.length)];
    const cards = [...bg.cards];
    const pool = Object.values(CARD_CATALOG)
        .filter(c => c.faction === faction && c.tier !== TIER.X && !cards.includes(c.id))
        .map(c => c.id);
    for (let i = 0; i < 2 && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        cards.push(pool.splice(idx, 1)[0]);
    }
    return { battlegroup: bg, cards };
}

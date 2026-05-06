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
        iconPath: '../images/ua/icon-1.png',
        desc: 'Territorial defence platoon. +1 DEF in settlements. Cannot be flanked while Fortified — critical for urban defence.'
    },
    ua_fpv: {
        id: 'ua_fpv', faction: 'ua', name: 'FPV Operator',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 5, def: 0, mov: 2, rng: 4, rp: 4,
        abilities: ['one_shot', 'anti_armor', 'interceptable', 'precision_optics'],
        iconPath: '../images/ua/icon-2.png',
        desc: 'Ukrainian FPV drones (DJI converted). Kamikaze strike — destroyed after firing. +3 ATK vs tracked. IGLA can intercept. +1 ATK if target ISR-spotted.'
    },
    ua_recon_drone: {
        id: 'ua_recon_drone', faction: 'ua', name: 'Recon Drone (Mavic)',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 0, def: 0, mov: 5, rng: 5, rp: 3,
        abilities: ['recon_reveal', 'intel_zone', 'arty_spotter', 'video_feed', 'fragile'],
        iconPath: '../images/ua/icon-3.png',
        desc: 'DJI Mavic / Autel commercial drone. Attack action = recon pass: spots size-3 units at full range, size-2 at −1 hex, size-1 only at ≤2 hexes. Stationary snipers invisible. Creates Intel Zone. Fragile: dies on any hit.'
    },
    ua_sniper: {
        id: 'ua_sniper', faction: 'ua', name: 'Sniper Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 3, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['ignore_light_cover', 'suppress_on_hit', 'stealth_stationary'],
        iconPath: '../images/ua/icon-4.png',
        desc: 'Ukrainian sniper teams (SVD/Barrett). Ignores DEF from light cover. Every hit Suppresses target. Invisible to drones if stationary — set up a hide and stay still.'
    },
    ua_mortar: {
        id: 'ua_mortar', faction: 'ua', name: 'Mortar Team (M120)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 4, def: 1, mov: 2, rng: 5, rp: 5,
        abilities: ['indirect_fire', 'mine_coordination', 'setup_req'],
        iconPath: '../images/ua/icon-5.png',
        desc: '120mm mortar team. Indirect fire — ignores LoS. Setup required: cannot fire if moved this turn. Mine coordination: mortar rounds triggering nearby mines cause chain detonation.'
    },
    ua_bike: {
        id: 'ua_bike', faction: 'ua', name: 'Bike Infantry',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 5, rng: 1, rp: 3,
        abilities: ['rapid_reposition'],
        iconPath: '../images/ua/icon-6.png',
        desc: 'Motorcycle-mounted infantry. Fast repositioning — used for rapid response and flanking approaches. +1 MOV on friendly-controlled hexes.'
    },
    ua_igla: {
        id: 'ua_igla', faction: 'ua', name: 'IGLA Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['anti_air_reaction', 'fpv_intercept', 'recon_shield'],
        iconPath: '../images/ua/icon-7.png',
        desc: 'MANPADS / anti-drone team. Free intercept of 1 FPV per turn. Recon shield: friendly drones within 5 hexes cannot be intercepted. ATK 2 vs ground as last resort.'
    },
    ua_pickup: {
        id: 'ua_pickup', faction: 'ua', name: 'Pickup Technical',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 4, atk: 3, def: 1, mov: 4, rng: 2, rp: 4,
        abilities: ['supply_run', 'can_depot', 'weapon_mount'],
        iconPath: '../images/ua/icon-8.png',
        desc: 'Armed pickup truck (Hilux / Humvee). Supply run: removes Suppressed from adjacent friendlies. DEPOT mode: extends supply +3 hex. Weapon mount: can attack while in DEPOT.'
    },
    ua_drg: {
        id: 'ua_drg', faction: 'ua', name: 'DRG (Recon-Strike)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 5, atk: 4, def: 2, mov: 3, rng: 2, rp: 6,
        abilities: ['mine_layer', 'ambush', 'exfil', 'infiltrate', 'stealth_stationary'],
        iconPath: '../images/ua/icon-9.png',
        desc: 'Ukrainian recon-strike group. Mine layer: lay mines on move (1 AP). Ambush: first strike ignores DEF. Exfil: retreat to any friendly hex once. Invisible to drones when stationary in hides.'
    },
    ua_ifv: {
        id: 'ua_ifv', faction: 'ua', name: 'IFV (Bradley / Marder)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 10, atk: 6, def: 4, mov: 3, rng: 2, rp: 8,
        abilities: ['combined_arms', 'can_depot', 'transport'],
        iconPath: '../images/ua/icon-10.png',
        desc: 'M2 Bradley / Marder IFV. 25mm autocannon devastates infantry. Combined arms: adjacent infantry +1 DEF. DEPOT capable. Transports 1 infantry unit.'
    },
    ua_isr_drone: {
        id: 'ua_isr_drone', faction: 'ua', name: 'ISR Drone (Bayraktar)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 2,
        hp: 3, atk: 2, def: 0, mov: 1, rng: 6, rp: 6,
        abilities: ['permanent_isr', 'recon_reveal', 'arty_relay', 'fragile'],
        iconPath: '../images/ua/icon-11.png',
        desc: 'Bayraktar TB2 / Leleka-100. Permanent ISR: Intel Zone every turn. Active recon pass spots enemies by size. Arty relay: all friendly artillery +1 RNG. Limited MAM missiles (ATK 2). Fragile.'
    },
    ua_tank: {
        id: 'ua_tank', faction: 'ua', name: 'Tank (Leopard 2 / T-64BV)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 12, atk: 7, def: 5, mov: 2, rng: 2, rp: 9,
        abilities: ['hull_down', 'mine_immune_first', 'nato_ammo'],
        iconPath: '../images/ua/icon-12.png',
        desc: 'Leopard 2A4/A6 or upgraded T-64BV. Excellent optics and crew training. Hull-down: +2 DEF on ridgeline. First mine ignored. NATO ammo: +1 ATK vs all armored targets.'
    },
    ua_ew: {
        id: 'ua_ew', faction: 'ua', name: 'EW Unit (Bukovel-AD)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 2,
        hp: 4, atk: 0, def: 1, mov: 1, rng: 0, rp: 6,
        ewRadius: 3,
        abilities: ['ew_jamming', 'starlink_passive'],
        iconPath: '../images/ua/icon-13.png',
        desc: 'Bukovel-AD drone jammer. EW radius 3: drones lose range, artillery accuracy −30%. Starlink passive: first EW comms disruption per match is negated via satellite link.'
    },
    ua_loitering: {
        id: 'ua_loitering', faction: 'ua', name: 'Loitering Munition (Switchblade)',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 4, def: 0, mov: 0, rng: 0, rp: 6,
        abilities: ['delayed_strike', 'jammable'],
        iconPath: '../images/ua/icon-14.png',
        desc: 'Switchblade 600 / UJ-22. Designate target hex — strikes for 4 ATK (ignores cover) after 2-turn countdown. Countdown is visible to opponent. Jammable via EW zone.'
    },
    ua_arty: {
        id: 'ua_arty', faction: 'ua', name: 'Artillery (M777 / Caesar)',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 6, atk: 7, def: 1, mov: 1, rng: 8, rp: 9,
        abilities: ['precision_fire', 'shoot_and_scoot', 'counter_battery', 'indirect_fire'],
        iconPath: '../images/ua/icon-15.png',
        desc: 'M777 howitzer / Caesar wheeled SPH. Precision fire: ignores terrain DEF if target ISR-spotted. Shoot & scoot: move 1 hex after firing. Counter-battery: free return fire vs enemy arty. 155mm — ATK 7.'
    },
    ua_sf: {
        id: 'ua_sf', faction: 'ua', name: 'Special Operations (SOF)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 6, atk: 5, def: 3, mov: 3, rng: 2, rp: 7,
        abilities: ['deep_recon', 'sabotage_order', 'exfil', 'ambush', 'stealth_stationary'],
        iconPath: '../images/ua/icon-16.png',
        desc: 'Ukraine SOF (SSO). Highly trained, small signature. Deep recon: can enter enemy spawn zone. Sabotage: disable enemy DEPOT/EW (1 AP). Ambush on first strike. Invisible to drones when stationary.'
    },
    ua_air_assault: {
        id: 'ua_air_assault', faction: 'ua', name: '95th Air Assault Brigade',
        tier: TIER.R, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 9, atk: 6, def: 3, mov: 4, rng: 2, rp: 12,
        abilities: ['air_insert', 'assault_tempo', 'settlement_hold'],
        iconPath: '../images/ua/icon-17.png',
        desc: 'Elite Ukrainian airborne. Air insert: deploy on any non-enemy hex (helo assault). Assault tempo: each kill grants 1 free AP (max 2/turn). Settlement hold: +1 DEF in built-up areas.'
    },
    ua_mech_brigade: {
        id: 'ua_mech_brigade', faction: 'ua', name: 'Mechanized Brigade (54th)',
        tier: TIER.R, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 14, atk: 6, def: 5, mov: 2, rng: 2, rp: 12,
        abilities: ['combined_arms', 'defensive_depth', 'hq_action'],
        iconPath: '../images/ua/icon-18.png',
        desc: 'Full mechanized brigade with Western IFVs. Combined arms: all adjacent units +1 DEF. Defensive depth: anchors the line. HQ action: once/turn uses 1 Order at no CP cost.'
    },
    ua_commander: {
        id: 'ua_commander', faction: 'ua', name: 'Commander — SOF Strike',
        tier: TIER.X, unitClass: UNIT_CLASS.COMMAND,
        size: 1,
        hp: 0, atk: 0, def: 0, mov: 0, rng: 0, rp: 0,
        abilities: ['precision_strike_cmd'],
        iconPath: '../images/ua/icon-19.png',
        desc: 'ONCE/MATCH: Select any ISR-spotted enemy → 3 ATK ignoring all cover and DEF bonuses. Requires active drone ISR on that hex.'
    },

    // ═══════════════════ RUSSIA ════════════════════════════════════════════

    ru_assault: {
        id: 'ru_assault', faction: 'ru', name: 'Assault Infantry (Shtorm-Z)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 3, def: 1, mov: 2, rng: 1, rp: 2,
        abilities: ['wave_bonus', 'pack_bonus'],
        iconPath: '../images/ru/icon-1.png',
        desc: 'Convict assault infantry / Shtorm-Z. Expendable mass — cheap and numerous. Pack bonus: +1 ATK per 2 adjacent friendlies. Benefits from Wave Regiment aura. Losses are expected.'
    },
    ru_motorized: {
        id: 'ru_motorized', faction: 'ru', name: 'Motorized Infantry (BMP)',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 5, atk: 3, def: 2, mov: 3, rng: 1, rp: 4,
        abilities: ['road_bonus', 'suppressive_fire'],
        iconPath: '../images/ru/icon-2.png',
        desc: 'Standard Russian motorized infantry. Road bonus: +1 MOV on roads. Suppressive fire: always applies Suppressed on hit — degrades enemy coordination systematically.'
    },
    ru_fpv: {
        id: 'ru_fpv', faction: 'ru', name: 'FPV Operator',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 4, def: 0, mov: 2, rng: 3, rp: 4,
        abilities: ['one_shot', 'anti_armor', 'interceptable'],
        iconPath: '../images/ru/icon-3.png',
        desc: 'Russian FPV drone teams. Kamikaze strike — destroyed after use. Anti-armor: +3 vs tracked vehicles. Interceptable by IGLA. Slightly shorter range than UA equivalent.'
    },
    ru_bike: {
        id: 'ru_bike', faction: 'ru', name: 'Bike Infantry',
        tier: TIER.C, unitClass: UNIT_CLASS.WHEELED,
        size: 1,
        hp: 3, atk: 2, def: 0, mov: 6, rng: 1, rp: 3,
        abilities: ['flanking_bonus', 'no_fortify'],
        iconPath: '../images/ru/icon-4.png',
        desc: 'Russian assault motorcycle infantry — used en masse for rapid flanking. Cannot fortify. Flanking bonus: +2 ATK from the flank. Extremely fast (MOV 6) but fragile.'
    },
    ru_mortar: {
        id: 'ru_mortar', faction: 'ru', name: 'Mortar Team (2B14)',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 4, def: 1, mov: 2, rng: 5, rp: 5,
        abilities: ['indirect_fire', 'stealth_mine'],
        iconPath: '../images/ru/icon-5.png',
        desc: '82mm / 120mm mortar team. Indirect fire. Stealth mine: lay concealed mines (1 AP) — hidden from enemy until triggered. Russia uses mine-laying extensively as area denial.'
    },
    ru_recon: {
        id: 'ru_recon', faction: 'ru', name: 'Recon Drone (Orlan-10)',
        tier: TIER.C, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 1, atk: 0, def: 0, mov: 4, rng: 5, rp: 3,
        abilities: ['recon_reveal', 'intel_zone', 'fragile'],
        iconPath: '../images/ru/icon-6.png',
        desc: 'Orlan-10 fixed-wing UAV. Attack action = recon pass: spots size-3 at full range, size-2 at −1 hex, size-1 at ≤2 hexes. Stationary snipers/SF invisible. Fragile. Intel Zone for 1 turn.'
    },
    ru_igla: {
        id: 'ru_igla', faction: 'ru', name: 'IGLA / Strela Team',
        tier: TIER.C, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 3, atk: 2, def: 1, mov: 2, rng: 4, rp: 4,
        abilities: ['anti_air_reaction', 'fpv_intercept'],
        iconPath: '../images/ru/icon-7.png',
        desc: 'IGLA-S / Strela-10 MANPADS. Free FPV intercept once/turn. Anti-air reaction: fires at any drone entering range. Russia deploys these densely — significantly limits UA drone effectiveness.'
    },
    ru_drg: {
        id: 'ru_drg', faction: 'ru', name: 'DRG (Recon Group)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 5, atk: 4, def: 2, mov: 3, rng: 2, rp: 6,
        abilities: ['infiltrate', 'ambush', 'deep_recon', 'stealth_stationary'],
        iconPath: '../images/ru/icon-8.png',
        desc: 'Russian recon-strike DRG team. Infiltrate: may enter enemy-held hexes. Ambush: first strike ignores DEF. Deep recon. Invisible to drones when stationary — Russia relies on deep reconnaissance.'
    },
    ru_btr: {
        id: 'ru_btr', faction: 'ru', name: 'BTR Battalion (BTR-82A)',
        tier: TIER.U, unitClass: UNIT_CLASS.WHEELED,
        size: 2,
        hp: 8, atk: 4, def: 3, mov: 4, rng: 2, rp: 7,
        abilities: ['carrier', 'suppressive_fire', 'can_depot'],
        iconPath: '../images/ru/icon-9.png',
        desc: 'BTR-82A wheeled APC. 14.5mm / 30mm autocannon. Carrier: transports 1 infantry. Suppressive fire. DEPOT capable. Wheeled — fast on roads, vulnerable in broken terrain.'
    },
    ru_lancet: {
        id: 'ru_lancet', faction: 'ru', name: 'Lancet-3 Loitering',
        tier: TIER.U, unitClass: UNIT_CLASS.DRONE,
        size: 1,
        hp: 2, atk: 5, def: 0, mov: 0, rng: 5, rp: 7,
        abilities: ['delayed_strike', 'anti_armor', 'zone_denial_passive', 'interceptable'],
        iconPath: '../images/ru/icon-10.png',
        desc: 'Lancet-3 anti-armor loitering munition — Russia\'s most effective drone weapon. Designate hex, strikes for 5 ATK (+3 vs armored) after 2 turns. Zone denial. Interceptable. Most feared by UA forces.'
    },
    ru_tank_72: {
        id: 'ru_tank_72', faction: 'ru', name: 'Tank T-72B3 / T-80',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 10, atk: 7, def: 4, mov: 2, rng: 2, rp: 8,
        abilities: ['breakthrough', 'armor_class', 'mine_immune_first'],
        iconPath: '../images/ru/icon-11.png',
        desc: 'T-72B3 / T-80BV main battle tank. 125mm gun — high ATK but older armour (DEF 4). Breakthrough: ignores Overwatch on assault. Mine immune first pass. Russia uses these en masse; losses are high but numbers matter.'
    },
    ru_tank_90: {
        id: 'ru_tank_90', faction: 'ru', name: 'Tank T-90M (Proryv)',
        tier: TIER.U, unitClass: UNIT_CLASS.TRACKED,
        size: 3,
        hp: 12, atk: 8, def: 6, mov: 2, rng: 2, rp: 9,
        abilities: ['reactive_armor', 'breakthrough', 'armor_class'],
        iconPath: '../images/ru/icon-12.png',
        desc: 'T-90M Proryv — Russia\'s best tank. Kontakt-5 / Relikt ERA: first incoming attack is halved. 125mm 2A46M-4 gun. Breakthrough. Expensive and scarce; losing one is a strategic event.'
    },
    ru_spetsnaz: {
        id: 'ru_spetsnaz', faction: 'ru', name: 'Spetsnaz / VDV',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 1,
        hp: 6, atk: 5, def: 3, mov: 3, rng: 2, rp: 7,
        abilities: ['deep_recon', 'night_raid', 'ambush', 'stealth_stationary'],
        iconPath: '../images/ru/icon-13.png',
        desc: 'Russian Spetsnaz / VDV airborne. Professional soldiers. Deep recon. Night raid: +1 ATK at night. Ambush on first strike. Invisible to drones when stationary — used in covert infiltration.'
    },
    ru_zu23: {
        id: 'ru_zu23', faction: 'ru', name: 'ZU-23-2 / Tunguska',
        tier: TIER.U, unitClass: UNIT_CLASS.VEHICLE,
        size: 2,
        hp: 5, atk: 4, def: 2, mov: 2, rng: 4, rp: 6,
        abilities: ['dual_role', 'area_suppression', 'anti_air_reaction'],
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
        iconPath: '../images/ru/icon-15.png',
        desc: 'Krasukha-4 EW complex. Massive EW radius 4: all drones lose range, artillery accuracy −30%. Comms disruption: costs UA −1 CP/turn while alive. Russia\'s EW superiority is historically dominant.'
    },
    ru_naval: {
        id: 'ru_naval', faction: 'ru', name: 'Naval Infantry (810th)',
        tier: TIER.U, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 7, atk: 5, def: 3, mov: 2, rng: 2, rp: 7,
        abilities: ['amphibious', 'trench_def', 'assault_tempo'],
        iconPath: '../images/ru/icon-16.png',
        desc: '810th Naval Infantry Brigade — experienced assault unit. Amphibious: crosses rivers freely. Trench DEF: +2 DEF when Fortified in settlement or forest. Assault tempo: each kill = 1 free AP.'
    },
    ru_mlrs: {
        id: 'ru_mlrs', faction: 'ru', name: 'MLRS (BM-21 / BM-30)',
        tier: TIER.U, unitClass: UNIT_CLASS.WHEELED,
        size: 3,
        hp: 5, atk: 5, def: 1, mov: 2, rng: 6, rp: 7,
        abilities: ['area_attack', 'rapid_fire', 'indirect_fire'],
        iconPath: '../images/ru/icon-17.png',
        desc: 'BM-21 Grad / BM-30 Smerch MLRS. Area attack: hits target hex + all 6 adjacent (3 ATK each). Rapid fire: fire twice per activation. Indirect fire. Devastating area denial — used to saturate positions.'
    },
    ru_wave_regt: {
        id: 'ru_wave_regt', faction: 'ru', name: 'Wave Assault Regiment',
        tier: TIER.R, unitClass: UNIT_CLASS.INFANTRY,
        size: 2,
        hp: 6, atk: 4, def: 2, mov: 2, rng: 1, rp: 10,
        abilities: ['wave_spawn', 'human_wave_aura'],
        iconPath: '../images/ru/icon-18.png',
        desc: 'Mass assault regiment (ex-Wagner tactics). Wave spawn: generates 1 Assault Group token per turn in adjacent rear hex. Human wave aura: adjacent infantry +1 ATK on all assaults. Attrition warfare incarnate.'
    },
    ru_arty_regt: {
        id: 'ru_arty_regt', faction: 'ru', name: 'Artillery Regiment (2S3 / 2S19)',
        tier: TIER.R, unitClass: UNIT_CLASS.VEHICLE,
        size: 3,
        hp: 8, atk: 6, def: 2, mov: 1, rng: 7, rp: 10,
        abilities: ['barrage_2hex', 'counter_battery', 'double_fire', 'indirect_fire'],
        iconPath: '../images/ru/icon-19.png',
        desc: '2S3 Akatsiya / 2S19 Msta-S 152mm. Barrage: split fire across 2 hexes per activation. Counter-battery reaction. Double fire: fire twice for 2 AP. Russia\'s fire superiority — artillery accounts for 80% of casualties.'
    },
    ru_commander: {
        id: 'ru_commander', faction: 'ru', name: 'Commander — Mass Mobilization',
        tier: TIER.X, unitClass: UNIT_CLASS.COMMAND,
        size: 1,
        hp: 0, atk: 0, def: 0, mov: 0, rng: 0, rp: 0,
        abilities: ['mass_mobilization_cmd'],
        iconPath: '../images/ru/icon-20.png',
        desc: 'ONCE/MATCH: Place 3 Assault Group tokens (HP 3, ATK 3) anywhere in rear hexes. Represents emergency mobilization reserves — human wave under command pressure.'
    }
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
    { id: 'cmd_resolve',     name: "Commander's Resolve",       effect: 'reset_commanders',    desc: 'Both Commander cards may be used again this match.' },
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

// ── PRESET DECKS ─────────────────────────────────────────────────────────────
const PRESET_DECKS = {
    ua: [
        'ua_terodef', 'ua_terodef',
        'ua_fpv', 'ua_fpv',
        'ua_recon_drone',
        'ua_sniper',
        'ua_mortar',
        'ua_igla',
        'ua_ifv',
        'ua_tank',
        'ua_arty',
        'ua_ew',
        'ua_sf',
        'ua_mech_brigade'
    ],
    ru: [
        'ru_assault', 'ru_assault', 'ru_assault',
        'ru_fpv', 'ru_fpv',
        'ru_recon',
        'ru_mortar',
        'ru_igla',
        'ru_btr',
        'ru_tank_72',
        'ru_ew',
        'ru_mlrs',
        'ru_arty_regt'
    ]
};

const DESTROY_VP = { C: 0, U: 1, R: 3, X: 0 };

const OBJ_VP = {
    settlement_s1: 1,
    settlement_s2: 2,
    road_junction: 1,
    bridge: 2,
    forward_position: 3
};

'use strict';
// ── ui.js — Game UI Management ────────────────────────────────────────────

const ABILITY_LABELS = {
    // Positioning
    rapid_reposition:    ['Rapid Reposition', 'Free move when entering a friendly-held hex'],
    air_insert:          ['Air Insert',        'Can deploy anywhere, not just the spawn zone'],
    road_bonus:          ['Road Bonus',        'Half movement cost on road hexes'],
    amphibious:          ['Amphibious',        'Crosses rivers freely — no AP penalty'],
    exfil:               ['Exfil',             'Can move through enemy hexes without overwatch penalty'],
    infiltrate:          ['Infiltrate',        'Can enter enemy-occupied hexes'],
    // Attack
    anti_armor:          ['Anti-Armor',        '+3 ATK vs tracked vehicles (tanks, IFV, BTR)'],
    one_shot:            ['One Shot',          'Single use — removed from board after firing'],
    interceptable:       ['Drone',             'Can be intercepted by IGLA units mid-flight'],
    precision_optics:    ['Precision Optics',  '+1 ATK when target is ISR-spotted'],
    precision_fire:      ['Precision Fire',    '+2 ATK when target is inside an Intel Zone'],
    indirect_fire:       ['Indirect Fire',     'Attacks beyond line of sight; ignores cover'],
    area_attack:         ['Area Attack',       'Hits all units on target hex AND all 6 adjacent hexes'],
    rapid_fire:          ['Rapid Fire',        'Can fire twice per activation'],
    double_fire:         ['Double Fire',       'Fires twice for 2AP total instead of 1 shot for 3AP'],
    barrage_2hex:        ['2-Hex Barrage',     'Can split fire across 2 separate hexes per activation'],
    counter_battery:     ['Counter-Battery',   'Free return shot when this unit is targeted by artillery'],
    suppressive_fire:    ['Suppressive',       'Always applies SUPPRESSED on hit (target loses 1 AP next turn)'],
    suppress_on_hit:     ['Suppressor',        'Every hit also applies SUPPRESSED to target'],
    ignore_light_cover:  ['Ignore Cover',      'DEF bonus from forests and light terrain is ignored'],
    dual_role:           ['Dual Role',         'Can attack ground or air targets in the same turn'],
    area_suppression:    ['Area Suppression',  'Applies SUPPRESSED to ALL units in target hex'],
    breakthrough:        ['Breakthrough',      '+2 ATK when target is already SUPPRESSED'],
    shoot_and_scoot:     ['Shoot & Scoot',     'Can move 1 hex after firing at no additional AP cost'],
    nato_ammo:           ['NATO Ammo',         '+1 ATK vs FORTIFIED positions'],
    wave_bonus:          ['Wave Bonus',        '+1 ATK per adjacent friendly infantry unit'],
    pack_bonus:          ['Pack Bonus',        '+1 ATK when 2 or more friendly units are adjacent'],
    human_wave_aura:     ['Human Wave Aura',   'Adjacent friendlies gain +1 ATK on all assaults'],
    sabotage_order:      ['Sabotage',          'Can use the Sabotage special order once per match'],
    // Defense
    reactive_armor:      ['Reactive Armor',    'First incoming attack per match is halved (T-90 only)'],
    mine_immune_first:   ['Mine Immunity',     'Ignores the first mine detonation triggered'],
    hull_down:           ['Hull Down',         '+2 DEF when on a ridgeline hex'],
    home_ground:         ['Home Ground',       '+1 DEF when fighting inside a settlement hex'],
    hold_the_line:       ['Hold the Line',     'Cannot be displaced from objective hexes by normal attacks'],
    recon_shield:        ['Recon Shield',      'Nearby friendly drones cannot be intercepted by IGLA'],
    armor_class:         ['Armored',           '+1 DEF vs all infantry attacks'],
    trench_def:          ['Trench DEF',        '+2 DEF when FORTIFIED in settlement or forest'],
    defensive_depth:     ['Defensive Depth',   'Adjacent friendly units gain free OVERWATCH each turn'],
    settlement_hold:     ['Settlement Hold',   '+1 DEF in settlements; can hold against double the attackers'],
    // Recon / Intel
    intel_zone:          ['Intel Zone',        'Reveals all units within 3 hexes — enemies become visible'],
    permanent_isr:       ['Permanent ISR',     'Always provides Intel Zone regardless of movement or status'],
    arty_spotter:        ['Arty Spotter',      'Adjacent artillery gains +1 ATK and ignores terrain cover'],
    arty_relay:          ['Arty Relay',        'Any friendly artillery on the board gains a targeting bonus'],
    video_feed:          ['Video Feed',        'On entering enemy hex and surviving: opponent reveals 1 hand card'],
    deep_recon:          ['Deep Recon',        'Can enter enemy spawn zone; reveals all units there for 1 turn'],
    night_raid:          ['Night Raid',        'Ignores all night-time penalties to range and accuracy'],
    // EW
    ew_jamming:          ['EW Jamming',        'Creates EW zone: drones lose range, artillery accuracy −30%'],
    starlink_passive:    ['Starlink Passive',  'First enemy comms disruption each match is negated'],
    comms_disruption:    ['Comms Disruption',  'Costs opponent 1 CP per turn while this unit is alive'],
    zone_denial_passive: ['Zone Denial',       'Enemy units entering this hex are immediately SUPPRESSED'],
    // Drones
    fpv_intercept:       ['IGLA Intercept',    'Free reaction: shoots down 1 enemy drone per turn'],
    anti_air_reaction:   ['Anti-Air',          'Reaction shot vs any drone that enters attack range'],
    delayed_strike:      ['Loitering Munition','Designate a hex; strikes for 4 ATK after a 2-turn countdown'],
    jammable:            ['Jammable',          'Strike is cancelled if the target hex enters an EW zone'],
    // Logistics
    can_depot:           ['DEPOT Mode',        '1AP: enter DEPOT — extends supply range +3 for all adjacent allies'],
    supply_run:          ['Supply Run',        'Counts as a supply source even in enemy territory'],
    weapon_mount:        ['Weapon Mount',      'Carries light weapons — can attack while in DEPOT mode'],
    carrier:             ['Carrier',           'Can transport 1 infantry unit across the map'],
    transport:           ['Transport',         'Can carry 2 infantry units at once'],
    // Special
    fragile:             ['Fragile',           'Destroyed if any enemy ends a turn adjacent to this unit'],
    no_fortify:          ['No Fortify',        'This unit cannot dig in or take FORTIFIED status'],
    mine_layer:          ['Mine Layer',        '1AP: place hidden mines on current hex'],
    mine_coordination:   ['Mine Coordination', 'Mortar rounds that land near mines trigger chain detonation'],
    stealth_mine:        ['Stealth Mines',     'Mines placed are hidden from opponent until triggered'],
    ambush:              ['Ambush',            'First attack each turn from this hex ignores all defender DEF'],
    combined_arms:       ['Combined Arms',     '+1 ATK when adjacent to a unit of a different class'],
    assault_tempo:       ['Assault Tempo',     'Each kill grants 1 free AP immediately (max 2 per turn)'],
    hq_action:           ['HQ Action',         'Once per turn: use 1 Order card without paying its CP cost'],
    wave_spawn:          ['Wave Spawn',        'Spawns 1 Assault token in a rear hex at the start of each turn'],
    precision_strike_cmd: ['Commander Strike',   'COMMANDER: 3 ATK ignoring all cover on any ISR-spotted enemy'],
    mass_mobilization_cmd:['Mass Mobilization',  'COMMANDER: place 3 Assault tokens anywhere in rear hexes'],
    // New mechanics
    recon_reveal:         ['Recon Pass',         'Attack action = spotting pass. Spots size-3 units at full range, size-2 at −1 hex, size-1 (infantry) only ≤2 hexes. Stationary snipers/SF invisible.'],
    stealth_stationary:   ['Stealth Stationary', 'Invisible to recon drones if this unit did not move this turn. Move to reposition — but you will be spotted next recon pass.'],
    flanking_bonus:       ['Flanking Bonus',     '+2 ATK when attacking from the flank (FLANKING status)'],
};

const STATUS_LABELS = {
    SUPPRESSED:       'Suppressed — −1 ATK this turn',
    PINNED:           'Pinned — cannot move',
    FORTIFIED:        'Fortified — +1–2 DEF (cleared on move)',
    OVERWATCH:        'Overwatch — free reaction shot on entering units',
    FLANKING:         'Flanking — +1 ATK from the side',
    AMBUSH:           'In Ambush — first hit ignores DEF',
    RECON_SPOTTED:    'Spotted — visible to all enemies',
    ENCIRCLED:        'Encircled — −1 ATK and DEF',
    LOW_SUPPLY:       'Low Supply — −1 ATK, no HP regen',
    UNSUPPLIED:       'Unsupplied — −1 ATK, −1 DEF, −1 HP/turn',
    DEPOT:            'DEPOT — extending supply to adjacent allies',
    EW_SUPPRESSED:    'EW Jammed — drones lose range, arty −30% accuracy',
};

class GameUI {

    constructor() {
        this.engine = null;
        this.timerInterval = null;
        this.timerRemaining = TURN_SECONDS;
        this.pendingCommanderAbility = null;
        this._setupFaction = 'ua';
        this._setupDiff = 1.0;
        this._veteranQueue = [];
    }

    // ── Setup Screen ─────────────────────────────────────────────────────────

    initSetupScreen() {
        // Faction buttons
        document.querySelectorAll('.faction-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.faction-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._setupFaction = btn.dataset.faction;
            });
        });

        // Difficulty buttons
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._setupDiff = parseFloat(btn.dataset.diff);
            });
        });

        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('input-lat').value = btn.dataset.lat;
                document.getElementById('input-lng').value = btn.dataset.lng;
            });
        });

        // Random point (frontline area in Donetsk/Zaporizhzhia)
        document.getElementById('btn-random-point').addEventListener('click', () => {
            const presets = [
                [48.10, 37.30], [48.58, 37.95], [47.83, 35.16],
                [49.00, 36.30], [48.38, 38.48], [47.60, 36.80],
                [48.20, 37.70], [48.85, 37.50]
            ];
            const p = presets[Math.floor(Math.random() * presets.length)];
            document.getElementById('input-lat').value = p[0];
            document.getElementById('input-lng').value = p[1];
        });

        // Start button
        document.getElementById('btn-start').addEventListener('click', () => this._startGame());

        // Global tooltip for .ab-chip (title attr doesn't work inside overflow:hidden)
        const gtip = document.getElementById('gtip');
        document.addEventListener('mouseover', e => {
            const chip = e.target.closest('[data-tip]');
            if (chip) { gtip.textContent = chip.dataset.tip; gtip.classList.add('gtip-visible'); }
        });
        document.addEventListener('mousemove', e => {
            if (gtip.classList.contains('gtip-visible')) {
                const x = e.clientX + 16;
                const y = e.clientY - 10;
                // Keep inside viewport
                gtip.style.left = Math.min(x, window.innerWidth - gtip.offsetWidth - 8) + 'px';
                gtip.style.top = Math.max(4, y) + 'px';
            }
        });
        document.addEventListener('mouseout', e => {
            if (e.target.closest('[data-tip]')) gtip.classList.remove('gtip-visible');
        });

        // New game from victory screen
        document.getElementById('btn-new-game').addEventListener('click', () => {
            document.getElementById('victory-screen').style.display = 'none';
            document.getElementById('game-screen').style.display = 'none';
            document.getElementById('setup-screen').style.display = '';
            document.getElementById('setup-status').textContent = '';
            document.getElementById('btn-start').disabled = false;
        });
    }

    async _startGame() {
        const lat = parseFloat(document.getElementById('input-lat').value) || 48.10;
        const lng = parseFloat(document.getElementById('input-lng').value) || 37.30;

        document.getElementById('setup-status').textContent = 'Generating battlefield…';
        document.getElementById('btn-start').disabled = true;

        // Destroy previous game's Leaflet map so the container can be reused
        this._stopTimer();
        if (this.engine?.board) this.engine.board.destroy();
        this._actionMode = null;
        this._actionUnitId = null;
        this._selectedDeployCardId = null;
        this.pendingCommanderAbility = null;
        this._veteranQueue = [];
        document.getElementById('unit-info').style.display = 'none';

        this.engine = new GameEngine();

        // Bind engine callbacks
        this.engine.onStateChange = s => this.render(s);
        this.engine.onVeteranPromotion = r => this._showVeteranPromotion(r);
        this.engine.onEventFlip = c => this._showEventPopup(c);
        this.engine.onLog = msg => this._addLog(msg);
        this.engine.onVictory = r => this._showVictory(r);

        try {
            const state = await this.engine.startGame({
                playerFaction: this._setupFaction,
                difficulty: this._setupDiff,
                centerLat: lat,
                centerLng: lng
            });

            document.getElementById('setup-screen').style.display = 'none';
            document.getElementById('game-screen').style.display = '';

            // Init Leaflet map
            this.engine.board.initLeafletMap('map');
            this.engine.board.onHexClick = hexId => this._onHexClick(hexId);
            this.engine.board.onUnitClick = unitId => this._onUnitClick(unitId);

            this._renderAll(state);
            this._startDeployMode(state);

        } catch (e) {
            console.error('Game start failed:', e);
            document.getElementById('setup-status').textContent = 'Error: ' + e.message;
            document.getElementById('btn-start').disabled = false;
        }
    }

    // ── Deployment Mode ───────────────────────────────────────────────────────

    _startDeployMode(state) {
        document.getElementById('phase-label').textContent = 'DEPLOYMENT — Place units on your spawn zone';

        // Render deploy hand
        this._renderDeployHand(state);

        // Deploy button at top (re-use end-turn button)
        const btn = document.getElementById('btn-end-turn');
        btn.textContent = 'FINISH DEPLOY';
        btn.onclick = () => {
            this.engine.board.clearRange(); // clear spawn-zone highlight
            this._selectedDeployCardId = null;
            this.engine.finishDeployment();
            btn.textContent = 'END TURN';
            btn.onclick = () => this.engine.endPlayerTurn();
            this._startTurnTimer();
        };
    }

    _renderDeployHand(state) {
        const hand = document.getElementById('card-hand');
        hand.innerHTML = '';
        state.playerDeck.forEach(cardId => {
            const card = CARD_CATALOG[cardId];
            if (!card) return;
            const el = this._makeCardEl(card, cardId, state.playerRP);
            el.addEventListener('click', () => {
                // Select card for placement
                document.querySelectorAll('.card-el').forEach(c => c.classList.remove('card-selected'));
                el.classList.add('card-selected');
                this._selectedDeployCardId = cardId;
                // Highlight spawn hexes
                this.engine.board.showRange([...state.spawnHexIds.playerHexes], []);
            });
            hand.appendChild(el);
        });

        document.getElementById('ap-display').innerHTML =
            `<span class="res-label">RP</span><span id="rp-val">${state.playerRP}</span>`;
    }

    _abilityChips(abilities, maxShow = 99) {
        if (!abilities?.length) return '';
        const visible = abilities.slice(0, maxShow);
        const hidden  = abilities.length - visible.length;
        const chips = visible.map(ab => {
            const [label, tip] = ABILITY_LABELS[ab] || [ab, ''];
            return `<span class="ab-chip" data-tip="${tip}">${label}</span>`;
        }).join('');
        const more = hidden > 0 ? `<span class="ab-chip ab-chip-more" data-tip="${abilities.slice(maxShow).map(ab => (ABILITY_LABELS[ab]||[ab,''])[0]).join(', ')}">+${hidden}</span>` : '';
        return chips + more;
    }

    _makeCardEl(card, cardId, budget) {
        const el = document.createElement('div');
        el.className = `card-el tier-${card.tier.toLowerCase()} ${budget < card.rp ? 'card-unaffordable' : ''}`;
        el.dataset.cardId = cardId;
        el.innerHTML = `
<div class="card-header-row">
  <span class="card-tier">${TIER_LABEL[card.tier]}</span>
  <span class="card-rp">${card.rp} RP</span>
</div>
<div class="card-body-row">
  <img class="card-icon" src="${card.iconPath}" onerror="this.style.display='none'">
  <div class="card-main">
    <div class="card-name">${card.name}</div>
    <div class="card-stats">
      <span class="stat-pill" title="Hit Points">HP&nbsp;${card.hp}</span>
      <span class="stat-pill atk" title="Attack">ATK&nbsp;${card.atk}</span>
      <span class="stat-pill def" title="Defence">DEF&nbsp;${card.def}</span>
      <span class="stat-pill mov" title="Movement range">MOV&nbsp;${card.mov}</span>
      <span class="stat-pill rng" title="Attack range in hexes">RNG&nbsp;${card.rng}</span>
    </div>
    <div class="card-abilities">${this._abilityChips(card.abilities)}</div>
  </div>
</div>`;
        return el;
    }

    // ── Main Render ───────────────────────────────────────────────────────────

    render(state) {
        this._renderAll(state);
    }

    _renderAll(state) {
        this._renderHUD(state);
        this.engine.board.renderHexes(state);
        this.engine.board.renderAllUnits(state);
        this.engine.board.renderEffects(state);
        if (state.phase !== 'deploy') {
            this._renderActionHand(state);
            this._renderOrdersHand(state);
            this._renderCommanderCard(state);
        }
    }

    // ── HUD ───────────────────────────────────────────────────────────────────

    _renderHUD(state) {
        const factionFlag = state.playerFaction === 'ua' ? '🇺🇦 Ukraine' : '⚔️ Russia';
        document.getElementById('hud-faction').textContent = factionFlag;

        const phaseLabel = state.phase === 'deploy' ? 'Deployment'
            : state.phase === 'player_action' ? `Turn ${state.turn}/${MAX_TURNS}`
            : state.phase === 'ai_action' ? 'AI Turn…'
            : 'Game Over';
        document.getElementById('hud-turn').textContent = phaseLabel;

        document.getElementById('vp-player').textContent = `🇺🇦 ${state.playerVP} VP`;
        document.getElementById('vp-ai').textContent = `${state.aiVP} VP ⚔️`;

        // Weather icon
        const wIcon = { clear: '☀️', overcast: '🌥️', rain: '🌧️', storm: '⛈️' };
        const tIcon = { day: '🌅', dusk: '🌆', night: '🌙' };
        document.getElementById('hud-weather').textContent =
            `${wIcon[state.weather] || ''} ${tIcon[state.timeOfDay] || ''}`;

        // AP pips
        const apEl = document.getElementById('ap-pips');
        if (apEl && state.phase === 'player_action') {
            apEl.innerHTML = Array.from({ length: AP_PER_TURN }, (_, i) =>
                `<span class="pip ${i < state.playerAP ? 'pip-on' : 'pip-off'}"></span>`
            ).join('');
        }

        // CP pips
        const cpEl = document.getElementById('cp-pips');
        if (cpEl) {
            cpEl.innerHTML = Array.from({ length: MAX_CP }, (_, i) =>
                `<span class="pip pip-cp ${i < state.playerCP ? 'pip-on' : 'pip-off'}"></span>`
            ).join('');
        }

        // Initiative bar
        const init = state.initiative;
        document.getElementById('init-value').textContent = init;
        const pct = (init / 10) * 100;
        document.getElementById('init-fill').style.width = `${pct}%`;
        document.getElementById('init-fill').style.background =
            init >= 7 ? '#4caf50' : init <= 3 ? '#f44336' : '#ffc107';
        document.getElementById('init-marker').style.left = `calc(${pct}% - 6px)`;

        // Phase label
        const pl = document.getElementById('phase-label');
        if (state.phase === 'player_action') pl.textContent = `AP: ${state.playerAP}/${AP_PER_TURN}`;
        else if (state.phase === 'ai_action') pl.textContent = 'AI thinking…';
    }

    // ── Card Hand (in-game) ───────────────────────────────────────────────────

    _renderActionHand(state) {
        const hand = document.getElementById('card-hand');
        hand.innerHTML = '';

        if (state.phase !== 'player_action') return;

        // Show all living player units as selectable cards
        state.units.forEach(unit => {
            if (unit.faction !== 'player' || unit.hp <= 0) return;
            const card = CARD_CATALOG[unit.cardId];
            if (!card) return;

            const apCost = TIER_AP[card.tier];
            const canAct = state.playerAP >= apCost;
            const isSelected = state.selectedUnit === unit.id;

            const hpPct = Math.max(0, Math.round((unit.hp / unit.maxHp) * 100));
            const hpColor = hpPct > 60 ? '#4caf50' : hpPct > 30 ? '#ff9800' : '#f44336';
            const supplyBadge = unit.status.has(STATUS.UNSUPPLIED) ? '<span class="ab-chip chip-danger">No Supply</span>'
                : unit.status.has(STATUS.LOW_SUPPLY) ? '<span class="ab-chip chip-warn">Low Supply</span>' : '';
            const statusBadges = [...unit.status]
                .filter(s => s !== STATUS.LOW_SUPPLY && s !== STATUS.UNSUPPLIED)
                .map(s => `<span class="ab-chip chip-status" data-tip="${STATUS_LABELS[s] || s}">${s.replace(/_/g,' ')}</span>`)
                .join('');
            const expBadge = unit.experience >= 3 ? '<span class="ab-chip chip-vet">VETERAN</span>'
                : unit.experience >= 1 ? '<span class="ab-chip chip-bld">Blooded</span>' : '';

            const el = document.createElement('div');
            el.className = `card-el tier-${card.tier.toLowerCase()} ${!canAct ? 'card-unaffordable' : ''} ${isSelected ? 'card-selected' : ''}`;
            el.innerHTML = `
<div class="card-header-row">
  <span class="card-name">${unit.realName || card.name}</span>
  <span class="card-ap-cost">${apCost}AP</span>
</div>
<div class="card-body-row">
  <img class="card-icon" src="${card.iconPath}" onerror="this.style.display='none'">
  <div class="card-main">
    <div class="hp-bar-wrap"><div class="hp-bar-fill" style="width:${hpPct}%;background:${hpColor}"></div></div>
    <div class="card-stats">
      <span class="stat-pill" title="Hit Points">HP&nbsp;${unit.hp}/${unit.maxHp}</span>
      <span class="stat-pill atk" title="Attack">ATK&nbsp;${unit.atk}</span>
      <span class="stat-pill def" title="Defence">DEF&nbsp;${unit.def}</span>
      <span class="stat-pill mov" title="Move range (hexes)">MOV&nbsp;${unit.mov}</span>
      <span class="stat-pill rng" title="Attack range (hexes)">RNG&nbsp;${unit.rng}</span>
    </div>
    <div class="card-abilities">${expBadge}${supplyBadge}${statusBadges}${this._abilityChips(card.abilities, 3)}</div>
  </div>
</div>
<div class="card-actions">
  <button class="act-btn" data-act="move" ${!canAct ? 'disabled' : ''} title="Move this unit (${apCost}AP) — click hex to move">Move</button>
  <button class="act-btn" data-act="attack" ${!canAct ? 'disabled' : ''} title="Attack (${apCost}AP) — click enemy hex or unit">Attack</button>
  <button class="act-btn" data-act="fortify" ${!canAct || card.abilities?.includes('no_fortify') ? 'disabled' : ''} title="Fortify: +DEF, gain Overwatch (${apCost}AP)">Fortify</button>
  ${card.abilities?.includes('can_depot') ? `<button class="act-btn" data-act="depot" ${!canAct ? 'disabled' : ''} title="Enter DEPOT: extend supply +3 to adjacent allies (${apCost}AP)">DEPOT</button>` : ''}
  ${card.abilities?.includes('delayed_strike') ? `<button class="act-btn" data-act="loiter" ${!canAct ? 'disabled' : ''} title="Designate loitering target hex — 4 ATK after 2 turns">Designate</button>` : ''}
</div>`;

            el.querySelector('[data-act="move"]')?.addEventListener('click', e => {
                e.stopPropagation();
                this._setActionMode(unit.id, 'move', state);
            });
            el.querySelector('[data-act="attack"]')?.addEventListener('click', e => {
                e.stopPropagation();
                this._setActionMode(unit.id, 'attack', state);
            });
            el.querySelector('[data-act="fortify"]')?.addEventListener('click', e => {
                e.stopPropagation();
                this.engine.fortifyUnit(unit.id);
            });
            el.querySelector('[data-act="depot"]')?.addEventListener('click', e => {
                e.stopPropagation();
                this.engine.activateDepot(unit.id);
            });
            el.querySelector('[data-act="loiter"]')?.addEventListener('click', e => {
                e.stopPropagation();
                this._setActionMode(unit.id, 'loiter', state);
            });

            el.addEventListener('click', () => {
                this.engine.selectUnit(unit.id);
                this._focusOnUnit(unit);
            });

            hand.appendChild(el);
        });
    }

    _setActionMode(unitId, mode, state) {
        this._actionMode = mode;
        this._actionUnitId = unitId;
        this.engine.selectUnit(unitId, true); // force-select, never toggle off

        const unit = state.units.get(unitId);
        const card = CARD_CATALOG[unit.cardId];

        document.getElementById('phase-label').textContent =
            mode === 'move' ? `Moving ${card.name} — click target hex` :
            mode === 'attack' ? `Attacking with ${card.name} — click enemy hex` :
            `Designating loitering target — click hex`;
    }

    _renderOrdersHand(state) {
        const area = document.getElementById('orders-hand');
        area.innerHTML = '';
        if (state.phase !== 'player_action') return;

        const availOrders = this.engine.getAvailableOrderIds();

        availOrders.forEach(orderId => {
            const order = ORDERS_CATALOG[orderId];
            const canAfford = state.playerCP >= order.cp || state.freeOrderUse > 0;
            const el = document.createElement('div');
            el.className = `order-card ${!canAfford ? 'order-unaffordable' : ''}`;
            el.innerHTML = `
<div class="order-name">${order.name}</div>
<div class="order-cp">${order.cp} CP</div>
<div class="order-desc">${order.desc}</div>`;
            el.addEventListener('click', () => {
                if (!canAfford) return;
                this._handleOrderClick(orderId, order, state);
            });
            area.appendChild(el);
        });
    }

    _renderCommanderCard(state) {
        const area = document.getElementById('commander-card');
        const used = state.playerCommanderUsed;
        const cmdId = `${state.playerFaction}_commander`;
        const card = CARD_CATALOG[cmdId];
        if (!card) return;

        area.innerHTML = `
<div class="cmd-card ${used ? 'cmd-used' : ''}">
  <div class="cmd-name">${card.name}</div>
  <div class="cmd-desc">${card.desc}</div>
  <button class="cmd-btn" ${used ? 'disabled' : ''} id="use-commander">USE</button>
</div>`;

        document.getElementById('use-commander')?.addEventListener('click', () => {
            const result = this.engine.usePlayerCommander();
            if (result.ok && result.needTarget) {
                this.pendingCommanderAbility = result.ability;
                document.getElementById('phase-label').textContent = 'COMMANDER: Click a spotted enemy unit';
            }
        });
    }

    // ── Hex / Unit Click Handlers ─────────────────────────────────────────────

    _onHexClick(hexId) {
        const state = this.engine.state;
        if (!state) return;
        console.log('[HEX CLICK]', hexId, 'phase:', state.phase, 'selectedUnit:', state.selectedUnit, 'actionMode:', this._actionMode);

        // Deploy mode: place selected card
        if (state.phase === 'deploy' && this._selectedDeployCardId) {
            const result = this.engine.deployPlayerUnit(this._selectedDeployCardId, hexId);
            if (result.ok) {
                this._selectedDeployCardId = null;
                this.engine.board.clearRange();
                document.querySelectorAll('.card-el').forEach(c => c.classList.remove('card-selected'));
                this._renderDeployHand(state);
                this._renderAll(state);
            } else {
                this._flashStatus(result.error);
            }
            return;
        }

        if (state.phase !== 'player_action') return;

        // Pending commander ability
        if (this.pendingCommanderAbility === 'precision_strike_cmd') {
            // Try to find enemy unit on clicked hex
            const enemies = [...state.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);
            if (enemies.length > 0) {
                const result = this.engine.executePrecisionStrike(enemies[0].id);
                if (result.ok) {
                    this.pendingCommanderAbility = null;
                    document.getElementById('phase-label').textContent = '';
                } else {
                    this._flashStatus(result.error);
                }
            }
            return;
        }

        // Handle explicit pending action (from card buttons)
        if (this._actionMode && this._actionUnitId) {
            if (this._actionMode === 'move') {
                const result = this.engine.moveUnit(this._actionUnitId, hexId);
                if (!result.ok) this._flashStatus(result.error);
                this._clearActionMode();
            } else if (this._actionMode === 'attack') {
                const enemies = [...state.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);
                if (enemies.length > 0) {
                    const result = this.engine.attackUnit(this._actionUnitId, hexId);
                    if (!result.ok) this._flashStatus(result.error);
                } else {
                    this._flashStatus('No enemy unit on that hex');
                }
                this._clearActionMode();
            } else if (this._actionMode === 'loiter') {
                const result = this.engine.designateLoitering(this._actionUnitId, hexId);
                if (!result.ok) this._flashStatus(result.error || 'Designation failed');
                this._clearActionMode();
            }
            return;
        }

        // Smart click: unit already selected via map, infer action from clicked hex
        if (state.selectedUnit) {
            const selUnit = state.units.get(state.selectedUnit);
            if (selUnit && selUnit.faction === 'player' && selUnit.hp > 0) {
                const enemies = [...state.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);
                const friendly = [...state.units.values()].filter(u => u.faction === 'player' && u.hexId === hexId && u.hp > 0);

                if (enemies.length > 0) {
                    // Attack
                    const result = this.engine.attackUnit(state.selectedUnit, hexId);
                    if (!result.ok) this._flashStatus(result.error);
                    this.engine.state.selectedUnit = null;
                    this.engine.state.moveRange = null;
                    this.engine.state.attackRange = null;
                    this.engine._notify();
                } else if (friendly.length > 0 && friendly[0].id !== state.selectedUnit) {
                    // Switch selection to the friendly on this hex
                    this.engine.selectUnit(friendly[0].id);
                } else if (friendly.length === 0) {
                    // Move
                    const result = this.engine.moveUnit(state.selectedUnit, hexId);
                    if (!result.ok) this._flashStatus(result.error);
                    else {
                        this.engine.state.selectedUnit = null;
                        this.engine.state.moveRange = null;
                        this.engine.state.attackRange = null;
                        this.engine._notify();
                    }
                }
                return;
            }
        }

        // Select friendly unit on hex (or deselect)
        const friendlyUnits = [...state.units.values()].filter(u => u.faction === 'player' && u.hexId === hexId && u.hp > 0);
        if (friendlyUnits.length > 0) {
            this.engine.selectUnit(friendlyUnits[0].id);
        } else if (state.selectedUnit) {
            this.engine.selectUnit(state.selectedUnit); // toggles off
        }
    }

    _onUnitClick(unitId) {
        const state = this.engine.state;
        if (!state || state.phase !== 'player_action') return;

        const unit = state.units.get(unitId);
        if (!unit) return;

        // Enemy unit clicked during attack mode
        if (this._actionMode === 'attack' && this._actionUnitId && unit.faction === 'ai') {
            const result = this.engine.attackUnit(this._actionUnitId, unit.hexId);
            if (!result.ok) this._flashStatus(result.error);
            this._clearActionMode();
            return;
        }

        // Enemy during commander precision strike
        if (this.pendingCommanderAbility === 'precision_strike_cmd' && unit.faction === 'ai') {
            const result = this.engine.executePrecisionStrike(unitId);
            if (result.ok) {
                this.pendingCommanderAbility = null;
                document.getElementById('phase-label').textContent = '';
            } else {
                this._flashStatus(result.error);
            }
            return;
        }

        if (unit.faction === 'player') {
            // Clicking a selected unit again → deselect
            if (state.selectedUnit === unitId) {
                this.engine.selectUnit(unitId); // toggles off
                this._clearActionMode();
                document.getElementById('unit-info').style.display = 'none';
            } else {
                // Select and show range — subsequent hex click will smart-route
                this.engine.selectUnit(unitId);
                this._showUnitInfo(unit, state);
                document.getElementById('phase-label').textContent =
                    `${CARD_CATALOG[unit.cardId]?.name || unit.displayName} — click hex to move/attack`;
            }
        } else if (unit.faction === 'ai') {
            // Clicking enemy during smart-select attack
            if (state.selectedUnit) {
                const result = this.engine.attackUnit(state.selectedUnit, unit.hexId);
                if (!result.ok) this._flashStatus(result.error);
                else {
                    this.engine.state.selectedUnit = null;
                    this.engine.state.moveRange = null;
                    this.engine.state.attackRange = null;
                    this.engine._notify();
                }
            }
        }
    }

    _clearActionMode() {
        this._actionMode = null;
        this._actionUnitId = null;
        this.engine.board.clearRange();
        const state = this.engine.state;
        if (state) {
            state.selectedUnit = null;
            state.moveRange = null;
            state.attackRange = null;
            document.getElementById('phase-label').textContent = `AP: ${state.playerAP}/${AP_PER_TURN}`;
        }
    }

    // ── Unit Info Panel ───────────────────────────────────────────────────────

    _showUnitInfo(unit, state) {
        const card = CARD_CATALOG[unit.cardId];
        const panel = document.getElementById('unit-info');
        const name = unit.realName || unit.displayName;
        const hpPct = Math.max(0, Math.round((unit.hp / unit.maxHp) * 100));
        const hpColor = hpPct > 60 ? '#4caf50' : hpPct > 30 ? '#ff9800' : '#f44336';
        const apCost = TIER_AP[card.tier];
        const expLabel = unit.experience >= 3 ? '<span class="ab-chip chip-vet">VETERAN</span>'
            : unit.experience >= 1 ? '<span class="ab-chip chip-bld">Blooded</span>' : '';
        const tierLabel = TIER_LABEL[card.tier] || card.tier;
        const factionLabel = unit.faction === 'player' ? (state.playerFaction === 'ua' ? '🇺🇦 Ukraine' : '🪖 Russia') : (state.aiFaction === 'ua' ? '🇺🇦 Ukraine' : '🪖 Russia');

        const abilitiesHtml = (card.abilities || []).map(ab => {
            const [label, tip] = ABILITY_LABELS[ab] || [ab, ''];
            return `<div class="info-ability"><span class="ab-chip">${label}</span><span class="info-ability-desc">${tip}</span></div>`;
        }).join('');

        const statusHtml = [...unit.status].length
            ? [...unit.status].map(s => {
                const desc = STATUS_LABELS[s] || s;
                return `<div class="info-status-row"><span class="ab-chip chip-status">${s.replace(/_/g,' ')}</span><span class="info-ability-desc">${desc}</span></div>`;
            }).join('')
            : '<div class="info-ability-desc" style="color:#888">No active status effects</div>';

        const supplyStatus = unit.status.has(STATUS.UNSUPPLIED) ? '<span class="ab-chip chip-danger">No Supply</span> -1 HP/turn'
            : unit.status.has(STATUS.LOW_SUPPLY) ? '<span class="ab-chip chip-warn">Low Supply</span> -1 ATK'
            : '<span class="ab-chip chip-ok">Supplied</span>';

        panel.innerHTML = `
<div class="info-header">
  <div>
    <div class="info-name">${name} ${expLabel}</div>
    <div class="info-meta">${factionLabel} · ${tierLabel} · ${apCost}AP to activate</div>
  </div>
  <button class="info-close" id="unit-info-close">✕</button>
</div>
<div class="info-hp-bar"><div class="info-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div></div>
<div class="info-hp-text">HP ${unit.hp} / ${unit.maxHp}</div>
<div class="info-stat-grid">
  <div class="info-stat"><span class="info-stat-val atk">${unit.atk}</span><span class="info-stat-lbl">ATK</span></div>
  <div class="info-stat"><span class="info-stat-val def">${unit.def}</span><span class="info-stat-lbl">DEF</span></div>
  <div class="info-stat"><span class="info-stat-val mov">${unit.mov}</span><span class="info-stat-lbl">MOV</span></div>
  <div class="info-stat"><span class="info-stat-val rng">${unit.rng}</span><span class="info-stat-lbl">RNG</span></div>
</div>
<div class="info-section-label">SUPPLY</div>
<div class="info-ability">${supplyStatus}</div>
${abilitiesHtml ? `<div class="info-section-label">ABILITIES</div>${abilitiesHtml}` : ''}
<div class="info-section-label">STATUS EFFECTS</div>
${statusHtml}
<div class="info-desc">${card.desc}</div>`;

        panel.style.display = '';
        document.getElementById('unit-info-close').onclick = () => { panel.style.display = 'none'; };
    }

    // ── Order Handlers ────────────────────────────────────────────────────────

    _handleOrderClick(orderId, order, state) {
        // Some orders need a target — for now prompt via click
        const needsUnitTarget = ['artillery_barrage', 'supply_run', 'flanking_order'].includes(orderId);

        if (needsUnitTarget) {
            this._actionMode = `order_${orderId}`;
            this._pendingOrder = { orderId, order };
            document.getElementById('phase-label').textContent = `Order: ${order.name} — click target unit`;
        } else {
            const result = this.engine.useOrder(orderId, null, null);
            if (!result.ok) this._flashStatus(result.error || 'Order failed');
        }
    }

    // ── Timer ─────────────────────────────────────────────────────────────────

    _startTurnTimer() {
        this._stopTimer();
        this.timerRemaining = TURN_SECONDS;
        this._updateTimerRing(TURN_SECONDS);

        this.timerInterval = setInterval(() => {
            this.timerRemaining--;
            this._updateTimerRing(this.timerRemaining);
            if (this.timerRemaining <= 0) {
                this._stopTimer();
                this.engine.endPlayerTurn();
            }
        }, 1000);
    }

    _stopTimer() {
        if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    }

    _updateTimerRing(seconds) {
        const circumference = 2 * Math.PI * 18; // r=18
        const pct = seconds / TURN_SECONDS;
        const offset = circumference * (1 - pct);
        const ring = document.getElementById('timer-ring');
        const text = document.getElementById('timer-text');
        if (ring) ring.setAttribute('stroke-dashoffset', offset.toFixed(1));
        if (text) text.textContent = Math.max(0, seconds);
        const color = seconds > 10 ? '#e8c84a' : seconds > 5 ? '#f5922e' : '#f44336';
        if (ring) ring.setAttribute('stroke', color);
        if (text) text.setAttribute('fill', color);
    }

    // ── Event Popup ───────────────────────────────────────────────────────────

    _showEventPopup(card) {
        const popup = document.getElementById('event-popup');
        document.getElementById('event-title').textContent = card.name;
        document.getElementById('event-desc').textContent = card.desc;
        popup.style.display = '';
        setTimeout(() => { popup.style.display = 'none'; }, 4000);
    }

    // ── Veteran Promotion ─────────────────────────────────────────────────────

    _showVeteranPromotion(result) {
        const unit = result.unit;
        if (result.type === 'blooded') {
            // Show stat choice dialog
            const overlay = document.createElement('div');
            overlay.className = 'veteran-overlay';
            overlay.innerHTML = `
<div class="veteran-box">
  <div class="vet-title">⚔️ ${unit.displayName} — BLOODED</div>
  <div class="vet-sub">First kill! Choose a permanent bonus:</div>
  <div class="vet-choices">
    <button class="vet-choice" data-stat="atk">+1 ATK</button>
    <button class="vet-choice" data-stat="def">+1 DEF</button>
  </div>
</div>`;
            document.body.appendChild(overlay);
            overlay.querySelectorAll('.vet-choice').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.engine.combat.applyVeteranBonus(unit, btn.dataset.stat);
                    overlay.remove();
                    this.engine._notify();
                });
            });
        } else if (result.type === 'veteran') {
            // Just show a flash notification
            this._flashStatus(`⭐ ${unit.displayName} is now a VETERAN!`, 3000);
            this.engine.combat.applyVeteranName(unit, unit.displayName);
        }
    }

    // ── Victory Screen ────────────────────────────────────────────────────────

    _showVictory(result) {
        this._stopTimer();
        const screen = document.getElementById('victory-screen');
        const isWin = result.winner === 'player';

        document.getElementById('victory-label').textContent = isWin ? '🏆 VICTORY' : '💀 DEFEAT';
        document.getElementById('victory-label').className = isWin ? 'victory-win' : 'victory-loss';
        document.getElementById('victory-detail').textContent = `${result.reason} · ${result.vpLabel}`;
        document.getElementById('victory-vp').textContent =
            `Player ${result.playerVP} VP — AI ${result.aiVP} VP`;

        screen.style.display = '';
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    _addLog(msg) {
        // Could render a scrolling log — for now just console
        console.log('[FRONTLINE]', msg);
    }

    _flashStatus(msg, duration = 2500) {
        let el = document.getElementById('flash-msg');
        if (!el) {
            el = document.createElement('div');
            el.id = 'flash-msg';
            el.className = 'flash-msg';
            document.getElementById('game-screen').appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(this._flashTimeout);
        this._flashTimeout = setTimeout(() => { el.style.opacity = '0'; }, duration);
    }

    _focusOnUnit(unit) {
        const hex = this.engine.board.hexes.get(unit.hexId);
        if (!hex || !this.engine.board._map) return;
        const [lng, lat] = hex.centroid;
        this.engine.board._map.panTo([lat, lng], { animate: true, duration: 0.3 });
    }
}

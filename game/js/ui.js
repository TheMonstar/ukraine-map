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
    anti_armor:          ['Anti-Armor',        '+2 ATK vs tracked vehicles (tanks, IFV, BTR)'],
    night_hunter:        ['Night Hunter',      '−1 to-hit at night (thermal optics) instead of the usual night penalty'],
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
    reactive_armor:      ['Reactive Armor',    'First incoming attack each turn is halved (T-90 only)'],
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
    // New mechanics
    recon_reveal:         ['Recon Pass',         'Attack action = spotting pass. Spots size-3 units at full range, size-2 at −1 hex, size-1 (infantry) only ≤2 hexes. Stationary snipers/SF invisible.'],
    stealth_stationary:   ['Stealth Stationary', 'Invisible to recon drones if this unit did not move this turn. Move to reposition — but you will be spotted next recon pass.'],
    flanking_bonus:       ['Flanking Bonus',     '+2 ATK when attacking from the flank (FLANKING status)'],
};

// Keyed by the STATUS string values stored in unit.status
const STATUS_LABELS = {
    suppressed:       'Suppressed — +1 to-hit penalty when attacking this turn',
    pinned:           'Pinned — cannot move',
    fortified:        'Fortified — better save (cleared on move)',
    overwatch:        'Overwatch — free reaction shot on entering units',
    flanking:         'Flanked — attackers hit this unit on −1 to-hit',
    ambush:           'In Ambush — first strike denies the enemy save',
    recon_spotted:    'Spotted 👁 — visible to all enemies, they hit on −1 to-hit',
    marked:           'Marked 🎯 — −1 save for 2 turns',
    encircled:        'Encircled — −1 ATK and DEF',
    low_supply:       'Low Supply — −1 ATK, no HP regen',
    unsupplied:       'Unsupplied — −1 ATK, −1 DEF, −1 HP/turn',
    depot:            'DEPOT — extending supply to adjacent allies',
    ew_suppressed:    'EW Jammed — cannot attack, drones grounded; leave the purple zone',
};

class GameUI {

    constructor() {
        this.engine = null;
        this.timerInterval = null;
        this.timerRemaining = TURN_SECONDS;
        this._doctrineTargetType = null;
        this._setupFaction = 'ua';
        this._setupDiff = 1.0;
        this._setupBattlegroup = null;
        this._setupDoctrine = null;
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
                this._renderBattlegroupChoice();
                this._renderDoctrineChoice();
            });
        });

        this._renderBattlegroupChoice();
        this._renderDoctrineChoice();

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

        // Random point ON the real frontline (boundary of the occupied area);
        // falls back to a static list if the data is unavailable
        document.getElementById('btn-random-point').addEventListener('click', async () => {
            const btn = document.getElementById('btn-random-point');
            btn.disabled = true;
            try {
                const cands = await this._frontCandidates();
                if (!cands.length) throw new Error('no balanced front points');
                const [lat, lng] = cands[Math.floor(Math.random() * cands.length)];
                document.getElementById('input-lat').value = lat.toFixed(2);
                document.getElementById('input-lng').value = lng.toFixed(2);
            } catch (e) {
                const fallbacks = [[48.01, 37.07], [47.88, 36.53], [47.63, 36.18], [49.70, 37.60]];
                const p = fallbacks[Math.floor(Math.random() * fallbacks.length)];
                document.getElementById('input-lat').value = p[0];
                document.getElementById('input-lng').value = p[1];
            } finally {
                btn.disabled = false;
            }
        });

        // Snap the named presets to the current front (async, non-blocking)
        this._refreshPresetButtons();

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

        // Legend / rules overlay
        document.getElementById('btn-legend').addEventListener('click', () => this._toggleLegend());

        // Battle log collapse/expand
        document.getElementById('log-head').addEventListener('click', () => {
            const entries = document.getElementById('log-entries');
            const collapsed = entries.style.display === 'none';
            entries.style.display = collapsed ? '' : 'none';
            document.getElementById('log-toggle').textContent = collapsed ? '▾' : '▸';
            if (collapsed) entries.scrollTop = entries.scrollHeight;
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

    // Balanced points on the real front: occupied-boundary vertices whose ±9 km
    // probes fall partly inside and partly outside the occupied area (the outer
    // ring also includes state borders, which a plain vertex pick would hit).
    async _frontCandidates() {
        if (this._frontCands) return this._frontCands;
        const geo = await TerrainLoader.fetchControlGeo();
        // All occupied polygons — the front spans several (north pockets etc.)
        const polys = geo.features
            .filter(f => f.geometry?.type === 'Polygon' &&
                         ['#a52714', '#880e4f'].includes(f.properties?.fill));
        // Union once so candidates are scored exactly as classifyFront will,
        // and probe at the board half-extent (~18 km) so a candidate predicts
        // the real on-board UA/RU split, not just a local notch.
        let union = polys[0];
        for (let i = 1; i < polys.length; i++) {
            try { union = turf.union(union, polys[i]); } catch (e) {}
        }
        const dLat = 16 / 110.574;                                    // ~16 km in latitude
        const out = [];
        polys.forEach(poly => {
            const ring = poly.geometry.coordinates[0];
            for (let i = 0; i < ring.length; i += 3) {
                const [lng, lat] = ring[i];
                if (lat < 46.2 || lat > 50.6 || lng < 32.5 || lng > 38.9) continue;
                const dLng = 16 / (111.32 * Math.cos(lat * Math.PI / 180)); // ~16 km in longitude
                let inside = 0;
                [[lng + dLng, lat], [lng - dLng, lat], [lng, lat + dLat], [lng, lat - dLat]]
                    .forEach(p => { if (turf.booleanPointInPolygon(turf.point(p), union)) inside++; });
                if (inside === 2) out.push([lat, lng]); // 2/4 = a real two-sided board
            }
        });
        this._frontCands = out;
        return out;
    }

    // Presets are named axes with approximate anchors; snap each to the nearest
    // balanced point on the live front so they never go stale as the line moves
    async _refreshPresetButtons() {
        try {
            const cands = await this._frontCandidates();
            if (!cands.length) return;
            const defaults = {
                lat: document.getElementById('input-lat').value,
                lng: document.getElementById('input-lng').value
            };
            document.querySelectorAll('.preset-btn').forEach(btn => {
                const aLat = parseFloat(btn.dataset.lat);
                const aLng = parseFloat(btn.dataset.lng);
                let best = null, bd = Infinity;
                cands.forEach(([lat, lng]) => {
                    const d = (lat - aLat) ** 2 + (lng - aLng) ** 2;
                    if (d < bd) { bd = d; best = [lat, lng]; }
                });
                if (best && bd < 0.25) { // within ~0.5° (~50 km) of the axis anchor
                    btn.dataset.lat = best[0].toFixed(2);
                    btn.dataset.lng = best[1].toFixed(2);
                    btn.title = `Snapped to the current front: ${best[0].toFixed(2)}, ${best[1].toFixed(2)}`;
                }
            });
            // If the user hasn't touched the inputs, point them at a live preset
            const first = document.querySelector('.preset-btn[data-lat]');
            if (first &&
                document.getElementById('input-lat').value === defaults.lat &&
                document.getElementById('input-lng').value === defaults.lng) {
                const pokrovsk = [...document.querySelectorAll('.preset-btn')]
                    .find(b => b.textContent.includes('Pokrovsk')) || first;
                document.getElementById('input-lat').value = pokrovsk.dataset.lat;
                document.getElementById('input-lng').value = pokrovsk.dataset.lng;
            }
        } catch (e) {
            console.warn('Preset snap to live front failed:', e.message);
        }
    }

    _renderBattlegroupChoice() {
        const wrap = document.getElementById('bg-choice');
        wrap.innerHTML = '';
        BATTLEGROUPS[this._setupFaction].forEach((bg, i) => {
            const btn = document.createElement('button');
            btn.className = 'diff-btn' + (i === 0 ? ' active' : '');
            btn.textContent = bg.name;
            btn.title = bg.desc;
            btn.addEventListener('click', () => {
                wrap.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._setupBattlegroup = bg.id;
            });
            wrap.appendChild(btn);
        });
        this._setupBattlegroup = BATTLEGROUPS[this._setupFaction][0].id;
    }

    _renderDoctrineChoice() {
        const wrap = document.getElementById('doc-choice');
        wrap.innerHTML = '';
        DOCTRINES[this._setupFaction].forEach((doc, i) => {
            const btn = document.createElement('button');
            btn.className = 'diff-btn' + (i === 0 ? ' active' : '');
            btn.textContent = doc.name;
            btn.title = `Passive: ${doc.passive}\n${doc.activeName}: ${doc.activeDesc}`;
            btn.addEventListener('click', () => {
                wrap.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._setupDoctrine = doc.id;
            });
            wrap.appendChild(btn);
        });
        this._setupDoctrine = DOCTRINES[this._setupFaction][0].id;
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
        this._doctrineTargetType = null;
        this._veteranQueue = [];
        document.querySelectorAll('.veteran-overlay').forEach(el => el.remove());
        document.getElementById('unit-info').style.display = 'none';
        document.getElementById('log-entries').innerHTML = '';

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
                battlegroup: this._setupBattlegroup,
                doctrine: this._setupDoctrine,
                centerLat: lat,
                centerLng: lng
            });

            document.getElementById('setup-screen').style.display = 'none';
            document.getElementById('game-screen').style.display = '';

            // Init Leaflet map
            this.engine.board.initLeafletMap('map');
            this.engine.board.onHexClick = hexId => this._onHexClick(hexId);
            this.engine.board.onUnitClick = unitId => this._onUnitClick(unitId);
            this.engine.board.onHexHover = hexId => this._onHexHover(hexId);

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
        this._renderActionBar(state);
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
</div>`;

            // Cards are compact status displays — all actions live in the action bar
            el.addEventListener('click', () => {
                this.engine.selectUnit(unit.id, true);
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

    // ── Legend / Rules Overlay ────────────────────────────────────────────────

    _toggleLegend() {
        const el = document.getElementById('legend-overlay');
        if (el.style.display !== 'none') { el.style.display = 'none'; return; }

        if (!el.innerHTML) {
            const terrainColors = {
                open: '#c8b87a', agricultural: '#d4c98a', forest_light: '#4a7c4e',
                forest_dense: '#2a5a2e', settlement_s1: '#a08060', settlement_s2: '#805040',
                wetland: '#6a8a6a', industrial: '#707070', ridgeline: '#9a8060'
            };
            const terrainRows = Object.entries(TERRAIN_RULES).map(([type, r]) => `
<tr><td><span class="lg-swatch" style="background:${terrainColors[type] || '#999'}"></span> ${type.replace(/_/g, ' ')}</td>
<td>${r.moveCost}</td><td>+${r.defMod}</td><td>${r.stackLimit}</td></tr>`).join('');

            el.innerHTML = `
<div class="legend-box">
  <div class="legend-head">RULES &amp; LEGEND <button id="legend-close">✕</button></div>
  <div class="legend-cols">
    <div>
      <div class="lg-title">TERRAIN</div>
      <table class="lg-table"><tr><th></th><th>move</th><th>DEF</th><th>stack</th></tr>${terrainRows}</table>
      <div class="lg-title">MAP MARKINGS</div>
      <div class="lg-row"><span class="lg-line" style="border-color:#1abc9c"></span> your intel zone (dashed) — reveals enemies inside</div>
      <div class="lg-row"><span class="lg-line" style="border-color:#e67e22"></span> enemy intel zone — they see your units here</div>
      <div class="lg-row"><span class="lg-fill" style="background:#9b59b6"></span> enemy EW jamming — drones inside cannot attack</div>
      <div class="lg-row"><span class="lg-line" style="border-color:#e53935"></span> the front line — armies deploy along the <b>real control line</b> for yesterday's date (blue band = UA side, red band = RU side)</div>
      <div class="lg-row">💣 mined hex — entry: 3 dmg infantry / 5 vehicles + Suppressed</div>
      <div class="lg-row">⚪ objective — hold it for VP each turn</div>
      <div class="lg-row">👁 spotted unit · 🎯 marked unit (−1 save)</div>
    </div>
    <div>
      <div class="lg-title">SPOTTING (ISR)</div>
      <div class="lg-row">Enemies are <b>hidden</b> unless: adjacent to your unit, recon-spotted, or inside your intel zone.</div>
      <div class="lg-row">Drone recon pass spots by size: big (tanks/arty) at full range, medium at −1 hex, small teams only ≤2 hexes.</div>
      <div class="lg-row">Stealth units (snipers, SOF, DRG) are invisible to drones while they don't move.</div>
      <div class="lg-row">Spotted units are easier to hit (−1 to-hit) and last 2–3 turns.</div>
      <div class="lg-title">ACTIONS (${AP_PER_TURN} AP per turn)</div>
      <div class="lg-row">Move: <b>1 AP</b> any unit, up to MOV hexes (numbers on highlighted hexes = cost).</div>
      <div class="lg-row">Attack / Fortify / other actions: <b>1/2/3 AP</b> by unit tier (C/U/R).</div>
      <div class="lg-title">DICE COMBAT</div>
      <div class="lg-row">Attack rolls 1d6 per ATK. Hits on 4+ (veteran/spotted/flank −1; suppressed/night +1).</div>
      <div class="lg-row">Defender saves each hit — armor + terrain + fortification set the save.</div>
      <div class="lg-row">A natural 6 is a <b>crit</b>: 2 damage, no save, Suppresses the target.</div>
      <div class="lg-row">Hover an enemy before attacking to see hit odds and expected damage.</div>
    </div>
  </div>
</div>`;
            el.querySelector('#legend-close').addEventListener('click', () => { el.style.display = 'none'; });
            el.addEventListener('click', e => { if (e.target === el) el.style.display = 'none'; });
        }
        el.style.display = '';
    }

    // ── Action Bar (one place for all unit actions) ───────────────────────────

    _renderActionBar(state) {
        const bar = document.getElementById('action-bar');
        if (!bar) return;
        const unit = state.phase === 'player_action' && state.selectedUnit
            ? state.units.get(state.selectedUnit) : null;
        if (!unit || unit.faction !== 'player' || unit.hp <= 0) {
            bar.style.display = 'none';
            return;
        }

        const card = CARD_CATALOG[unit.cardId];
        const tierAp = TIER_AP[card.tier];
        const ap = state.playerAP;
        const isRecon = card.abilities?.includes('recon_reveal');
        const skill = ACTIVE_SKILLS[card.active];

        const btn = (act, label, cost, disabled, title) =>
            `<button class="bar-btn" data-act="${act}" ${disabled ? 'disabled' : ''} title="${title}">${label}${cost !== null ? ` <span class="bar-ap">${cost}AP</span>` : ''}</button>`;

        let html = `<span class="bar-unit">${unit.realName || card.name}</span>`;
        html += btn('move', 'MOVE', 1, ap < 1 || unit.mov <= 0, 'Click a highlighted hex to move (numbers = MOV cost)');
        if (isRecon) {
            html += btn('attack', 'RECON', tierAp, ap < tierAp, 'Spotting pass — reveals enemies by size within drone range');
        } else if (unit.rng > 0) {
            html += btn('attack', 'ATTACK', tierAp, ap < tierAp, 'Click an enemy hex or unit; hover first to see hit odds');
        }
        if (!card.abilities?.includes('no_fortify')) {
            html += btn('fortify', 'FORTIFY', tierAp, ap < tierAp, '+DEF and Overwatch return fire until you move');
        }
        if (skill) {
            const ready = (unit.skillCd || 0) === 0;
            html += btn('skill', ready ? skill.name.toUpperCase() : `${skill.name.toUpperCase()} (CD ${unit.skillCd})`,
                skill.apCost, !ready || ap < skill.apCost, skill.desc);
        }
        if (card.abilities?.includes('can_depot')) {
            html += btn('depot', unit.inDepot ? 'EXIT DEPOT' : 'DEPOT', tierAp, ap < tierAp, 'Extend supply +3 hexes to adjacent allies');
        }
        if (card.abilities?.includes('delayed_strike')) {
            html += btn('loiter', 'DESIGNATE', tierAp, ap < tierAp, 'Pick a hex — strikes after a 2-turn countdown');
        }
        html += btn('cancel', '✕ CANCEL', null, false, 'Deselect unit');

        bar.innerHTML = html;
        bar.style.display = '';

        bar.querySelectorAll('.bar-btn').forEach(b => {
            b.addEventListener('click', () => {
                const act = b.dataset.act;
                if (act === 'move' || act === 'attack' || act === 'loiter') {
                    this._setActionMode(unit.id, act, state);
                } else if (act === 'fortify') {
                    const r = this.engine.fortifyUnit(unit.id);
                    if (!r.ok) this._flashStatus(r.error || 'Cannot fortify');
                } else if (act === 'depot') {
                    this.engine.activateDepot(unit.id);
                } else if (act === 'skill') {
                    if (skill.target === 'self' || skill.target === 'none') {
                        const r = this.engine.useUnitSkill(unit.id, {});
                        if (!r.ok) this._flashStatus(r.error);
                    } else {
                        this._actionMode = 'skill';
                        this._actionUnitId = unit.id;
                        document.getElementById('phase-label').textContent =
                            `${skill.name}: click target ${skill.target === 'hex' ? 'hex' : 'unit'}`;
                    }
                } else if (act === 'cancel') {
                    this._clearActionMode();
                    document.getElementById('phase-label').textContent = '';
                }
            });
        });
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
        const { state: d, def } = this.engine.doctrineDef('player');
        if (!def) return;
        const available = this.engine.doctrineAvailable('player');
        const cdLeft = Math.max(0, def.cooldown - (state.turn - d.lastUsedTurn));
        const pips = Array.from({ length: 3 }, (_, i) =>
            `<span class="pip ${i < d.charges ? 'pip-on' : 'pip-off'}"></span>`).join('');

        area.innerHTML = `
<div class="cmd-card ${available ? '' : 'cmd-used'}">
  <div class="cmd-name">${def.name}</div>
  <div class="cmd-desc"><b>Passive:</b> ${def.passive}</div>
  <div class="cmd-desc"><b>${def.activeName}:</b> ${def.activeDesc}</div>
  <div class="cmd-charges">Charges ${pips}${d.charges > 0 && !available ? ` · ready in ${cdLeft}t` : ''}</div>
  <button class="cmd-btn" ${available ? '' : 'disabled'} id="use-commander">USE</button>
</div>`;

        document.getElementById('use-commander')?.addEventListener('click', () => {
            const result = this.engine.usePlayerDoctrine();
            if (!result.ok) { this._flashStatus(result.error); return; }
            if (result.needTarget) {
                this._actionMode = 'doctrine';
                this._doctrineTargetType = result.needTarget;
                document.getElementById('phase-label').textContent = result.needTarget === 'unit'
                    ? `${def.activeName}: click a spotted enemy unit`
                    : `${def.activeName}: click a target hex`;
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

        // Doctrine targeting
        if (this._actionMode === 'doctrine') {
            if (this._doctrineTargetType === 'hex') {
                const result = this.engine.executeDoctrineTarget({ hexId });
                if (!result.ok) this._flashStatus(result.error);
                this._clearActionMode();
            } else {
                // unit-targeted doctrine: resolve via the unit on this hex
                const enemies = [...state.units.values()].filter(u => u.faction === 'ai' && u.hexId === hexId && u.hp > 0);
                if (enemies.length > 0) {
                    const result = this.engine.executeDoctrineTarget({ unitId: enemies[0].id });
                    if (!result.ok) this._flashStatus(result.error);
                    this._clearActionMode();
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
                    this._doPlayerAttack(this._actionUnitId, hexId);
                } else {
                    this._flashStatus('No enemy unit on that hex');
                }
                this._clearActionMode();
            } else if (this._actionMode === 'loiter') {
                const result = this.engine.designateLoitering(this._actionUnitId, hexId);
                if (!result.ok) this._flashStatus(result.error || 'Designation failed');
                this._clearActionMode();
            } else if (this._actionMode === 'skill') {
                const units = [...state.units.values()].filter(u => u.hexId === hexId && u.hp > 0);
                const result = this.engine.useUnitSkill(this._actionUnitId, { hexId, unitId: units[0]?.id });
                if (!result.ok) this._flashStatus(result.error);
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
                    this._doPlayerAttack(state.selectedUnit, hexId);
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

    // Attack via engine + dice tray on success
    _doPlayerAttack(attackerId, hexId) {
        const result = this.engine.attackUnit(attackerId, hexId);
        if (!result.ok) this._flashStatus(result.error);
        else if (result.result?.dice) this._showDiceTray(result.result);
        else if (result.result?.missed) this._flashStatus('Artillery missed!');
        document.getElementById('atk-preview').style.display = 'none';
        return result;
    }

    // Terrain chip — always shows what the hovered hex does
    _updateTerrainInfo(hexId) {
        const el = document.getElementById('terrain-info');
        if (!el) return;
        const hex = hexId ? this.engine?.board.hexes.get(hexId) : null;
        if (!hex) { el.style.display = 'none'; return; }

        const rules = TERRAIN_RULES[hex.terrainType] || TERRAIN_RULES.open;
        const tags = [];
        if (hex.isFrontline) tags.push('⚔ FRONT LINE');
        if (hex.hasRoad) tags.push('ROAD −1 move');
        if (hex.overlays.has('river_minor')) tags.push('RIVER +2 move');
        if (hex.overlays.has('river_major')) tags.push(hex.hasBridge ? 'BRIDGE' : 'RIVER (impassable)');
        if (hex.overlays.has('mined')) tags.push('⚠ MINED');
        if (hex.smokeTurns > 0) tags.push('SMOKE — no ranged attacks in');
        if (hex.illuminatedTurns > 0) tags.push('ILLUMINATED');
        if (hex.interdictedTurns > 0) tags.push('INTERDICTED');
        if (hex.isObjective) {
            const ctrl = hex.controlledBy === 'player' ? 'yours' : hex.controlledBy === 'ai' ? 'enemy' : 'neutral';
            tags.push(`★ OBJECTIVE (${ctrl})`);
        }

        el.innerHTML =
            `<b>${hex.terrainType.replace(/_/g, ' ').toUpperCase()}</b>` +
            ` · move cost ${rules.moveCost || 1}` +
            ` · DEF +${rules.defMod || 0}` +
            ` · max ${rules.stackLimit} units` +
            (tags.length ? `<span class="ti-tags"> · ${tags.join(' · ')}</span>` : '');
        el.style.display = '';
    }

    // Pre-attack odds preview while hovering a hex with a visible enemy
    _onHexHover(hexId) {
        this._updateTerrainInfo(hexId);
        const el = document.getElementById('atk-preview');
        const state = this.engine?.state;
        if (!el) return;
        const hide = () => { el.style.display = 'none'; };
        if (!hexId || !state || state.phase !== 'player_action') return hide();

        const attackerId = (this._actionMode === 'attack' && this._actionUnitId)
            ? this._actionUnitId : state.selectedUnit;
        if (!attackerId) return hide();
        const attacker = state.units.get(attackerId);
        if (!attacker || attacker.faction !== 'player' || attacker.hp <= 0) return hide();
        const card = CARD_CATALOG[attacker.cardId];
        if (card?.abilities?.includes('recon_reveal')) return hide();

        const target = [...state.units.values()].find(u =>
            u.faction === 'ai' && u.hexId === hexId && u.hp > 0 &&
            this.engine.board._isUnitVisible(u, state));
        if (!target) return hide();
        const dist = this.engine.board.hexDistance(attacker.hexId, hexId);
        if (dist < 1 || dist > attacker.rng) return hide();

        const pv = this.engine.combat.previewAttack(attacker, target, state);
        el.innerHTML = `
<div class="ap-title">${card.name} → ${target.displayName}</div>
<div class="ap-dice">${pv.numDice}d6 · hit ${pv.hitTarget}+ · save ${pv.saveTarget > 6 ? '—' : pv.saveTarget + '+'}${pv.missChance ? ` · ${Math.round(pv.missChance * 100)}% arty miss` : ''}</div>
<div class="ap-odds">
  <span>HIT <b>${Math.round(pv.hitChance * 100)}%</b></span>
  <span>Ø DMG <b>${pv.expDamage.toFixed(1)}</b></span>
  <span>KILL <b>${Math.round(pv.killChance * 100)}%</b></span>
</div>`;
        el.style.display = '';
    }

    // Show rolled dice after an attack resolves
    _showDiceTray(res) {
        const d = res.dice;
        if (!d) return;
        let el = document.getElementById('dice-tray');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dice-tray';
            document.getElementById('game-screen').appendChild(el);
        }
        const dieHtml = d.rolls.map(r =>
            `<span class="die ${r >= d.hitTarget ? (r === 6 ? 'die-crit' : 'die-hit') : 'die-miss'}">${r}</span>`
        ).join('');
        el.innerHTML = `
<div class="dice-row">${dieHtml}</div>
<div class="dice-sum">${d.hits} hit · ${d.saved} saved · <b>${res.damage} dmg</b>${d.crits ? ' · CRIT!' : ''}</div>`;
        el.style.display = '';
        clearTimeout(this._diceTimeout);
        this._diceTimeout = setTimeout(() => { el.style.display = 'none'; }, 2600);
    }

    _onUnitClick(unitId) {
        const state = this.engine.state;
        if (!state || state.phase !== 'player_action') return;

        const unit = state.units.get(unitId);
        if (!unit) return;

        // Enemy unit clicked during attack mode
        if (this._actionMode === 'attack' && this._actionUnitId && unit.faction === 'ai') {
            this._doPlayerAttack(this._actionUnitId, unit.hexId);
            this._clearActionMode();
            return;
        }

        // Doctrine targeting on a unit
        if (this._actionMode === 'doctrine' && this._doctrineTargetType === 'unit' && unit.faction === 'ai') {
            const result = this.engine.executeDoctrineTarget({ unitId });
            if (!result.ok) this._flashStatus(result.error);
            this._clearActionMode();
            return;
        }

        // Skill targeting on a unit (enemy or friendly — engine validates)
        if (this._actionMode === 'skill' && this._actionUnitId) {
            const result = this.engine.useUnitSkill(this._actionUnitId, { unitId, hexId: unit.hexId });
            if (!result.ok) this._flashStatus(result.error);
            this._clearActionMode();
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
                if (unit.mov > 0 && state.moveRange && state.moveRange.size === 0) {
                    this._flashStatus('No reachable hexes — surrounded by impassable terrain');
                }
            }
        } else if (unit.faction === 'ai') {
            // Clicking enemy during smart-select attack
            if (state.selectedUnit) {
                const result = this._doPlayerAttack(state.selectedUnit, unit.hexId);
                if (result.ok) {
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

        const skill = ACTIVE_SKILLS[card.active];
        let skillHtml = '';
        if (skill) {
            const ready = (unit.skillCd || 0) === 0;
            const canUse = unit.faction === 'player' && state.phase === 'player_action' &&
                           ready && state.playerAP >= skill.apCost;
            const btn = unit.faction === 'player'
                ? `<button class="skill-btn" id="use-skill" ${canUse ? '' : 'disabled'}>${ready ? `USE — ${skill.apCost} AP` : `COOLDOWN ${unit.skillCd}t`}</button>`
                : '';
            skillHtml = `
<div class="info-section-label">ACTIVE SKILL</div>
<div class="info-ability"><span class="ab-chip chip-skill">${skill.name}</span><span class="info-ability-desc">${skill.desc}</span></div>
${btn}`;
        }

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
${skillHtml}
${abilitiesHtml ? `<div class="info-section-label">ABILITIES</div>${abilitiesHtml}` : ''}
<div class="info-section-label">STATUS EFFECTS</div>
${statusHtml}
<div class="info-desc">${card.desc}</div>`;

        panel.style.display = '';
        document.getElementById('unit-info-close').onclick = () => { panel.style.display = 'none'; };

        document.getElementById('use-skill')?.addEventListener('click', () => {
            if (skill.target === 'self' || skill.target === 'none') {
                const result = this.engine.useUnitSkill(unit.id, {});
                if (!result.ok) this._flashStatus(result.error);
                else this._showUnitInfo(unit, state);
            } else {
                this._actionMode = 'skill';
                this._actionUnitId = unit.id;
                document.getElementById('phase-label').textContent =
                    `${skill.name}: click target ${skill.target === 'hex' ? 'hex' : 'unit'}`;
            }
        });
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
        console.log('[FRONTLINE]', msg);
        const wrap = document.getElementById('log-entries');
        if (!wrap) return;

        const turn = this.engine?.state?.turn ?? '—';
        const entry = document.createElement('div');
        entry.className = 'log-entry' +
            (msg.startsWith('☠') ? ' log-kill' : '') +
            (msg.startsWith('🔻') ? ' log-enemy' : '') +
            (msg.startsWith('Turn ') ? ' log-turn' : '');
        entry.textContent = `T${turn} · ${msg}`;
        wrap.appendChild(entry);

        // Cap entries, keep scrolled to the latest
        while (wrap.children.length > 80) wrap.removeChild(wrap.firstChild);
        wrap.scrollTop = wrap.scrollHeight;
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

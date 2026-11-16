// Capture Mala Tokmachka: the controller the viewer talks to. It owns the game
// (solo, hosting or as a guest), the fixed-step loop, the computer players, the
// input while a game is open, and hands the state to the view and the UI.
//
// main.js only constructs it, wires the panel button and calls update(dt) every
// frame. It touches nothing in the viewer beyond the camera controls (restored on
// stop) and the scene group it adds.

import * as THREE from 'three';
import { MALA_TOKMACHKA as PRESET } from './mala-tokmachka.js';
import { blockAt, buildWorld } from './streets.js';
import { FACTIONS, RULES, command, createGame, marchSpeed, neutralGarrison, standings, step } from './sim.js';
import { AI_LEVELS, estimateNeed, think } from './ai.js';
import { CaptureView } from './view.js';
import { CaptureUI, QUARTERS, RING } from './ui.js';
import { GuestNet, HostNet, applySnapshot, cleanCommand, cleanName, encodeSnapshot, inviteLink } from './net.js';
import { SIDES } from './text.js';

const store = {
    get(k, d) { try { return localStorage.getItem(`capture-${k}`) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`capture-${k}`, v); } catch { /* private mode */ } },
};
// drag controls: the quarters (RING, QUARTERS in ui.js) open once the finger rests on a target
const DWELL_MS = 250;   // a deliberate stop, not a slow drag
const DWELL_PX = 12;
const quarterAt = (dx, dy) => {                          // screen y grows downwards
    const a = Math.atan2(dy, dx);                        // 0 = right, π/2 = down
    return QUARTERS[[1, 2, 3, 0][((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4]];
};

function sessionToken() {
    try {
        let t = sessionStorage.getItem('capture-token');
        if (!t) { t = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('capture-token', t); }
        return t;
    } catch { return Math.random().toString(36).slice(2, 12); }
}

export class CaptureGame {
    /**
     * @param o {scene, camera, controls, canvas, terrain, proj,
     *           inScene(x, z) → bool, onRunningChange(running)}
     */
    constructor(o) {
        Object.assign(this, o);
        this.mode = null;          // null | 'setup' | 'solo' | 'host' | 'guest'
        this.selected = new Set();
        this.frac = 0.5;
        this.hover = null;
        // 'drag': hold on your block to charge, drag to the target, let go (touch-first);
        // 'click': select a block, then click a target with the % from 1–4
        this.controlsMode = store.get('controls', matchMedia('(pointer: coarse)').matches ? 'drag' : 'click');
        const game = this;
        window.__capture = {
            get state() { return game.st || game.mirror || null; },
            get world() { return game.world; },
            get you() { return game.you; },
            get mode() { return game.mode; },
            autoplay(on = true) { game.autoplay = !!on; return game.autoplay; },
            command(cmd) { return game._issue(cmd); },
            fastForward(seconds) { return game._fastForward(seconds); },
            debug() {
                return game.view && {
                    figures: game.view.figs.body.count, dots: game.view.dots.geometry.drawRange.count, fx: game.view.fx.length,
                    gesture: game.gesture && { frac: game.gesture.frac, target: game.gesture.target, sources: game.gesture.sources },
                };
            },
            pick(x, y) { return game.view ? game._pick({ clientX: x, clientY: y }) : -1; },
            get scene() { return game.scene; },
        };
    }

    get running() { return this.mode !== null; }

    canPlayHere() {
        return PRESET.outline.every(([lng, lat]) => {
            const p = this.proj.toLocal(lat, lng);
            return this.inScene(p.x, p.z);
        });
    }

    presetUrl(join) {
        const p = new URLSearchParams(location.search);
        const f = PRESET.frame;
        const q = new URLSearchParams({ lat: f.lat, lng: f.lng, size: f.size, game: 'capture' });
        if (p.get('date')) q.set('date', p.get('date'));
        return `${location.pathname}?${q}${join ? `#join=${encodeURIComponent(join)}` : ''}`;
    }

    /**
     * Open the setup screen (or the join screen for an invite link). `standalone`: the
     * page was opened as the game (?game=capture or an invite), so quitting goes back
     * to this screen rather than to the viewer.
     */
    openSetup({ join = null, standalone = false } = {}) {
        if (!this.canPlayHere()) {
            location.href = this.presetUrl(join);
            return;
        }
        this.standalone = this.standalone || standalone;
        this._activate();
        this.joinId = join;
        this.mode = 'setup';
        this._showSetup();
    }

    _showSetup() {
        this.ui.showSetup({
            joinId: this.joinId, side: store.get('side', 'us'), level: store.get('level', 'normal'),
            name: store.get('name', ''), standalone: this.standalone, controls: this.controlsMode,
        });
    }

    _setControls(mode) {
        this.controlsMode = mode === 'drag' ? 'drag' : 'click';
        store.set('controls', this.controlsMode);
        this._gestureCancel();
    }

    _quit() {
        if (this.standalone) this._reset(); else this.stop();
    }

    /** Back to the setup screen, the scene and the input kept (standalone game page). */
    _reset() {
        clearInterval(this.loop);
        clearInterval(this.lobbyTimer);
        this.loop = null;
        this.net?.close();
        this.net = null;
        this.st = this.mirror = this.seats = this.seatsShown = this.link = null;
        this.selected.clear();
        this.hover = null;
        this.endShown = false;
        this.paused = false;
        this._gestureCancel();
        this.view.setPreview(null);
        this.view.markDirty();
        if (location.hash.startsWith('#join=')) history.replaceState(null, '', location.pathname + location.search);
        this.joinId = null;
        this.mode = 'setup';
        this._overview();
        this._showSetup();
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    _activate() {
        if (this.view) return;
        this.world = buildWorld(PRESET, (lat, lng) => this.proj.toLocal(lat, lng));
        this.view = new CaptureView({ scene: this.scene, terrain: this.terrain, world: this.world });
        this.ui = new CaptureUI({
            onPlay: (side, level) => this._startSolo(side, level),
            onHost: (side, level) => this._startHost(side, level),
            onJoin: (side, name) => this._startGuest(side, name),
            onStart: () => this._hostStart(),
            onAgain: () => this._again(),
            onQuit: () => this._quit(),
            onControls: mode => this._setControls(mode),
            onPause: () => { if (this.mode === 'solo') { this.paused = !this.paused; this.autoPaused = false; } },
            onInvite: () => this._showHostLobby(),
            onFrac: f => { this.frac = f; },
            onUpgrade: track => this._upgrade(track),
            onRally: () => this._rally(),
            inGame: () => !!this.st,
        });
        this.board = {          // what the board shows before a game starts
            t: 0, mudUntil: 0, hold: null, winner: null, groups: [], log: [],
            blocks: this.world.blocks.map(b => ({ id: b.id, owner: null, troops: neutralGarrison(b.houses), lv: [0, 0, 0] })),
        };
        this._bindInput();
        const c = this.controls;
        this.savedControls = { buttons: { ...c.mouseButtons }, touches: { ...c.touches }, spp: c.screenSpacePanning };
        c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
        c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
        c.screenSpacePanning = false;
        // the viewer's near plane of 1 m leaves ~1 m of depth precision at a few km, so the ground
        // apron 4 m under the river valley and the road ribbons flicker; the game never zooms
        // closer than the orbit minimum (200 m), so a 25 m near plane costs nothing
        this.savedNear = this.camera.near;
        this.camera.near = Math.max(this.camera.near, 25);
        this.camera.updateProjectionMatrix();
        this._overview();
        document.body.classList.add('capture-on');
        this.mode = 'setup';
        this.onRunningChange?.(true);
    }

    stop() {
        if (!this.view) return;
        this._gestureCancel();
        clearInterval(this.loop);
        clearInterval(this.lobbyTimer);
        this.loop = null;
        this.net?.close();
        this.net = null;
        this._unbindInput();
        this.view.dispose();
        this.ui.dispose();
        this.view = this.ui = null;
        this.st = this.mirror = null;
        this.selected.clear();
        this.hover = null;
        this.endShown = false;
        this.paused = false;
        this.camera.near = this.savedNear;
        this.camera.updateProjectionMatrix();
        this.controls.mouseButtons = this.savedControls.buttons;
        this.controls.touches = this.savedControls.touches;
        this.controls.screenSpacePanning = this.savedControls.spp;
        document.body.classList.remove('capture-on');
        if (location.hash.startsWith('#join=')) history.replaceState(null, '', location.pathname + location.search);
        this.mode = null;
        this.onRunningChange?.(false);
    }

    _overview(ids) {
        const list = (ids && ids.length ? ids : this.world.blocks.map(b => b.id)).map(i => this.world.blocks[i]);
        const x = list.reduce((s, b) => s + b.x, 0) / list.length;
        const z = list.reduce((s, b) => s + b.z, 0) / list.length;
        const y = this.terrain.sampleHeight(x, z);
        const far = ids && ids.length ? 1600 : 3900;
        this.controls.target.set(x, y, z);
        this.camera.position.set(x, y + far, z + far);
        this.controls.update();
    }

    // ── starting games ───────────────────────────────────────────────────────
    _remember(side, level, name) {
        store.set('side', side);
        if (level) store.set('level', level);
        if (name != null) store.set('name', name);
    }

    _seatsFor(you, level) {
        this.seats = Object.fromEntries(FACTIONS.map(f => [f, f === you ? { kind: 'you' } : { kind: 'ai', level }]));
    }

    _newGame() {
        this.st = createGame(this.world, { seed: (Math.random() * 2 ** 32) >>> 0 });
        this.aiTimer = Object.fromEntries(FACTIONS.map((f, i) => [f, 1 + i]));
        this.endShown = false;
        this.selected.clear();
        this.acc = 0;
        this.lastTick = performance.now();
        const home = this.st.blocks.find(b => b.owner === this.you);
        if (home) {
            this.selected.add(home.id);
            this._overview([home.id]);
        }
        this.ui.hideModal();
        if (!this.loop) this.loop = setInterval(() => this._tick(), 50);
    }

    _startSolo(side, level) {
        this._remember(side, level);
        this.mode = 'solo';
        this.you = side;
        this._seatsFor(side, level);
        this.level = level;
        this._newGame();
    }

    _again() {
        if (this.mode === 'solo' || this.mode === 'host') {
            this._newGame();
            if (this.mode === 'host') this._broadcastSnap(true);
        }
    }

    // ── hosting ──────────────────────────────────────────────────────────────
    async _startHost(side, level) {
        this._remember(side, level);
        this.mode = 'host';
        this.you = side;
        this.level = level;
        this._seatsFor(side, level);
        this.guests = new Map();     // conn → side
        this.ui.showLobby({ title: 'Online game', seats: this._seatLabels(), canStart: false, note: 'Connecting…' });
        this.net = new HostNet({
            onOpen: id => {
                this.link = inviteLink(id);
                this._showHostLobby();
            },
            onHello: (conn, msg) => this._guestHello(conn, msg),
            onCmd: (conn, cmd) => {
                const side = this.guests.get(conn);
                const c = cleanCommand(cmd, this.world.blocks.length);
                if (side && c && this.st) command(this.world, this.st, side, c);
            },
            onLeave: conn => {
                const side = this.guests.get(conn);
                if (!side) return;
                this.guests.delete(conn);
                this.ui.toast(`${this.seats[side].name} left: the computer plays ${SIDES[side].name}.`);
                this.seats[side] = { kind: 'ai', level: 'normal', token: this.seats[side].token };
                this._lobbyChanged();
            },
            onError: text => this.ui.toast(text),
        });
        try {
            await this.net.start();
        } catch (err) {
            this.ui.showMessage('Online play unavailable', err.message);
            return;
        }
        this.lobbyTimer = setInterval(() => { if (!this.st) this._lobbyChanged(); }, 1000);
    }

    _seatLabels() {
        return Object.fromEntries(FACTIONS.map(f => {
            const s = this.seats[f];
            return [f, s.kind === 'you' ? (this.mode === 'host' ? 'host' : 'you') : s.kind === 'guest' ? s.name : 'computer'];
        }));
    }

    _showHostLobby() {
        if (!this.link) return;
        this.ui.showLobby({ link: this.link, seats: this._seatLabels(), canStart: true });
    }

    _lobbyChanged() {
        if (this.mode !== 'host' || !this.net) return;
        const seats = this._seatLabels();
        for (const [conn, side] of this.guests) this.net.send(conn, { t: 'lobby', seats: { ...seats, [side]: 'you' }, started: !!this.st });
        if (!this.st && this.link && this.ui.modalOpen) this._showHostLobby();
    }

    _guestHello(conn, msg) {
        const token = String(msg.token || '').slice(0, 40);
        const name = cleanName(msg.name);
        let side = FACTIONS.find(f => this.seats[f].token === token && this.seats[f].kind === 'ai');
        if (!side && FACTIONS.includes(msg.want) && this.seats[msg.want].kind === 'ai') side = msg.want;
        if (!side) side = FACTIONS.find(f => this.seats[f].kind === 'ai');
        if (!side) {
            this.net.send(conn, { t: 'reject', reason: 'The game is full.' });
            return;
        }
        this.seats[side] = { kind: 'guest', name, token };
        this.guests.set(conn, side);
        this.net.send(conn, { t: 'welcome', seat: side });
        this.ui.toast(`${name} joined as ${SIDES[side].name}.`);
        this._lobbyChanged();
        if (this.st) this.net.send(conn, encodeSnapshot(this.st, g => marchSpeed(this.st, g.f)));
    }

    _hostStart() {
        if (this.st) { this.ui.hideModal(); return; }
        clearInterval(this.lobbyTimer);
        this._newGame();
        this._lobbyChanged();
        this._broadcastSnap(true);
    }

    _broadcastSnap(force) {
        const now = performance.now();
        if (!this.net || !this.st || (!force && now - (this.lastSnap || 0) < 200)) return;
        this.lastSnap = now;
        this.net.broadcast(encodeSnapshot(this.st, g => marchSpeed(this.st, g.f)));
    }

    // ── joining ──────────────────────────────────────────────────────────────
    async _startGuest(side, name) {
        this._remember(side, null, name);
        this.mode = 'guest';
        this.you = side;
        this.seatsShown = null;
        this.ui.showLobby({ seats: { us: '…', cn: '…', ru: '…' }, canStart: false, note: 'Connecting to the host…' });
        this.net = new GuestNet(this.joinId, {
            onMessage: msg => this._guestMessage(msg),
            onLost: text => {
                clearInterval(this.loop);
                this.ui?.showMessage('Game over', text);
            },
        });
        try {
            await this.net.start({ token: sessionToken(), name: cleanName(name), want: side });
        } catch (err) {
            this.ui.showMessage('Online play unavailable', err.message);
        }
    }

    _guestMessage(msg) {
        if (!this.ui) return;
        if (msg.t === 'welcome' && FACTIONS.includes(msg.seat)) {
            this.you = msg.seat;
            this.ui.toast(`You play ${SIDES[msg.seat].long}.`);
        } else if (msg.t === 'reject') {
            this.ui.showMessage('Could not join', String(msg.reason || 'The host said no.'));
        } else if (msg.t === 'lobby') {
            this.seatsShown = msg.seats;
            if (!msg.started) this.ui.showLobby({ seats: msg.seats, canStart: false, note: 'The host starts the game.' });
        } else if (msg.t === 'snap') {
            const first = !this.mirror;
            const restarted = this.mirror && msg.time < this.mirror.t;
            this.mirror = applySnapshot(msg, restarted ? null : this.mirror);
            this.snapAt = performance.now();
            if (first || restarted) {
                this.ui.hideModal();
                this.endShown = false;
                this.selected.clear();
                const home = this.mirror.blocks.find(b => b.owner === this.you);
                if (home) { this.selected.add(home.id); this._overview([home.id]); }
            }
            if (this.mirror.winner && !this.endShown) this._showEnd(this.mirror, false);
        }
    }

    // ── the loop ─────────────────────────────────────────────────────────────
    _tick() {
        const now = performance.now();
        const dt = (now - this.lastTick) / 1000;
        this.lastTick = now;
        if (!this.st) return;
        if (this.mode === 'solo' && document.hidden && !this.paused) { this.paused = true; this.autoPaused = true; }
        if (this.mode === 'solo' && !document.hidden && this.autoPaused) { this.paused = false; this.autoPaused = false; }
        if (this.paused) return;
        this.acc = Math.min(this.acc + dt, 5);
        let n = 0;
        while (this.acc >= RULES.tick && n < 50 && !this.st.winner) {
            this._aiTurn();
            step(this.world, this.st);
            this.acc -= RULES.tick;
            n++;
        }
        if (this.mode === 'host') this._broadcastSnap(!!this.st.winner);
        if (this.st.winner && !this.endShown) this._showEnd(this.st, true);
    }

    _aiTurn() {
        for (const f of FACTIONS) {
            const seat = this.seats[f];
            const level = seat.kind === 'ai' ? seat.level : (seat.kind === 'you' && this.autoplay ? 'normal' : null);
            if (!level) continue;
            this.aiTimer[f] -= RULES.tick;
            if (this.aiTimer[f] > 0) continue;
            this.aiTimer[f] += AI_LEVELS[level].every;
            for (const c of think(this.world, this.st, f, level)) command(this.world, this.st, f, c);
        }
    }

    _fastForward(seconds) {
        if (!this.st) return null;
        for (let i = 0; i < seconds / RULES.tick && !this.st.winner; i++) {
            this._aiTurn();
            step(this.world, this.st);
        }
        return { t: this.st.t, winner: this.st.winner };
    }

    _showEnd(st, canReplay) {
        this.endShown = true;
        this.ui.showEnd({ winner: st.winner, reason: st.winReason, rows: standings(st), you: this.you, canReplay });
    }

    // ── commands from the player ─────────────────────────────────────────────
    _issue(cmd) {
        if (this.mode === 'guest') {
            this.net?.send(cmd);
            return { ok: true, sent: 'to host' };
        }
        if (!this.st) return { ok: false, reason: 'no game' };
        const r = command(this.world, this.st, this.you, cmd);
        if (!r.ok) this.ui.toast({ 'too few troops': 'Not enough troops there.', maxed: 'Already at the top level.' }[r.reason] || r.reason);
        return r;
    }

    _send(to) {
        const st = this.st || this.mirror;
        const from = [...this.selected].filter(i => i !== to && st.blocks[i].owner === this.you);
        if (!from.length) return;
        this._issue({ type: 'send', from, to, frac: this.frac });
    }

    _upgrade(track) {
        const st = this.st || this.mirror;
        const ids = [...this.selected].filter(i => st.blocks[i].owner === this.you);
        if (ids.length !== 1) {
            this.ui.toast('Select a single block to build in it.');
            return;
        }
        this._issue({ type: 'upgrade', block: ids[0], track });
    }

    /** Toggle the selected block as your gathering point. */
    _rally() {
        const st = this.st || this.mirror;
        const ids = [...this.selected].filter(i => st.blocks[i].owner === this.you);
        if (ids.length !== 1) {
            this.ui.toast('Select one of your blocks to gather at.');
            return;
        }
        const clear = st.rally?.[this.you] === ids[0];
        const r = this._issue({ type: 'rally', block: clear ? null : ids[0] });
        if (r.ok) this.ui.toast(clear ? 'Gathering point cleared.' : 'Gathering point set: your rear blocks send their troops here.');
    }

    // ── input ────────────────────────────────────────────────────────────────
    _bindInput() {
        const c = this.canvas;
        this.h = {
            grab: e => this._gestureStart(e),     // capture phase: runs before the orbit controls
            down: e => { this.down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button }; },
            up: e => {
                if (this._gestureEnd(e)) { this.down = null; return; }
                const d = this.down;
                this.down = null;
                if (!d || d.b !== e.button || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 450) return;
                this._click(this._pick(e), e.button, e.shiftKey);
            },
            move: e => {
                this.pointer = { x: e.clientX, y: e.clientY };
                this.pointerMoved = true;
                this._gestureMove(e);
            },
            cancel: () => this._gestureCancel(),
            leave: () => { this.pointer = null; this.pointerMoved = true; },
            menu: e => e.preventDefault(),
            key: e => this._key(e),
        };
        c.addEventListener('pointerdown', this.h.grab, true);
        c.addEventListener('pointerdown', this.h.down);
        c.addEventListener('pointerup', this.h.up);
        c.addEventListener('pointercancel', this.h.cancel);
        c.addEventListener('pointermove', this.h.move);
        c.addEventListener('pointerleave', this.h.leave);
        c.addEventListener('contextmenu', this.h.menu);
        window.addEventListener('keydown', this.h.key);
    }

    _unbindInput() {
        const c = this.canvas;
        c.removeEventListener('pointerdown', this.h.grab, true);
        c.removeEventListener('pointerdown', this.h.down);
        c.removeEventListener('pointerup', this.h.up);
        c.removeEventListener('pointercancel', this.h.cancel);
        c.removeEventListener('pointermove', this.h.move);
        c.removeEventListener('pointerleave', this.h.leave);
        c.removeEventListener('contextmenu', this.h.menu);
        window.removeEventListener('keydown', this.h.key);
    }

    _pick(e) {
        const r = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        const p = this.view.pick(ndc, this.camera);
        return p ? blockAt(this.world, p.x, p.z) : -1;
    }

    _click(id, button, shift) {
        const st = this.st || this.mirror;
        if (!st || st.winner || this.ui.modalOpen) return;
        if (id < 0) {
            if (button === 0 && !shift) this.selected.clear();
            this.view.markDirty();
            return;
        }
        const mine = st.blocks[id].owner === this.you;
        if (button === 2) {
            if (this.selected.size) this._send(id);
        } else if (mine) {
            if (shift) {
                if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
            } else if (this.selected.size === 1 && this.selected.has(id)) {
                this.selected.clear();
            } else {
                this.selected.clear();
                this.selected.add(id);
            }
        } else if (this.selected.size) {
            this._send(id);
        } else {
            this.ui.toast('Click one of your blocks first.');
        }
        this.view.markDirty();
    }

    // ── drag controls: press your block, drag to a target, let go on a quarter ──
    // Resting on a block for a moment opens four quarters (25 % up, then clockwise) under
    // the finger; letting go on one sends that share, in the hub or before they open the
    // last share used. Moving well away closes them; own blocks the finger leaves join in.
    _gestureStart(e) {
        if (this.gesture) {                      // a second finger: hand the map back
            if (e.pointerId !== this.gesture.id) this._gestureCancel();
            return;
        }
        const st = this.st || this.mirror;
        if (this.controlsMode !== 'drag' || !e.isPrimary || e.button !== 0 || !st || st.winner || this.ui.modalOpen) return;
        const id = this._pick(e);
        if (id < 0 || st.blocks[id].owner !== this.you) return;
        const base = QUARTERS.includes(this.frac) ? this.frac : 0.5;
        this.gesture = {
            id: e.pointerId, start: id, sources: [id], target: null, menu: null, dwell: null,
            x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false,
            base, frac: base, hub: true,
        };
        this.controls.enabled = false;          // the orbit controls see enabled=false and ignore this press
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
        this.selected.clear();
        this.selected.add(id);
        this.view.markDirty();
    }

    _gestureMove(e) {
        const g = this.gesture;
        if (!g || e.pointerId !== g.id) return;
        g.x = e.clientX;
        g.y = e.clientY;
        if (Math.hypot(g.x - g.x0, g.y - g.y0) > 12) g.moved = true;
        if (!g.moved) return;
        const st = this.st || this.mirror;
        if (g.menu) {
            const dx = g.x - g.menu.x, dy = g.y - g.menu.y, r = Math.hypot(dx, dy);
            if (r <= RING.outer + RING.slack) {
                g.hub = r < RING.inner;
                g.frac = g.hub ? g.base : quarterAt(dx, dy);
                return;
            }
            g.menu = null;                      // left the quarters: aim again
            g.hub = true;
            g.frac = g.base;
        }
        const id = this._pick(e);
        const next = id >= 0 && !g.sources.includes(id) ? id : null;
        if (next !== g.target) {
            // an own block the finger slides off joins the column
            const prev = g.target;
            if (prev != null && st.blocks[prev].owner === this.you && !g.sources.includes(prev)) {
                g.sources.push(prev);
                this.selected.add(prev);
            }
            g.target = next;
            g.dwell = next == null ? null : { x: g.x, y: g.y, t: performance.now() };
            this.view.setPreview(next == null ? null : this.world.route(g.sources[0], next));
            this.view.markDirty();
        } else if (g.dwell && Math.hypot(g.x - g.dwell.x, g.y - g.dwell.y) > DWELL_PX) {
            g.dwell = { x: g.x, y: g.y, t: performance.now() };     // still moving: no quarters yet
        }
    }

    /** Every frame: a finger resting on a target opens the quarters under it. */
    _gestureTick() {
        const g = this.gesture;
        if (!g || g.menu || !g.dwell || g.target == null || performance.now() - g.dwell.t < DWELL_MS) return;
        g.menu = { x: g.x, y: g.y };
        g.hub = true;
        g.frac = g.base;
    }

    _gestureEnd(e) {
        const g = this.gesture;
        if (!g || e.pointerId !== g.id) return false;
        this._gestureCancel();
        if (!g.moved) return true;              // a tap just selects the block (its panel shows)
        if (g.target == null) return true;       // let go on nothing: cancelled
        const from = g.sources.filter(i => i !== g.target);
        this.frac = g.frac;                     // the hub sends this share next time
        if (from.length) this._issue({ type: 'send', from, to: g.target, frac: g.frac });
        return true;
    }

    _gestureCancel() {
        if (!this.gesture) return;
        try { this.canvas.releasePointerCapture?.(this.gesture.id); } catch { /* already released */ }
        this.gesture = null;
        this.controls.enabled = true;
        this.view?.setPreview(null);
        this.view?.markDirty();
    }

    _gestureView(st) {
        const g = this.gesture;
        if (!g) return null;
        const n = g.sources.filter(i => i !== g.target).reduce((s, i) => s + Math.floor(st.blocks[i].troops * g.frac), 0);
        return {
            x: g.x, y: g.y, menu: g.menu, frac: g.frac, hub: g.hub, base: g.base, n, target: g.target,
            own: g.target != null && st.blocks[g.target].owner === this.you,
        };
    }

    _key(e) {
        if (!this.ui || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName) || this.ui.modalOpen) return;
        const st = this.st || this.mirror;
        if (!st) return;
        const k = e.code;
        if (/^Digit[1-4]$/.test(k)) this.frac = [0.25, 0.5, 0.75, 1][Number(k.slice(5)) - 1];
        else if (k === 'KeyZ') this._upgrade(0);
        else if (k === 'KeyX') this._upgrade(1);
        else if (k === 'KeyC') this._upgrade(2);
        else if (k === 'KeyG') this._rally();
        else if (k === 'Escape') { this.selected.clear(); this.view.markDirty(); }
        else if (k === 'Space') {
            const mine = st.blocks.filter(b => b.owner === this.you).map(b => b.id);
            this._overview(mine.length ? mine : null);
        } else if (k === 'KeyP' && this.mode === 'solo') { this.paused = !this.paused; this.autoPaused = false; }
        else return;
        e.preventDefault();
    }

    // ── every frame ──────────────────────────────────────────────────────────
    update(dt) {
        if (!this.view) return;
        const st = this.st || this.mirror || this.board;
        const now = performance.now();
        const dOf = this.mirror && !this.st
            ? g => g.d + g.v * Math.min(1, (now - this.snapAt) / 1000)
            : g => g.d + (this.paused || st.winner ? 0 : marchSpeed(st, g.f) * Math.min(RULES.tick, this.acc + (now - this.lastTick) / 1000));

        // selection only ever holds blocks we own
        for (const i of [...this.selected]) if (st.blocks[i].owner !== this.you) { this.selected.delete(i); this.view.markDirty(); }

        // what the pointer aims at
        if (this.pointerMoved) {
            this.pointerMoved = false;
            let hover = null;
            if (this.pointer && this.selected.size && !this.ui.modalOpen && this.controlsMode === 'click') {
                const id = this._pick({ clientX: this.pointer.x, clientY: this.pointer.y });
                if (id >= 0 && !this.selected.has(id)) hover = id;
            }
            if (hover !== this.hover) {
                this.hover = hover;
                this.view.markDirty();
                if (hover == null) {
                    this.view.setPreview(null);
                    this.previewNeed = null;
                } else {
                    const src = [...this.selected][0];
                    const r = this.world.route(src, hover);
                    this.view.setPreview(r);
                    this.previewNeed = estimateNeed(this.world, st, this.you, hover, r.len / marchSpeed(st, this.you));
                }
            }
        }

        this._gestureTick();
        const gesture = this._gestureView(st);
        this.view.update(dt, st, dOf, this.camera, { selected: this.selected, target: gesture ? gesture.target : this.hover });
        this.ui.update({
            st, world: this.world, view: this.view, camera: this.camera, canvas: this.canvas, dOf,
            you: this.st || this.mirror ? this.you : null, selected: this.selected, frac: this.frac,
            hover: this.hover, previewNeed: this.previewNeed,
            seats: this.seats ? this._seatLabels() : this.seatsShown,
            paused: this.paused, online: this.mode === 'host' ? 'host' : this.mode === 'guest' ? 'guest' : null,
            controls: this.controlsMode, gesture,
        });
    }
}

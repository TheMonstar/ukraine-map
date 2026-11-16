// Capture Mala Tokmachka: the HTML side — floating block labels and column
// bubbles, the HUD, the selected-block panel, the log, and the setup / lobby /
// end screens. It only draws; capture.js owns the game and the input.

import * as THREE from 'three';
import { FACTIONS, RULES, capOf, holdShare, prodRate, upgradeCost } from './sim.js';
import { NEUTRAL, SIDES, TITLES, UPGRADES, blockName, eventLine, formatClock } from './text.js';

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};
const colorOf = f => (f ? SIDES[f].color : NEUTRAL.color);
const kbd = k => el('kbd', 'cap-kbd', k);            // keyboard hint, hidden on touch screens
// drag controls: four quarters that open under the finger on the target pick the share
export const RING = { inner: 20, outer: 58, slack: 14 };  // px; slack: how far past the ring before it closes
export const QUARTERS = [0.25, 0.5, 0.75, 1];            // up, right, down, left
const REASONS = {
    hold: 'held the village long enough',
    last: 'was the last side standing',
    time: 'had the most blocks when the clock ran out',
};

export class CaptureUI {
    constructor(handlers) {
        this.h = handlers;
        this.root = el('div', 'cap-root');
        this.labels = el('div', 'cap-labels');
        this.root.append(this.labels);
        this.blockLabels = [];
        this.bubbles = [];

        // HUD: one slim bar: sides | clock and the win rule | buttons, the hold line along its foot
        this.hud = el('div', 'cap-hud');
        this.chips = el('div', 'cap-chips');
        const mid = el('div', 'cap-mid');
        this.clock = el('div', 'cap-clock');
        this.holdText = el('div', 'cap-hold-text');
        mid.append(this.clock, this.holdText);
        this.mud = el('div', 'cap-mud');
        this.holdBar = el('div', 'cap-hold');
        this.holdFill = el('div', 'cap-hold-fill');
        this.holdMark = el('div', 'cap-hold-mark');
        this.holdBar.append(this.holdFill, this.holdMark);
        const buttons = el('div', 'cap-hud-buttons');
        this.controlsBtn = el('button', 'cap-controls-btn');
        this.controlsBtn.title = 'Switch between drag (touch) and click controls';
        this.controlsBtn.onclick = () => this.h.onControls(this.controls === 'drag' ? 'click' : 'drag');
        this.pauseBtn = el('button');
        this.pauseBtn.onclick = () => this.h.onPause();
        this.inviteBtn = el('button', null, 'Invite');
        this.inviteBtn.onclick = () => this.h.onInvite();
        const quit = el('button', null, 'Quit');
        quit.title = 'Quit the game';
        quit.onclick = () => this.h.onQuit();
        buttons.append(this.controlsBtn, this.inviteBtn, this.pauseBtn, quit);
        this.hud.append(this.chips, mid, this.mud, buttons, this.holdBar);
        this.root.append(this.hud);

        this.panel = el('div', 'cap-panel');
        this.root.append(this.panel);
        this.tip = el('div', 'cap-tip');
        this.root.append(this.tip);
        this.log = el('div', 'cap-log');
        this.root.append(this.log);
        this.toastEl = el('div', 'cap-toast');
        this.root.append(this.toastEl);
        this._buildRing();
        this.modal = el('div', 'cap-modal hidden');
        this.root.append(this.modal);
        document.body.append(this.root);
        this.chipEls = {};
        this.lastLog = -1;
        this.panelKey = '';
    }

    // ── screens ──────────────────────────────────────────────────────────────
    _open(card) {
        this.modal.replaceChildren(card);
        this.modal.classList.remove('hidden');
    }

    hideModal() {
        this.modal.classList.add('hidden');
        this.modal.replaceChildren();
    }

    get modalOpen() { return !this.modal.classList.contains('hidden'); }

    showSetup({ joinId = null, side = 'us', level = 'normal', name = '', standalone = false, controls = 'click' } = {}) {
        this.controls = controls;
        const card = el('div', 'cap-card');
        if (!standalone) {
            const close = el('button', 'cap-x', '×');
            close.title = 'Back to the 3D viewer';
            close.onclick = () => this.h.onQuit();
            card.append(close);
        }
        card.append(el('h2', null, 'Capture Mala Tokmachka'));
        card.append(el('p', 'cap-intro', joinId
            ? 'You were invited to a game. Pick the side you would like; the host gives you a free seat.'
            : 'Take the street blocks of a real village. Blocks raise troops; send them down the lanes. Hold 60% for 20 seconds to win.'));
        let pick = side;
        const sides = el('div', 'cap-sides');
        const cards = {};
        for (const f of FACTIONS) {
            const s = SIDES[f];
            const b = el('button', 'cap-side');
            b.style.setProperty('--side', s.color);
            b.append(el('b', null, s.long), el('span', 'cap-perk', s.perk), el('span', 'cap-blurb', s.blurb));
            b.onclick = () => {
                pick = f;
                Object.values(cards).forEach(c => c.classList.toggle('on', c === b));
            };
            cards[f] = b;
            sides.append(b);
        }
        cards[pick].classList.add('on');
        card.append(sides);

        const row = el('div', 'cap-row');
        let lvl = null, nameIn = null;
        if (joinId) {
            nameIn = el('input');
            nameIn.placeholder = 'Your name';
            nameIn.maxLength = 24;
            nameIn.value = name;
            row.append(el('label', null, 'Name'), nameIn);
        } else {
            lvl = el('select');
            for (const [v, t] of [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']]) lvl.add(new Option(t, v));
            lvl.value = level;
            row.append(el('label', null, 'Computer players'), lvl);
        }
        card.append(row);

        const ctl = el('div', 'cap-row');
        ctl.append(el('label', null, 'Controls'));
        const how = el('ul', 'cap-how');
        const seg = el('div', 'cap-seg');
        const modes = { drag: 'Drag (touch)', click: 'Click' };
        const fill = mode => {
            how.replaceChildren(...this._howTo(mode).map(line => el('li', null, line)));
            [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
        };
        for (const [mode, label] of Object.entries(modes)) {
            const b = el('button', null, label);
            b.dataset.mode = mode;
            b.onclick = () => {
                this.controls = mode;
                this.h.onControls(mode);
                fill(mode);
            };
            seg.append(b);
        }
        ctl.append(seg);
        card.append(ctl);

        const go = el('div', 'cap-actions');
        if (joinId) {
            const join = el('button', 'cap-primary', 'Join game');
            join.onclick = () => this.h.onJoin(pick, nameIn.value);
            go.append(join);
        } else {
            const play = el('button', 'cap-primary', 'Play vs computer');
            play.onclick = () => this.h.onPlay(pick, lvl.value);
            const host = el('button', null, 'Host online game');
            host.title = 'Get a link to send to up to two friends; the computer plays any empty side';
            host.onclick = () => this.h.onHost(pick, lvl.value);
            go.append(play, host);
        }
        card.append(go);
        fill(controls);
        card.append(how);
        this._open(card);
    }

    _howTo(mode) {
        return mode === 'drag' ? [
            'Drag from your block to any block. Stop on it to pick 25–100%.',
            'Slide over more of your blocks on the way to send them too.',
            'Tap a block to build there (Z / X / C) or make it your gathering point ⚑ (G).',
            'One finger pans, two zoom and turn. Space recentres.',
        ] : [
            'Click your block, then a target. 1–4 sets the share.',
            'Shift-click adds blocks; right-click your own block to reinforce it.',
            'Build with Z / X / C; G makes the selected block your gathering point ⚑.',
            'Drag pans, right-drag turns, scroll zooms. Space recentres.',
        ];
    }

    showLobby({ title = null, link = null, seats, canStart, note = '' }) {
        const card = el('div', 'cap-card');
        card.append(el('h2', null, title || (link ? 'Online game' : 'Waiting for the host')));
        if (link) {
            card.append(el('p', 'cap-intro', 'Send this link to up to two friends. Anyone can also join after the start; the computer plays any empty side.'));
            const row = el('div', 'cap-row cap-link');
            const input = el('input');
            input.readOnly = true;
            input.value = link;
            const copy = el('button', null, 'Copy');
            copy.onclick = async () => {
                input.select();
                try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied'; } catch { document.execCommand('copy'); }
            };
            row.append(input, copy);
            card.append(row);
        }
        const list = el('div', 'cap-seats');
        for (const f of FACTIONS) {
            const r = el('div', 'cap-seat');
            r.style.setProperty('--side', SIDES[f].color);
            r.append(el('b', null, SIDES[f].name), el('span', null, seats[f]));
            list.append(r);
        }
        card.append(list);
        if (note) card.append(el('p', 'cap-note', note));
        const go = el('div', 'cap-actions');
        if (canStart) {
            const start = el('button', 'cap-primary', this.h.inGame?.() ? 'Back to the game' : 'Start');
            start.onclick = () => this.h.onStart();
            go.append(start);
        }
        const leave = el('button', null, 'Leave');
        leave.onclick = () => this.h.onQuit();
        go.append(leave);
        card.append(go);
        this._open(card);
    }

    showEnd({ winner, reason, rows, you, canReplay }) {
        const card = el('div', 'cap-card cap-end');
        const head = el('h2', null, winner === you ? 'You are the Mayor of Mala Tokmachka!' : `${SIDES[winner].long} wins`);
        head.style.color = colorOf(winner);
        card.append(head, el('p', 'cap-intro', `${SIDES[winner].long} ${REASONS[reason] || 'won'}.`));
        const list = el('div', 'cap-seats');
        rows.forEach((r, i) => {
            const row = el('div', 'cap-seat');
            row.style.setProperty('--side', colorOf(r.f));
            row.append(el('b', null, SIDES[r.f].name + (r.f === you ? ' (you)' : '')),
                el('span', null, `${TITLES[i]} · ${r.blocks} blocks`));
            list.append(row);
        });
        card.append(list);
        const go = el('div', 'cap-actions');
        if (canReplay) {
            const again = el('button', 'cap-primary', 'Play again');
            again.onclick = () => this.h.onAgain();
            go.append(again);
        }
        const close = el('button', null, 'Close');
        close.onclick = () => this.h.onQuit();
        go.append(close);
        card.append(go);
        this._open(card);
    }

    showMessage(title, text) {
        const card = el('div', 'cap-card');
        card.append(el('h2', null, title), el('p', 'cap-intro', text));
        const go = el('div', 'cap-actions');
        const ok = el('button', 'cap-primary', 'Close');
        ok.onclick = () => this.h.onQuit();
        go.append(ok);
        card.append(go);
        this._open(card);
    }

    toast(text) {
        this.toastEl.textContent = text;
        this.toastEl.classList.add('on');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), 2200);
    }

    // ── per frame ────────────────────────────────────────────────────────────
    /**
     * @param ctx {st, world, view, camera, canvas, dOf, you, selected:Set, frac, hover, seats, paused, online}
     */
    update(ctx) {
        const { st, world, camera, canvas } = ctx;
        this.root.classList.toggle('cap-playing', ctx.you != null);
        if (!st) return;
        const rect = canvas.getBoundingClientRect();
        const v = new THREE.Vector3();
        const place = (node, x, y, z) => {
            v.set(x, y, z).project(camera);
            const on = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
            node.style.display = on ? '' : 'none';
            if (on) {
                const px = rect.left + (v.x + 1) / 2 * rect.width, py = rect.top + (1 - v.y) / 2 * rect.height;
                node.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
            }
            return on;
        };

        // block labels
        world.blocks.forEach((b, i) => {
            let node = this.blockLabels[i];
            if (!node) {
                node = el('div', 'cap-label');
                node.append(el('i'), el('span'), el('small'), el('em', null, '⚑'));
                this.labels.append(node);
                this.blockLabels[i] = node;
                node._h = ctx.view.h(b.x, b.z);
            }
            const s = st.blocks[i];
            const n = String(Math.floor(s.troops));
            const pips = s.owner ? '•'.repeat(s.lv[0] + s.lv[1] + s.lv[2]) : '';
            const rally = !!s.owner && st.rally?.[s.owner] === i;
            const key = `${s.owner}|${n}|${pips}|${rally}|${ctx.selected.has(i)}|${ctx.hover === i}`;
            if (node._key !== key) {
                node._key = key;
                node.children[1].textContent = n;
                node.children[2].textContent = pips;
                node.title = `${blockName(i)}${s.owner ? ` · ${SIDES[s.owner].name}` : ''}`;
                node.style.setProperty('--side', colorOf(s.owner));
                node.classList.toggle('own', s.owner === ctx.you);
                node.classList.toggle('neutral', !s.owner);
                node.classList.toggle('rally', rally);
                node.classList.toggle('sel', ctx.selected.has(i));
                node.classList.toggle('hover', ctx.hover === i);
            }
            place(node, b.x, node._h + 30, b.z);
        });

        // column bubbles
        let k = 0;
        for (const g of st.groups) {
            if (g.n < 3) continue;
            let node = this.bubbles[k];
            if (!node) {
                node = el('div', 'cap-bubble');
                this.labels.append(node);
                this.bubbles[k] = node;
            }
            const text = String(Math.round(g.n));
            if (node.textContent !== text) node.textContent = text;
            node.style.setProperty('--side', colorOf(g.f));
            const p = ctx.view.headOf(g, ctx.dOf(g));
            place(node, p.x, p.y, p.z);
            k++;
        }
        for (let i = k; i < this.bubbles.length; i++) this.bubbles[i].style.display = 'none';

        this._hud(ctx);
        this._panel(ctx);
        this._log(st);
        if (ctx.you) this.ring.style.setProperty('--side', SIDES[ctx.you].color);
        this._ringUpdate(ctx.gesture);
    }

    // the drag-mode quarters: they open under the finger on the target, 25 % up then clockwise,
    // with a hub in the middle that sends the last share used
    _buildRing() {
        const { inner: ri, outer: ro } = RING;
        const pt = (r, deg) => `${(r * Math.cos(deg * Math.PI / 180)).toFixed(1)} ${(r * Math.sin(deg * Math.PI / 180)).toFixed(1)}`;
        const parts = QUARTERS.map((q, i) => {
            const mid = -90 + 90 * i, a0 = mid - 43, a1 = mid + 43;
            const d = `M${pt(ri, a0)} L${pt(ro, a0)} A${ro} ${ro} 0 0 1 ${pt(ro, a1)} L${pt(ri, a1)} A${ri} ${ri} 0 0 0 ${pt(ri, a0)}Z`;
            const [lx, ly] = pt((ri + ro) / 2, mid).split(' ');
            return `<g data-q="${q}"><path d="${d}"/><text x="${lx}" y="${ly}">${q * 100}%</text></g>`;
        }).join('');
        const hub = `<g class="cap-hub"><circle r="${ri - 3}"/><text></text></g>`;
        this.ring = el('div', 'cap-ring');
        this.ring.innerHTML = `<svg viewBox="${-ro - 2} ${-ro - 2} ${2 * ro + 4} ${2 * ro + 4}" width="${2 * ro + 4}" height="${2 * ro + 4}">${parts}${hub}</svg>`;
        this.hubText = this.ring.querySelector('.cap-hub text');
        this.badge = el('div', 'cap-badge');
        this.root.append(this.ring, this.badge);
    }

    _ringUpdate(g) {
        this.ring.classList.toggle('on', !!g?.menu);
        this.badge.classList.toggle('on', !!g);
        if (!g) return;
        if (g.menu) {
            this.ring.style.transform = `translate(${g.menu.x}px, ${g.menu.y}px)`;
            for (const q of this.ring.querySelectorAll('g[data-q]')) q.classList.toggle('on', !g.hub && Number(q.dataset.q) === g.frac);
            this.ring.querySelector('.cap-hub').classList.toggle('on', g.hub);
            this.hubText.textContent = `${Math.round(g.base * 100)}`;
        }
        // the label sits above the quarters when they are open, else above the finger
        const [bx, by] = g.menu ? [g.menu.x, g.menu.y - RING.outer - 34] : [g.x, g.y - 58];
        this.badge.style.transform = `translate(${bx}px, ${by}px)`;
        this.badge.textContent = g.target == null
            ? `Drag to a block · ${g.n} troops`
            : `${Math.round(g.frac * 100)}% · ${g.own ? 'Reinforce' : 'Send'} ${g.n} → ${blockName(g.target)}`;
    }

    _hud({ st, you, seats, paused, online, controls }) {
        this.controls = controls;
        this.controlsBtn.textContent = controls === 'drag' ? 'Drag mode' : 'Click mode';
        const rows = Object.fromEntries(FACTIONS.map(f => [f, { blocks: 0, troops: 0 }]));
        for (const b of st.blocks) if (b.owner) { rows[b.owner].blocks++; rows[b.owner].troops += b.troops; }
        for (const g of st.groups) rows[g.f].troops += g.n;
        for (const f of FACTIONS) {
            let chip = this.chipEls[f];
            if (!chip) {
                chip = el('div', 'cap-chip');
                chip.style.setProperty('--side', SIDES[f].color);
                chip.append(el('i'), el('b', null, SIDES[f].name), el('strong'), el('span'), el('em'));
                this.chips.append(chip);
                this.chipEls[f] = chip;
            }
            chip.classList.toggle('you', f === you);
            chip.classList.toggle('out', !rows[f].blocks && rows[f].troops < 1);
            chip.children[2].textContent = String(rows[f].blocks);
            chip.children[3].textContent = `blocks · ${Math.floor(rows[f].troops)} troops`;
            chip.children[4].textContent = f === you ? 'you' : seats?.[f] || 'computer';
            chip.title = `${SIDES[f].long} · ${f === you ? 'you' : seats?.[f] || 'computer'} · ${rows[f].blocks} blocks, ${Math.floor(rows[f].troops)} troops`;
        }
        this.clock.textContent = formatClock(st.t);
        this.clock.classList.toggle('paused', !!paused);
        const mud = st.mudUntil - st.t;
        this.mud.textContent = mud > 0 ? `Mud season ${Math.ceil(mud)} s` : '';
        this.mud.classList.toggle('on', mud > 0);
        const lead = FACTIONS.reduce((a, f) => (rows[f].blocks > rows[a].blocks ? f : a), FACTIONS[0]);
        const share = rows[lead].blocks / st.blocks.length, need = holdShare(st.t);
        this.holdFill.style.width = `${(share * 100).toFixed(1)}%`;
        this.holdFill.style.background = SIDES[lead].color;
        this.holdMark.style.left = `${(need * 100).toFixed(1)}%`;
        this.holdText.textContent = paused ? 'Paused'
            : st.hold ? `${SIDES[st.hold.f].name} holds ${Math.round(share * 100)}% · wins in ${Math.max(0, Math.ceil(RULES.holdTime - (st.t - st.hold.since)))} s`
                : `Hold ${Math.round(need * 100)}% for ${RULES.holdTime} s to win`;
        this.pauseBtn.style.display = online ? 'none' : '';
        this.pauseBtn.replaceChildren(paused ? 'Resume ' : 'Pause ', kbd('P'));
        this.inviteBtn.style.display = online === 'host' ? '' : 'none';
    }

    _panel({ st, world, you, selected, frac, hover, previewNeed }) {
        const ids = [...selected].filter(i => st.blocks[i].owner === you);
        const first = ids[0];
        const rallyHere = first != null && st.rally?.[you] === first;
        const key = first == null ? `none|${this.controls}|${st.rally?.[you]}`
            : `${ids.join(',')}|${frac}|${this.controls}|${Math.floor(st.blocks[first].troops)}|${st.blocks[first].lv.join('')}|${rallyHere}`;
        if (key !== this.panelKey) {
            this.panelKey = key;
            this.panel.replaceChildren();
            this.panel.classList.toggle('empty', first == null);
            if (first == null) {
                this.panel.append(el('div', 'cap-panel-hint', this.controls === 'drag'
                    ? 'Drag from your block to a target · stop on it to pick 25–100% · tap a block to build'
                    : 'Click your block, then a target'));
                const keys = el('div', 'cap-keys');
                for (const [k, what] of [['1–4', 'share'], ['Shift', 'add block'], ['Right-click', 'reinforce'], ['Z X C', 'build'], ['G', 'gather'], ['Space', 'recentre'], ['P', 'pause'], ['Esc', 'deselect']]) {
                    const item = el('span');
                    item.append(kbd(k), ` ${what}`);
                    keys.append(item);
                }
                this.panel.append(keys);
            } else {
                const b = st.blocks[first];
                const head = el('div', 'cap-panel-head');
                const cap = capOf(world, st, first);
                head.append(el('b', null, ids.length > 1 ? `${ids.length} blocks` : blockName(first)),
                    el('span', null, ids.length > 1 ? 'selected'
                        : `${world.blocks[first].houses} houses · +${prodRate(world, st, first).toFixed(1)}/s`));
                this.panel.append(head);
                const troops = ids.length > 1 ? ids.reduce((s, i) => s + st.blocks[i].troops, 0) : b.troops;
                const bar = el('div', 'cap-bar');
                const fill = el('i');
                fill.style.width = `${Math.min(100, (b.troops / cap) * 100).toFixed(0)}%`;
                bar.append(fill, el('span', null, ids.length > 1 ? `${Math.floor(troops)} troops` : `${Math.floor(troops)} / ${Math.round(cap)} troops`));
                if (ids.length === 1) this.panel.append(bar);
                if (this.controls !== 'drag') {               // drag mode picks the share at the target
                    const fr = el('div', 'cap-fracs');
                    for (const [i, f] of [0.25, 0.5, 0.75, 1].entries()) {
                        const btn = el('button', f === frac ? 'on' : '');
                        btn.append(kbd(String(i + 1)), `${f * 100}%`);
                        btn.title = `Send ${f * 100}% (key ${i + 1})`;
                        btn.onclick = () => this.h.onFrac(f);
                        fr.append(btn);
                    }
                    this.panel.append(fr);
                }
                if (ids.length === 1) {
                    const ups = el('div', 'cap-ups');
                    UPGRADES.forEach((u, track) => {
                        const level = b.lv[track];
                        const maxed = level >= RULES.maxLevel;
                        const cost = maxed ? null : upgradeCost(level);
                        const btn = el('button', 'cap-up');
                        btn.disabled = maxed || b.troops < cost;
                        btn.title = `${u.hint} (key ${u.hotkey})`;
                        const dots = el('span', 'cap-dots');
                        for (let k = 0; k < RULES.maxLevel; k++) dots.append(el('i', k < level ? 'on' : ''));
                        const name = el('b', null, `${u.name} `);
                        name.append(kbd(u.hotkey));
                        btn.append(name, el('small', null, u.short), dots, el('small', null, maxed ? 'max level' : `${cost} troops`));
                        btn.onclick = () => this.h.onUpgrade(track);
                        ups.append(btn);
                    });
                    const rally = el('button', `cap-up cap-rally${rallyHere ? ' on' : ''}`);
                    rally.title = rallyHere
                        ? 'Gathering point: your rear blocks send their troops here. Tap to clear (key G)'
                        : 'Make this the gathering point: your rear blocks keep sending their troops here (key G)';
                    const rname = el('b', null, '⚑ Gather ');
                    rname.append(kbd('G'));
                    rally.append(rname, el('small', null, rallyHere ? 'on · tap to clear' : 'rear troops come here'));
                    rally.onclick = () => this.h.onRally();
                    ups.append(rally);
                    this.panel.append(ups);
                }
            }
        }
        if (hover != null && first != null) {
            const send = ids.reduce((s, i) => s + Math.floor(st.blocks[i].troops * frac), 0);
            const verb = st.blocks[hover].owner === you ? 'Reinforce' : 'Send';
            this.tip.textContent = `${verb} ${send} → ${blockName(hover)}${previewNeed != null && st.blocks[hover].owner !== you ? ` (needs ~${Math.ceil(previewNeed)})` : ''}`;
            this.tip.classList.add('on');
        } else {
            this.tip.classList.remove('on');
        }
    }

    _log(st) {
        const last = st.log.length ? st.log[st.log.length - 1].seq : 0;
        if (last === this.lastLog) return;
        this.lastLog = last;
        this.log.replaceChildren();
        const lines = st.log.filter(e => e.type !== 'start' || st.t < 20).slice(-6);
        lines.forEach((ev, k) => {
            const line = el('div', 'cap-line');
            line.style.setProperty('--side', colorOf(ev.f));
            line.style.opacity = String(0.45 + 0.55 * (k + 1) / lines.length);   // older lines fade
            line.append(el('i'), el('span', 'cap-time', formatClock(ev.t)), el('span', null, eventLine(ev)));
            this.log.append(line);
        });
    }

    dispose() {
        clearTimeout(this.toastTimer);
        this.root.remove();
    }
}

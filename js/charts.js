/**
 * Charts — a docked right panel offering an alternative read of the same war the
 * map shows: how much, and which way is it moving.
 *
 * Two data tiers. Tier 1 is the General Staff morning sheet, already reachable
 * from the browser, and the territory numbers the diff-slice renderer already
 * computes. Tier 2 (air/fires, RU equipment losses, Moscow's claims, the USF
 * killboard) lives in private spreadsheets and arrives as a precomputed
 * data/charts-tier2.json. Tier 2 is always optional — _loadTier2() resolves null
 * rather than rejecting, and every Tier 2 card degrades to a note.
 *
 * Nothing is fetched until the panel is first opened.
 */
class Charts {
    static TIER2_URL = 'data/charts-tier2.json';

    /** The 12 named axes are RUSSIAN assaults. `Undefined` is Ukrainian. */
    static AXES = ['Kharkiv', 'Kupiansk', 'Lyman', 'Siversk', 'Kramatorsk', 'Toretsk',
        'Pokrovsk', 'Novopavlivka', 'Gulyaipole', 'Orikhiv', 'Prydniprovske', 'Kursk'];

    /**
     * The Ukrainian-side count steps from ~50/day to ~120/day here. It is a
     * reporting-basis change, not a tripling of activity; any RU/UA ratio
     * spanning it is meaningless and the tempo chart marks it.
     */
    static UA_BASIS_CHANGE = '2026-05-08';

    /** Month panels show this many recent months; more labels than this are unreadable. */
    static MONTH_TAIL = 18;

    static CARDS = [
        { id: 'axis', title: 'Axis pressure', open: true },
        { id: 'tempo', title: 'Daily tempo', open: true },
        { id: 'ledger', title: 'Territory ledger', open: false },
        { id: 'price', title: 'Price of ground', open: true },
        { id: 'gsua', title: 'General Staff, by month', open: false },
        { id: 'usf', title: 'Drone force', open: false }
    ];

    static esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Sheet values arrive as strings, including '' and '#DIV/0!'. */
    static num(x) {
        const v = parseFloat(String(x ?? '').replace(/,/g, ''));
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * Slice labels arrive from dashboard.formatDate() as "Jun 1, 2026", not ISO.
     * Drop the year — the card header already says which window this is.
     */
    static shortDate(v) {
        return String(v ?? '').replace(/,\s*\d{4}\s*$/, '');
    }

    static iso(date) {
        return date instanceof Date ? date.toLocaleDateString('en-CA') : String(date);
    }

    static fmt(n, dp = 0) {
        if (n === null || n === undefined || !Number.isFinite(n)) return '—';
        return n.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    static signed(n, dp = 0) {
        if (!Number.isFinite(n)) return '—';
        const s = n > 0 ? '+' : n < 0 ? '−' : '±';
        return s + Charts.fmt(Math.abs(n), dp);
    }

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.daily = null;              // normalized morning sheet
        this.tier2 = null;              // parsed charts-tier2.json, or null
        this._morningPromise = null;
        this._tier2Promise = null;
        this._territory = null;         // pushed from renderDeepLayer
        this._months = null;
        this._partialMonth = null;
        this._openCards = new Set(Charts.CARDS.filter(c => c.open).map(c => c.id));
        this._lastKey = null;
        this._debounce = null;
        this._applyingRange = false;
        this._bound = false;
        this._loaded = false;
        this.renderCount = 0;           // instrumentation for the reactivity check
    }

    // ---------------------------------------------------------------- panel

    isOpen() {
        const panel = this.dashboard.getEl('charts-panel');
        return !!panel && !panel.classList.contains('collapsed');
    }

    setOpen(open) {
        const panel = this.dashboard.getEl('charts-panel');
        if (!panel) return;
        panel.classList.toggle('collapsed', !open);

        // Leaflet is never told the map resized anywhere in this app, so shrinking
        // .map-container would leave a stale pixel size: wrong click targets and a
        // skewed MCP screenshot. Fire after the width transition, with a fallback in
        // case the transition is suppressed (reduced motion, background tab).
        const settle = () => this.dashboard.map?.invalidateSize();
        panel.addEventListener('transitionend', settle, { once: true });
        clearTimeout(this._sizeTimer);
        this._sizeTimer = setTimeout(settle, 350);

        if (open) {
            this._bindPanel();
            this.refresh({ force: true });
        }
    }

    _bindPanel() {
        if (this._bound) return;
        const panel = this.dashboard.getEl('charts-panel');
        if (!panel) return;
        // Two delegated listeners on the root. Cards are rebuilt with innerHTML, so
        // per-element handlers would leak on every date change.
        panel.addEventListener('click', (e) => this._onClick(e));
        panel.addEventListener('pointermove', (e) => this._onHover(e));
        panel.addEventListener('pointerleave', () => this._hideTip());
        panel.addEventListener('pointerdown', (e) => this._onBrushStart(e));
        this._bound = true;
    }

    _onClick(e) {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const kind = act.dataset.act;
        if (kind === 'card') {
            const id = act.dataset.card;
            if (this._openCards.has(id)) this._openCards.delete(id);
            else this._openCards.add(id);
            this.refresh({ force: true });
        } else if (kind === 'axis') {
            this._flyToAxis(act.dataset.axis);
        } else if (kind === 'month') {
            this._setDateRange(act.dataset.from, act.dataset.to);
        } else if (kind === 'enable-diff') {
            ['diff-area', 'diff-highlight'].forEach((id) => {
                const el = this.dashboard.getEl(id);
                if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change')); }
            });
        }
    }

    _onHover(e) {
        const node = e.target.closest('[data-tip]');
        const tip = document.getElementById('charts-tooltip');
        if (!tip) return;
        if (!node) { tip.style.display = 'none'; return; }
        tip.textContent = node.dataset.tip;
        tip.style.display = 'block';
        const pad = 14;
        let x = e.clientX - tip.offsetWidth - pad;
        if (x < 4) x = e.clientX + pad;
        let y = e.clientY - tip.offsetHeight - pad;
        if (y < 4) y = e.clientY + pad;
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
    }

    _hideTip() {
        const tip = document.getElementById('charts-tooltip');
        if (tip) tip.style.display = 'none';
    }

    setStatus(message, isError = false) {
        const el = this.dashboard.getEl('charts-status');
        if (!el) return;
        el.textContent = message || '';
        el.style.color = isError ? '#f87171' : '';
    }

    clear() {
        const body = this.dashboard.getEl('charts-body');
        if (body) body.innerHTML = '';
        this._lastKey = null;
    }

    // ---------------------------------------------------------------- data

    /**
     * Memoise around DataStore.loadSourceData, which already fetches and unwraps
     * `result.data` and try/catches to []. Same in-flight-promise idiom as
     * Settlements.loadSettlementTimeline.
     */
    _loadMorning() {
        if (this.daily) return Promise.resolve(this.daily);
        if (this._morningPromise) return this._morningPromise;
        this._morningPromise = this.dashboard.dataStore.loadSourceData('morning')
            .then((rows) => {
                this.daily = this._normalize(rows || []);
                this._months = null;
                return this.daily;
            })
            .catch((err) => {
                this._morningPromise = null;   // let a later open retry
                throw err;
            });
        return this._morningPromise;
    }

    _normalize(rows) {
        let mismatches = 0;
        const out = [];
        for (const r of rows) {
            const date = r?.Date;
            if (!date || String(date).length !== 10) continue;
            const axes = {};
            let ru = 0;
            for (const a of Charts.AXES) {
                const v = Charts.num(r[a]);
                axes[a] = v;
                ru += v;
            }
            const ua = Charts.num(r.Undefined);
            const total = Charts.num(r['Total Attacks']);
            if (total && ru + ua !== total) mismatches++;
            out.push({
                date, t: Date.parse(`${date}T00:00:00Z`), axes, ru, ua, total,
                losses: Charts.num(r.Losses), magyar: Charts.num(r.Magyar)
            });
        }
        out.sort((a, b) => a.t - b.t);
        if (mismatches) {
            // sum(axes) + Undefined === Total Attacks holds on every day. If it stops
            // holding, a 13th axis was added to the sheet and Charts.AXES is stale.
            console.warn(`Charts: axis identity failed on ${mismatches} day(s) — Charts.AXES may be stale`);
        }
        return out;
    }

    /** Never rejects. A missing Tier 2 file is a normal, supported state. */
    _loadTier2() {
        if (this._tier2Promise) return this._tier2Promise;
        this._tier2Promise = fetch(Charts.TIER2_URL)
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { this.tier2 = j && j.schema === 1 ? j : null; return this.tier2; })
            .catch(() => { this.tier2 = null; return null; });
        return this._tier2Promise;
    }

    /** Pure, in-memory. No network on date change, ever. */
    _window(startISO, endISO) {
        const rows = (this.daily || []).filter(d => d.date >= startISO && d.date <= endISO);
        const axes = {};
        Charts.AXES.forEach(a => { axes[a] = 0; });
        let ru = 0, ua = 0, losses = 0, magyar = 0;
        for (const d of rows) {
            Charts.AXES.forEach(a => { axes[a] += d.axes[a]; });
            ru += d.ru; ua += d.ua; losses += d.losses; magyar += d.magyar;
        }
        return { days: rows.length, from: startISO, to: endISO, axes, ru, ua, losses, magyar, daily: rows };
    }

    // ---------------------------------------------------------------- reactivity

    onDateChange() {
        if (!this.isOpen() || this._applyingRange) return;
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.refresh(), 120);
    }

    onTerritoryStats(stats) {
        this._territory = stats && stats.length ? stats : null;
        if (this.isOpen() && this._openCards.has('ledger')) this.refresh({ force: true });
    }

    async refresh({ force = false } = {}) {
        if (!this.isOpen()) return;
        const db = this.dashboard;
        const startISO = Charts.iso(db.startDate);
        const endISO = Charts.iso(db.endDate);
        const key = `${startISO}|${endISO}|${[...this._openCards].sort().join(',')}`;
        if (!force && key === this._lastKey) return;
        this._lastKey = key;

        if (!this._loaded) {
            this.setStatus('Loading…');
            try {
                await Promise.all([this._loadMorning(), this._loadTier2()]);
                this._loaded = true;
            } catch (err) {
                console.error('Charts: morning sheet failed', err);
                this.setStatus('General Staff series unavailable', true);
                const body = db.getEl('charts-body');
                if (body) body.innerHTML = '<p class="charts-empty">Could not load the General Staff series. The map is unaffected.</p>';
                return;
            }
        }
        this._render(startISO, endISO);
    }

    _render(startISO, endISO) {
        const body = this.dashboard.getEl('charts-body');
        if (!body) return;
        this.renderCount++;

        const win = this._window(startISO, endISO);
        const html = Charts.CARDS.map((card) => {
            const open = this._openCards.has(card.id);
            const inner = open ? this._card(card.id, win) : '';
            return `<div class="charts-card">
                <div class="charts-card-header" data-act="card" data-card="${card.id}">
                    <span class="charts-card-arrow">${open ? '&#9660;' : '&#9654;'}</span>
                    ${Charts.esc(card.title)}
                </div>
                ${open ? `<div class="charts-card-body">${inner}</div>` : ''}
            </div>`;
        }).join('');
        body.innerHTML = html;

        const span = win.days === 1 ? '1 day' : `${win.days} days`;
        this.setStatus(this.tier2
            ? `${span} · through ${Charts.esc(endISO)}`
            : `${span} · extended series unavailable`);
    }

    _card(id, win) {
        try {
            switch (id) {
                case 'axis': return this._chartAxis(win);
                case 'tempo': return this._chartTempo(win);
                case 'ledger': return this._chartLedger();
                case 'price': return this._chartPrice(win);
                case 'gsua': return this._chartGsua(win);
                case 'usf': return this._chartUsf();
                default: return '';
            }
        } catch (err) {
            console.error(`Charts: card "${id}" failed`, err);
            return '<p class="charts-empty">This chart could not be drawn.</p>';
        }
    }

    // ---------------------------------------------------------------- charts

    /**
     * Axis pressure. Bullet idiom: a bar for the selected window, a tick for the
     * previous equal-length window. A ghost bar behind the current bar is invisible
     * whenever current exceeds previous, which reads as "no comparison available".
     */
    _chartAxis(win) {
        if (!win.days) return '<p class="charts-empty">No General Staff days in this range.</p>';
        const prev = this._previousWindow(win);
        const rows = Charts.AXES
            .map(a => ({ name: a, now: win.axes[a], was: prev ? prev.axes[a] : null }))
            .sort((x, y) => y.now - x.now);
        const mx = Math.max(1, ...rows.map(r => Math.max(r.now, r.was ?? 0)));

        // R reserves two right-hand columns: the value, then the signed delta.
        // They collide at anything narrower.
        const W = 320, L = 74, R = 76, rh = 19, T = 4;
        const h = T + rows.length * rh + 4;
        const sc = (W - L - R) / mx;
        let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Russian assaults per axis">`;
        rows.forEach((r, i) => {
            const y = T + i * rh;
            const bw = Math.max(0.8, r.now * sc);
            const d = r.was === null ? null : r.now - r.was;
            const cls = d === null ? 'c-fl' : d > 0 ? 'c-up' : d < 0 ? 'c-dn' : 'c-fl';
            const tip = `${r.name}: ${Charts.fmt(r.now)} assaults`
                + (r.was === null ? '' : ` · previous ${Charts.fmt(r.was)} (${Charts.signed(d)})`);
            s += `<g data-act="axis" data-axis="${Charts.esc(r.name)}" data-tip="${Charts.esc(tip)}" style="cursor:pointer">`;
            s += `<rect x="0" y="${y}" width="${W}" height="${rh - 2}" class="c-hit"/>`;
            s += `<text x="${L - 6}" y="${y + 11}" text-anchor="end" class="c-lbl">${Charts.esc(r.name)}</text>`;
            s += `<rect x="${L}" y="${y + 3}" width="${bw.toFixed(1)}" height="11" rx="2" class="c-ru"/>`;
            if (r.was !== null) {
                const px = L + r.was * sc;
                s += `<line x1="${px.toFixed(1)}" y1="${y + 1}" x2="${px.toFixed(1)}" y2="${y + 16}" class="c-prev"/>`;
            }
            s += `<text x="${W - R + 5}" y="${y + 11}" class="c-val">${Charts.fmt(r.now)}</text>`;
            if (d !== null && d !== 0) {
                s += `<text x="${W}" y="${y + 11}" text-anchor="end" class="c-val ${cls}">${Charts.signed(d)}</text>`;
            }
            s += `</g>`;
        });
        s += '</svg>';

        const top2 = rows.slice(0, 2);
        const share = win.ru ? (top2[0].now + top2[1].now) / win.ru * 100 : 0;
        return `<div class="charts-legend">
                <span><i style="background:var(--chart-ru)"></i>selected</span>
                <span><i class="tick"></i>previous ${prev ? `${prev.days}d` : 'n/a'}</span>
            </div>${s}
            <p class="charts-card-note">${Charts.fmt(win.ru)} Russian assaults.
            ${Charts.esc(top2[0].name)} and ${Charts.esc(top2[1].name)} take ${share.toFixed(0)}% of them.
            Click an axis to move the map there.</p>`;
    }

    _previousWindow(win) {
        if (!win.days) return null;
        const dayMs = 86400000;
        const start = Date.parse(`${win.from}T00:00:00Z`);
        const end = Date.parse(`${win.to}T00:00:00Z`);
        const prevEnd = new Date(start - dayMs);
        const prevStart = new Date(start - dayMs - (end - start));
        const p = this._window(Charts.iso(prevEnd) < Charts.iso(prevStart) ? Charts.iso(prevEnd) : Charts.iso(prevStart),
            Charts.iso(prevEnd));
        return p.days ? p : null;
    }

    /** Russian assaults against Ukrainian attacks, day by day. Brushable. */
    _chartTempo(win) {
        const d = win.daily;
        if (!d.length) return '<p class="charts-empty">No General Staff days in this range.</p>';
        const W = 320, H = 108, L = 24, R = 4, T = 6, B = 16;
        const mx = Math.max(1, ...d.map(x => Math.max(x.ru, x.ua)));
        const nice = Charts.niceMax(mx);
        const sy = v => T + (H - T - B) * (1 - v / nice);
        const bw = (W - L - R) / d.length;
        let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Russian assaults and Ukrainian attacks per day">`;
        for (let i = 0; i <= 2; i++) {
            const v = nice * i / 2, y = sy(v);
            s += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" class="c-grid"/>`;
            s += `<text x="${L - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="c-tick">${Charts.fmt(v)}</text>`;
        }
        const half = Math.max(0.7, (bw - 1.4) / 2);
        d.forEach((x, i) => {
            const bx = L + i * bw;
            const tip = `${x.date}: ${Charts.fmt(x.ru)} Russian, ${Charts.fmt(x.ua)} Ukrainian`;
            s += `<g data-tip="${Charts.esc(tip)}">`;
            s += `<rect x="${bx.toFixed(1)}" y="${T}" width="${bw.toFixed(2)}" height="${H - T - B}" class="c-hit"/>`;
            s += `<rect x="${bx.toFixed(1)}" y="${sy(x.ru).toFixed(1)}" width="${half.toFixed(2)}" height="${(H - B - sy(x.ru)).toFixed(1)}" class="c-ru"/>`;
            s += `<rect x="${(bx + half + 0.7).toFixed(1)}" y="${sy(x.ua).toFixed(1)}" width="${half.toFixed(2)}" height="${(H - B - sy(x.ua)).toFixed(1)}" class="c-ua"/>`;
            s += `</g>`;
        });
        // The Ukrainian series changes basis here; a ratio across it is not a ratio.
        const brk = d.findIndex(x => x.date >= Charts.UA_BASIS_CHANGE);
        let note = '';
        if (brk > 0 && d[0].date < Charts.UA_BASIS_CHANGE) {
            const bxr = L + brk * bw;
            s += `<line x1="${bxr.toFixed(1)}" y1="${T}" x2="${bxr.toFixed(1)}" y2="${H - B}" class="c-break"/>`;
            note = ` <b>The dashed rule is 8 May 2026</b>, where the Ukrainian count changes
                reporting basis (~50/day to ~120/day). Do not read a ratio across it.`;
        }
        s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="c-ax"/>`;
        s += `<text x="${L}" y="${H - 4}" class="c-tick">${Charts.esc(d[0].date.slice(5))}</text>`;
        s += `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="c-tick">${Charts.esc(d[d.length - 1].date.slice(5))}</text>`;
        s += `<rect id="charts-brush" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"
              fill="transparent" style="cursor:ew-resize"/>`;
        s += '</svg>';
        const ratio = win.ru ? (win.ua / win.ru) : 0;
        return `<div class="charts-legend">
                <span><i style="background:var(--chart-ru)"></i>Russian assaults</span>
                <span><i style="background:var(--chart-ua)"></i>Ukrainian attacks</span>
            </div>${s}
            <p class="charts-card-note">${Charts.fmt(win.ru)} against ${Charts.fmt(win.ua)},
            ${ratio.toFixed(2)} Ukrainian per Russian. Drag across the chart to set the date range.${note}</p>`;
    }

    /**
     * Territory ledger. Recomputes nothing — renderDeepLayer already builds these
     * numbers and pushes them here. `gains`/`losses` are Russian-relative, so red is
     * a Russian gain and blue a Russian loss; green-good/red-bad would invert it.
     */
    _chartLedger() {
        const stats = this._territory;
        if (!stats) {
            // Distinguish "the layer is off" from "the layer is on but produced no
            // slices" — offering a button that is already pressed reads as broken.
            const on = this.dashboard.isChecked('diff-area');
            if (on) {
                return `<p class="charts-empty">Diff area is on but no slices were computed.
                    Set <b>Diff slices</b> to 1 or more — the ledger reads the per-slice numbers
                    the renderer produces.</p>`;
            }
            return `<p class="charts-empty">Needs the diff-area layers. The ledger reads the
                numbers the slice renderer already computes.</p>
                <p><button class="btn btn-sm" data-act="enable-diff">Enable diff area</button></p>`;
        }
        const W = 320, rh = 34, L = 4, R = 4, T = 14;
        const h = T + stats.length * rh + 6;
        const mx = Math.max(1, ...stats.map(s => Math.max(s.gains, s.losses)));
        const mid = W * 0.46;
        const sc = Math.min(mid - L - 30, W - R - mid - 34) / mx;
        let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Territory gained and given back">`;
        s += `<text x="${mid}" y="9" text-anchor="middle" class="c-tick">given back | gained</text>`;
        s += `<line x1="${mid}" y1="${T}" x2="${mid}" y2="${h - 4}" class="c-ax"/>`;
        stats.forEach((st, i) => {
            const y = T + i * rh;
            const gw = st.gains * sc, lw = st.losses * sc;
            const net = st.gains - st.losses;
            const tip = `${st.from} → ${st.to}: Russia gained ${st.gains.toFixed(1)} km², `
                + `lost ${st.losses.toFixed(1)} km², net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)}`;
            s += `<g data-tip="${Charts.esc(tip)}">`;
            s += `<rect x="0" y="${y}" width="${W}" height="${rh - 4}" class="c-hit"/>`;
            s += `<rect x="${(mid - lw).toFixed(1)}" y="${y + 2}" width="${lw.toFixed(1)}" height="12" rx="2" class="c-ua"/>`;
            s += `<rect x="${mid}" y="${y + 2}" width="${gw.toFixed(1)}" height="12" rx="2" class="c-ru"/>`;
            s += `<text x="${(mid - lw - 4).toFixed(1)}" y="${y + 11}" text-anchor="end" class="c-val">${st.losses.toFixed(0)}</text>`;
            s += `<text x="${(mid + gw + 4).toFixed(1)}" y="${y + 11}" class="c-val">${st.gains.toFixed(0)}</text>`;
            s += `<text x="${L}" y="${y + 24}" class="c-tick">${Charts.esc(Charts.shortDate(st.from))} → ${Charts.esc(Charts.shortDate(st.to))}</text>`;
            s += `<text x="${W - R}" y="${y + 24}" text-anchor="end" class="c-tick ${net > 0 ? 'c-up' : net < 0 ? 'c-dn' : 'c-fl'}">net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)} km²</text>`;
            s += `</g>`;
        });
        s += '</svg>';
        const g = stats.reduce((a, x) => a + x.gains, 0);
        const l = stats.reduce((a, x) => a + x.losses, 0);
        return `<div class="charts-legend">
                <span><i style="background:var(--chart-ru)"></i>Russian gain</span>
                <span><i style="background:var(--chart-ua)"></i>Russian loss</span>
            </div>${s}
            <p class="charts-card-note">${g.toFixed(0)} km² taken, ${l.toFixed(0)} given back,
            net ${(g - l) >= 0 ? '+' : '−'}${Math.abs(g - l).toFixed(0)}. Net alone cannot tell a
            quiet month from a churning one.</p>`;
    }

    /**
     * Price of ground: claimed losses per assault, rolling 7 days. A ratio of sums,
     * never a mean of ratios — the denominator hits zero on quiet days.
     */
    _chartPrice(win) {
        const d = win.daily;
        if (d.length < 2) return '<p class="charts-empty">Needs at least two days.</p>';
        const pts = [];
        for (let i = 0; i < d.length; i++) {
            const from = Math.max(0, i - 6);
            let sl = 0, sr = 0;
            for (let j = from; j <= i; j++) { sl += d[j].losses; sr += d[j].ru; }
            if (sr > 0) pts.push({ date: d[i].date, v: sl / sr });
        }
        if (!pts.length) return '<p class="charts-empty">No assaults recorded in this range.</p>';
        const W = 320, H = 100, L = 24, R = 4, T = 8, B = 16;
        const mx = Charts.niceMax(Math.max(...pts.map(p => p.v)));
        const sy = v => T + (H - T - B) * (1 - v / mx);
        const sx = i => L + (W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
        let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Claimed losses per assault">`;
        for (let i = 0; i <= 2; i++) {
            const v = mx * i / 2, y = sy(v);
            s += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" class="c-grid"/>`;
            s += `<text x="${L - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="c-tick">${v.toFixed(0)}</text>`;
        }
        const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)} ${sy(p.v).toFixed(1)}`).join('');
        s += `<path d="${path}" fill="none" stroke="var(--chart-warn)" stroke-width="2" stroke-linejoin="round"/>`;
        pts.forEach((p, i) => {
            s += `<rect x="${(sx(i) - 2).toFixed(1)}" y="${T}" width="4" height="${H - T - B}" class="c-hit"
                   data-tip="${Charts.esc(`${p.date}: ${p.v.toFixed(1)} claimed losses per assault (7-day)`)}"/>`;
        });
        s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="c-ax"/>`;
        s += `<text x="${L}" y="${H - 4}" class="c-tick">${Charts.esc(pts[0].date.slice(5))}</text>`;
        s += `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="c-tick">${Charts.esc(pts[pts.length - 1].date.slice(5))}</text>`;
        s += '</svg>';
        const overall = win.ru ? win.losses / win.ru : 0;
        return `${s}<p class="charts-card-note">${overall.toFixed(1)} claimed losses per assault across
            the window. Rising while assaults fall means fewer, costlier attacks.</p>`;
    }

    /** Monthly rollup of the Tier 1 daily series. */
    _byMonth() {
        if (this._months) return this._months;
        const out = new Map();
        for (const d of this.daily || []) {
            const m = d.date.slice(0, 7);
            const o = out.get(m) || { m, ru: 0, ua: 0, losses: 0, magyar: 0, days: 0 };
            o.ru += d.ru; o.ua += d.ua; o.losses += d.losses; o.magyar += d.magyar; o.days++;
            out.set(m, o);
        }
        const all = [...out.values()].sort((a, b) => (a.m < b.m ? -1 : 1));
        // The month in progress is one or two days deep and would plot as a collapse
        // next to full months. Drop it from the monthly panels; the daily charts
        // still show it. Only the trailing month is dropped — an interior month with
        // a missing day or two is still worth comparing.
        const last = all[all.length - 1];
        if (last) {
            const [y, mo] = last.m.split('-').map(Number);
            const inMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            if (last.days < inMonth) {
                last.partial = true;
                all.pop();
                this._partialMonth = last;
            }
        }
        this._months = all;
        return this._months;
    }

    /**
     * The six-month arc is what says whether a month is a turn or noise. Not
     * windowed by the slider: the app opens on a 3-month range, which would leave
     * four bars. Trimmed to the recent tail — 50-odd month labels are unreadable at
     * this width and the early months predate most of these series anyway.
     */
    _chartGsua() {
        const months = this._byMonth().slice(-Charts.MONTH_TAIL);
        if (!months.length) return '<p class="charts-empty">No monthly data.</p>';
        const eng = this.tier2?.gsua || null;

        let out = Charts.monthBars(months.map(r => ({
            label: r.m.slice(5), value: r.ru,
            tip: `${r.m}: ${Charts.fmt(r.ru)} Russian assaults over ${r.days} days`
        })), 'Russian assaults');

        if (eng) {
            const rows = months
                .map(r => ({ m: r.m, e: eng[r.m]?.engagements }))
                .filter(r => Number.isFinite(r.e?.perDay));
            if (rows.length) {
                out += Charts.monthBars(rows.map(r => ({
                    label: r.m.slice(5), value: r.e.perDay,
                    tip: `${r.m}: ${Charts.fmt(r.e.perDay, 1)} engagements per reported day `
                        + `(${Charts.fmt(r.e.total)} over ${r.e.days} days)`
                })), 'Combat engagements per reported day');
            }
        }

        out += Charts.monthBars(months.map(r => ({
            label: r.m.slice(5), value: r.losses,
            tip: `${r.m}: ${Charts.fmt(r.losses)} claimed Russian losses`
        })), 'Claimed Russian losses');

        const price = months.filter(r => r.ru > 0);
        out += Charts.monthBars(price.map(r => ({
            label: r.m.slice(5), value: r.losses / r.ru,
            tip: `${r.m}: ${(r.losses / r.ru).toFixed(2)} claimed losses per assault`
        })), 'Losses per assault', 320, 92, 1);

        const part = this._partialMonth
            ? ` ${Charts.esc(this._partialMonth.m)} is still in progress (${this._partialMonth.days} d) and is left out.`
            : '';
        return out + `<p class="charts-card-note">Engagements render per reported day, never as
            monthly totals — coverage moves between months.${part}${eng ? '' :
                ' Engagements need the extended series, which is not published with this build.'}</p>`;
    }

    _chartUsf() {
        const t2 = this.tier2;
        if (!t2 || !t2.usf) {
            return `<p class="charts-empty">The drone-force killboard comes from the extended
                series, which is not published with this build.</p>`;
        }
        const months = (t2.months || []).filter(m => t2.usf[m]).slice(-Charts.MONTH_TAIL);
        if (!months.length) return '<p class="charts-empty">No drone-force data.</p>';
        const panel = (pick, title, dp = 0) => Charts.monthBars(months.map(m => {
            const u = t2.usf[m];
            return { label: m.slice(5), value: pick(u), tip: `${m}: ${Charts.fmt(pick(u), dp)}` };
        }), title);
        return panel(u => u.strikeSorties, 'Strike sorties')
            + panel(u => u.totalPersonnelCasualties, 'Claimed personnel casualties')
            + panel(u => (u.strikeSorties ? u.totalPersonnelCasualties / u.strikeSorties * 1000 : 0),
                'Casualties per 1 000 sorties', 0)
            + `<p class="charts-card-note">Sorties and claimed effect have come apart: the third
               panel is the one that shows it.</p>`;
    }

    // ---------------------------------------------------------------- svg helpers

    static niceMax(v) {
        if (!Number.isFinite(v) || v <= 0) return 1;
        const exp = Math.pow(10, Math.floor(Math.log10(v)));
        const f = v / exp;
        const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
        return step * exp;
    }

    /** Small monthly bar panel, last bar emphasised only when it is the series high. */
    static monthBars(items, title, W = 320, H = 92, dp = 0) {
        const L = 4, R = 4, T = 24, B = 14;
        const mx = Math.max(1, ...items.map(i => i.value));
        const bw = (W - L - R) / items.length;
        let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${Charts.esc(title)}">`;
        s += `<text x="${L}" y="11" class="c-lbl">${Charts.esc(title)}</text>`;
        items.forEach((it, i) => {
            const bh = (H - T - B) * (it.value / mx);
            const bx = L + i * bw + 1.5;
            const by = H - B - bh;
            const isMax = it.value >= mx;
            s += `<g data-tip="${Charts.esc(it.tip)}">`;
            s += `<rect x="${bx.toFixed(1)}" y="${T}" width="${(bw - 3).toFixed(1)}" height="${H - T - B}" class="c-hit"/>`;
            s += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"
                   fill="${isMax ? 'var(--chart-warn)' : '#64748b'}"/>`;
            s += `<text x="${(bx + (bw - 3) / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="c-tick">${Charts.esc(it.label)}</text>`;
            s += `</g>`;
        });
        s += `<text x="${W - R}" y="11" text-anchor="end" class="c-val">${Charts.fmt(items[items.length - 1].value, dp)}</text>`;
        s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="c-ax"/>`;
        s += '</svg>';
        return s;
    }

    // ---------------------------------------------------------------- interaction

    _flyToAxis(name) {
        const db = this.dashboard;
        // regionPolygons holds only the Russian groupings, not the 12 GSUA axes, so
        // the polygon cache is a bonus rather than the path. Never call
        // loadPredefinedRegion() — it mutates drawnItems and selectedPolygons.
        const poly = db.regionPolygonCache?.get(name);
        if (poly && window.L) {
            try {
                db.map.fitBounds(L.geoJSON(poly).getBounds(), { padding: [24, 24] });
                return;
            } catch (err) { /* fall through to the point */ }
        }
        const c = db.regionCoordinates?.[name];
        if (c) db.map.setView(c, 10);
    }

    _setDateRange(startISO, endISO) {
        const db = this.dashboard;
        const start = new Date(startISO);
        const end = new Date(endISO);
        if (!(start instanceof Date) || isNaN(start) || isNaN(end)) return;
        this._applyingRange = true;
        try {
            if (start >= db.minDate && end <= db.maxDate) {
                db.updateSliderValues(start, end);
            } else {
                // Canonical widening recipe, from AttackMapDashboard.restoreSession
                // by way of mcp/browser/agent-api.js setDates().
                if (start < db.minDate) db.minDate = start;
                if (end > db.maxDate) db.maxDate = end;
                const ds = db.getEl('date-start'); if (ds) ds.valueAsDate = db.minDate;
                const de = db.getEl('date-end'); if (de) de.valueAsDate = db.maxDate;
                db.initSlider(db.minDate, db.maxDate, start, end);
            }
        } finally {
            this._applyingRange = false;
        }
        this.refresh({ force: true });
    }

    _onBrushStart(e) {
        const rect = e.target.closest('#charts-brush');
        if (!rect) return;
        const d = this._window(Charts.iso(this.dashboard.startDate), Charts.iso(this.dashboard.endDate)).daily;
        if (d.length < 2) return;
        e.preventDefault();
        // Map through the brush rect's own box, not the SVG's: the rect already spans
        // exactly the plot area, so the fraction across it is the fraction across the
        // days with no margin arithmetic. Bail on a zero-width box (panel mid-
        // transition, hidden tab) — dividing by it clamps every index to the same day.
        const box = rect.getBoundingClientRect();
        if (!box.width) return;
        const toIndex = (clientX) => {
            const f = (clientX - box.left) / box.width;
            return Math.max(0, Math.min(d.length - 1, Math.round(f * (d.length - 1))));
        };
        const a = toIndex(e.clientX);
        rect.setPointerCapture(e.pointerId);
        const move = (ev) => { ev.preventDefault(); };
        const up = (ev) => {
            rect.removeEventListener('pointermove', move);
            rect.removeEventListener('pointerup', up);
            const b = toIndex(ev.clientX);
            const lo = Math.min(a, b), hi = Math.max(a, b);
            if (hi - lo < 1) return;                    // a click, not a drag
            this._setDateRange(d[lo].date, d[hi].date);
        };
        rect.addEventListener('pointermove', move);
        rect.addEventListener('pointerup', up);
    }

    // ---------------------------------------------------------------- session

    /**
     * Only the card set. Whether the panel itself is open lives in
     * SESSION_TOGGLE_IDS as `charts-panel-on`, which is also what the MCP
     * map_set_layers tool drives — keeping it in one place avoids two sources of
     * truth disagreeing on restore.
     */
    serialize() {
        return { cards: [...this._openCards] };
    }

    /** Call before the session's toggle pass, so the first render uses these cards. */
    restore(state) {
        if (!state || !Array.isArray(state.cards)) return;
        this._openCards = new Set(state.cards);
        if (this.isOpen()) this.refresh({ force: true });
    }

    /** Plain JSON for the MCP bridge. */
    summary() {
        if (!this.daily) return { loaded: false, open: this.isOpen() };
        const w = this._window(Charts.iso(this.dashboard.startDate), Charts.iso(this.dashboard.endDate));
        return {
            loaded: true, open: this.isOpen(), tier2: !!this.tier2,
            window: { from: w.from, to: w.to, days: w.days },
            ru: w.ru, ua: w.ua, losses: w.losses,
            lossesPerAssault: w.ru ? +(w.losses / w.ru).toFixed(2) : null,
            axes: w.axes,
            cards: [...this._openCards]
        };
    }
}

window.Charts = Charts;

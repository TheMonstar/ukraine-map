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

    /**
     * Month panels show this many recent months; more labels than this are
     * unreadable at the given width. Expanding the panel earns more of them.
     */
    static MONTH_TAIL = 18;
    static MONTH_TAIL_WIDE = 40;

    /** The groupings are keyed in Cyrillic (regionPolygons/regionCoordinates use
     *  those names); show them transliterated but always look up by the key. */
    static DIRECTION_LABELS = {
        'Север': 'Sever', 'Запад': 'Zapad', 'Юг': 'Yug',
        'Центр': 'Tsentr', 'Восток': 'Vostok', 'Днепр': 'Dnepr'
    };

    /** Same palette renderDeepLayer paints diff slices with, so a segment here and
     *  a patch on the map are recognisably the same period. */
    static SLICE_COLORS = ['#ff5252', '#ff9800', '#ffeb3b', '#8bc34a', '#03a9f4', '#9c27b0'];

    /** SVG viewBox width, narrow and expanded. Charts re-render, they do not scale. */
    static W_NARROW = 320;
    static W_WIDE = 660;

    static CARDS = [
        { id: 'axis', title: 'Axis pressure', open: true },
        { id: 'tempo', title: 'Daily tempo', open: true },
        { id: 'ledger', title: 'Territory ledger', open: false },
        { id: 'region', title: 'Km² by direction', open: false },
        { id: 'price', title: 'Price of ground', open: true },
        { id: 'gsua', title: 'General Staff, by month', open: false },
        { id: 'usf', title: 'Drone force', open: false },
        // Only while the geolocated-events layer is on — the card charts exactly the
        // array that layer already fetched, so it has nothing to show otherwise.
        {
            id: 'events', title: 'Geolocated events', open: false,
            when: (db) => db.isChecked('feature-owl-events') && (db.owlEventsData || []).length > 0
        }
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
    static dirLabel(name) {
        return Charts.DIRECTION_LABELS[name] || name;
    }

    /** OWL event dates arrive as YYYYMMDD; every other date in this file is ISO. */
    static eventIso(v) {
        const s = String(v ?? '');
        if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
        return s.slice(0, 10);
    }

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
        this._sources = null;           // DeepState/Suriyak/RIA comparison, on demand
        this._sourcesBusy = false;
        this._regions = null;           // per-direction breakdown, on demand
        this._regionGeom = null;        // its diff geometry, kept so a tab switch re-clips
        this._regionsBusy = false;
        this._regionSide = 'ua';        // 'ua' = the 12 GS axes, 'ru' = the 6 groupings
        this._sawEvents = false;
        this._months = null;
        this._partialMonth = null;
        this._openCards = new Set(Charts.CARDS.filter(c => c.open).map(c => c.id));
        this._lastKey = null;
        this._debounce = null;
        this._applyingRange = false;
        this._bound = false;
        this._loaded = false;
        this._wide = false;
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

        this._settleMapSize();

        if (open) {
            this._bindPanel();
            this.refresh({ force: true });
        }
    }

    /**
     * Leaflet is never told the map resized anywhere in this app, so changing the
     * panel width leaves a stale pixel size: wrong click targets and a skewed MCP
     * screenshot. transitionend is the accurate signal; the timer is the fallback
     * for when the transition is suppressed (reduced motion, background tab) and is
     * deliberately longer than the 300ms transition — firing mid-ease captures an
     * intermediate width and leaves Leaflet wrong in the other direction.
     */
    _settleMapSize() {
        const panel = this.dashboard.getEl('charts-panel');
        const settle = () => this.dashboard.map?.invalidateSize();
        if (panel) panel.addEventListener('transitionend', settle, { once: true });
        clearTimeout(this._sizeTimer);
        this._sizeTimer = setTimeout(settle, 450);
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
        } else if (kind === 'expand') {
            this.setWide(!this._wide);
        } else if (kind === 'axis') {
            this._flyToAxis(act.dataset.axis);
        } else if (kind === 'month') {
            this._setDateRange(act.dataset.from, act.dataset.to);
        } else if (kind === 'compare-sources') {
            this._compareSources();
        } else if (kind === 'compute-regions') {
            this._computeRegions(act.dataset.source || 'DeepState');
        } else if (kind === 'region-side') {
            this._setRegionSide(act.dataset.side);
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

    /**
     * Under 768px the panel is an overlay drawer capped near 340px, so the wide
     * viewBox would only render the same charts at a smaller effective type size.
     * Expanded is a no-op there and the button is hidden by the same media query.
     */
    _effectiveWide() {
        return this._wide && !window.matchMedia('(max-width: 768px)').matches;
    }

    _w() { return this._effectiveWide() ? Charts.W_WIDE : Charts.W_NARROW; }

    _mh() { return this._effectiveWide() ? 150 : 92; }

    _monthTail() {
        return this._effectiveWide() ? Charts.MONTH_TAIL_WIDE : Charts.MONTH_TAIL;
    }

    /**
     * Expanded mode. The width token lives on <body> rather than the panel because
     * .charts-toggle is a sibling of the panel and reads the same token for its
     * offset — scoping it to the panel would strand the button.
     */
    setWide(wide) {
        this._wide = !!wide;
        document.body.classList.toggle('charts-wide', this._wide);
        const btn = this.dashboard.getEl('charts-expand');
        if (btn) {
            btn.classList.toggle('on', this._wide);
            btn.title = this._wide ? 'Shrink charts' : 'Expand charts';
            btn.setAttribute('aria-pressed', String(this._wide));
        }
        this._settleMapSize();
        this.refresh({ force: true });
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

    static _dayAfter(iso) {
        const d = new Date(`${iso}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
    }

    /**
     * The date-split boundaries as consecutive, non-overlapping windows. Slices share
     * a boundary date on the map; here each window starts the day after the previous
     * one ends, so the segments sum to the whole-window total instead of
     * double-counting every boundary day.
     */
    _sliceWindows() {
        const db = this.dashboard;
        const dates = db.getDiffSliceDates ? db.getDiffSliceDates() : [];
        if (!dates.length) return null;
        const bounds = [db.startDate, ...dates, db.endDate].map(Charts.iso);
        const out = [];
        for (let i = 0; i < bounds.length - 1; i++) {
            const from = i === 0 ? bounds[i] : Charts._dayAfter(bounds[i]);
            const to = bounds[i + 1];
            if (from > to) continue;
            out.push({ from, to, color: Charts.SLICE_COLORS[i % Charts.SLICE_COLORS.length] });
        }
        return out.length > 1 ? out : null;
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

    /**
     * The geolocated-events layer finished loading, or was switched off. The card
     * appears and disappears with it, so a plain re-render is the whole handler —
     * but only when the panel is open, or this fires on every date change with the
     * layer on and nothing to show for it.
     */
    onOwlEvents() {
        if (!this.isOpen()) return;
        const available = Charts.CARDS.find(c => c.id === 'events')?.when(this.dashboard);
        if (available && !this._sawEvents) {
            // first time it has anything: open it rather than hiding the new card
            this._sawEvents = true;
            this._openCards.add('events');
        }
        this.refresh({ force: true });
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
        const html = Charts.CARDS.filter(c => !c.when || c.when(this.dashboard)).map((card) => {
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
                case 'region': return this._chartRegions();
                case 'price': return this._chartPrice(win);
                case 'gsua': return this._chartGsua(win);
                case 'usf': return this._chartUsf();
                case 'events': return this._chartEvents();
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
        const slices = this._sliceWindows();
        return slices ? this._axisSliced(win, slices) : this._axisBullet(win);
    }

    /** No date splits: this window against the previous equal-length one. */
    _axisBullet(win) {
        const prev = this._previousWindow(win);
        const rows = Charts.AXES
            .map(a => ({ name: a, now: win.axes[a], was: prev ? prev.axes[a] : null }))
            .sort((x, y) => y.now - x.now);
        const mx = Math.max(1, ...rows.map(r => Math.max(r.now, r.was ?? 0)));

        // R reserves two right-hand columns: the value, then the signed delta.
        // They collide at anything narrower.
        const W = this._w(), L = 74, R = 76, rh = this._effectiveWide() ? 24 : 19, T = 4;
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
            Click an axis to move the map there. Set <b>Diff slices</b> to break each axis
            down by period.</p>`;
    }

    /**
     * Date splits are on: each axis becomes a stacked bar, one segment per slice, in
     * the slice colours the map paints. The stack total is still the window total, so
     * the ordering reads the same as the unsplit chart while the segments show when
     * within the window the pressure actually fell.
     */
    _axisSliced(win, slices) {
        const per = slices.map(s => ({ ...s, w: this._window(s.from, s.to) }));
        const rows = Charts.AXES
            .map(a => ({
                name: a,
                now: win.axes[a],
                parts: per.map(p => ({ v: p.w.axes[a], color: p.color, from: p.from, to: p.to }))
            }))
            .sort((x, y) => y.now - x.now);
        const mx = Math.max(1, ...rows.map(r => r.now));

        const W = this._w(), L = 74, R = 46, rh = this._effectiveWide() ? 24 : 19, T = 4;
        const h = T + rows.length * rh + 4;
        const sc = (W - L - R) / mx;
        let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Russian assaults per axis, by period">`;
        rows.forEach((r, i) => {
            const y = T + i * rh;
            s += `<g data-act="axis" data-axis="${Charts.esc(r.name)}" style="cursor:pointer">`;
            s += `<text x="${L - 6}" y="${y + 11}" text-anchor="end" class="c-lbl">${Charts.esc(r.name)}</text>`;
            let x = L;
            r.parts.forEach((p) => {
                const bw = p.v * sc;
                if (bw > 0.15) {
                    const tip = `${r.name} · ${p.from} → ${p.to}: ${Charts.fmt(p.v)} assaults`;
                    // A 2px surface gap keeps adjacent segments legible; skip it when
                    // the segment is too thin to survive being trimmed.
                    const gap = bw > 4 ? 1.5 : 0;
                    s += `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${(bw - gap).toFixed(1)}" height="11"`
                        + ` fill="${p.color}" data-tip="${Charts.esc(tip)}"/>`;
                }
                x += bw;
            });
            s += `<text x="${W - R + 5}" y="${y + 11}" class="c-val">${Charts.fmt(r.now)}</text>`;
            s += `</g>`;
        });
        s += '</svg>';

        const legend = per.map(p =>
            `<span><i style="background:${p.color}"></i>${Charts.esc(p.from.slice(5))}–${Charts.esc(p.to.slice(5))}</span>`
        ).join('');
        const totals = per.map(p => Charts.fmt(p.w.ru)).join(' → ');
        return `<div class="charts-legend">${legend}</div>${s}
            <p class="charts-card-note">${Charts.fmt(win.ru)} Russian assaults across
            ${per.length} periods: ${totals}. Segment colours match the diff slices on the map.</p>`;
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
        const W = this._w(), H = this._effectiveWide() ? 190 : 108, L = 24, R = 4, T = 6, B = 16;
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
        if (!stats) return this._ledgerSources();
        const W = this._w(), rh = this._effectiveWide() ? 42 : 34, L = 4, R = 4, T = 14;
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
     * With no date splits there is no per-period ledger to draw, so the card answers
     * the other question worth asking of one window: how far apart the three mapping
     * projects are on it. Net area alone hides that — a map that never concedes
     * ground reports a very different month from one that does.
     */
    _ledgerSources() {
        const src = this._sources;
        const busy = this._sourcesBusy;
        const head = `<p class="charts-empty">No date splits, so there is no per-period ledger.
            Compare what the three mapping projects say about this one window instead —
            or set <b>Diff slices</b> for a ledger over time.</p>`;
        if (!src) {
            return head + `<p><button class="btn btn-sm" data-act="compare-sources"
                ${busy ? 'disabled' : ''}>${busy ? 'Comparing…' : 'Compare sources'}</button></p>`;
        }

        const rows = src.rows;
        const mx = Math.max(1, ...rows.map(r => Math.max(r.gains, r.losses)));
        const W = this._w(), rh = this._effectiveWide() ? 44 : 36, L = 62, R = 96, T = 16;
        const h = T + rows.length * rh + 6;
        const mid = L + (W - L - R) * 0.5;
        const sc = Math.min(mid - L, W - R - mid) / mx;
        let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Area change by mapping project">`;
        s += `<text x="${mid}" y="10" text-anchor="middle" class="c-tick">given back | gained</text>`;
        s += `<line x1="${mid}" y1="${T}" x2="${mid}" y2="${h - 4}" class="c-ax"/>`;
        rows.forEach((r, i) => {
            const y = T + i * rh;
            const net = r.gains - r.losses;
            const back = r.gains > 0 ? (r.losses / r.gains * 100) : null;
            const gw = r.gains * sc, lw = r.losses * sc;
            const tip = r.failed
                ? `${r.name}: unavailable for this window`
                : `${r.name}: gained ${r.gains.toFixed(0)} km², gave back ${r.losses.toFixed(0)}`
                  + (back === null ? '' : ` (${back.toFixed(0)}% of what it took)`);
            s += `<g data-tip="${Charts.esc(tip)}">`;
            s += `<rect x="0" y="${y}" width="${W}" height="${rh - 4}" class="c-hit"/>`;
            s += `<text x="4" y="${y + 14}" class="c-lbl">${Charts.esc(r.name)}</text>`;
            s += `<rect x="${(mid - lw).toFixed(1)}" y="${y + 4}" width="${lw.toFixed(1)}" height="12" rx="2" class="c-ua"/>`;
            s += `<rect x="${mid}" y="${y + 4}" width="${gw.toFixed(1)}" height="12" rx="2" class="c-ru"/>`;
            s += `<text x="${(mid - lw - 4).toFixed(1)}" y="${y + 13}" text-anchor="end" class="c-val">${r.losses.toFixed(0)}</text>`;
            s += `<text x="${(mid + gw + 4).toFixed(1)}" y="${y + 13}" class="c-val">${r.gains.toFixed(0)}</text>`;
            s += `<text x="${W - 4}" y="${y + 13}" text-anchor="end" class="c-val ${net > 0 ? 'c-up' : net < 0 ? 'c-dn' : 'c-fl'}">net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(0)} km²</text>`;
            if (back !== null) {
                s += `<text x="${W - 4}" y="${y + 25}" text-anchor="end" class="c-tick">gives back ${back.toFixed(0)}%</text>`;
            }
            s += `</g>`;
        });
        s += '</svg>';

        const ds = rows.find(r => r.name === 'DeepState');
        const ria = rows.find(r => r.name === 'RIA');
        let read = '';
        if (ds && ria && ds.gains > 0 && ria.gains > 0) {
            const dsBack = ds.losses / ds.gains * 100, riaBack = ria.losses / ria.gains * 100;
            read = ` DeepState gives back ${dsBack.toFixed(0)}% of what it takes, RIA
                ${riaBack.toFixed(0)}%. A map that rarely concedes ground is not tracking a
                front line so much as ratcheting.`;
        }
        return `<div class="charts-legend">
                <span><i style="background:var(--chart-ru)"></i>gained</span>
                <span><i style="background:var(--chart-ua)"></i>given back</span>
            </div>${s}
            <p class="charts-card-note">${Charts.esc(src.window)}. The three map different
            things — assessed control, every polygon regardless of status, and a state-media
            overlay — so they are never merged or averaged.${read}</p>
            <p><button class="btn btn-sm" data-act="compare-sources"
               ${busy ? 'disabled' : ''}>${busy ? 'Comparing…' : 'Recompute'}</button></p>`;
    }

    /**
     * Where the month's ground actually moved. Clips one source's gain and loss
     * geometry against the six Russian groupings — the only region set this app
     * holds polygons for (regionPolygons covers the groupings, not the twelve
     * General Staff axes). Behind a button for the same reason as the source
     * comparison: it is a fetch plus a turf union plus six intersects.
     */
    async _computeRegions(sourceName = 'DeepState') {
        if (this._regionsBusy) return;
        const db = this.dashboard;
        if (!db.regionDiffRows) {
            this.setStatus('Direction breakdown unavailable', true);
            return;
        }
        const from = db.startDate, to = db.endDate;
        this._regionsBusy = true;
        this.setStatus(`Clipping ${sourceName} by direction…`);
        this.refresh({ force: true });
        try {
            const diff = sourceName === 'Suriyak'
                ? await db.layers.getManifestDiffAreaKm2('suriyak', from, to)
                : sourceName === 'RIA'
                    ? await db.layers.getRiaDiffAreaKm2(from, to)
                    : await db.getDeepStateDiffKm2(from, to);
            // Keep the geometry: switching tab is then six or twelve intersects
            // rather than another fetch and union.
            this._regionGeom = {
                source: sourceName,
                window: `${Charts.iso(from)} → ${Charts.iso(to)}`,
                gainsGeom: diff.gainsGeom, lossesGeom: diff.lossesGeom,
                total: { gains: diff.gains || 0, losses: diff.losses || 0 }
            };
            this._clipRegions();
            this.setStatus('');
        } catch (error) {
            console.error('Charts: direction breakdown failed', error);
            this.setStatus('Direction breakdown failed', true);
            this._regions = null;
            this._regionGeom = null;
        } finally {
            this._regionsBusy = false;
            this.refresh({ force: true });
        }
    }

    /** Re-clip the cached geometry against whichever region set the tab selects. */
    _clipRegions() {
        const g = this._regionGeom;
        if (!g) { this._regions = null; return; }
        const names = this._regionSide === 'ru'
            ? (this.dashboard.RU_DIRECTIONS || [])
            : Charts.AXES;
        const rows = this.dashboard.regionDiffRows(g.gainsGeom, g.lossesGeom, names);
        this._regions = {
            source: g.source, window: g.window, side: this._regionSide,
            rows: rows.slice().sort((a, b) => (b.gains + b.losses) - (a.gains + a.losses)),
            total: g.total
        };
    }

    _setRegionSide(side) {
        if (side !== 'ua' && side !== 'ru') return;
        if (side === this._regionSide) return;
        this._regionSide = side;
        this._clipRegions();
        this.refresh({ force: true });
    }

    _chartRegions() {
        const src = this._regions;
        const busy = this._regionsBusy;
        const side = this._regionSide;
        const tabs = `<div class="charts-tabs">`
            + `<button class="${side === 'ua' ? 'on' : ''}" data-act="region-side" data-side="ua">`
            + `UA axes</button>`
            + `<button class="${side === 'ru' ? 'on' : ''}" data-act="region-side" data-side="ru">`
            + `RU groupings</button></div>`;
        const picker = ['DeepState', 'Suriyak', 'RIA'].map(n =>
            `<button class="btn btn-sm" data-act="compute-regions" data-source="${n}"
              ${busy ? 'disabled' : ''}>${busy && src?.source === n ? 'Working…' : n}</button>`
        ).join(' ');

        const setName = side === 'ru' ? 'Russian groupings' : 'General Staff axes';
        if (!src) {
            return tabs + `<p class="charts-empty">Gains and losses clipped against the
                ${setName}, for the selected window. Pick a source:</p>
                <p class="btn-row">${picker}</p>`;
        }
        if (!src.rows.length) {
            return tabs + `<p class="charts-empty">${Charts.esc(src.source)} recorded no change
                inside any of the ${setName} for ${Charts.esc(src.window)}.</p>
                <p class="btn-row">${picker}</p>`;
        }

        const rows = src.rows;
        const mx = Math.max(1, ...rows.map(r => Math.max(r.gains, r.losses)));
        const W = this._w(), rh = this._effectiveWide() ? 40 : 32, L = 62, R = 92, T = 16;
        const h = T + rows.length * rh + 6;
        const mid = L + (W - L - R) * 0.5;
        const sc = Math.min(mid - L, W - R - mid) / mx;
        let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Area change by direction">`;
        s += `<text x="${mid}" y="10" text-anchor="middle" class="c-tick">lost | taken</text>`;
        s += `<line x1="${mid}" y1="${T}" x2="${mid}" y2="${h - 4}" class="c-ax"/>`;
        rows.forEach((r, i) => {
            const y = T + i * rh;
            const gw = r.gains * sc, lw = r.losses * sc;
            const net = r.net;
            const tip = `${Charts.dirLabel(r.name)}: Russia took ${r.gains.toFixed(1)} km², lost ${r.losses.toFixed(1)}`
                + ` — net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)} km²`;
            s += `<g data-act="axis" data-axis="${Charts.esc(r.name)}" data-tip="${Charts.esc(tip)}" style="cursor:pointer">`;
            s += `<rect x="0" y="${y}" width="${W}" height="${rh - 4}" class="c-hit"/>`;
            s += `<text x="4" y="${y + 14}" class="c-lbl">${Charts.esc(Charts.dirLabel(r.name))}</text>`;
            s += `<rect x="${(mid - lw).toFixed(1)}" y="${y + 4}" width="${lw.toFixed(1)}" height="12" rx="2" class="c-ua"/>`;
            s += `<rect x="${mid}" y="${y + 4}" width="${gw.toFixed(1)}" height="12" rx="2" class="c-ru"/>`;
            if (lw > 16) s += `<text x="${(mid - lw + 4).toFixed(1)}" y="${y + 13}" class="c-val" fill="var(--ground)">${r.losses.toFixed(0)}</text>`;
            if (gw > 16) s += `<text x="${(mid + gw - 4).toFixed(1)}" y="${y + 13}" text-anchor="end" class="c-val" fill="var(--ground)">${r.gains.toFixed(0)}</text>`;
            s += `<text x="${W - 4}" y="${y + 13}" text-anchor="end" class="c-val ${net > 0 ? 'c-up' : net < 0 ? 'c-dn' : 'c-fl'}">${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)} km²</text>`;
            s += `</g>`;
        });
        s += '</svg>';

        const covered = rows.reduce((a, r) => a + r.gains + r.losses, 0);
        const all = src.total.gains + src.total.losses;
        const outside = all > 0 ? Math.max(0, 100 - covered / all * 100) : 0;
        const top = rows[0];
        return tabs + `<div class="charts-legend">
                <span><i style="background:var(--chart-ru)"></i>Russia took</span>
                <span><i style="background:var(--chart-ua)"></i>Russia lost</span>
            </div>${s}
            <p class="charts-card-note">${Charts.esc(src.source)}, ${Charts.esc(src.window)}.
            Most movement in <b>${Charts.esc(Charts.dirLabel(top.name))}</b>
            (${(top.gains + top.losses).toFixed(0)} km² changed hands either way).
            ${outside > 1 ? `${outside.toFixed(0)}% of the change fell outside this region set.` : ''}
            Click a row to move the map there. The two tabs are different units of account —
            ${side === 'ru' ? 'Russian operational commands' : 'General Staff axes'} — and are
            never differenced against each other.</p>
            <p class="btn-row">${picker}</p>`;
    }

    /**
     * DeepState against Suriyak against RIA over the selected window. Deliberately
     * behind a button: each source is a per-day KML/GeoJSON fetch and a turf union,
     * far too heavy to fire off a slider drag. All three return the same
     * { gains, losses } shape and all three are Russian-relative.
     */
    async _compareSources() {
        if (this._sourcesBusy) return;
        const db = this.dashboard;
        const from = db.startDate, to = db.endDate;
        const label = `${Charts.iso(from)} → ${Charts.iso(to)}`;
        this._sourcesBusy = true;
        this.setStatus('Comparing sources…');
        const rows = [];
        const add = async (name, fn) => {
            try {
                const r = await fn();
                if (r) rows.push({ name, gains: r.gains || 0, losses: r.losses || 0 });
            } catch (error) {
                console.warn(`Charts: ${name} diff failed`, error);
                rows.push({ name, gains: 0, losses: 0, failed: true });
            }
        };
        await add('DeepState', () => db.getDeepStateDiffKm2?.(from, to));
        await add('Suriyak', () => db.layers.getManifestDiffAreaKm2('suriyak', from, to));
        await add('RIA', () => db.layers.getRiaDiffAreaKm2(from, to));
        this._sources = { window: label, rows };
        this._sourcesBusy = false;
        this.setStatus('');
        this.refresh({ force: true });
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
        const W = this._w(), H = this._effectiveWide() ? 170 : 100, L = 24, R = 4, T = 8, B = 16;
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
        const months = this._byMonth().slice(-this._monthTail());
        if (!months.length) return '<p class="charts-empty">No monthly data.</p>';
        const eng = this.tier2?.gsua || null;

        let out = Charts.monthBars(months.map(r => ({
            label: r.m.slice(5), value: r.ru,
            tip: `${r.m}: ${Charts.fmt(r.ru)} Russian assaults over ${r.days} days`
        })), 'Russian assaults', this._w(), this._mh());

        if (eng) {
            const rows = months
                .map(r => ({ m: r.m, e: eng[r.m]?.engagements }))
                .filter(r => Number.isFinite(r.e?.perDay));
            if (rows.length) {
                out += Charts.monthBars(rows.map(r => ({
                    label: r.m.slice(5), value: r.e.perDay,
                    tip: `${r.m}: ${Charts.fmt(r.e.perDay, 1)} engagements per reported day `
                        + `(${Charts.fmt(r.e.total)} over ${r.e.days} days)`
                })), 'Combat engagements per reported day', this._w(), this._mh());
            }
        }

        out += Charts.monthBars(months.map(r => ({
            label: r.m.slice(5), value: r.losses,
            tip: `${r.m}: ${Charts.fmt(r.losses)} claimed Russian losses`
        })), 'Claimed Russian losses', this._w(), this._mh());

        const price = months.filter(r => r.ru > 0);
        out += Charts.monthBars(price.map(r => ({
            label: r.m.slice(5), value: r.losses / r.ru,
            tip: `${r.m}: ${(r.losses / r.ru).toFixed(2)} claimed losses per assault`
        })), 'Losses per assault', this._w(), this._mh(), 1);

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
        const months = (t2.months || []).filter(m => t2.usf[m]).slice(-this._monthTail());
        if (!months.length) return '<p class="charts-empty">No drone-force data.</p>';
        const panel = (pick, title, dp = 0) => Charts.monthBars(months.map(m => {
            const u = t2.usf[m];
            return { label: m.slice(5), value: pick(u), tip: `${m}: ${Charts.fmt(pick(u), dp)}` };
        }), title, this._w(), this._mh(), dp);
        return panel(u => u.strikeSorties, 'Strike sorties')
            + panel(u => u.totalPersonnelCasualties, 'Claimed personnel casualties')
            + panel(u => (u.strikeSorties ? u.totalPersonnelCasualties / u.strikeSorties * 1000 : 0),
                'Casualties per 1 000 sorties', 0)
            + `<p class="charts-card-note">Sorties and claimed effect have come apart: the third
               panel is the one that shows it.</p>`;
    }

    /**
     * The geolocated event archive for the selected window. Counts are the wrong
     * thing to trust here — the archive backfills for weeks, so the most recent days
     * are always understated and a falling tail is an artefact, not a quiet week.
     * The composition charts are the reliable read, and the daily bars shade the
     * unsettled tail rather than pretending it is complete.
     */
    _chartEvents() {
        const all = this.dashboard.owlEventsData || [];
        if (!all.length) return '<p class="charts-empty">No events loaded for this window.</p>';

        const byDate = new Map();
        const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1);
        const targets = new Map(), actors = new Map(), events = new Map(), terr = new Map();
        for (const e of all) {
            if (e.date) tally(byDate, Charts.eventIso(e.date));
            tally(targets, e.target || 'unknown');
            tally(actors, e.actor || 'unknown');
            tally(events, e.event || 'other');
            if (e.territory) tally(terr, e.territory);
        }
        const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        let out = '';

        // ---- per day, with the unsettled tail marked
        if (days.length > 1) {
            const W = this._w(), H = this._effectiveWide() ? 150 : 96;
            const L = 26, R = 4, T = 8, B = 16;
            const mx = Charts.niceMax(Math.max(...days.map(d => d[1])));
            const sy = v => T + (H - T - B) * (1 - v / mx);
            const bw = (W - L - R) / days.length;
            // Roughly how long the archive keeps filling in; days newer than this are
            // provisional whatever they currently show.
            const settleFrom = new Date(Date.now() - 11 * 86400000).toISOString().slice(0, 10);
            let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Events per day">`;
            for (let i = 0; i <= 2; i++) {
                const v = mx * i / 2, y = sy(v);
                s += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" class="c-grid"/>`;
                s += `<text x="${L - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="c-tick">${Charts.fmt(v)}</text>`;
            }
            let firstUnsettled = -1;
            days.forEach(([d, n], i) => {
                const provisional = d >= settleFrom;
                if (provisional && firstUnsettled < 0) firstUnsettled = i;
                const bh = (H - T - B) * (n / mx);
                s += `<rect x="${(L + i * bw + 0.6).toFixed(1)}" y="${sy(n).toFixed(1)}"`
                    + ` width="${Math.max(0.8, bw - 1.2).toFixed(2)}" height="${(H - B - sy(n)).toFixed(1)}"`
                    + ` fill="var(--chart-ua)" opacity="${provisional ? 0.4 : 1}"`
                    + ` data-tip="${Charts.esc(`${d}: ${n} events${provisional ? ' — still backfilling' : ''}`)}"/>`;
            });
            if (firstUnsettled > 0) {
                const x = L + firstUnsettled * bw;
                s += `<line x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${H - B}" class="c-break"/>`;
            }
            s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="c-ax"/>`;
            s += `<text x="${L}" y="${H - 4}" class="c-tick">${Charts.esc(days[0][0].slice(5))}</text>`;
            s += `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="c-tick">${Charts.esc(days[days.length - 1][0].slice(5))}</text>`;
            s += '</svg>';
            out += `<p class="charts-card-note" style="margin:0 2px 2px">Events per day</p>${s}`;
        }

        // ---- what was hit, split by who is credited with it
        const top = [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        if (top.length) {
            const splitFor = (name) => {
                let ru = 0, ua = 0, other = 0;
                for (const e of all) {
                    if ((e.target || 'unknown') !== name) continue;
                    if (e.actor === 'RU') ru++; else if (e.actor === 'UA') ua++; else other++;
                }
                return { ru, ua, other };
            };
            const W = this._w(), L = 84, R = 44, rh = this._effectiveWide() ? 22 : 18, T = 4;
            const h = T + top.length * rh + 4;
            const mx = Math.max(1, ...top.map(x => x[1]));
            const sc = (W - L - R) / mx;
            let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Events by target">`;
            top.forEach(([name, n], i) => {
                const y = T + i * rh;
                const sp = splitFor(name);
                let x = L;
                s += `<text x="${L - 6}" y="${y + 11}" text-anchor="end" class="c-lbl">${Charts.esc(name)}</text>`;
                [['ru', 'var(--chart-ru)'], ['ua', 'var(--chart-ua)'], ['other', 'var(--chart-prev)']]
                    .forEach(([k, fill]) => {
                        const w = sp[k] * sc;
                        if (w <= 0.15) return;
                        const tip = `${name} · ${k === 'other' ? 'unattributed' : k.toUpperCase()}: ${sp[k]} events`;
                        s += `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="11" fill="${fill}"`
                            + ` data-tip="${Charts.esc(tip)}"/>`;
                        x += w;
                    });
                s += `<text x="${W - R + 5}" y="${y + 11}" class="c-val">${Charts.fmt(n)}</text>`;
            });
            s += '</svg>';
            out += `<p class="charts-card-note" style="margin:10px 2px 2px">By target, split by actor</p>
                <div class="charts-legend">
                    <span><i style="background:var(--chart-ru)"></i>RU</span>
                    <span><i style="background:var(--chart-ua)"></i>UA</span>
                    <span><i style="background:var(--chart-prev)"></i>unattributed</span>
                </div>${s}`;
        }

        const pct = (n) => (n / all.length * 100).toFixed(0);
        const ru = actors.get('RU') || 0, ua = actors.get('UA') || 0;
        const strike = events.get('strike') || 0;
        const terrBits = ['ukraine', 'occupied', 'russia']
            .filter(k => terr.get(k))
            .map(k => `${k} ${pct(terr.get(k))}%`).join(', ');
        return out + `<p class="charts-card-note">${Charts.fmt(all.length)} events over
            ${days.length} day${days.length === 1 ? '' : 's'}. RU-attributed ${pct(ru)}%,
            UA-attributed ${pct(ua)}%. Strikes are ${pct(strike)}% of all events.
            ${terrBits ? `Landing in ${terrBits}.` : ''}
            <b>Counts backfill for weeks</b>, so the faded bars are provisional and the archive
            total is never a trend. Composition is the safer read.</p>`;
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
        return { cards: [...this._openCards], wide: this._wide, regionSide: this._regionSide };
    }

    /** Call before the session's toggle pass, so the first render uses these cards. */
    restore(state) {
        if (!state || !Array.isArray(state.cards)) return;
        this._openCards = new Set(state.cards);
        if (state.regionSide === 'ua' || state.regionSide === 'ru') {
            this._regionSide = state.regionSide;
            this._clipRegions();
        }
        if (typeof state.wide === 'boolean' && state.wide !== this._wide) {
            this.setWide(state.wide);
            return;   // setWide already refreshed
        }
        if (this.isOpen()) this.refresh({ force: true });
    }

    /** Plain JSON for the MCP bridge. */
    summary() {
        if (!this.daily) return { loaded: false, open: this.isOpen() };
        const w = this._window(Charts.iso(this.dashboard.startDate), Charts.iso(this.dashboard.endDate));
        return {
            loaded: true, open: this.isOpen(), wide: this._wide, tier2: !!this.tier2,
            window: { from: w.from, to: w.to, days: w.days },
            ru: w.ru, ua: w.ua, losses: w.losses,
            lossesPerAssault: w.ru ? +(w.losses / w.ru).toFixed(2) : null,
            axes: w.axes,
            cards: [...this._openCards]
        };
    }
}

window.Charts = Charts;

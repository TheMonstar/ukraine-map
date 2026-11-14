/**
 * Low cloud, fog, visibility and cloud base — what a drone can see and how high it can fly — sampled on a
 * grid over the view and painted as one smooth image per hour, from Open-Meteo (free, no key). Two modes:
 *   forecast  ICON-EU (DWD, ~7 km, hourly to ~5.5 days ahead);
 *   history   the Historical Forecast archive (the models' own past hours, with visibility, from 2022): ICON-EU
 *             from 24 Jul 2024, Open-Meteo's best_match blend before. The day follows the date slider.
 * Cloud base is not a model output here: it is the lowest height above ground where the cloud cover on the
 * pressure levels (1000…700 hPa, heights from surface pressure and temperature) reaches 60 % (broken), 0 in fog,
 * and null when no level up to 700 hPa (~3 km) does.
 *
 * A snapshot is the whole fetch — grid, hours and values — so the same hours can be redrawn without the
 * network: the sidebar keeps one per view, and a 2D video keeps one per film (map_prepare_video writes
 * it next to the export, through the static helpers below, which Node loads with require()).
 *
 * Rows are spaced evenly in Web Mercator y, so the image overlays Leaflet's map without a seam.
 */
(function () {
    const API = 'https://api.open-meteo.com/v1/forecast';
    const HISTORY_API = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
    const HISTORY_FROM = '2022-01-01';
    const HISTORY_MAX_DAYS = 31;
    const ICON_EU_HISTORY_FROM = '2024-07-24';     // the archive's ICON-EU hours have visibility from 23 Jul 2024 17:00
    const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700];
    const VARS = ['cloud_cover_low', 'visibility', 'weather_code', 'surface_pressure', 'temperature_2m', ...LEVELS.map((p) => `cloud_cover_${p}hPa`)];
    const CEILING_PCT = 60;
    const MAX_POINTS = 400;          // one POST; Open-Meteo counts each point as a call
    const RATE_BUDGET = 550;         // of the free tier's 600 call units a minute
    const MIN_STEP = 0.07;           // ≈ an ICON-EU cell
    const UPSCALE = 12;              // canvas px per grid cell before Leaflet stretches it (smooths the cells)
    const FOG_VIS_M = 1000;

    const isFog = (vis, code) => code === 45 || code === 48 || (vis != null && vis < FOG_VIS_M && (code == null || code < 50));
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

    /** The sample grid over [[s, w], [n, e]]: cols × rows ≤ maxPoints, square cells on the Mercator map, north first. */
    function grid([[s, w], [n, e]], maxPoints = MAX_POINTS) {
        const kx = Math.cos((((s + n) / 2) * Math.PI) / 180);
        const snap = (v, k) => Math.round(v / k) * k;
        let step = Math.max(MIN_STEP, Math.sqrt(((e - w) * (n - s)) / kx / maxPoints));
        for (;;) {
            step = +(Math.ceil(step / 0.01) * 0.01).toFixed(2);      // whole hundredths: nearby views share a grid
            const w0 = snap(w - step, step), e0 = snap(e + step, step);
            const cols = Math.max(2, Math.round((e0 - w0) / step) + 1);
            const ys = mercY(snap(s - step, step)), yn = mercY(snap(n + step, step));
            const rows = Math.max(2, Math.round((yn - ys) / (step * (Math.PI / 180))) + 1);
            if (cols * rows > maxPoints) { step *= 1.08; continue; }
            const lats = Array.from({ length: rows }, (_, r) => +latOf(yn - ((yn - ys) * r) / (rows - 1)).toFixed(4));
            const lngs = Array.from({ length: cols }, (_, c) => +(w0 + step * c).toFixed(4));
            return { lats, lngs, step };
        }
    }

    /**
     * Cloud base above ground (m) from one hour's values: { ps (hPa), t (°C), cc: { [hPa]: % }, fog }. Level heights by the
     * hypsometric equation with a standard lapse rate; between the last level under 60 % and the first at or over it, the
     * height where the cover crosses 60 %. 0 in fog, null with no such level up to 700 hPa.
     */
    function cloudBase({ ps, t, cc, fog }) {
        if (fog) return 0;
        if (ps == null || t == null) return null;
        let prevH = 0, prevC = 0;
        for (const p of LEVELS) {
            if (p >= ps) continue;                           // below ground
            const c = cc[p];
            if (c == null) continue;
            let h = 29.27 * (t + 273.15) * Math.log(ps / p);
            h = 29.27 * (t + 273.15 - 0.0065 * h / 2) * Math.log(ps / p);
            if (c >= CEILING_PCT) return Math.round((prevH + (h - prevH) * (CEILING_PCT - prevC) / Math.max(1, c - prevC)) / 10) * 10;
            prevH = h; prevC = c;
        }
        return null;
    }

    // drone limits as colour: purple (worst) → red → orange → yellow → pale green → clear. Stops in metres.
    const RAMP = [[130, 40, 170, 0.78], [220, 40, 40, 0.72], [245, 135, 30, 0.62], [250, 215, 60, 0.5], [170, 225, 120, 0.28], [170, 225, 120, 0]];
    const SCALES = {
        visibility: { stops: [200, 500, 1000, 2000, 5000, 10000], label: (m) => (m < 1000 ? `${m} m` : `${m / 1000} km`) },
        ceiling: { stops: [100, 200, 400, 700, 1200, 2000], label: (m) => `${m} m` },
    };
    /** RGBA for a value on a scale (log-interpolated between stops); past the last stop, clear. */
    function rampColor(v, stops) {
        if (v == null || v >= stops.at(-1)) return [0, 0, 0, 0];
        if (v <= stops[0]) return RAMP[0];
        let i = 0;
        while (v > stops[i + 1]) i++;
        const u = Math.log(v / stops[i]) / Math.log(stops[i + 1] / stops[i]);
        return RAMP[i].map((c, k) => c + (RAMP[i + 1][k] - c) * u);
    }

    /** Open-Meteo's weighting: variables over 10 and days over 14 multiply a point's cost. */
    const callCost = (nVars, nDays) => Math.max(1, nVars / 10) * Math.max(1, nDays / 14);

    /**
     * Fetch a snapshot: { source, model, model_run, fetched, lats, lngs, times, low, vis, code } (per hour, row-major cells).
     * With `from` (and `to`, 'YYYY-MM-DD', Kyiv days) it reads the history archive; without, the ICON-EU forecast.
     */
    async function fetchSnapshot(bounds, { fetchFn = fetch, days = 6, from = null, to = null, maxPoints = MAX_POINTS } = {}) {
        const history = from != null;
        let nDays = days;
        if (history) {
            to = to || from;
            if (from < HISTORY_FROM) throw new Error(`the weather archive starts ${HISTORY_FROM}`);
            if (to < from) throw new Error('`to` is before `from`');
            nDays = (Date.parse(to) - Date.parse(from)) / 864e5 + 1;
            if (nDays > HISTORY_MAX_DAYS) throw new Error(`at most ${HISTORY_MAX_DAYS} days of past weather in one fetch`);
        }
        // one model per request (two would double the cost): ICON-EU, or before its archive the best_match blend
        const model = history && from < ICON_EU_HISTORY_FROM ? 'best_match' : 'icon_eu';
        const { lats, lngs } = grid(bounds, Math.min(maxPoints, Math.floor(RATE_BUDGET / callCost(VARS.length, nDays))));
        const la = [], lo = [];
        for (const a of lats) for (const b of lngs) { la.push(a); lo.push(b); }
        const body = new URLSearchParams({ latitude: la.join(','), longitude: lo.join(','), hourly: VARS.join(','), timezone: 'Europe/Kyiv', models: model,
            ...(history ? { start_date: from, end_date: to } : { forecast_days: String(days) }) });
        const r = await fetchFn(history ? HISTORY_API : API, { method: 'POST', body });
        const json = await r.json().catch(() => ({}));
        if (!r.ok || json.error) throw new Error(`Open-Meteo: ${json.reason || r.status}`);
        const answers = Array.isArray(json) ? json : [json];
        const times0 = answers[0].hourly.time;
        const val = (p, k, h) => p.hourly[k]?.[h] ?? null;
        // the forecast's ICON-EU ends ~5.5 days out: keep the hours every point has
        let last = times0.length - 1;
        if (!history) while (last > 0 && answers.some((p) => val(p, 'visibility', last) == null)) last--;
        const times = times0.slice(0, last + 1);
        const take = (k) => times.map((_, h) => answers.map((p) => val(p, k, h)));
        const vis = take('visibility'), code = take('weather_code');
        const base = times.map((_, h) => answers.map((p, i) => cloudBase({
            ps: val(p, 'surface_pressure', h), t: val(p, 'temperature_2m', h),
            cc: Object.fromEntries(LEVELS.map((lv) => [lv, val(p, `cloud_cover_${lv}hPa`, h)])), fog: isFog(vis[h][i], code[h][i]) })));
        let model_run = null;
        if (!history) try {
            const m = await (await fetchFn('https://api.open-meteo.com/data/dwd_icon_eu/static/meta.json')).json();
            if (m.last_run_initialisation_time) model_run = new Date(m.last_run_initialisation_time * 1000).toISOString().slice(0, 16) + 'Z';
        } catch { /* optional */ }
        return { source: history ? 'history' : 'forecast', model, model_run, fetched: new Date().toISOString(), lats, lngs, times,
            low: take('cloud_cover_low'), vis, code, base };
    }

    /** The snapshot's hour index (fractional) for a Kyiv local 'YYYY-MM-DDTHH[:MM]'; null outside it. */
    function hourIndex(snap, iso) {
        const ms = (s) => Date.parse(`${s.slice(0, 13)}:00Z`) + (s.length > 14 ? +s.slice(14, 16) * 60000 : 0);
        const i = (ms(iso) - ms(snap.times[0])) / 3600e3;
        return i >= 0 && i <= snap.times.length - 1 ? i : null;
    }

    /** Kyiv's current hour as 'YYYY-MM-DDTHH:00'. */
    const nowKyiv = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 13).replace(' ', 'T') + ':00';

    /** 'Fri 14 Nov, 06:00' for a 'YYYY-MM-DDTHH:MM' Kyiv hour ('Fri 28 Nov 2025, 06:00' with year). */
    function hourLabel(iso, { year = false } = {}) {
        const d = new Date(`${iso.slice(0, 10)}T12:00Z`);
        const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
        return `${day}${year ? ` ${iso.slice(0, 4)}` : ''}, ${iso.slice(11, 16)}`;
    }

    /** The key for a view: colour swatches with their limits (the sidebar and the map card). */
    function legendHtml(show) {
        const scale = SCALES[show];
        if (!scale) {
            return `${show !== 'fog' ? '<span class="weather-key weather-key-cloud"></span>low cloud ' : ''}`
                + `${show !== 'low_cloud' ? '<span class="weather-key weather-key-fog"></span>fog (visibility &lt; 1 km)' : ''}`;
        }
        const sw = (c) => `<span class="weather-key" style="background:rgba(${c.slice(0, 3).map(Math.round).join(',')},${Math.max(c[3], 0.15)})"></span>`;
        const what = show === 'visibility' ? 'Visibility (how far a drone sees)' : 'Cloud base above ground (how high it can fly under cloud; 0 in fog)';
        // each colour sits at its stop and blends to the next; the last stop is clear
        return `${what}<br>` + scale.stops.slice(0, -1).map((v, i) => `${sw(RAMP[i])}${i ? '' : '≤'}${scale.label(v)}`).join(' ')
            + ` · clear: ${show === 'visibility' ? '10 km+' : '2 km+ or none'}`;
    }

    /** The card's lines for a snapshot hour: what is shown (forecast or past model hours) and when. */
    function cardText(snap, iso, show = 'both') {
        const history = snap.source === 'history';
        const model = { icon_eu: 'ICON-EU', best_match: 'model blend', 'icon_eu+best_match': 'ICON-EU + blend' }[snap.model] || snap.model;
        return {
            head: history ? `Past weather · ${model} · Kyiv time` : `Forecast · ICON-EU${snap.model_run ? ` run ${snap.model_run.slice(5, 10).replace('-', '/')} ${snap.model_run.slice(11, 13)}Z` : ''} · Kyiv time`,
            time: hourLabel(iso, { year: history }) + ({ visibility: ' · visibility', ceiling: ' · cloud base' }[show] || ''),
        };
    }

    class WeatherForecast {
        constructor(dashboard) {
            this.dashboard = dashboard;
            this.snap = null;            // the current snapshot
            this.hour = 0;               // fractional index into snap.times
            this.show = 'both';          // 'low_cloud' | 'fog' | 'both'
            this.mode = 'forecast';      // 'forecast' | 'history' (the day follows the date slider)
            this.card = false;           // the time card on the map
            this.cardLegend = false;     // the legend under the card's time
            this.on = false;
            this._images = new Map();    // `${h}|${show}` → data URL
            this._overlays = [];         // two image overlays: hour floor and ceil, blended
            this._moveTimer = null;
            this._onMove = () => { clearTimeout(this._moveTimer); this._moveTimer = setTimeout(() => this.refresh(), 600); };
            this.frozen = false;         // a video's snapshot: no refetch on pan
        }

        _status(msg) {
            const el = this.dashboard.getEl('weather-status');
            if (el) { el.style.display = msg ? 'block' : 'none'; el.textContent = msg || ''; }
        }

        _pane() {
            const map = this.dashboard.map;
            if (!map.getPane('weatherPane')) {
                const p = map.createPane('weatherPane', map.getPane('overlayPane').parentNode);   // beside the overlays (leaflet-rotate keeps them in its rotate pane)
                p.style.zIndex = 390;             // over territory fills' tile pane, under the overlay pane (400)
                p.style.pointerEvents = 'none';
            }
            return 'weatherPane';
        }

        async toggle(enabled) {
            this.on = enabled;
            const map = this.dashboard.map;
            if (!enabled) {
                map.off('moveend', this._onMove);
                if (this._cursor) map.off('mousemove', this._cursor);
                this.dashboard.setText('weather-cursor', '');
                this._overlays.forEach((o) => o.remove());
                this._overlays = [];
                this.frozen = false;
                this._status(null);
                this._syncCard();
                return;
            }
            map.on('moveend', this._onMove);
            this._cursor ||= (e) => this._onCursor(e);
            map.on('mousemove', this._cursor);
            this._legend();
            await this.refresh();
        }

        /** The snapshot covers the view, is under an hour old and no coarser than the view's own grid would be (zooming in refetches). */
        _covers(snap) {
            const b = this.dashboard.map.getBounds();
            if (!snap || snap.source !== this.mode) return false;
            if (this.mode === 'history' ? snap.times[0].slice(0, 10) !== this._day() : Date.now() - Date.parse(snap.fetched) >= 3600e3) return false;
            const own = grid([[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]).step;
            return b.getSouth() >= snap.lats.at(-1) && b.getNorth() <= snap.lats[0] && b.getWest() >= snap.lngs[0] && b.getEast() <= snap.lngs.at(-1)
                && snap.lngs[1] - snap.lngs[0] <= own * 1.5;
        }

        /** Fetch for the view when it isn't covered (or the snapshot is over an hour old), then draw. */
        async refresh() {
            if (!this.on) return;
            if (!this.frozen && !this._covers(this.snap)) {
                const b = this.dashboard.map.getBounds().pad(0.15);
                const history = this.mode === 'history', day = this._day();
                this._status(history ? `⏳ Loading the weather of ${day}…` : '⏳ Loading the ICON-EU forecast…');
                try {
                    const keep = this.snap?.times[Math.floor(this.hour)];
                    const keepHour = keep ? keep.slice(11) : null;      // history: the same hour on the new day
                    const snap = await WeatherForecast.fetchSnapshot([[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], history ? { from: day } : {});
                    if (this.mode !== (history ? 'history' : 'forecast') || (history && this._day() !== day)) return;   // changed while loading
                    this.load(snap);
                    this.setHour(history ? (keepHour ? hourIndex(snap, `${day}T${keepHour}`) ?? 12 : 12)
                        : (keep ? hourIndex(snap, keep) ?? hourIndex(snap, nowKyiv()) ?? 0 : hourIndex(snap, nowKyiv()) ?? 0));
                } catch (e) {
                    this._status(`Weather failed: ${e.message}`);
                    return;
                }
            }
            this.draw();
            this._syncUi();
        }

        /** Take a snapshot (fetched here or handed in by a video) and drop the old images. */
        load(snap, { frozen = false } = {}) {
            this.snap = snap;
            this.frozen = frozen;
            this._images.clear();
            const map = this.dashboard.map;
            this._overlays.forEach((o) => o.remove());
            const bounds = [[snap.lats.at(-1), snap.lngs[0]], [snap.lats[0], snap.lngs.at(-1)]];
            const pane = this._pane();
            this._overlays = [0, 1].map(() => L.imageOverlay('data:,', bounds, { pane, interactive: false, opacity: 0 }).addTo(map));
            this._overlays.forEach((o) => { o.getElement().style.imageRendering = 'auto'; });
            this.hour = Math.min(this.hour, snap.times.length - 1);
        }

        setHour(h) { this.hour = Math.max(0, Math.min(h, (this.snap?.times.length || 1) - 1)); }
        setShow(show) {
            this.show = show;
            this._legend();
            this._syncCard();
        }

        /** The sidebar key for the current view: colour swatches with their limits. */
        _legend() {
            const el = this.dashboard.getEl('weather-legend');
            if (el) el.innerHTML = legendHtml(this.show);
        }

        /** The values at a point (nearest grid cell, the hour on screen), for the cursor readout. */
        valuesAt(latlng) {
            const s = this.snap;
            if (!s) return null;
            const near = (arr, v) => arr.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(arr[best] - v) ? i : best), 0);
            if (latlng.lat < s.lats.at(-1) || latlng.lat > s.lats[0] || latlng.lng < s.lngs[0] || latlng.lng > s.lngs.at(-1)) return null;
            const i = near(s.lats, latlng.lat) * s.lngs.length + near(s.lngs, latlng.lng), h = Math.round(this.hour);
            return { vis: s.vis[h][i], base: s.base ? s.base[h][i] : undefined, low: s.low[h][i], fog: isFog(s.vis[h][i], s.code[h][i]) };
        }

        _onCursor(e) {
            const el = this.dashboard.getEl('weather-cursor');
            if (!el) return;
            const v = this.valuesAt(e.latlng);
            if (!v) { el.textContent = ''; return; }
            const km = (m) => (m == null ? '?' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
            const base = v.base === undefined ? '' : ` · cloud base ${v.base == null ? 'none under 3 km' : `${v.base} m`}`;
            el.textContent = `At cursor: visibility ${km(v.vis)}${base} · low cloud ${v.low ?? '?'} %${v.fog ? ' · fog' : ''}`;
        }

        /** The history day: the date slider's end date. */
        _day() {
            const d = this.dashboard.endDate || new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        async setMode(mode) {
            this.mode = mode;
            await this.refresh();
        }

        /** The date slider moved: in history mode, load that day (debounced, as the slider fires while dragging). */
        onDateChange() {
            if (!this.on || this.mode !== 'history' || this.frozen) return;
            clearTimeout(this._dateTimer);
            this._dateTimer = setTimeout(() => this.refresh(), 400);
        }

        async setCard(on) {
            this.card = on;
            this._syncCard();
        }

        setCardLegend(on) {
            this.cardLegend = on;
            this._syncCard();
        }

        /** The time card on the map: what is shown (forecast or past) and the hour, so a screenshot says it. */
        _syncCard() {
            const container = this.dashboard.map.getContainer();
            let el = container.querySelector('.weather-time-card');
            if (!(this.card || this.cardLegend) || !this.on || !this.snap || this.frozen) { el?.remove(); return; }
            if (!el) {
                el = document.createElement('div');
                el.className = 'weather-time-card';
                container.appendChild(el);
            }
            const { head, time } = cardText(this.snap, this.hourIso(), this.show);
            el.innerHTML = (this.card ? `<small>${head}</small>${time}` : '')
                + (this.cardLegend ? `<div class="weather-card-legend">${legendHtml(this.show)}</div>` : '');
        }

        /** One hour as a data URL: low cloud white, fog pale yellow (stronger as visibility drops). */
        /** Hour h as one RGBA per grid cell, in the current show. */
        _cells(h) {
            const s = this.snap, cols = s.lngs.length, rows = s.lats.length;
            const data = new Uint8ClampedArray(cols * rows * 4);
            const scale = SCALES[this.show];
            for (let i = 0; i < cols * rows; i++) {
                const low = s.low[h][i] ?? 0, vis = s.vis[h][i], code = s.code[h][i];
                let r = 255, g = 255, b = 255, a = 0;
                if (scale) {
                    // a snapshot from before cloud base was kept (an older film's weather.json) has no base: nothing to paint
                    [r, g, b, a] = rampColor(this.show === 'visibility' ? vis : s.base?.[h][i] ?? null, scale.stops);
                } else {
                    if (this.show !== 'fog') a = Math.max(0, (low - 15) / 85) * 0.8;
                    if (this.show !== 'low_cloud' && isFog(vis, code)) {
                        const f = WeatherForecast.fogLevel(vis ?? 500) / 2;     // 0..1
                        r = 255; g = 226; b = 120; a = Math.max(a, 0.45 + 0.45 * f);
                    }
                }
                data.set([r, g, b, Math.round(a * 255)], i * 4);
            }
            return data;
        }

        /** Grid cells (RGBA) smoothed up to the overlay's image, as a PNG data URL. */
        _png(data) {
            const cols = this.snap.lngs.length, rows = this.snap.lats.length;
            const small = document.createElement('canvas');
            small.width = cols; small.height = rows;
            const ctx = small.getContext('2d'), img = ctx.createImageData(cols, rows);
            img.data.set(data);
            ctx.putImageData(img, 0, 0);
            const big = document.createElement('canvas');
            big.width = cols * UPSCALE; big.height = rows * UPSCALE;
            const bctx = big.getContext('2d');
            bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
            bctx.drawImage(small, 0, 0, big.width, big.height);
            return big.toDataURL('image/png');
        }

        _image(h) {
            const key = `${h}|${this.show}`;
            if (!this._images.has(key)) this._images.set(key, this._png(this._cells(h)));
            return this._images.get(key);
        }

        /** Hours h0 and h1 mixed u of the way, cell by cell on premultiplied colour, so the tint changes evenly. */
        _imageBetween(h0, h1, u) {
            const A = this._cells(h0), B = this._cells(h1), out = new Uint8ClampedArray(A.length);
            for (let i = 0; i < A.length; i += 4) {
                const pa = A[i + 3] / 255 * (1 - u), pb = B[i + 3] / 255 * u, alpha = pa + pb;
                for (let c = 0; c < 3; c++) out[i + c] = alpha > 0 ? (A[i + c] * pa + B[i + c] * pb) / alpha : 255;
                out[i + 3] = Math.round(alpha * 255);
            }
            return this._png(out);
        }

        /** Draw the current (fractional) hour: its two neighbours mixed into one image. Resolves once it is decoded. */
        async draw() {
            if (!this.snap || !this._overlays.length) return;
            const h0 = Math.floor(this.hour), h1 = Math.min(h0 + 1, this.snap.times.length - 1), u = this.hour - h0;
            const [a, b] = this._overlays;
            // one image, not two stacked half-transparent ones: stacked, the tint grew to nearly double through each
            // hour and dropped back as it turned, so the layer seemed to reset every hour in videos
            const url = h1 === h0 || u < 1e-3 ? this._image(h0) : this._imageBetween(h0, h1, u);
            const el = a.getElement();
            if (el.getAttribute('src') !== url) { a.setUrl(url); await el.decode().catch(() => {}); }
            a.setOpacity(1);
            b.setOpacity(0);
        }

        /** The hour on screen as 'YYYY-MM-DDTHH:MM' (Kyiv). */
        hourIso() {
            const s = this.snap, h0 = Math.floor(this.hour);
            const ms = Date.parse(`${s.times[h0]}:00Z`) + (this.hour - h0) * 3600e3;
            return new Date(Math.round(ms / 60000) * 60000).toISOString().slice(0, 16);
        }

        _syncUi() {
            const slider = this.dashboard.getEl('weather-hour');
            if (!slider || !this.snap) return;
            slider.max = String(this.snap.times.length - 1);
            slider.value = String(Math.round(this.hour));
            this.dashboard.setText('weather-hour-value', hourLabel(this.hourIso(), { year: this.snap.source === 'history' }));
            this._status(this.snap.source === 'history'
                ? `Past model hours (${this.snap.model}) · Kyiv time · the day follows the date slider's end`
                : `ICON-EU run ${this.snap.model_run ? this.snap.model_run.replace('T', ' ') : '?'} · Kyiv time · not tied to the date slider`);
            this._syncCard();
        }

        /** Slider input: whole hours. */
        async onSlider(v) {
            this.setHour(+v);
            await this.draw();
            this._syncUi();
        }
    }

    WeatherForecast.grid = grid;
    WeatherForecast.fetchSnapshot = fetchSnapshot;
    WeatherForecast.hourIndex = hourIndex;
    WeatherForecast.hourLabel = hourLabel;
    WeatherForecast.cardText = cardText;
    WeatherForecast.legendHtml = legendHtml;
    WeatherForecast.cloudBase = cloudBase;
    WeatherForecast.rampColor = rampColor;
    WeatherForecast.SCALES = SCALES;
    WeatherForecast.nowKyiv = nowKyiv;
    // visibility (m) → 0..2, as mcp/tools/weather.js fogLevel (anim_set_conditions' fog scale)
    WeatherForecast.fogLevel = (vis) => Math.min(2, Math.max(0, (2 * Math.log10(5000 / Math.max(vis, 1))) / Math.log10(50)));

    if (typeof window !== 'undefined') window.WeatherForecast = WeatherForecast;
    if (typeof module !== 'undefined' && module.exports) module.exports = WeatherForecast;
})();

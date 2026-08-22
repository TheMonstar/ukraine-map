/**
 * Infiltration routes — least-cost paths through concealment.
 *
 * Small groups cannot cross open steppe: drones and thermals make bare fields
 * lethal. Real infiltration follows лісосмуги (field windbreaks), forest
 * blocks, built-up areas and the brushy low ground along streams and ditches.
 * This solves for that path: click a start and an end (each with a radius, so
 * it is really area-to-area) and get the most concealed way between them.
 *
 * The terrain comes from one Overpass query over the route corridor, is
 * rasterised onto a metric grid with the 2D canvas — orders of magnitude faster
 * than a turf point-in-polygon per cell — and searched with A* over an
 * 8-connected grid, reusing the MinHeap from line-features.js.
 */
class Infiltration {

    static CELL_M = 40;
    static MAX_CELLS = 500000;
    static MAX_CELL_M = 120;      // coarser than this cannot resolve a treeline
    static PAD_FRACTION = 0.3;    // how far off the direct line the route may wander
    static PAD_MIN_M = 1500;
    static PAD_MAX_M = 6000;      // capped, or the Overpass corridor grows quadratically

    // Cost multipliers per metre travelled. Open ground is the 1.0 baseline;
    // everything that hides a dismounted group is cheaper than it.
    static COST_COVER    = 0.20;   // wood, scrub, orchard, vineyard
    static COST_TREELINE = 0.30;   // natural=tree_row, hedges — the лісосмуги
    // A village is worth more than the cover it provides: it is where a group
    // can halt, rest and accumulate before the next bound, so a route that
    // strings settlements together is buying staging potential, not just
    // concealment. Priced below a treeline to reflect that — flip the
    // "avoid built-up" toggle when the settlements are the ones held.
    static COST_BUILTUP  = 0.25;
    static COST_RIPARIAN = 0.45;   // brush and dead ground along streams/ditches
    static COST_WETLAND  = 0.75;   // concealed but slow going
    static COST_BUILTUP_AVOID = 2.5;
    // Open water is priced, not forbidden: a group does cross a river, but only
    // where it is narrow. Making it impassable instead would cut the corridor in
    // two wherever a mapped river runs across it, and the search would fail.
    static COST_WATER = 25.0;

    // Open ground is not uniformly bad: hugging a treeline edge is survivable,
    // the middle of a 2 km field is not. Without this ramp every open cell costs
    // the same and the search cuts straight across fields instead of skirting them.
    static EXPOSURE_K = 3.0;
    static EXPOSURE_FULL_M = 400;

    static CROSSING_PENALTY_M = 400; // extra metre-equivalents to cross road/rail
    static PACE_KMH = 1.5;           // dismounted, at night, tactical movement

    // Dead ground. A balka with no waterway tag is invisible to OSM but is the
    // best concealment there is — you are simply below everyone's line of sight.
    // Topographic position (this cell against the mean around it) is what finds
    // one: negative means the ground sits below its surroundings.
    static DEM_ZOOM = 12;          // ~25 m/px here, SRTM's native limit
    static TPI_RADIUS_M = 700;     // wide enough to see a balka floor as sunk,
                                   // narrow enough not to flatten a whole valley
    static TPI_SCALE_M = 20;
    static DEFILADE_MIN = 0.45;    // ~20 m below the surroundings
    static DEFILADE_MAX = 1.5;     // skylined on a crest
    // Climbing out costs more than following the floor. Without this the route
    // hops in and out of a gully instead of staying in it.
    static SLOPE_FULL = 0.35;
    static SLOPE_MAX = 4.0;
    // A fall of more than one cell-width between neighbours is a DEM void, not
    // ground. See despike() — these matter far more than they look.
    static DESPIKE_GRADE = 1.2;

    // Mask bits, in precedence order (see _cellClass).
    static M_COVER = 1;
    static M_TREELINE = 2;
    static M_BUILTUP = 4;
    static M_RIPARIAN = 8;
    static M_WETLAND = 16;
    static M_WATER = 32;
    static M_CROSS = 64;

    static TREELINE_W_M = 20;   // painted width of a tree_row centreline
    static RIPARIAN_W_M = 120;  // painted width of the corridor along a watercourse

    static COLOR_CONCEALED = '#2e7d32';
    static COLOR_SETTLEMENT = '#f5c518';
    static COLOR_EXPOSED = '#e53935';

    // Alternates are found by re-running the search with the previous route's
    // ground made expensive, tapering to nothing at ALT_SEPARATION_M — a hard
    // wall instead would just produce a path pressed up against the first one.
    static MAX_ROUTES = 3;
    static ALT_SEPARATION_M = 700;
    static ALT_PENALTY = 5.0;

    static MODE_SOLVE = 'solve';
    static MODE_DRAW = 'draw';
    static COLOR_DRAWN = '#94a3b8';   // the hand-drawn line, kept as a reference
    // Outside the corridor the snap is not merely discouraged, it is forbidden —
    // the point of drawing a line is that the result stays near it.
    static OUT_OF_CORRIDOR_COST = 1e6;

    // Overpass allows two slots per IP, so a fast finger has to be absorbed here
    // rather than by the API. See _fetchOsm.
    static RETRY_DELAYS_MS = [3000, 8000];

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.active = false;
        this.points = [];
        this._clickHandler = null;
        this._dblClickHandler = null;
        this._moveHandler = null;
        this._keyHandler = null;
        this._draftLine = null;
        this._lastPreviewAt = 0;
        this._osmCache = new Map();     // bbox key -> FeatureCollection
        this._osmPending = new Map();   // bbox key -> in-flight Promise
        this.controller = null;
        this.routes = [];               // last result, best first
        this.drawn = null;              // the hand-drawn route, when there is one
        this._busy = false;
        this._finished = false;
    }

    mode() {
        return this.dashboard.getEl('infil-route-mode')?.value === Infiltration.MODE_DRAW
            ? Infiltration.MODE_DRAW : Infiltration.MODE_SOLVE;
    }

    // ── UI plumbing ──────────────────────────────────────────────────────────

    _layer() {
        if (!this.dashboard.infiltrationLayer) {
            this.dashboard.infiltrationLayer = L.layerGroup().addTo(this.dashboard.map);
        }
        return this.dashboard.infiltrationLayer;
    }

    setStatus(message, isError = false) {
        const el = this.dashboard.getEl('infil-status');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? '#ff6b6b' : '';
    }

    setHint(message) {
        const el = this.dashboard.getEl('infil-hint');
        if (!el) return;
        el.style.display = message ? 'block' : 'none';
        el.textContent = message || '';
    }

    static BUSY_IDS = ['infil-radius', 'infil-cell', 'infil-routes', 'infil-route-mode',
                       'infil-corridor', 'infil-snap', 'infil-terrain',
                       'infil-avoid-settlements', 'infil-to-drawing', 'infil-clear'];

    /** A cold run spends seconds inside Overpass. Without a visible busy state
     *  the panel looks broken, and every extra click starts another request. */
    _setBusy(busy) {
        this._busy = busy;
        for (const id of Infiltration.BUSY_IDS) {
            const el = this.dashboard.getEl(id);
            if (el) el.disabled = busy;
        }
        const spinner = this.dashboard.getEl('infil-spinner');
        if (spinner) spinner.style.display = busy ? 'inline-block' : 'none';
        if (this.active) {
            this.dashboard.map.getContainer().style.cursor = busy ? 'progress' : 'crosshair';
        }
    }

    static HINT_START = 'Click to add points · double-click or Enter to finish · Esc cancels · Backspace removes last';

    enableMode() {
        this.disableMode();
        const map = this.dashboard.map;
        this.active = true;
        this.points = [];
        this._finished = false;
        this._clickHandler = (e) => this._onClick(e);
        this._dblClickHandler = (e) => this._onDblClick(e);
        this._moveHandler = (e) => this._onMove(e);
        this._keyHandler = (e) => this._onKeyDown(e);
        map.on('click', this._clickHandler);
        map.on('dblclick', this._dblClickHandler);
        map.on('mousemove', this._moveHandler);
        document.addEventListener('keydown', this._keyHandler);
        // Finishing a route is a double-click, which would otherwise zoom.
        map.doubleClickZoom.disable();
        map.getContainer().style.cursor = 'crosshair';
        this.setHint(Infiltration.HINT_START);
    }

    disableMode() {
        const map = this.dashboard.map;
        if (this._clickHandler) {
            map.off('click', this._clickHandler);
            this._clickHandler = null;
        }
        if (this._dblClickHandler) {
            map.off('dblclick', this._dblClickHandler);
            this._dblClickHandler = null;
            map.doubleClickZoom.enable();
        }
        if (this._moveHandler) {
            map.off('mousemove', this._moveHandler);
            this._moveHandler = null;
        }
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        this._clearDraft();
        this._abort();
        map.getContainer().style.cursor = '';
        this.active = false;
        this.points = [];
        this.setHint('');
    }

    // ── Draft: the rubber band between the last point and the cursor ─────────

    /** One reusable polyline, moved with setLatLngs — rebuilding the layer on
     *  every mousemove is what makes a drawing tool feel heavy. */
    _onMove(e) {
        if (!this.active || this._busy || this._finished || !this.points.length) return;
        const now = performance.now();
        if (now - this._lastPreviewAt < 33) return;   // ~30 Hz, as the 3D sandbox does
        this._lastPreviewAt = now;
        this._drawDraft(e.latlng);
    }

    _drawDraft(hover = null) {
        const pts = hover ? [...this.points, hover] : [...this.points];
        if (pts.length < 2) { this._clearDraft(); return; }
        if (!this._draftLine) {
            this._draftLine = L.polyline(pts, {
                color: Infiltration.COLOR_DRAWN, weight: 2, opacity: 0.9,
                dashArray: '5,6', interactive: false,
            }).addTo(this._layer());
        } else {
            this._draftLine.setLatLngs(pts);
        }
    }

    _clearDraft() {
        if (this._draftLine) {
            this._layer().removeLayer(this._draftLine);
            this._draftLine = null;
        }
    }

    /** Enter commits, Escape drops the draft, Backspace removes the last point. */
    _onKeyDown(e) {
        if (!this.active || this._busy) return;
        // Backspace edits a number field just as it edits a text one, so the
        // panel's own inputs must keep their keystrokes — only the controls that
        // ignore typing entirely (checkbox, radio, slider, buttons) fall through.
        const el = document.activeElement;
        const PASSTHROUGH = ['checkbox', 'radio', 'range', 'button', 'submit', 'reset'];
        const typing = el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
                              el.tagName === 'SELECT' ||
                              (el.tagName === 'INPUT' && !PASSTHROUGH.includes(el.type)));
        if (typing) return;

        if (e.key === 'Enter' && this.points.length >= 2) {
            e.preventDefault();
            this._commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.clear();
        } else if (e.key === 'Backspace' && this.points.length) {
            e.preventDefault();
            this.points.pop();
            this._redrawPoints();
        }
    }

    /** Markers are plain layers with no identity, so stepping back a point means
     *  redrawing the lot — cheap at the handful of points a route ever has. */
    _redrawPoints() {
        this._layer().clearLayers();
        this._draftLine = null;
        this.points.forEach((ll, i) => this._markPoint(ll, i === 0));
        this._drawDraft();
        this.setHint(this.points.length
            ? `${this.points.length} point(s) — ${Infiltration.HINT_START}`
            : Infiltration.HINT_START);
    }

    _abort() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
    }

    clear() {
        this._abort();
        this._layer().clearLayers();
        this._draftLine = null;
        this.points = [];
        this.routes = [];
        this.drawn = null;
        this._finished = false;
        this.setStatus('');
        if (this.active) this.setHint(Infiltration.HINT_START);
    }

    _onClick(e) {
        if (!this.active || this._busy) return;
        if (this._finished) {   // a finished route — the next click starts over
            this._layer().clearLayers();
            this._draftLine = null;
            this.points = [];
            this._finished = false;
        }
        this.points.push(e.latlng);
        this._markPoint(e.latlng, this.points.length === 1);
        this._drawDraft();
        this.setHint(`${this.points.length} point(s) — ${Infiltration.HINT_START}`);
    }

    _markPoint(latlng, isStart) {
        L.circleMarker(latlng, {
            radius: 5, color: '#fff', weight: 2,
            fillColor: isStart ? '#2e7d32' : '#f59e0b', fillOpacity: 1,
        }).addTo(this._layer());
    }

    /**
     * Double-click finishes the route. Leaflet fires two `click` events before
     * `dblclick`, so the last one or two points are duplicates of the
     * destination and have to go — the same trim DrawingTool._closePolygon does.
     */
    async _onDblClick(e) {
        if (!this.active || this._busy) return;
        const map = this.dashboard.map;
        const px = (ll) => map.latLngToContainerPoint(ll);
        while (this.points.length > 1) {
            const a = px(this.points[this.points.length - 1]);
            const b = px(this.points[this.points.length - 2]);
            if (Math.hypot(a.x - b.x, a.y - b.y) >= 4) break;
            this.points.pop();
        }
        await this._commit();
    }

    async _commit() {
        if (this.points.length < 2) {
            this.setHint('Need at least a start and a destination — keep clicking.');
            return;
        }
        this._clearDraft();
        this._finished = true;
        this.setHint('Route finished. Click again to start a new one.');
        await this._run(this.points);
    }

    _options() {
        const el = (id) => this.dashboard.getEl(id);
        return {
            radiusM: parseFloat(el('infil-radius')?.value) || 0,
            cellM: parseFloat(el('infil-cell')?.value) || Infiltration.CELL_M,
            corridorM: parseFloat(el('infil-corridor')?.value) || 300,
            asked: parseFloat(el('infil-routes')?.value) || 1,
            avoidBuiltUp: this.dashboard.isChecked('infil-avoid-settlements'),
            useTerrain: this.dashboard.isChecked('infil-terrain'),
            snap: this.dashboard.isChecked('infil-snap'),
        };
    }

    async _run(points) {
        const o = this._options();
        this._setBusy(true);
        try {
            if (this.mode() === Infiltration.MODE_DRAW) await this._runDrawn(points, o);
            else await this._runSolve(points, o);
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('Infiltration route failed:', error);
            this.setStatus(error.message, true);
        } finally {
            this._setBusy(false);
        }
    }

    async _runSolve(points, o) {
        // Alternatives to a route the user has already shaped with waypoints are
        // both less useful and N times the search, so a multi-leg route gets one.
        const multiLeg = points.length > 2;
        const routes = multiLeg ? 1 : o.asked;

        this.drawn = null;
        this.routes = await this.computeRoutes(points, {
            radiusM: o.radiusM, cellM: o.cellM, avoidBuiltUp: o.avoidBuiltUp,
            routes, useTerrain: o.useTerrain,
        });
        this.render(this.routes, { radiusM: o.radiusM });
        let status = Infiltration.describeRoutes(this.routes);
        if (multiLeg && o.asked > 1) {
            status += `\n(${points.length - 1} legs — alternatives skipped for multi-leg routes)`;
        }
        this.setStatus(status);
    }

    async _runDrawn(points, o) {
        const { drawn, snapped } = await this.analyzeDrawn(points, {
            cellM: o.cellM, avoidBuiltUp: o.avoidBuiltUp, useTerrain: o.useTerrain,
            snap: o.snap, corridorM: o.corridorM, radiusM: 0,
        });
        this.drawn = drawn;
        this.routes = snapped ? [snapped] : [drawn];
        this.render(this.routes, { radiusM: 0, drawn: snapped ? drawn : null });

        const rows = [`as drawn · ${Infiltration.describeStats(drawn.stats)}`];
        if (snapped) rows.push(`snapped · ${Infiltration.describeStats(snapped.stats)}`);
        this.setStatus(rows.join('\n'));
    }

    static describeStats(s) {
        const parts = [
            `${s.length_km.toFixed(1)} km`,
            `${s.covered_pct}% under cover (${s.settlement_pct}% through settlements)`,
            `longest open crossing ${Math.round(s.longest_open_m)} m`,
            `${s.crossings} road/rail/water crossings`,
            `~${Math.round(s.transit_min)} min at ${Infiltration.PACE_KMH} km/h`,
        ];
        if (s.cell_m !== s.requested_cell_m) parts.push(`grid coarsened to ${s.cell_m} m`);
        return parts.join(' · ');
    }

    /** One row per route, numbered to match the badges on the map. */
    static describeRoutes(routes) {
        if (routes.length === 1) return Infiltration.describeStats(routes[0].stats);
        return routes.map(r => `${r.rank}. ${Infiltration.describeStats(r.stats)}`).join('\n');
    }

    // ── Grid ─────────────────────────────────────────────────────────────────

    /**
     * Metric grid over the corridor spanning every waypoint, in a local
     * equirectangular projection. One grid for the whole route rather than one
     * per leg, so a multi-leg route still costs a single Overpass call.
     * Coarsens itself rather than blowing up on a 60 km leg.
     */
    _makeGrid(points, cellM) {
        const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
        const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
        const mPerDegLat = 111320;
        const mPerDegLon = 111320 * Math.cos(latMid * Math.PI / 180);

        let pathM = 0;
        for (let i = 1; i < points.length; i++) {
            pathM += Math.hypot((points[i].lng - points[i - 1].lng) * mPerDegLon,
                                (points[i].lat - points[i - 1].lat) * mPerDegLat);
        }
        const padM = Math.min(Infiltration.PAD_MAX_M,
                              Math.max(Infiltration.PAD_MIN_M, pathM * Infiltration.PAD_FRACTION));

        const west = Math.min(...lngs) - padM / mPerDegLon;
        const east = Math.max(...lngs) + padM / mPerDegLon;
        const south = Math.min(...lats) - padM / mPerDegLat;
        const north = Math.max(...lats) + padM / mPerDegLat;

        const spanX = (east - west) * mPerDegLon;
        const spanY = (north - south) * mPerDegLat;

        // A long leg is coarsened rather than refused, but only so far: past
        // MAX_CELL_M the grid can no longer resolve a treeline, and a route it
        // produced would be confidently wrong rather than merely rough.
        let cell = cellM;
        let W = Math.ceil(spanX / cell), H = Math.ceil(spanY / cell);
        while (W * H > Infiltration.MAX_CELLS && cell < Infiltration.MAX_CELL_M) {
            cell = Math.min(Infiltration.MAX_CELL_M, Math.ceil(cell * 1.25));
            W = Math.ceil(spanX / cell);
            H = Math.ceil(spanY / cell);
        }
        if (W * H > Infiltration.MAX_CELLS) {
            const areaKm2 = Math.round(Infiltration.MAX_CELLS
                * (Infiltration.MAX_CELL_M / 1000) ** 2);
            throw new Error(
                `Corridor is ${Math.round(spanX / 1000)} x ${Math.round(spanY / 1000)} km — ` +
                `too large to resolve terrain (the limit is about ${areaKm2} km² at the coarsest ` +
                `usable grid). Trace this in shorter legs.`);
        }

        return {
            west, east, south, north, W, H, cell, mPerDegLat, mPerDegLon,
            xOf: (lng) => (lng - west) * mPerDegLon / cell,
            yOf: (lat) => (north - lat) * mPerDegLat / cell,
            lngOf: (x) => west + (x + 0.5) * cell / mPerDegLon,
            latOf: (y) => north - (y + 0.5) * cell / mPerDegLat,
        };
    }

    // ── Terrain data ─────────────────────────────────────────────────────────

    static query(south, west, north, east) {
        const bbox = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
        return `[out:json][timeout:60];
(
  way["natural"~"^(wood|scrub|wetland)$"](${bbox});
  relation["natural"~"^(wood|scrub|wetland)$"](${bbox});
  way["landuse"~"^(forest|orchard|vineyard)$"](${bbox});
  relation["landuse"~"^(forest|orchard|vineyard)$"](${bbox});
  way["natural"="tree_row"](${bbox});
  way["barrier"="hedge"](${bbox});
  way["landuse"~"^(residential|industrial|farmyard|allotments|cemetery)$"](${bbox});
  relation["landuse"~"^(residential|industrial|farmyard)$"](${bbox});
  way["waterway"~"^(stream|ditch|drain|river|canal)$"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["highway"~"^(motorway|trunk|primary|secondary)$"](${bbox});
  way["railway"="rail"](${bbox});
);
out body; >; out skel qt;`;
    }

    /**
     * One Overpass call per corridor. Two caches: resolved results forever, and
     * in-flight promises so concurrent callers for the same corridor share a
     * single request instead of racing — the same two-tier shape LineFeatures
     * uses. The in-flight entry is dropped on failure so the next attempt is a
     * fresh try rather than a cached error.
     */
    async _fetchOsm(grid) {
        const key = [grid.south, grid.west, grid.north, grid.east]
            .map(v => v.toFixed(3)).join(',');
        if (this._osmCache.has(key)) return this._osmCache.get(key);
        if (this._osmPending.has(key)) return this._osmPending.get(key);

        const promise = this._requestOsm(grid)
            .then((geojson) => {
                this._osmCache.set(key, geojson);
                return geojson;
            })
            .finally(() => this._osmPending.delete(key));

        this._osmPending.set(key, promise);
        return promise;
    }

    /** The request itself, retried through Overpass being busy rather than
     *  handing the user a 429 the first time two slots are already taken. */
    async _requestOsm(grid) {
        this.controller = new AbortController();
        const controller = this.controller;
        const attempts = Infiltration.RETRY_DELAYS_MS.length + 1;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            this.setStatus(attempt === 1
                ? 'Fetching terrain from Overpass…'
                : `Fetching terrain from Overpass… (attempt ${attempt} of ${attempts})`);

            const response = await fetch(Overpass.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: 'data=' + encodeURIComponent(
                    Infiltration.query(grid.south, grid.west, grid.north, grid.east)),
                signal: controller.signal,
            });

            if (response.ok) return osmtogeojson(await response.json());

            const busy = response.status === 429 || response.status === 504;
            if (!busy || attempt === attempts) {
                throw new Error(await Overpass.describeError(response));
            }

            const retryAfter = parseFloat(response.headers.get('Retry-After'));
            const waitMs = Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : Infiltration.RETRY_DELAYS_MS[attempt - 1];
            this.setStatus(`Overpass is busy — retrying in ${Math.round(waitMs / 1000)} s…`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        }
    }

    /** Which raster channel each feature paints into. A river is both: its
     *  valley is concealed ground, its channel is an obstacle to cross. */
    static channelsFor(p = {}) {
        const out = [];
        if (p.natural === 'wood' || p.natural === 'scrub' ||
            p.landuse === 'forest' || p.landuse === 'orchard' || p.landuse === 'vineyard') out.push('cover');
        if (p.natural === 'tree_row' || p.barrier === 'hedge') out.push('treeline');
        if (p.landuse === 'residential' || p.landuse === 'industrial' || p.landuse === 'farmyard' ||
            p.landuse === 'allotments' || p.landuse === 'cemetery') out.push('builtup');
        if (p.natural === 'wetland') out.push('wetland');
        if (p.natural === 'water') out.push('water');
        if (p.waterway) {
            out.push('riparian');
            if (p.waterway === 'river' || p.waterway === 'canal') out.push('crossing');
        }
        if (p.highway || p.railway) out.push('crossing');
        return out;
    }

    // ── Rasterisation ────────────────────────────────────────────────────────

    /**
     * Paint the OSM features onto the grid and read them back as one bitmask
     * per cell. Three passes, each carrying up to three classes in separate
     * colour channels under `lighter` compositing, so it costs three
     * getImageData calls instead of seven.
     */
    _rasterize(geojson, grid) {
        const { W, H } = grid;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const buckets = {
            cover: [], treeline: [], builtup: [],
            riparian: [], wetland: [], water: [], crossing: [],
        };
        for (const feature of (geojson.features || [])) {
            for (const channel of Infiltration.channelsFor(feature.properties)) {
                if (buckets[channel]) buckets[channel].push(feature);
            }
        }

        const mask = new Uint8Array(W * H);
        const PASSES = [
            [['cover', Infiltration.M_COVER], ['treeline', Infiltration.M_TREELINE], ['builtup', Infiltration.M_BUILTUP]],
            [['riparian', Infiltration.M_RIPARIAN], ['wetland', Infiltration.M_WETLAND], ['water', Infiltration.M_WATER]],
            [['crossing', Infiltration.M_CROSS]],
        ];
        const CHANNEL_COLORS = ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)'];

        for (const pass of PASSES) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, W, H);
            ctx.globalCompositeOperation = 'lighter';

            pass.forEach(([channel], slot) => {
                const color = CHANNEL_COLORS[slot];
                ctx.fillStyle = color;
                ctx.strokeStyle = color;
                for (const feature of buckets[channel]) {
                    this._paint(ctx, feature, grid, channel);
                }
            });

            const data = ctx.getImageData(0, 0, W, H).data;
            pass.forEach(([, bit], slot) => {
                for (let i = 0, p = slot; i < mask.length; i++, p += 4) {
                    if (data[p] > 0) mask[i] |= bit;
                }
            });
        }
        return mask;
    }

    _paint(ctx, feature, grid, channel) {
        const geom = feature.geometry;
        if (!geom) return;
        const cell = grid.cell;

        // Line widths are in metres so the painted corridor matches reality,
        // never thinner than a cell or the feature would fall between samples.
        const strokeCells = (metres) => Math.max(1.2, metres / cell);

        const trace = (ring) => {
            ctx.beginPath();
            ring.forEach(([lng, lat], i) => {
                const x = grid.xOf(lng), y = grid.yOf(lat);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
        };

        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
            const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
            for (const rings of polys) {
                ctx.beginPath();
                for (const ring of rings) {
                    ring.forEach(([lng, lat], i) => {
                        const x = grid.xOf(lng), y = grid.yOf(lat);
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    });
                    ctx.closePath();
                }
                ctx.fill('evenodd');   // inner rings are holes, not solid
            }
            return;
        }

        if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
            const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
            ctx.lineWidth = strokeCells(
                channel === 'treeline' ? Infiltration.TREELINE_W_M :
                channel === 'riparian' ? Infiltration.RIPARIAN_W_M : cell);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (const line of lines) {
                if (line.length < 2) continue;
                trace(line);
                ctx.stroke();
            }
        }
    }

    // ── Elevation ────────────────────────────────────────────────────────────

    /**
     * Elevation for every grid cell, from the Terrarium DEM tiles TerrainAnalysis
     * already fetches and caches. Each tile is read with ONE getImageData and
     * indexed into — TerrainAnalysis.sampleElevation does a 1x1 readback per
     * point, which is fine for a 72-ray viewshed and hopeless for 100k cells.
     */
    async _fetchElevation(grid) {
        const ta = this.dashboard.terrainAnalysis;
        if (!ta) throw new Error('TerrainAnalysis is not loaded — terrain costs need its tile math.');
        const z = Infiltration.DEM_ZOOM;
        const { W, H } = grid;

        const tl = ta._latlngToTile(grid.north, grid.west, z);
        const br = ta._latlngToTile(grid.south, grid.east, z);

        this.setStatus('Fetching elevation…');
        const tiles = new Map();
        const jobs = [];
        for (let tx = tl.x; tx <= br.x; tx++) {
            for (let ty = tl.y; ty <= br.y; ty++) {
                jobs.push(ta._getTileCanvas(z, tx, ty)
                    .then((canvas) => tiles.set(`${tx}/${ty}`,
                        canvas.getContext('2d').getImageData(0, 0, 256, 256).data))
                    .catch(() => { /* handled as missing coverage below */ }));
            }
        }
        await Promise.all(jobs);

        const n = Math.pow(2, z);
        const elev = new Float32Array(W * H);
        const missing = [];
        let sum = 0, got = 0;
        for (let y = 0; y < H; y++) {
            const lat = grid.latOf(y);
            const latR = lat * Math.PI / 180;
            const gy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
            const ty = Math.floor(gy);
            const py = Math.min(255, Math.max(0, Math.floor((gy - ty) * 256)));
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const gx = (grid.lngOf(x) + 180) / 360 * n;
                const data = tiles.get(`${Math.floor(gx)}/${ty}`);
                if (!data) { missing.push(i); continue; }
                const px = Math.min(255, Math.max(0, Math.floor((gx - Math.floor(gx)) * 256)));
                const p = (py * 256 + px) * 4;
                // Terrarium encoding, same as TerrainAnalysis.sampleElevation
                const v = (data[p] * 256 + data[p + 1] + data[p + 2] / 256) - 32768;
                elev[i] = v;
                sum += v;
                got++;
            }
        }
        if (!got) return null;
        // A hole left at 0 would read as a 170 m deep basin and the router would
        // dive straight into it. Fill with the mean instead, which is TPI-neutral.
        if (missing.length) {
            const mean = sum / got;
            for (const i of missing) elev[i] = mean;
            console.warn(`Infiltration: ${missing.length} cells had no DEM coverage, filled with the mean.`);
        }
        // Too many holes and the terrain term is guesswork, so drop it entirely
        // rather than route on a surface that is mostly invented.
        if (missing.length > elev.length * 0.2) return null;
        return Infiltration.despike(elev, W, H, grid.cell);
    }

    /**
     * Drop NODATA spikes out of the DEM.
     *
     * The Terrarium tiles carry small voids — contiguous blobs of pixels with
     * the blue channel zeroed and a corrupted high byte, which decode to things
     * like -478 m or +581 m in terrain that never leaves 120-230 m. Because the
     * red channel is the 256 m place, one bad pixel is a cliff, and a cliff is
     * exactly what the defilade term rewards: left in, these become magnet
     * "ravines" that the router dives into.
     *
     * Anything further from its neighbours' median than a full cell-width of
     * fall is not terrain, so replace it with that median. Two passes, because
     * the voids are a few pixels across.
     */
    static despike(elev, W, H, cell) {
        const limit = Infiltration.DESPIKE_GRADE * cell;
        for (let pass = 0; pass < 2; pass++) {
            const src = Float32Array.from(elev);
            for (let y = 1; y < H - 1; y++) {
                for (let x = 1; x < W - 1; x++) {
                    const i = y * W + x;
                    const n = [src[i - 1], src[i + 1], src[i - W], src[i + W],
                               src[i - W - 1], src[i - W + 1], src[i + W - 1], src[i + W + 1]];
                    n.sort((a, b) => a - b);
                    const median = (n[3] + n[4]) / 2;
                    if (Math.abs(src[i] - median) > limit) elev[i] = median;
                }
            }
        }
        return elev;
    }

    /** Separable box blur, used for the TPI neighbourhood mean. O(N) per axis. */
    static boxBlur(src, W, H, radius) {
        const r = Math.max(1, Math.round(radius));
        const tmp = new Float32Array(W * H);
        const out = new Float32Array(W * H);
        const clamp = (v, hi) => v < 0 ? 0 : (v > hi ? hi : v);

        for (let y = 0; y < H; y++) {
            const row = y * W;
            let sum = 0;
            for (let x = -r; x <= r; x++) sum += src[row + clamp(x, W - 1)];
            for (let x = 0; x < W; x++) {
                tmp[row + x] = sum / (2 * r + 1);
                sum += src[row + clamp(x + r + 1, W - 1)] - src[row + clamp(x - r, W - 1)];
            }
        }
        for (let x = 0; x < W; x++) {
            let sum = 0;
            for (let y = -r; y <= r; y++) sum += tmp[clamp(y, H - 1) * W + x];
            for (let y = 0; y < H; y++) {
                out[y * W + x] = sum / (2 * r + 1);
                sum += tmp[clamp(y + r + 1, H - 1) * W + x] - tmp[clamp(y - r, H - 1) * W + x];
            }
        }
        return out;
    }

    /**
     * Per-cell cost multiplier from the ground itself: cheap where the cell sits
     * below its surroundings (a balka — dead ground), expensive on a crest and
     * expensive to climb. Returns the factor, plus tpi for inspection/testing.
     */
    static terrainFactor(elev, grid) {
        const { W, H, cell } = grid;
        const M = Infiltration;
        const mean = M.boxBlur(elev, W, H, M.TPI_RADIUS_M / cell);
        const factor = new Float32Array(W * H);
        const tpi = new Float32Array(W * H);

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const t = elev[i] - mean[i];
                tpi[i] = t;

                const defilade = Math.min(M.DEFILADE_MAX, Math.max(M.DEFILADE_MIN,
                    1 + t / M.TPI_SCALE_M));

                const xe = x < W - 1 ? i + 1 : i, xw = x > 0 ? i - 1 : i;
                const ys = y < H - 1 ? i + W : i, yn = y > 0 ? i - W : i;
                const dzdx = (elev[xe] - elev[xw]) / ((xe - xw) / 1 * cell || cell);
                const dzdy = (elev[ys] - elev[yn]) / (((ys - yn) / W) * cell || cell);
                const grade = Math.hypot(dzdx, dzdy);
                const climb = Math.min(M.SLOPE_MAX, 1 + (grade / M.SLOPE_FULL) ** 2);

                factor[i] = defilade * climb;
            }
        }
        return { factor, tpi };
    }

    // ── Cost surface ─────────────────────────────────────────────────────────

    /** Chamfer 3-4 distance transform, in cells, from every set bit in `seed`. */
    static distanceTransform(seed, W, H) {
        const INF = 1e9;
        const d = new Float32Array(W * H);
        for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                let v = d[i];
                if (v === 0) continue;
                if (x > 0) v = Math.min(v, d[i - 1] + 3);
                if (y > 0) v = Math.min(v, d[i - W] + 3);
                if (y > 0 && x > 0) v = Math.min(v, d[i - W - 1] + 4);
                if (y > 0 && x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
                d[i] = v;
            }
        }
        for (let y = H - 1; y >= 0; y--) {
            for (let x = W - 1; x >= 0; x--) {
                const i = y * W + x;
                let v = d[i];
                if (v === 0) continue;
                if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
                if (y < H - 1) v = Math.min(v, d[i + W] + 3);
                if (y < H - 1 && x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
                if (y < H - 1 && x > 0) v = Math.min(v, d[i + W - 1] + 4);
                d[i] = v;
            }
        }
        for (let i = 0; i < d.length; i++) d[i] /= 3;   // chamfer units -> cells
        return d;
    }

    _costSurface(mask, grid, avoidBuiltUp, terrainFactor = null) {
        const { W, H, cell } = grid;
        const M = Infiltration;

        const coverSeed = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] & (M.M_COVER | M.M_TREELINE | M.M_BUILTUP)) coverSeed[i] = 1;
        }
        const distCells = M.distanceTransform(coverSeed, W, H);

        const builtupCost = avoidBuiltUp ? M.COST_BUILTUP_AVOID : M.COST_BUILTUP;
        const cost = new Float32Array(W * H);
        for (let i = 0; i < cost.length; i++) {
            const m = mask[i];
            if (m & M.M_WATER)         cost[i] = M.COST_WATER;
            else if (m & M.M_COVER)    cost[i] = M.COST_COVER;
            else if (m & M.M_TREELINE) cost[i] = M.COST_TREELINE;
            else if (m & M.M_BUILTUP)  cost[i] = builtupCost;
            else if (m & M.M_RIPARIAN) cost[i] = M.COST_RIPARIAN;
            else if (m & M.M_WETLAND)  cost[i] = M.COST_WETLAND;
            else {
                const exposure = Math.min(1, (distCells[i] * cell) / M.EXPOSURE_FULL_M);
                cost[i] = 1 + M.EXPOSURE_K * exposure;
            }
            // Dead ground is concealment the landcover layers cannot see, so it
            // multiplies whatever the surface already costs rather than replacing it.
            if (terrainFactor) cost[i] *= terrainFactor[i];
        }
        return cost;
    }

    /** Green under cover, yellow through settlements, red in the open. */
    static category(klass) {
        if (klass === 'builtup') return 'settlement';
        if (klass === 'open' || klass === 'water') return 'exposed';
        return 'concealed';
    }

    static categoryColor(category) {
        if (category === 'settlement') return Infiltration.COLOR_SETTLEMENT;
        if (category === 'exposed') return Infiltration.COLOR_EXPOSED;
        return Infiltration.COLOR_CONCEALED;
    }

    static cellClass(m) {
        const M = Infiltration;
        if (m & M.M_WATER)    return 'water';
        if (m & M.M_COVER)    return 'cover';
        if (m & M.M_TREELINE) return 'treeline';
        if (m & M.M_BUILTUP)  return 'builtup';
        if (m & M.M_RIPARIAN) return 'riparian';
        if (m & M.M_WETLAND)  return 'wetland';
        return 'open';
    }

    // ── Search ───────────────────────────────────────────────────────────────

    /** Cells within `rCells` of (cx, cy) — the endpoint disc that makes this
     *  area-to-area. Falls back to the single nearest cell when the radius is
     *  zero or the click landed off the corridor. */
    _disc(grid, cx, cy, rCells) {
        const { W, H } = grid;
        const out = [];
        const r2 = rCells * rCells;
        const x0 = Math.max(0, Math.floor(cx - rCells)), x1 = Math.min(W - 1, Math.ceil(cx + rCells));
        const y0 = Math.max(0, Math.floor(cy - rCells)), y1 = Math.min(H - 1, Math.ceil(cy + rCells));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const dx = x - cx, dy = y - cy;
                if (dx * dx + dy * dy > r2) continue;
                out.push(y * W + x);
            }
        }
        if (out.length) return out;
        const sx = Math.max(0, Math.min(W - 1, Math.round(cx)));
        const sy = Math.max(0, Math.min(H - 1, Math.round(cy)));
        return [sy * W + sx];
    }

    _search(grid, cost, mask, a, b, radiusM) {
        const { W, H, cell } = grid;
        const N = W * H;
        const rCells = Math.max(0, radiusM / cell);

        const startCells = this._disc(grid, grid.xOf(a.lng), grid.yOf(a.lat), rCells);
        const finishCells = this._disc(grid, grid.xOf(b.lng), grid.yOf(b.lat), rCells);

        const goal = new Uint8Array(N);
        for (const i of finishCells) goal[i] = 1;
        const bx = grid.xOf(b.lng), by = grid.yOf(b.lat);

        // Admissible: nothing can travel a metre for less than the cheapest cell.
        const heuristic = (i) => {
            const d = Math.hypot((i % W) - bx, ((i / W) | 0) - by) - rCells;
            return Math.max(0, d) * cell * Infiltration.COST_COVER;
        };

        const g = new Float64Array(N).fill(Infinity);
        const prev = new Int32Array(N).fill(-1);
        const closed = new Uint8Array(N);
        const heap = new MinHeap();
        for (const i of startCells) {
            g[i] = 0;
            heap.push({ i, dist: heuristic(i) });
        }

        const D = cell, DIAG = cell * Math.SQRT2;
        const NEIGHBOURS = [
            [1, 0, D], [-1, 0, D], [0, 1, D], [0, -1, D],
            [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
        ];

        let reached = -1;
        while (heap.size) {
            const { i } = heap.pop();
            if (closed[i]) continue;
            closed[i] = 1;
            if (goal[i]) { reached = i; break; }

            const x = i % W, y = (i / W) | 0;
            const gi = g[i], ci = cost[i];
            for (const [dx, dy, len] of NEIGHBOURS) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const j = ny * W + nx;
                if (closed[j]) continue;
                const penalty = (mask[j] & Infiltration.M_CROSS) ? Infiltration.CROSSING_PENALTY_M : 0;
                const ng = gi + len * 0.5 * (ci + cost[j]) + penalty;
                if (ng < g[j]) {
                    g[j] = ng;
                    prev[j] = i;
                    heap.push({ i: j, dist: ng + heuristic(j) });
                }
            }
        }
        if (reached < 0) throw new Error('No route found — try a larger start/end radius.');

        const chain = [];
        for (let i = reached; i !== -1; i = prev[i]) chain.push(i);
        chain.reverse();
        return chain;
    }

    // ── Public entry point ───────────────────────────────────────────────────

    static toLatLngs(points) {
        const path = (Array.isArray(points) ? points : [points])
            .map(p => L.latLng(p.lat ?? p[0], p.lng ?? p[1]));
        if (path.length < 2) throw new Error('A route needs a start and a destination.');
        return path;
    }

    /** Grid, landcover mask and cost surface for the corridor spanning `path`.
     *  Shared by the solver and by the scoring of a hand-drawn route, so both
     *  are measured against exactly the same ground. */
    async _buildSurface(path, { cellM = Infiltration.CELL_M, avoidBuiltUp = false,
                                useTerrain = true } = {}) {
        const grid = this._makeGrid(path, cellM);
        const geojson = await this._fetchOsm(grid);
        let terrain = null;
        if (useTerrain) {
            const elev = await this._fetchElevation(grid);
            if (elev) terrain = Infiltration.terrainFactor(elev, grid);
            else console.warn('Infiltration: no usable DEM coverage, routing without terrain.');
        }

        this.setStatus('Building cost surface…');
        await new Promise(resolve => setTimeout(resolve, 0));  // let the status paint

        const mask = this._rasterize(geojson, grid);
        const cost = this._costSurface(mask, grid, avoidBuiltUp, terrain?.factor);
        return { grid, mask, cost, terrain };
    }

    /**
     * Trace the most concealed routes from a to b, best first. Both endpoints
     * are treated as discs of `radiusM`, so this is area-to-area. Each route
     * carries the runs it splits into and the stats that matter.
     */
    async computeRoutes(points, { radiusM = 300, cellM = Infiltration.CELL_M,
                                  avoidBuiltUp = false, routes = 1, useTerrain = true } = {}) {
        const path = Infiltration.toLatLngs(points);
        const wanted = Math.max(1, Math.min(Infiltration.MAX_ROUTES, Math.round(routes)));
        const { grid, mask, cost } = await this._buildSurface(path, { cellM, avoidBuiltUp, useTerrain });

        const out = [];
        for (let n = 0; n < wanted; n++) {
            // The first search is the true optimum; each later one runs against
            // a surface where the ground already used has been made expensive.
            if (n > 0) this._penalizeNear(cost, out[n - 1].chain, grid);
            const chain = this._searchLegs(grid, cost, mask, path, radiusM);
            const route = this._describe(chain, grid, mask, cellM);
            route.chain = chain;
            route.rank = n + 1;
            route.legs = path.length - 1;
            out.push(route);
        }
        return out;
    }

    /**
     * Score a hand-drawn route, and optionally snap it onto nearby cover.
     *
     * The drawn line is an intent, not a pixel-exact path, so the snap re-solves
     * inside a corridor of `corridorM` around it: the result is the most
     * concealed line that still goes where you meant. Both versions are scored
     * through the same _describe as an automatic route, so the numbers compare.
     */
    async analyzeDrawn(points, { cellM = Infiltration.CELL_M, avoidBuiltUp = false,
                                 useTerrain = true, snap = true, corridorM = 300,
                                 radiusM = 0 } = {}) {
        const path = Infiltration.toLatLngs(points);
        const { grid, mask, cost } = await this._buildSurface(path, { cellM, avoidBuiltUp, useTerrain });

        const drawnChain = Infiltration.rasterizePath(path, grid);
        const drawn = this._describe(drawnChain, grid, mask, cellM);
        drawn.chain = drawnChain;
        drawn.rank = 1;
        drawn.legs = path.length - 1;
        drawn.kind = 'drawn';
        if (!snap) return { drawn, snapped: null };

        // Everything outside the corridor is priced out of reach rather than
        // deleted, so the search still has a fallback if the drawn line clips
        // the grid edge and cannot be followed exactly.
        const corridor = Infiltration.distanceTransform(
            Infiltration.chainMask(drawnChain, grid), grid.W, grid.H);
        const limit = corridorM / grid.cell;
        const constrained = Float32Array.from(cost);
        for (let i = 0; i < constrained.length; i++) {
            if (corridor[i] > limit) constrained[i] = Infiltration.OUT_OF_CORRIDOR_COST;
        }

        const ends = [path[0], path[path.length - 1]];
        const snappedChain = this._search(grid, constrained, mask, ends[0], ends[1], radiusM);
        const snapped = this._describe(snappedChain, grid, mask, cellM);
        snapped.chain = snappedChain;
        snapped.rank = 1;
        snapped.legs = drawn.legs;
        snapped.kind = 'snapped';
        return { drawn, snapped };
    }

    static chainMask(chain, grid) {
        const seed = new Uint8Array(grid.W * grid.H);
        for (const i of chain) seed[i] = 1;
        return seed;
    }

    /**
     * A drawn polyline as a connected run of grid cells, walked in half-cell
     * steps so no cell is skipped on a diagonal. This is the same shape a search
     * returns, which is what lets a drawn route reuse the whole scoring path.
     */
    static rasterizePath(path, grid) {
        const { W, H } = grid;
        const clampX = (x) => Math.max(0, Math.min(W - 1, Math.round(x)));
        const clampY = (y) => Math.max(0, Math.min(H - 1, Math.round(y)));
        const chain = [];
        const push = (x, y) => {
            const i = clampY(y) * W + clampX(x);
            if (chain[chain.length - 1] !== i) chain.push(i);
        };

        for (let k = 0; k < path.length - 1; k++) {
            const x0 = grid.xOf(path[k].lng), y0 = grid.yOf(path[k].lat);
            const x1 = grid.xOf(path[k + 1].lng), y1 = grid.yOf(path[k + 1].lat);
            const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
            for (let s = k === 0 ? 0 : 1; s <= steps; s++) {
                const t = s / steps;
                push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
            }
        }
        return chain;
    }

    /** One search per waypoint pair, over the shared cost surface, stitched into
     *  a single chain — the joint cell would otherwise appear twice. */
    _searchLegs(grid, cost, mask, path, radiusM) {
        const chain = [];
        for (let i = 0; i < path.length - 1; i++) {
            const leg = this._search(grid, cost, mask, path[i], path[i + 1], radiusM);
            chain.push(...(chain.length ? leg.slice(1) : leg));
        }
        return chain;
    }

    /** Make the ground a route already used expensive, fading back to normal at
     *  ALT_SEPARATION_M, so the next search finds a genuinely separate line. */
    _penalizeNear(cost, chain, grid) {
        const seed = new Uint8Array(cost.length);
        for (const i of chain) seed[i] = 1;
        const distCells = Infiltration.distanceTransform(seed, grid.W, grid.H);
        const rCells = Infiltration.ALT_SEPARATION_M / grid.cell;
        for (let i = 0; i < cost.length; i++) {
            if (distCells[i] >= rCells) continue;
            const nearness = 1 - distCells[i] / rCells;
            cost[i] *= 1 + (Infiltration.ALT_PENALTY - 1) * nearness;
        }
    }

    /** Cell chain -> lat/lng path, movement-class runs, and route stats. */
    _describe(chain, grid, mask, requestedCellM) {
        const { W, cell } = grid;
        const latlngs = chain.map(i => [grid.latOf((i / W) | 0), grid.lngOf(i % W)]);
        const category = chain.map(i => Infiltration.category(Infiltration.cellClass(mask[i])));

        let lengthM = 0, coveredM = 0, settlementM = 0;
        let longestOpenM = 0, openRunM = 0, crossings = 0;
        let inCrossing = false;
        for (let k = 1; k < chain.length; k++) {
            const prevI = chain[k - 1], curI = chain[k];
            const dx = (curI % W) - (prevI % W);
            const dy = ((curI / W) | 0) - ((prevI / W) | 0);
            const segM = Math.hypot(dx, dy) * cell;
            lengthM += segM;

            if (category[k] === 'exposed') {
                openRunM += segM;
                longestOpenM = Math.max(longestOpenM, openRunM);
            } else {
                openRunM = 0;
                coveredM += segM;
                if (category[k] === 'settlement') settlementM += segM;
            }

            const onCrossing = !!(mask[curI] & (Infiltration.M_CROSS | Infiltration.M_WATER));
            if (onCrossing && !inCrossing) crossings++;
            inCrossing = onCrossing;
        }

        // Split into runs of like movement class, sharing a vertex so the drawn
        // line stays continuous, then simplify each run on its own — a global
        // simplify would smear the boundary between covered and open ground.
        const tolerance = (cell * 0.75) / grid.mPerDegLat;
        const runs = [];
        let current = null;
        for (let k = 0; k < latlngs.length; k++) {
            // Measure before simplify — it is what the hover tooltip reports,
            // and simplify throws away the vertices the length is made of.
            const stepM = k ? Math.hypot((chain[k] % W) - (chain[k - 1] % W),
                                         ((chain[k] / W) | 0) - ((chain[k - 1] / W) | 0)) * cell : 0;
            if (!current || current.category !== category[k]) {
                if (current) {
                    current.points.push(latlngs[k]);
                    current.lengthM += stepM;
                    runs.push(current);
                }
                current = { category: category[k], points: [latlngs[k]], lengthM: 0 };
            } else {
                current.points.push(latlngs[k]);
                current.lengthM += stepM;
            }
        }
        if (current) runs.push(current);
        for (const run of runs) run.points = Infiltration.simplify(run.points, tolerance);

        return {
            latlngs,
            runs,
            stats: {
                length_km: lengthM / 1000,
                covered_pct: lengthM ? Math.round(100 * coveredM / lengthM) : 0,
                settlement_pct: lengthM ? Math.round(100 * settlementM / lengthM) : 0,
                longest_open_m: longestOpenM,
                crossings,
                transit_min: (lengthM / 1000) / Infiltration.PACE_KMH * 60,
                cell_m: cell,
                requested_cell_m: requestedCellM,
            },
        };
    }

    static simplify(points, tolerance) {
        if (points.length < 3) return points;
        try {
            const line = turf.lineString(points.map(([lat, lng]) => [lng, lat]));
            const out = turf.simplify(line, { tolerance, highQuality: true });
            return out.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        } catch (error) {
            return points;   // degenerate geometry — the raw chain is still valid
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    render(routes, { radiusM = 0, drawn = null } = {}) {
        const layer = this._layer();
        layer.clearLayers();
        this._draftLine = null;
        if (!routes?.length) return;

        // The line the user actually drew stays visible underneath, so how far
        // the snap moved it — and whether that was reasonable — is legible.
        if (drawn) {
            L.polyline(drawn.latlngs, {
                color: Infiltration.COLOR_DRAWN, weight: 2, opacity: 0.75,
                dashArray: '5,6', interactive: false,
            }).addTo(layer);
        }

        // Alternates go down first so the best route draws on top of them.
        for (let n = routes.length - 1; n >= 0; n--) {
            this._renderRoute(routes[n], layer, n === 0, routes.length > 1);
        }

        const path = routes[0].latlngs;
        [path[0], path[path.length - 1]].forEach((ll, idx) => {
            if (!ll) return;
            L.circleMarker(ll, {
                radius: 5, color: '#fff', weight: 2,
                fillColor: idx === 0 ? '#2e7d32' : '#f59e0b', fillOpacity: 1,
            }).addTo(layer);
            if (radiusM > 0) {
                L.circle(ll, {
                    radius: radiusM, color: '#ffffff', weight: 1,
                    opacity: 0.5, fillOpacity: 0.04, dashArray: '3,5',
                }).addTo(layer);
            }
        });
    }

    _renderRoute(route, layer, primary, numbered) {
        // A coloured line on satellite imagery or over the forest overlay is
        // invisible, so every run gets a dark casing underneath it.
        const weight = primary ? 3.5 : 2.5;
        for (const run of route.runs) {
            if (run.points.length < 2) continue;
            L.polyline(run.points, {
                color: '#0b0b0b', weight: weight + 3.5, opacity: primary ? 0.45 : 0.3,
                // The casing sits on top of the coloured line and would eat the
                // hover, leaving the tooltip bound to a layer nothing can reach.
                interactive: false,
            }).addTo(layer);
            L.polyline(run.points, {
                color: Infiltration.categoryColor(run.category),
                weight,
                opacity: primary ? 1 : 0.75,
                dashArray: run.category === 'exposed' ? '6,6' : null,
            }).bindTooltip(Infiltration.runTooltip(route, run), {
                sticky: true, className: 'infil-tooltip',
            }).addTo(layer);
        }

        const path = route.latlngs;
        if (path.length >= 2) {
            this._arrowHead(path[path.length - 2], path[path.length - 1],
                            Infiltration.COLOR_CONCEALED, layer);
        }
        if (numbered && path.length) {
            // With three overlapping lines the stats readout is unusable unless
            // each line says which one it is.
            L.marker(path[Math.floor(path.length / 2)], {
                interactive: false,
                icon: L.divIcon({
                    className: 'infil-badge',
                    html: `<span>${route.rank ?? ''}</span>`,
                    iconSize: [18, 18], iconAnchor: [9, 9],
                }),
            }).addTo(layer);
        }
    }

    static RUN_LABEL = {
        concealed: 'under cover',
        settlement: 'through settlement',
        exposed: 'open ground',
    };

    /** What the cursor is actually over, then what the whole route costs. */
    static runTooltip(route, run) {
        const s = route.stats;
        const legs = route.legs > 1 ? ` · ${route.legs} legs` : '';
        const name = route.kind === 'snapped' ? 'Snapped'
                   : route.kind === 'drawn' ? 'As drawn'
                   : `Route ${route.rank}`;
        return `<b>${name} — ${Infiltration.RUN_LABEL[run.category]}, `
             + `${Math.round(run.lengthM)} m</b><br>`
             + `${s.length_km.toFixed(1)} km · ${s.covered_pct}% under cover`
             + ` · worst open crossing ${Math.round(s.longest_open_m)} m`
             + ` · ${s.crossings} crossings${legs}`;
    }

    _arrowHead(p1, p2, color, layer) {
        const lat = p2[0] * Math.PI / 180;
        const dy = p2[0] - p1[0];
        const dx = (p2[1] - p1[1]) * Math.cos(lat);
        const angle = Math.atan2(dy, dx);
        const len = 0.0022;
        const spread = Math.PI / 6;
        const barb = (a) => [
            p2[0] - len * Math.sin(a),
            p2[1] - (len * Math.cos(a)) / Math.cos(lat),
        ];
        L.polygon([p2, barb(angle - spread), barb(angle + spread)], {
            color: '#0b0b0b', fillColor: color, fillOpacity: 1, weight: 1.5, opacity: 0.6,
            interactive: false,   // sits over the line's last run; must not eat the hover
        }).addTo(layer);
    }

    /** Hand the route to DrawingTool so it survives session save, share links
     *  and poster export — those persist drawTool.shapes, not Leaflet layers. */
    toDrawing() {
        if (!this.routes.length) {
            this.setStatus('Trace a route first.', true);
            return;
        }
        const drawTool = this.dashboard.drawTool;
        if (!drawTool) {
            this.setStatus('Drawing tool is not ready yet.', true);
            return;
        }
        for (const route of this.routes) {
            drawTool.shapes.push({
                type: 'freedraw',
                points: route.latlngs,
                head: true,
                dash: true,
                color: Infiltration.COLOR_CONCEALED,
                thickness: route.rank === 1 ? 3 : 2,
            });
        }
        drawTool._render();
        const what = this.drawn ? 'Snapped route' : `${this.routes.length} route(s)`;
        this.setStatus(`${what} added to the drawing layer.`);
    }
}

window.Infiltration = Infiltration;

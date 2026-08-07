/**
 * In-page bridge for the MCP server. Injected with page.addInitScript(); the app
 * itself is never modified and never knows this exists.
 *
 * Everything here runs in the browser against `window.dashboard`. Keep it thin —
 * it is the only code that touches app internals, so all coupling lives in one file.
 *
 * COORDINATE CONTRACT: DrawingTool shapes use [lat, lng]. GeoJSON uses [lng, lat].
 * `toLatLng` is the only place that flips.
 */
(() => {
    const AI_OWNER = 'ai';

    const d = () => window.dashboard;
    const toLatLng = (geoCoords) => [geoCoords[1], geoCoords[0]];

    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

    /** Accepts an L.LatLng, {lat,lng} or [lat,lng] and normalises to [lat,lng]. */
    const pt = (v) => {
        if (!v) return null;
        if (Array.isArray(v)) return [v[0], v[1]];
        if (num(v.lat) !== null && num(v.lng) !== null) return [v.lat, v.lng];
        return null;
    };

    const api = {
        // ── readiness ────────────────────────────────────────────────────────
        async ready(timeoutMs = 45000) {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                const db = d();
                if (db && db.map && db.drawTool && db.settlementsData?.features?.length) {
                    return { ok: true, settlements: db.settlementsData.features.length };
                }
                await new Promise((r) => setTimeout(r, 250));
            }
            const db = d();
            throw new Error(
                `map not ready after ${timeoutMs}ms (dashboard=${!!db} map=${!!db?.map} ` +
                `drawTool=${!!db?.drawTool} settlements=${db?.settlementsData?.features?.length ?? 0})`
            );
        },

        // ── read ─────────────────────────────────────────────────────────────
        state() {
            const db = d();
            const c = db.map.getCenter();
            const b = db.map.getBounds();
            const session = db.serializeSession();
            const shapes = db.drawTool.shapes;
            const byType = {};
            shapes.forEach((s) => { byType[s.type] = (byType[s.type] || 0) + 1; });

            return {
                view: {
                    center: [c.lat, c.lng],
                    zoom: db.map.getZoom(),
                    bounds: { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() },
                },
                dates: session.dates,
                basemap: session.basemap,
                activeLayers: Object.entries(session.toggles || {})
                    .filter(([, on]) => on === true)
                    .map(([id]) => id),
                shapes: {
                    total: shapes.length,
                    byAi: shapes.filter((s) => s.owner === AI_OWNER).length,
                    byType,
                },
                mapUmlScript: session.mapUml || '',
            };
        },

        /**
         * Resolve a place name to coordinates. Delegates to MapUMLEngine.findCoordinates,
         * which already handles [Alias:lat,lon] literals, compass tokens, quoted-exact,
         * `*` wildcards, substring matching and unit-marker names.
         */
        resolve(query, limit = 5) {
            const db = d();
            const hit = db.mapUmlEngine ? db.mapUmlEngine.findCoordinates(query) : null;

            const alternatives = [];
            const q = String(query).toLowerCase().trim();
            for (const f of db.settlementsData?.features || []) {
                const p = f.properties || {};
                const name = (p.name || '').toLowerCase();
                const en = (p['name:en'] || '').toLowerCase();
                if (!name.includes(q) && !en.includes(q)) continue;
                alternatives.push({
                    name: p.name,
                    nameEn: p['name:en'],
                    place: p.place,
                    population: p.population ? Number(String(p.population).replace(/\D/g, '')) || null : null,
                    coords: toLatLng(f.geometry.coordinates),
                    exact: name === q || en === q,
                    starts: name.startsWith(q) || en.startsWith(q),
                });
                if (alternatives.length > 200) break;
            }
            alternatives.sort((a, b) =>
                (b.exact - a.exact) || (b.starts - a.starts) || ((b.population || 0) - (a.population || 0)));

            if (hit && hit.isDirection) {
                return { found: false, isDirection: true, offset: hit.offset, alternatives: [] };
            }
            // Literal [Alias:lat,lon] and unit-marker hits are unambiguous — take them as-is.
            if (hit && hit.latlng && hit.type !== 'settlement') {
                return { found: true, coords: pt(hit.latlng), kind: hit.type, name: hit.name,
                         alternatives: alternatives.slice(0, limit) };
            }
            // An exact settlement match always beats the engine's substring hit:
            // findCoordinates returns the first substring match, so "Pokrovsk" would
            // otherwise land on "Pokrovske" hundreds of km away.
            const best = alternatives[0];
            if (best && best.exact) {
                return { found: true, coords: best.coords, kind: 'settlement',
                         name: best.nameEn || best.name, alternatives: alternatives.slice(0, limit) };
            }
            if (hit && hit.latlng) {
                return { found: true, coords: pt(hit.latlng), kind: hit.type, name: hit.name,
                         alternatives: alternatives.slice(0, limit) };
            }
            if (best) {
                return { found: true, coords: best.coords, kind: 'settlement', ambiguous: true,
                         name: best.nameEn || best.name, alternatives: alternatives.slice(0, limit) };
            }
            return { found: false, coords: null, alternatives: [] };
        },

        /** Whatever is currently loaded on the map, optionally clipped to a bbox. */
        features(kind, bbox, limit = 150) {
            const db = d();
            const within = ([lat, lng]) =>
                !bbox || (lat <= bbox.north && lat >= bbox.south && lng <= bbox.east && lng >= bbox.west);
            const cap = (arr) => ({ count: arr.length, truncated: arr.length > limit, items: arr.slice(0, limit) });

            if (kind === 'settlements') {
                const out = [];
                for (const f of db.settlementsData?.features || []) {
                    const c = toLatLng(f.geometry.coordinates);
                    if (!within(c)) continue;
                    const p = f.properties || {};
                    out.push({ name: p.name, nameEn: p['name:en'], place: p.place,
                               population: p.population ? Number(String(p.population).replace(/\D/g, '')) || null : null,
                               coords: c });
                }
                out.sort((a, b) => (b.population || 0) - (a.population || 0));
                return cap(out);
            }

            if (kind === 'units') {
                const out = [];
                for (const [side, layer] of [['UA', db.dailyLayerUA], ['RU', db.dailyLayerRU]]) {
                    if (!layer) continue;
                    layer.eachLayer((l) => {
                        const f = l.feature;
                        const ll = l.getLatLng ? l.getLatLng() : null;
                        if (!f || !ll || !within([ll.lat, ll.lng])) return;
                        const p = f.properties || {};
                        out.push({ side, name: p.Name || p.name || p.unit || p.designation || '(unnamed)',
                                   coords: [ll.lat, ll.lng] });
                    });
                }
                return cap(out);
            }

            const eventSets = {
                events: db.eventsData,
                ria_events: db.riaEventsData,
                owl_events: db.owlEventsData,
                modr: db.modrData,
            };
            if (kind in eventSets) {
                const src = eventSets[kind] || [];
                const out = [];
                for (const e of src) {
                    const lat = num(e.lat), lng = num(e.lng ?? e.lon);
                    if (lat === null || lng === null || !within([lat, lng])) continue;
                    out.push({
                        name: e.name || e.fullName || '',
                        date: e.date || null,
                        category: e.category || e.icon || e.event || null,
                        actor: e.actor || null,
                        weapon: e.weapon || null,
                        coords: [lat, lng],
                    });
                }
                return cap(out);
            }

            if (kind === 'territory') {
                const diff = db.currentDiffResult;
                if (!diff) return { count: 0, items: [], note: 'no territory diff loaded — enable the diff-area layer first' };
                return {
                    statistics: diff.statistics || {},
                    count: (diff.polygons || []).length,
                    items: (diff.polygons || []).slice(0, limit).map((p) => ({
                        kind: p.type || 'control',
                        areaKm2: p.area ? p.area.squareKilometers : null,
                        color: p.style?.fillColor || p.style?.color || null,
                    })),
                };
            }

            throw new Error(`unknown feature kind: ${kind}`);
        },

        // ── view / time / layers ─────────────────────────────────────────────
        setView(center, zoom) {
            const db = d();
            db.map.setView(center, zoom ?? db.map.getZoom());
            return api.state().view;
        },

        async loadRegion(name, zoom) {
            const db = d();
            if (!db.regionCoordinates[name]) {
                throw new Error(`unknown region "${name}" — known: ${Object.keys(db.regionCoordinates).join(', ')}`);
            }
            if (db.regionPolygons && db.regionPolygons[name]) db.loadPredefinedRegion(name);
            // loadPredefinedRegion ends with an animated fitBounds; let it settle,
            // then apply the requested zoom so it is not overridden mid-flight.
            await new Promise((r) => setTimeout(r, 450));
            if (zoom != null) db.map.setView(db.regionCoordinates[name], zoom, { animate: false });
            else if (!db.regionPolygons?.[name]) db.map.setView(db.regionCoordinates[name], db.map.getZoom(), { animate: false });
            return api.state().view;
        },

        /** Basemap + hypsometric topo overlay — both are <select>s, not checkboxes. */
        setBasemap(style, topoMode) {
            const db = d();
            const out = {};
            if (style) {
                const sel = db.getEl('map-style');
                if (!sel) throw new Error('map-style select not found');
                if (!db.mapStyles[style]) {
                    throw new Error(`unknown basemap "${style}" — known: ${Object.keys(db.mapStyles).join(', ')}`);
                }
                sel.value = style;
                sel.dispatchEvent(new Event('change'));
                out.basemap = style;
            }
            if (topoMode !== undefined) {
                const sel = db.getEl('topo-mode');
                if (sel) { sel.value = topoMode; sel.dispatchEvent(new Event('change')); out.topoMode = topoMode; }
            }
            return out;
        },

        basemaps() {
            const db = d();
            return { current: db.getEl('map-style')?.value, available: Object.keys(db.mapStyles) };
        },

        regions() {
            const db = d();
            return Object.entries(db.regionCoordinates).map(([name, coords]) => ({
                name, coords, hasOutline: !!(db.regionPolygons && db.regionPolygons[name]),
            }));
        },

        /** Canonical date recipe, lifted from AttackMapDashboard.restoreSession. */
        setDates(startISO, endISO) {
            const db = d();
            const start = new Date(startISO);
            const end = new Date(endISO);
            if (start < db.minDate) db.minDate = start;
            if (end > db.maxDate) db.maxDate = end;
            const ds = db.getEl('date-start'); if (ds) ds.valueAsDate = db.minDate;
            const de = db.getEl('date-end');   if (de) de.valueAsDate = db.maxDate;
            db.initSlider(db.minDate, db.maxDate, start, end);
            return { start: start.toISOString(), end: end.toISOString() };
        },

        layerIds() {
            return (d().constructor.SESSION_TOGGLE_IDS || []).map((id) => ({
                id, on: !!d().getEl(id)?.checked,
            }));
        },

        setLayers(map) {
            const db = d();
            const known = new Set(d().constructor.SESSION_TOGGLE_IDS || []);
            const applied = [], unknown = [];
            for (const [id, want] of Object.entries(map)) {
                const el = db.getEl(id);
                if (!el || !known.has(id)) { unknown.push(id); continue; }
                if (el.checked !== !!want) { el.checked = !!want; el.dispatchEvent(new Event('change')); }
                applied.push(id);
            }
            return { applied, unknown, knownIds: [...known] };
        },

        // ── draw ─────────────────────────────────────────────────────────────
        addShapes(shapes) {
            const db = d();
            const tagged = shapes.map((s) => ({ ...s, owner: AI_OWNER }));
            db.drawTool.shapes.push(...tagged);
            db.drawTool._render();
            return { added: tagged.length, total: db.drawTool.shapes.length };
        },

        erase(scope, n = 1) {
            const db = d();
            const before = db.drawTool.shapes.length;
            if (scope === 'all') {
                db.drawTool.shapes = [];
            } else if (scope === 'ai') {
                db.drawTool.shapes = db.drawTool.shapes.filter((s) => s.owner !== AI_OWNER);
            } else if (scope === 'last') {
                db.drawTool.shapes.splice(Math.max(0, before - n), n);
            } else {
                throw new Error(`unknown erase scope: ${scope}`);
            }
            db.drawTool._render();
            return { removed: before - db.drawTool.shapes.length, total: db.drawTool.shapes.length };
        },

        undo() {
            const db = d();
            db.drawTool.undo();
            return { total: db.drawTool.shapes.length };
        },

        // ── terrain ──────────────────────────────────────────────────────────

        /** Elevation in metres at each [lat,lng], via the Terrarium DEM tiles. */
        async elevations(points) {
            const ta = d().terrainAnalysis;
            if (!ta) throw new Error('TerrainAnalysis not loaded');
            const lats = points.map((p) => p[0]);
            const lngs = points.map((p) => p[1]);
            await ta._prefetchTiles(Math.min(...lats), Math.max(...lats),
                                    Math.min(...lngs), Math.max(...lngs));
            return Promise.all(points.map(([lat, lng]) => ta.sampleElevation(lat, lng)));
        },

        /**
         * Least-cost path from a to b over the elevation grid: an advance follows
         * valleys and saddles rather than climbing straight over ridges, which is
         * what makes a drawn axis look plausible instead of ruler-straight.
         *
         * Dijkstra over a coarse lattice; cost = distance + climb penalty. `detour`
         * caps how far off the direct line the corridor may wander.
         */
        async terrainPath(a, b, { steps = 40, spread = 21, climbWeight = 120, detour = 0.16,
                                  bendPenalty = 0.35 } = {}) {
            const ta = d().terrainAnalysis;
            if (!ta) throw new Error('TerrainAnalysis not loaded');

            const dLat = b[0] - a[0], dLng = b[1] - a[1];
            const len = Math.hypot(dLat, dLng);
            if (!len) return [a, b];
            // unit normal to the a→b direction, in degrees
            const nLat = -dLng / len, nLng = dLat / len;
            const halfWidth = len * detour;

            // lattice: `steps` columns along the axis, `spread` rows across it
            const node = (i, j) => {
                const t = i / steps;
                const o = ((j / (spread - 1)) - 0.5) * 2 * halfWidth;
                return [a[0] + dLat * t + nLat * o, a[1] + dLng * t + nLng * o];
            };
            const pts = [];
            for (let i = 0; i <= steps; i++) for (let j = 0; j < spread; j++) pts.push(node(i, j));

            const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
            await ta._prefetchTiles(Math.min(...lats), Math.max(...lats),
                                    Math.min(...lngs), Math.max(...lngs));
            const elev = await Promise.all(pts.map(([lat, lng]) => ta.sampleElevation(lat, lng)));
            const idx = (i, j) => i * spread + j;
            const at = (i, j) => elev[idx(i, j)] ?? 0;

            // columns advance strictly left→right, so a simple DP suffices
            const KM_DEG = 111;
            const cost = new Array(pts.length).fill(Infinity);
            const from = new Array(pts.length).fill(-1);
            const startJ = Math.floor(spread / 2);
            cost[idx(0, startJ)] = 0;

            // MAX_SHIFT caps lateral movement per column. Without it the path can jump
            // clear across the corridor in one step, producing right-angled staircases
            // instead of a route.
            const MAX_SHIFT = 1;
            for (let i = 0; i < steps; i++) {
                for (let j = 0; j < spread; j++) {
                    const c = cost[idx(i, j)];
                    if (!isFinite(c)) continue;
                    for (let k = Math.max(0, j - MAX_SHIFT); k <= Math.min(spread - 1, j + MAX_SHIFT); k++) {
                        const p = node(i, j), q = node(i + 1, k);
                        const distKm = Math.hypot((q[0] - p[0]) * KM_DEG,
                                                  (q[1] - p[1]) * KM_DEG * Math.cos(p[0] * Math.PI / 180));
                        const climb = Math.abs(at(i + 1, k) - at(i, j)) / 1000;   // km of vertical
                        // a small cost per lateral step keeps the route from wandering
                        // on DEM noise where the ground is genuinely flat
                        const bend = k === j ? 0 : bendPenalty;
                        const nc = c + distKm + climb * climbWeight + bend;
                        if (nc < cost[idx(i + 1, k)]) {
                            cost[idx(i + 1, k)] = nc;
                            from[idx(i + 1, k)] = j;
                        }
                    }
                }
            }

            // node(0, startJ) === a and node(steps, startJ) === b by construction, so
            // the route must both start and finish on the centre row
            const cols = new Array(steps + 1);
            let j = startJ;
            for (let i = steps; i >= 0; i--) {
                cols[i] = j;
                if (i > 0) { const prev = from[idx(i, j)]; j = prev < 0 ? startJ : prev; }
            }
            const path = cols.map((jj, i) => node(i, jj));
            path[0] = a;
            path[path.length - 1] = b;
            return path;
        },

        /** Road-network route between the roads nearest a and b. */
        async roadPath(a, b) {
            const lf = d().lineFeatures;
            if (!lf) throw new Error('LineFeatures not loaded');
            const roads = await lf.loadAllRoads();
            if (!roads?.length) throw new Error('no road data loaded');

            const nearest = (pt) => {
                let best = null, bestD = Infinity;
                for (const f of roads) {
                    for (const coords of lf._lines(f)) {
                        for (const c of coords) {
                            const dd = (c[1] - pt[0]) ** 2 + (c[0] - pt[1]) ** 2;
                            if (dd < bestD) { bestD = dd; best = f; }
                        }
                    }
                }
                return best;
            };
            const fa = nearest(a), fb = nearest(b);
            if (!fa || !fb) throw new Error('no road near the given points');

            const mids = await lf.findRoadPath(fa, fb);
            if (!mids) return null;

            // stitch the chosen features into one ordered [lat,lng] path
            const segs = [fa, ...mids, fb].flatMap((f) => lf._lines(f).map((c) => c.map(([lng, lat]) => [lat, lng])));
            const out = [a];
            const used = new Array(segs.length).fill(false);
            let cur = a;
            for (let n = 0; n < segs.length; n++) {
                let bi = -1, bd = Infinity, flip = false;
                segs.forEach((s, i) => {
                    if (used[i] || s.length < 2) return;
                    const dh = (s[0][0] - cur[0]) ** 2 + (s[0][1] - cur[1]) ** 2;
                    const dt = (s[s.length - 1][0] - cur[0]) ** 2 + (s[s.length - 1][1] - cur[1]) ** 2;
                    if (Math.min(dh, dt) < bd) { bd = Math.min(dh, dt); bi = i; flip = dt < dh; }
                });
                if (bi < 0) break;
                used[bi] = true;
                const seg = flip ? [...segs[bi]].reverse() : segs[bi];
                out.push(...seg);
                cur = seg[seg.length - 1];
            }
            out.push(b);
            return out;
        },

        /**
         * The real control boundary from the loaded DeepState territory, clipped to
         * a bbox — a genuine front line rather than a hand-drawn guess.
         */
        async frontLine(bbox, dateStr) {
            const db = d();
            const utils = new DeepUtils(null);
            const data = await utils.addDeepMap(dateStr ? new Date(dateStr) : (db.endDate || new Date()));
            const inBox = ([lat, lng]) => !bbox ||
                (lat <= bbox.north && lat >= bbox.south && lng <= bbox.east && lng >= bbox.west);

            // keep only Russian-controlled polygons; their edge inside the viewport
            // is the front. Grey-zone polygons would double every line.
            const runs = [];
            for (const poly of data.polygons || []) {
                if ((poly.properties?.fill || '').toLowerCase() !== '#a52714') continue;
                let run = [];
                for (const c of poly.coordinates) {
                    if (inBox(c)) { run.push(c); }
                    else if (run.length) { runs.push(run); run = []; }
                }
                if (run.length) runs.push(run);
            }
            return runs.filter((r) => r.length >= 4).sort((x, y) => y.length - x.length);
        },

        // ── poster chrome ────────────────────────────────────────────────────
        poster(cfg) {
            const p = d().poster;
            if (!p) throw new Error('Poster module not loaded');
            if (cfg.clear) return p.clear();
            if (cfg.title !== undefined || cfg.subtitle !== undefined ||
                cfg.dateline !== undefined || cfg.caveat !== undefined) {
                p.setTitle({
                    title: cfg.title, subtitle: cfg.subtitle,
                    dateline: cfg.dateline, caveat: cfg.caveat,
                });
            }
            if (cfg.legend !== undefined) p.setLegend(cfg.legend);
            if (cfg.show !== undefined) p.show(cfg.show);
            return { ...p.serialize(), legendRows: p.legend ? p._resolveRows() : [] };
        },

        // ── persistence ──────────────────────────────────────────────────────
        saveSession() { return d().serializeSession(); },
        async loadSession(state) { await d().restoreSession(state); return api.state(); },

        shareLink() {
            const db = d();
            const btn = db.getEl('share-session-link');
            if (!btn) throw new Error('share-session-link button not found');
            btn.click();
            return db.lastShareLink || null;
        },
    };

    window.__agent = api;
})();

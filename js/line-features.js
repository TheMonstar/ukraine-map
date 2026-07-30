/**
 * Roads, waterways and railways — the three OSM line overlays.
 *
 * Data comes from the slim per-group files produced by tools/slim_geodata.py
 * (see that script for the schema). One file per UI checkbox, fetched lazily the
 * first time its checkbox is on and its zoom gate is met, so switching on
 * "Highway" downloads 0.5 MB instead of the 118 MB monolith this replaces.
 *
 * Everything is drawn into a single shared canvas renderer and filtered to the
 * viewport, so the number of features on screen — not the size of the dataset —
 * determines render cost.
 */
class LineFeatures {

    // `mb` is the measured uncompressed size, used only to drive the progress
    // bar (the files are gzipped on the wire, so Content-Length can't be used).
    static GROUPS = [
        { id: 'motorlines-type-highway',  file: 'roads-highway',  family: 'motor', mb: 3.6,  minZoom: 0,  style: { color: '#d32f2f', weight: 3 } },
        { id: 'motorlines-type-primary',  file: 'roads-primary',  family: 'motor', mb: 14.2, minZoom: 8,  style: { color: '#f57c00', weight: 2 } },
        { id: 'motorlines-type-tertiary', file: 'roads-tertiary', family: 'motor', mb: 20.9, minZoom: 10, style: { color: '#fbc02d', weight: 1 } },
        { id: 'motorlines-type-bridge',   file: 'roads-bridge',   family: 'motor', mb: 2.4,  minZoom: 0,  style: { color: '#7b1fa2', weight: 3 } },
        { id: 'waterways-type-river',     file: 'water-river',    family: 'water', mb: 10.3, minZoom: 0,  style: { color: '#2b7cff', weight: 2 } },
        { id: 'waterways-type-stream',    file: 'water-stream',   family: 'water', mb: 29.6, minZoom: 10, style: { color: '#2b7cff', weight: 1, dashArray: '4,6' } },
        { id: 'railways-type-rail',       file: 'rail-rail',      family: 'rail',  mb: 10.2, minZoom: 0,  style: { color: '#111111', weight: 1.5, dashArray: '6 4' } },
        { id: 'railways-type-station',    file: 'rail-station',   family: 'rail',  mb: 0.1,  minZoom: 0,  style: { color: '#00897b', weight: 4 } },
        { id: 'railways-type-bridge',     file: 'rail-bridge',    family: 'rail',  mb: 0.7,  minZoom: 0,  style: { color: '#7b1fa2', weight: 3.5 } },
    ];

    static FAMILIES = {
        motor: { master: 'feature-motorlines', layer: 'featureMotorLayer' },
        water: { master: 'feature-waterways', layer: 'featureWaterLayer' },
        rail: { master: 'feature-railways', layer: 'featureRailwayLayer' },
    };

    // Road classes that live in each file, for the analytics helpers below.
    static ROAD_CLASS_FILES = ['roads-highway', 'roads-primary', 'roads-tertiary'];

    static HIGHLIGHT_COLOR = '#ff6f00';
    static CELL_DEG = 0.5;      // ~55 km spatial index cells
    static MOVE_DEBOUNCE_MS = 400;

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.features = new Map();   // file -> feature array
        this.indexes = new Map();    // file -> { bboxes, cells }
        this.pending = new Map();    // file -> Promise
        this.roadById = new Map();   // road properties.id -> feature
        this.layersById = new Map(); // road properties.id -> [Leaflet layers]
        this.roadGraph = null;
        this.renderer = null;
        this.loading = 0;
        this._moveHandler = null;
    }

    // --- lifecycle ---------------------------------------------------------

    init() {
        const map = this.dashboard.map;
        if (!this.renderer) {
            // Thousands of polylines as individual SVG paths is what made these
            // layers unusable; canvas draws them all in one element.
            this.renderer = L.canvas({ padding: 0.3 });
        }
        if (!this.dashboard.featureWaterLayer) {
            // Waterways used to share featureLayer with the daily position and
            // attack markers, so toggling them wiped those out.
            this.dashboard.featureWaterLayer = L.layerGroup().addTo(map);
        }
        if (!this._moveHandler) {
            this._moveHandler = this._debounce(() => this.renderAll(), LineFeatures.MOVE_DEBOUNCE_MS);
            map.on('moveend zoomend rotate', this._moveHandler);
        }
    }

    _debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    // --- loading -----------------------------------------------------------

    _showLoader(text) {
        const loader = this.dashboard.getEl('settlement-boundaries-loader');
        const title = this.dashboard.getEl('boundaries-loader-title');
        if (title) title.textContent = 'Loading Map Features';
        if (loader) loader.classList.add('active');
        this._updateLoader(0, text);
    }

    _updateLoader(percentage, text) {
        const bar = this.dashboard.getEl('boundaries-progress-bar');
        const label = this.dashboard.getEl('boundaries-loader-text');
        if (bar) bar.style.width = `${percentage}%`;
        if (label && text) label.textContent = text;
    }

    _hideLoader() {
        const loader = this.dashboard.getEl('settlement-boundaries-loader');
        const title = this.dashboard.getEl('boundaries-loader-title');
        if (loader) loader.classList.remove('active');
        if (title) title.textContent = 'Loading Settlement Boundaries';
    }

    /** Fetch one group file, streaming so the progress bar moves. Cached. */
    async load(group) {
        const file = group.file;
        if (this.features.has(file)) return this.features.get(file);
        if (this.pending.has(file)) return this.pending.get(file);

        const promise = (async () => {
            this.loading++;
            this._showLoader(`${file}...`);
            try {
                const response = await fetch(`${APP_STATIC_URL}/${file}.json`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                let text;
                if (response.body) {
                    const reader = response.body.getReader();
                    const chunks = [];
                    let received = 0;
                    const expected = group.mb * 1e6;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        received += value.length;
                        this._updateLoader(Math.min(99, Math.round(100 * received / expected)),
                            `${file}: ${(received / 1e6).toFixed(1)} MB`);
                    }
                    text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
                } else {
                    text = await response.text();
                }
                this._updateLoader(100, `${file}: parsing...`);
                const features = (JSON.parse(text).features) || [];

                this.features.set(file, features);
                this.indexes.set(file, this._buildIndex(features));
                if (file.startsWith('roads-')) {
                    for (const f of features) {
                        const id = f.properties?.id;
                        if (id && !this.roadById.has(id)) this.roadById.set(id, f);
                    }
                    this.roadGraph = null; // new segments can change routing
                }
                return features;
            } finally {
                this.loading--;
                this.pending.delete(file);
                if (!this.loading) this._hideLoader();
            }
        })();

        this.pending.set(file, promise);
        return promise;
    }

    /** Load every road class file — needed for routing and the km analytics,
     *  which must see the whole network regardless of which boxes are ticked. */
    async loadAllRoads() {
        const groups = LineFeatures.GROUPS.filter(g => LineFeatures.ROAD_CLASS_FILES.includes(g.file));
        await Promise.all(groups.map(g => this.load(g)));
        return groups.flatMap(g => this.features.get(g.file) || []);
    }

    // --- spatial index -----------------------------------------------------

    _lines(feature) {
        const geom = feature.geometry;
        if (!geom) return [];
        if (geom.type === 'LineString') return [geom.coordinates];
        if (geom.type === 'MultiLineString') return geom.coordinates;
        return [];
    }

    /** Per-feature bbox plus a coarse grid of feature indices, so viewport
     *  filtering costs O(features in view) instead of O(whole country). */
    _buildIndex(features) {
        const bboxes = new Float64Array(features.length * 4);
        const cells = new Map();
        const CELL = LineFeatures.CELL_DEG;
        features.forEach((feature, i) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const coords of this._lines(feature)) {
                for (const [x, y] of coords) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            bboxes[i * 4] = minX; bboxes[i * 4 + 1] = minY;
            bboxes[i * 4 + 2] = maxX; bboxes[i * 4 + 3] = maxY;
            if (minX === Infinity) return;
            for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
                for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
                    const key = `${cx},${cy}`;
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(i);
                }
            }
        });
        return { bboxes, cells };
    }

    /** Features of a group whose bbox intersects the padded viewport. */
    visibleFeatures(file) {
        const features = this.features.get(file) || [];
        const index = this.indexes.get(file);
        const map = this.dashboard.map;
        if (!index || !map) return features;

        const b = map.getBounds();
        // Pad generously: leaflet-rotate's bounds are the rotated viewport, and
        // the canvas renderer itself draws a margin outside the view.
        const padX = Math.max(0.05, (b.getEast() - b.getWest()) * 0.25);
        const padY = Math.max(0.05, (b.getNorth() - b.getSouth()) * 0.25);
        const west = b.getWest() - padX, east = b.getEast() + padX;
        const south = b.getSouth() - padY, north = b.getNorth() + padY;

        const CELL = LineFeatures.CELL_DEG;
        const { bboxes, cells } = index;
        const seen = new Set();
        const out = [];
        for (let cx = Math.floor(west / CELL); cx <= Math.floor(east / CELL); cx++) {
            for (let cy = Math.floor(south / CELL); cy <= Math.floor(north / CELL); cy++) {
                for (const i of (cells.get(`${cx},${cy}`) || [])) {
                    if (seen.has(i)) continue;
                    seen.add(i);
                    if (bboxes[i * 4] > east || bboxes[i * 4 + 2] < west) continue;
                    if (bboxes[i * 4 + 1] > north || bboxes[i * 4 + 3] < south) continue;
                    out.push(features[i]);
                }
            }
        }
        return out;
    }

    // --- rendering ---------------------------------------------------------

    renderAll() {
        return Promise.all([this.renderRoads(), this.renderWaterways(), this.renderRailways()]);
    }

    _groupsFor(family) {
        return LineFeatures.GROUPS.filter(g => g.family === family);
    }

    /** Common path: clear the family's layer, then draw each enabled group whose
     *  zoom gate is met. Nothing is fetched for a gated-out or unticked group. */
    async _renderFamily(family, decorate) {
        const dashboard = this.dashboard;
        const { master, layer: layerKey } = LineFeatures.FAMILIES[family];
        const layerGroup = dashboard[layerKey];
        if (!layerGroup) return [];
        layerGroup.clearLayers();
        if (!dashboard.isChecked(master)) return [];

        const zoom = dashboard.map.getZoom();
        const active = this._groupsFor(family).filter(g => dashboard.isChecked(g.id) && zoom >= g.minZoom);
        // One unreachable file shouldn't stop the other groups from drawing.
        await Promise.all(active.map(g => this.load(g).catch(e => {
            console.error(`Error loading ${g.file}:`, e);
        })));

        const drawn = [];
        for (const group of active) {
            // A re-render may have been queued while we awaited the fetch.
            if (!dashboard.isChecked(master) || !dashboard.isChecked(group.id)) continue;
            const features = decorate ? decorate(group, this.visibleFeatures(group.file)) : this.visibleFeatures(group.file);
            if (!features.length) continue;
            const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
                renderer: this.renderer,
                smoothFactor: 1.5,
                style: (feature) => this._styleFor(feature, group),
                onEachFeature: family === 'motor' ? (feature, lyr) => this._attachRoad(feature, lyr, group) : undefined,
            }).addTo(layerGroup);
            drawn.push({ group, layer });
        }
        return drawn;
    }

    async renderRoads() {
        this.layersById.clear();
        const bridgeOn = this.dashboard.isChecked('motorlines-type-bridge');
        // roads-bridge.json is a cross-class subset, so its features also live in
        // the class files. Let the bridge group own them (it draws last, as
        // before) and drop them from the class groups to avoid double geometry.
        const drawn = await this._renderFamily('motor', (group, features) =>
            (bridgeOn && group.file !== 'roads-bridge')
                ? features.filter(f => f.properties?.bridge !== 1)
                : features);
        this._renderHiddenSelection();
        return drawn;
    }

    renderWaterways() {
        return this._renderFamily('water');
    }

    renderRailways() {
        return this._renderFamily('rail');
    }

    _styleFor(feature, group) {
        const style = group.style;
        if (feature.properties?.id && this.dashboard.selectedRoadFeatures.has(feature.properties.id)) {
            return { color: LineFeatures.HIGHLIGHT_COLOR, weight: style.weight + 3 };
        }
        return style;
    }

    _attachRoad(feature, layer, group) {
        const id = feature.properties?.id;
        if (id) {
            if (!this.layersById.has(id)) this.layersById.set(id, []);
            this.layersById.get(id).push(layer);
        }
        layer._lfGroup = group;
        layer.on('click', (e) => this._onRoadClick(feature, e));
    }

    async _onRoadClick(feature, e) {
        const dashboard = this.dashboard;
        const selected = dashboard.selectedRoadFeatures;
        const id = feature.properties?.id;
        const wantsRange = e.originalEvent?.shiftKey
            && dashboard.lastClickedRoadFeature
            && dashboard.lastClickedRoadFeature !== feature;

        if (wantsRange) {
            let path = null;
            try {
                path = await this.findRoadPath(dashboard.lastClickedRoadFeature, feature);
            } catch (e) {
                console.error('Road routing failed:', e);
            }
            if (!path) {
                console.warn('No connected road path found between the selected segments; selecting endpoints only.');
            }
            const startId = dashboard.lastClickedRoadFeature.properties?.id;
            if (startId) selected.add(startId);
            if (id) selected.add(id);
            (path || []).forEach(f => { if (f.properties?.id) selected.add(f.properties.id); });
        } else if (id && selected.has(id)) {
            selected.delete(id);
        } else if (id) {
            selected.add(id);
        }
        dashboard.lastClickedRoadFeature = feature;
        this.refreshRoadSelection();
    }

    /** Restyle in place instead of rebuilding every layer, which is what made
     *  each click re-filter the whole dataset. */
    refreshRoadSelection() {
        for (const layers of this.layersById.values()) {
            for (const layer of layers) {
                layer.setStyle(this._styleFor(layer.feature, layer._lfGroup));
            }
        }
        this._renderHiddenSelection();
    }

    /** A routed selection can include segments whose OSM classification (and
     *  therefore type checkbox, or zoom gate) differs from the rest of the
     *  route. Draw those anyway so the highlighted path stays continuous. */
    _renderHiddenSelection() {
        const dashboard = this.dashboard;
        if (this._selectionLayer) {
            dashboard.featureMotorLayer.removeLayer(this._selectionLayer);
            this._selectionLayer = null;
        }
        if (!dashboard.isChecked('feature-motorlines')) return;
        const hidden = [...dashboard.selectedRoadFeatures]
            .filter(id => !this.layersById.has(id))
            .map(id => this.roadById.get(id))
            .filter(Boolean);
        if (!hidden.length) return;
        this._selectionLayer = L.geoJSON({ type: 'FeatureCollection', features: hidden }, {
            renderer: this.renderer,
            smoothFactor: 1.5,
            style: (feature) => this._styleFor(feature, this._groupForFeature(feature)),
            onEachFeature: (feature, layer) => layer.on('click', (e) => this._onRoadClick(feature, e)),
        }).addTo(dashboard.featureMotorLayer);
    }

    _groupForFeature(feature) {
        const highway = feature.properties?.highway;
        if (feature.properties?.bridge === 1) return LineFeatures.GROUPS.find(g => g.file === 'roads-bridge');
        if (highway === 'motorway' || highway === 'trunk') return LineFeatures.GROUPS.find(g => g.file === 'roads-highway');
        if (highway === 'primary' || highway === 'secondary') return LineFeatures.GROUPS.find(g => g.file === 'roads-primary');
        return LineFeatures.GROUPS.find(g => g.file === 'roads-tertiary');
    }

    clearRoadSelection() {
        this.dashboard.selectedRoadFeatures.clear();
        this.dashboard.lastClickedRoadFeature = null;
        this.refreshRoadSelection();
    }

    // --- road routing ------------------------------------------------------

    _nodeKey([lng, lat]) { return `${lng.toFixed(5)},${lat.toFixed(5)}`; }

    _endpoints(feature) {
        const keys = new Set();
        for (const coords of this._lines(feature)) {
            if (coords.length < 2) continue;
            keys.add(this._nodeKey(coords[0]));
            keys.add(this._nodeKey(coords[coords.length - 1]));
        }
        return keys;
    }

    /** Graph of every road segment, regardless of which type checkboxes are on,
     *  so range-selection can route across road types. */
    async getRoadGraph() {
        if (this.roadGraph) return this.roadGraph;
        const features = await this.loadAllRoads();

        const graph = new Map(); // nodeKey -> [{ to, feature, weight }]
        const addEdge = (a, b, feature, weight) => {
            if (!graph.has(a)) graph.set(a, []);
            graph.get(a).push({ to: b, feature, weight });
        };

        const byRef = new Map();
        const seen = new Set();
        for (const feature of features) {
            const id = feature.properties?.id;
            if (id) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            const ref = feature.properties?.ref;
            for (const coords of this._lines(feature)) {
                if (coords.length < 2) continue;
                const a = this._nodeKey(coords[0]);
                const b = this._nodeKey(coords[coords.length - 1]);
                // properties.len is precomputed on the un-simplified geometry by
                // tools/slim_geodata.py — this used to be a turf.length walk over
                // every vertex of every road in the country. Every road feature
                // is a LineString, so one length per feature is exact.
                const weight = feature.properties?.len ?? 0;
                addEdge(a, b, feature, weight);
                addEdge(b, a, feature, weight);
                if (ref) {
                    if (!byRef.has(ref)) byRef.set(ref, []);
                    byRef.get(ref).push({ coord: coords[0], key: a });
                    byRef.get(ref).push({ coord: coords[coords.length - 1], key: b });
                }
            }
        }

        // Real numbered highways (M-14 etc.) routinely split into separate
        // carriageway ways at bridges/interchanges whose endpoints don't share an
        // exact coordinate — gaps of 10-200 m are common (e.g. twin bridges).
        // Exact-match edges alone leave these disconnected, so same-route
        // endpoints within a small radius get an extra "connector" edge
        // (feature: null, since it isn't a real segment to highlight).
        const SNAP_KM = 0.25;
        const GRID_DEG = 0.01; // ~1 km cells; a 3x3 neighborhood covers the radius
        for (const endpoints of byRef.values()) {
            if (endpoints.length < 2) continue;
            const cellOf = (c) => `${Math.floor(c[0] / GRID_DEG)},${Math.floor(c[1] / GRID_DEG)}`;
            const grid = new Map();
            for (const ep of endpoints) {
                const cell = cellOf(ep.coord);
                if (!grid.has(cell)) grid.set(cell, []);
                grid.get(cell).push(ep);
            }
            for (const ep of endpoints) {
                const [cx, cy] = cellOf(ep.coord).split(',').map(Number);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (const other of (grid.get(`${cx + dx},${cy + dy}`) || [])) {
                            if (other.key === ep.key) continue;
                            const km = LineFeatures.approxKm(ep.coord, other.coord);
                            if (km <= SNAP_KM) addEdge(ep.key, other.key, null, km);
                        }
                    }
                }
            }
        }

        this.roadGraph = graph;
        return graph;
    }

    /** Equirectangular approximation — accurate well under a metre at these
     *  distances, and avoids a turf.distance call per candidate pair. */
    static approxKm([lon1, lat1], [lon2, lat2]) {
        const KM_PER_DEG = 111.32;
        const x = (lon2 - lon1) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
        const y = lat2 - lat1;
        return Math.hypot(x, y) * KM_PER_DEG;
    }

    /**
     * Shortest path (by length) of road features connecting startFeature to
     * endFeature. Returns the intermediate features (excluding start/end), or
     * null if disconnected or if no path is found within maxSearchKm (Ukraine's
     * road network is one big connected graph, so an unbounded search can
     * "succeed" by routing clear across the country when the two clicks aren't
     * actually near the same local road).
     *
     * Search state is (node, arrivedViaSnapConnector) rather than just node, and
     * a snap connector edge (see getRoadGraph) can't be followed immediately by
     * another one. Without this, the search can silently string several ~250 m
     * gap-connectors together into a much larger jump, skipping real
     * intermediate segments that should have been selected instead.
     */
    async findRoadPath(startFeature, endFeature) {
        if (startFeature === endFeature) return [];
        const graph = await this.getRoadGraph();
        const startNodes = this._endpoints(startFeature);
        const endNodes = this._endpoints(endFeature);
        if (!startNodes.size || !endNodes.size) return null;

        const startPoint = this._lines(startFeature)[0]?.[0];
        const endPoint = this._lines(endFeature)[0]?.[0];
        const straightKm = (startPoint && endPoint) ? LineFeatures.approxKm(startPoint, endPoint) : 0;
        const maxSearchKm = Math.min(Math.max(straightKm * 4, 5), 300);

        const dist = new Map();     // stateKey (`${node}|${0|1}`) -> dist
        const prevEdge = new Map(); // stateKey -> { fromState, feature }
        const heap = new MinHeap();
        for (const n of startNodes) {
            const state = `${n}|0`;
            dist.set(state, 0);
            heap.push({ state, node: n, snap: 0, dist: 0 });
        }

        let reachedState = null;
        while (heap.size) {
            const { state, node, snap, dist: d } = heap.pop();
            if (d > maxSearchKm) break; // heap pops in increasing order: nothing shorter remains
            if (d > (dist.get(state) ?? Infinity)) continue;
            if (endNodes.has(node)) { reachedState = state; break; }
            for (const edge of (graph.get(node) || [])) {
                const isSnap = edge.feature === null;
                if (isSnap && snap) continue; // no two snap connectors back to back
                const nextSnap = isSnap ? 1 : 0;
                const nextState = `${edge.to}|${nextSnap}`;
                const nd = d + edge.weight;
                if (nd < (dist.get(nextState) ?? Infinity)) {
                    dist.set(nextState, nd);
                    prevEdge.set(nextState, { fromState: state, feature: edge.feature });
                    heap.push({ state: nextState, node: edge.to, snap: nextSnap, dist: nd });
                }
            }
        }
        if (!reachedState) return null;

        const startStates = new Set([...startNodes].map(n => `${n}|0`));
        const path = [];
        let cur = reachedState;
        while (!startStates.has(cur)) {
            const step = prevEdge.get(cur);
            if (!step) return null;
            if (step.feature) path.push(step.feature); // null = synthetic gap connector, nothing to highlight
            cur = step.fromState;
        }
        return path;
    }
}

/** Binary min-heap keyed by `dist`, used by the Dijkstra search above. */
class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(item) {
        this.items.push(item);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.items[parent].dist <= this.items[i].dist) break;
            [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
            i = parent;
        }
    }
    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length) {
            this.items[0] = last;
            let i = 0;
            while (true) {
                const l = i * 2 + 1, r = i * 2 + 2;
                let smallest = i;
                if (l < this.items.length && this.items[l].dist < this.items[smallest].dist) smallest = l;
                if (r < this.items.length && this.items[r].dist < this.items[smallest].dist) smallest = r;
                if (smallest === i) break;
                [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

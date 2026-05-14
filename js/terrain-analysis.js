class TerrainAnalysis {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.MAPBOX_TOKEN = this.dashboard.mapboxToken;
        this.DEM_ZOOM = 11;
        this.tileCache = new Map();
        this.losMode = null;
        this.p2pPoints = [];
        this._boundClickHandler = null;
        this._losCanvas = null;
        this._losCtx = null;
        this._losShapes = [];
        this._forestEnabled = false;
        this._forestMoveHandler = null;
    }

    // ── Forest layer (Overpass API) ───────────────────────────────────────────

    _forestStyle() {
        return { color: '#228B22', weight: 0.5, opacity: 0.6, fillColor: '#228B22', fillOpacity: 0.3 };
    }

    async _fetchForestData() {
        const map = this.dashboard.map;
        if (map.getZoom() < 9) {
            if (this.dashboard.forestLayer) this.dashboard.forestLayer.clearLayers();
            return;
        }
        const b = map.getBounds();
        const s = b.getSouth().toFixed(5), w = b.getWest().toFixed(5);
        const n = b.getNorth().toFixed(5), e = b.getEast().toFixed(5);
        const query = `[out:json][timeout:25];(way["natural"="wood"](${s},${w},${n},${e});way["landuse"="forest"](${s},${w},${n},${e});relation["natural"="wood"](${s},${w},${n},${e});relation["landuse"="forest"](${s},${w},${n},${e}););out body;>;out skel qt;`;
        try {
            const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
            const data = await res.json();
            const geojson = this._osmToGeoJSON(data);
            if (this.dashboard.forestLayer) {
                this.dashboard.forestLayer.clearLayers();
                this.dashboard.forestLayer.addData(geojson);
                if (window._map3DView) window._map3DView.updateForest3D(true);
            }
        } catch (err) {
            console.warn('Forest fetch failed:', err);
        }
    }

    _osmToGeoJSON(osmData) {
        const nodeMap = {};
        osmData.elements.forEach(el => { if (el.type === 'node') nodeMap[el.id] = [el.lon, el.lat]; });
        const features = [];
        osmData.elements.forEach(el => {
            if (el.type === 'way' && el.nodes) {
                const coords = el.nodes.map(id => nodeMap[id]).filter(Boolean);
                if (coords.length >= 3) {
                    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
                        coords.push(coords[0]);
                    }
                    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: el.tags || {} });
                }
            }
        });
        return { type: 'FeatureCollection', features };
    }

    _initForestLayer() {
        if (this.dashboard.forestLayer) return;
        this.dashboard.forestLayer = L.geoJSON(null, { style: () => this._forestStyle() });
        this._forestMoveHandler = this._debounceForest(() => {
            if (this._forestEnabled) this._fetchForestData();
        }, 600);
        this.dashboard.map.on('moveend zoomend', this._forestMoveHandler);
    }

    _debounceForest(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    toggleForestLayer(enabled) {
        this._forestEnabled = enabled;
        this._initForestLayer();
        if (enabled) {
            if (!this.dashboard.map.hasLayer(this.dashboard.forestLayer)) {
                this.dashboard.forestLayer.addTo(this.dashboard.map);
            }
            this._fetchForestData();
        } else {
            if (this.dashboard.map.hasLayer(this.dashboard.forestLayer)) {
                this.dashboard.map.removeLayer(this.dashboard.forestLayer);
            }
        }
    }

    // ── Canvas overlay ────────────────────────────────────────────────────────

    _initLosCanvas() {
        const mapContainer = this.dashboard.map.getContainer();
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.zIndex = '490';
        canvas.style.pointerEvents = 'none';
        canvas.width = mapContainer.offsetWidth;
        canvas.height = mapContainer.offsetHeight;
        mapContainer.appendChild(canvas);
        this._losCanvas = canvas;
        this._losCtx = canvas.getContext('2d');

        this.dashboard.map.on('move zoom resize', () => this._rerenderLos());

        const resizeObserver = new ResizeObserver(() => {
            canvas.width = mapContainer.offsetWidth;
            canvas.height = mapContainer.offsetHeight;
            this._rerenderLos();
        });
        resizeObserver.observe(mapContainer);
    }

    _rerenderLos() {
        if (!this._losCtx || !this._losCanvas) return;
        const ctx = this._losCtx;
        ctx.clearRect(0, 0, this._losCanvas.width, this._losCanvas.height);
        this._losShapes.forEach(shape => {
            if (shape.type === 'viewshed') {
                shape.visiblePts.forEach(ll => {
                    const pt = this.dashboard.map.latLngToContainerPoint(ll);
                    ctx.fillStyle = 'rgba(0,200,60,0.22)';
                    ctx.fillRect(pt.x - 2, pt.y - 2, 5, 5);
                });
                shape.blockedPts.forEach(ll => {
                    const pt = this.dashboard.map.latLngToContainerPoint(ll);
                    ctx.fillStyle = 'rgba(220,30,30,0.18)';
                    ctx.fillRect(pt.x - 2, pt.y - 2, 5, 5);
                });
            }
        });
    }

    // ── Tile math ─────────────────────────────────────────────────────────────

    _latlngToTile(lat, lng, z) {
        const n = Math.pow(2, z);
        const x = Math.floor((lng + 180) / 360 * n);
        const latR = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
        return { x, y, z };
    }

    _latlngToTilePixel(lat, lng, z, tx, ty) {
        const n = Math.pow(2, z);
        const latR = lat * Math.PI / 180;
        const xPx = ((lng + 180) / 360 * n - tx) * 256;
        const yPx = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n - ty) * 256;
        return {
            px: Math.max(0, Math.min(255, Math.floor(xPx))),
            py: Math.max(0, Math.min(255, Math.floor(yPx)))
        };
    }

    // ── DEM tile fetch + elevation decode ────────────────────────────────────

    async _getTileCanvas(z, x, y) {
        const key = `${z}/${x}/${y}`;
        if (!this.tileCache.has(key)) {
            this.tileCache.set(key, new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = c.height = 256;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = reject;
                // AWS Terrarium tiles — free, no auth, global SRTM coverage
                img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
            }));
        }
        return this.tileCache.get(key);
    }

    async sampleElevation(lat, lng) {
        const { x, y, z } = this._latlngToTile(lat, lng, this.DEM_ZOOM);
        const canvas = await this._getTileCanvas(z, x, y);
        const { px, py } = this._latlngToTilePixel(lat, lng, z, x, y);
        const [R, G, B] = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
        // Terrarium encoding: elevation = (R*256 + G + B/256) - 32768
        return (R * 256 + G + B / 256) - 32768;
    }

    async _prefetchTiles(minLat, maxLat, minLng, maxLng) {
        const z = this.DEM_ZOOM;
        const tl = this._latlngToTile(maxLat, minLng, z);
        const br = this._latlngToTile(minLat, maxLng, z);
        const fetches = [];
        for (let tx = tl.x; tx <= br.x; tx++) {
            for (let ty = tl.y; ty <= br.y; ty++) {
                fetches.push(this._getTileCanvas(z, tx, ty));
            }
        }
        await Promise.all(fetches);
    }

    // ── Forest detection ─────────────────────────────────────────────────────

    _getForestFeatures() {
        if (!this.dashboard.forestLayer) return [];
        const features = [];
        this.dashboard.forestLayer.eachLayer(layer => {
            if (layer.feature) features.push(layer.feature);
        });
        return features;
    }

    _isForested(lat, lng, forestFeatures) {
        if (!forestFeatures.length) return false;
        const pt = turf.point([lng, lat]);
        return forestFeatures.some(f => {
            try { return turf.booleanPointInPolygon(pt, f); }
            catch (e) { return false; }
        });
    }

    // ── P2P LoS ───────────────────────────────────────────────────────────────

    async computeP2P(ll1, ll2) {
        const observerH = parseFloat(document.getElementById('los-observer-height')?.value) || 2;
        const targetH   = parseFloat(document.getElementById('los-target-height')?.value)   || 0;
        const treeBonus = document.getElementById('los-tree-bonus')?.checked ? 15 : 0;
        const STEP_M    = 60;

        const p1 = turf.point([ll1.lng, ll1.lat]);
        const p2 = turf.point([ll2.lng, ll2.lat]);
        const dist = turf.distance(p1, p2, { units: 'meters' });
        const bearing = turf.bearing(p1, p2);
        const steps = Math.max(2, Math.ceil(dist / STEP_M));

        const points = [];
        for (let i = 0; i <= steps; i++) {
            const frac = i / steps;
            const pt = turf.destination(p1, dist * frac / 1000, bearing, { units: 'kilometers' });
            points.push({ latlng: L.latLng(pt.geometry.coordinates[1], pt.geometry.coordinates[0]), frac });
        }

        // Pre-fetch all needed tiles
        const lats = points.map(p => p.latlng.lat);
        const lngs = points.map(p => p.latlng.lng);
        await this._prefetchTiles(Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs));

        const forestFeatures = treeBonus ? this._getForestFeatures() : [];
        const elevs = await Promise.all(points.map(async ({ latlng }) => {
            const e = await this.sampleElevation(latlng.lat, latlng.lng);
            const bonus = (treeBonus && this._isForested(latlng.lat, latlng.lng, forestFeatures)) ? treeBonus : 0;
            return e + bonus;
        }));

        const observerElev = (await this.sampleElevation(ll1.lat, ll1.lng)) + observerH;
        const targetElev   = (await this.sampleElevation(ll2.lat, ll2.lng)) + targetH;
        let maxSlope = -Infinity;
        const segments = [];

        for (let i = 1; i <= steps; i++) {
            const d = points[i].frac * dist;
            const curvature = (d * d) / (2 * 6371000);
            const groundH = elevs[i] - curvature;
            const slope = (groundH - observerElev) / d;
            const visible = slope >= maxSlope;
            maxSlope = Math.max(maxSlope, slope);
            segments.push({ from: points[i - 1].latlng, to: points[i].latlng, visible });
        }

        return { segments, dist };
    }

    renderP2PResult(result) {
        result.segments.forEach(seg => {
            L.polyline([seg.from, seg.to], {
                color: seg.visible ? '#00cc44' : '#ee1111',
                weight: 4,
                opacity: 0.85
            }).addTo(this.dashboard.losLayer);
        });
    }

    // ── Viewshed ──────────────────────────────────────────────────────────────

    async computeViewshed(observerLatlng) {
        const observerH = parseFloat(document.getElementById('los-observer-height')?.value) || 2;
        const radiusKm  = parseFloat(document.getElementById('los-radius')?.value) || 5;
        const treeBonus = document.getElementById('los-tree-bonus')?.checked ? 15 : 0;
        const RAY_COUNT = 72;
        const STEP_M    = 60;
        const steps     = Math.ceil(radiusKm * 1000 / STEP_M);

        // Bounding box for tile pre-fetch
        const R = 6371;
        const dLat = (radiusKm / R) * (180 / Math.PI);
        const dLng = dLat / Math.cos(observerLatlng.lat * Math.PI / 180);
        await this._prefetchTiles(
            observerLatlng.lat - dLat, observerLatlng.lat + dLat,
            observerLatlng.lng - dLng, observerLatlng.lng + dLng
        );

        const observerElev = await this.sampleElevation(observerLatlng.lat, observerLatlng.lng) + observerH;
        const forestFeatures = treeBonus ? this._getForestFeatures() : [];
        const visiblePts = [];
        const blockedPts = [];
        const origin = turf.point([observerLatlng.lng, observerLatlng.lat]);

        for (let r = 0; r < RAY_COUNT; r++) {
            const bearing = (r / RAY_COUNT) * 360;
            let maxSlope  = -Infinity;

            for (let s = 1; s <= steps; s++) {
                const d   = s * STEP_M;
                const pt  = turf.destination(origin, d / 1000, bearing, { units: 'kilometers' });
                const ll  = L.latLng(pt.geometry.coordinates[1], pt.geometry.coordinates[0]);
                let elev  = await this.sampleElevation(ll.lat, ll.lng);
                if (treeBonus && this._isForested(ll.lat, ll.lng, forestFeatures)) elev += treeBonus;
                const curvature = (d * d) / (2 * 6371000);
                const slope = (elev - curvature - observerElev) / d;

                if (slope >= maxSlope) {
                    maxSlope = slope;
                    visiblePts.push(ll);
                } else {
                    blockedPts.push(ll);
                }
            }
        }

        return { visiblePts, blockedPts };
    }

    renderViewshedResult(result) {
        this._losShapes = [{ type: 'viewshed', ...result }];
        this._rerenderLos();
    }

    // ── Click handler ─────────────────────────────────────────────────────────

    _losClickHandler(e) {
        if (!this.losMode) return;
        const latlng = e.latlng;

        L.circleMarker(latlng, {
            radius: 5,
            color: '#fff',
            fillColor: this.losMode === 'p2p' ? '#3b82f6' : '#f59e0b',
            fillOpacity: 1,
            weight: 2
        }).addTo(this.dashboard.losLayer);

        if (this.losMode === 'p2p') {
            this.p2pPoints.push(latlng);
            const hint = document.getElementById('los-hint');
            if (this.p2pPoints.length === 1) {
                if (hint) hint.textContent = 'Click target point...';
            } else if (this.p2pPoints.length >= 2) {
                if (hint) hint.textContent = 'Computing...';
                this._runP2P();
            }
        } else if (this.losMode === 'viewshed') {
            const hint = document.getElementById('los-hint');
            if (hint) hint.textContent = 'Computing viewshed...';
            this._runViewshed(latlng);
        }
    }

    async _runP2P() {
        const [p1, p2] = this.p2pPoints;
        this.p2pPoints = [];
        try {
            const result = await this.computeP2P(p1, p2);
            this.renderP2PResult(result);
            const hint = document.getElementById('los-hint');
            if (hint) hint.textContent = `Distance: ${(result.dist / 1000).toFixed(2)} km — click to run again`;
        } catch (err) {
            console.error('LoS P2P error:', err);
            const hint = document.getElementById('los-hint');
            if (hint) hint.textContent = 'Error sampling elevation. Check console.';
        }
    }

    async _runViewshed(latlng) {
        try {
            const result = await this.computeViewshed(latlng);
            this.renderViewshedResult(result);
            const hint = document.getElementById('los-hint');
            if (hint) hint.textContent = `Visible: ${result.visiblePts.length} pts — click to run again`;
        } catch (err) {
            console.error('Viewshed error:', err);
            const hint = document.getElementById('los-hint');
            if (hint) hint.textContent = 'Error computing viewshed. Check console.';
        }
    }

    // ── Mode management ───────────────────────────────────────────────────────

    enableMode(mode) {
        this.disableMode();
        this.losMode = mode;
        this.p2pPoints = [];
        this._boundClickHandler = this._losClickHandler.bind(this);
        this.dashboard.map.on('click', this._boundClickHandler);
        this.dashboard.map.getContainer().style.cursor = 'crosshair';

        const hint = document.getElementById('los-hint');
        if (hint) { hint.style.display = 'block'; hint.textContent = 'Click observer point...'; }

        const radiusRow = document.getElementById('los-radius-row');
        if (radiusRow) radiusRow.style.display = mode === 'viewshed' ? '' : 'none';
        const targetRow = document.getElementById('los-target-height-row');
        if (targetRow) targetRow.style.display = mode === 'p2p' ? '' : 'none';
    }

    disableMode() {
        if (this._boundClickHandler) {
            this.dashboard.map.off('click', this._boundClickHandler);
            this._boundClickHandler = null;
        }
        this.dashboard.map.getContainer().style.cursor = '';
        this.losMode = null;
        this.p2pPoints = [];
        const hint = document.getElementById('los-hint');
        if (hint) hint.style.display = 'none';
    }

    clearLos() {
        if (this.dashboard.losLayer) this.dashboard.losLayer.clearLayers();
        this._losShapes = [];
        if (this._losCtx && this._losCanvas) {
            this._losCtx.clearRect(0, 0, this._losCanvas.width, this._losCanvas.height);
        }
    }
}

window.TerrainAnalysis = TerrainAnalysis;

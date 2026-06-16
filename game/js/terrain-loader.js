'use strict';
// ── terrain-loader.js — OSM terrain classification + elevation ────────────
// Queries Overpass API for the bbox, classifies each hex, then falls back
// to deterministic pseudo-random terrain if API fails.

class TerrainLoader {

    // Main entry: classify all hexes in a HexBoard using OSM data.
    // Returns Map<hexId, terrainData> and mutates board.hexes in place.
    async classifyAll(board, opts = {}) {
        const [minLng, minLat, maxLng, maxLat] = board.bbox;
        const statusEl = document.getElementById('setup-status');
        if (statusEl && !opts.forceProcedural) statusEl.textContent = 'Loading terrain from OSM…';

        let osmData = null;
        if (!opts.forceProcedural) {
            try {
                osmData = await this._fetchOverpass(minLat, minLng, maxLat, maxLng);
            } catch (e) {
                console.warn('Overpass fetch failed, using procedural terrain:', e.message);
            }
        }

        // Random per-board noise phase — without it the fixed-coefficient noise
        // always clusters settlements toward the north-east (one side's rear)
        this._noisePhase = [Math.random() * 6.283, Math.random() * 6.283];

        board.hexes.forEach((hex, hexId) => {
            const [lng, lat] = hex.centroid;
            if (osmData) {
                this._classifyFromOSM(hex, lat, lng, osmData);
            } else {
                this._classifyProcedural(hex, board.centerLat, board.centerLng);
            }
        });

        // Mark road junctions as objectives
        this._flagRoadJunctions(board);
        // Mark bridge hexes
        this._flagBridges(board, osmData);
        // Guarantee contested objectives spread across the middle of the map
        this._ensureSpreadObjectives(board);

        if (statusEl) statusEl.textContent = 'Terrain ready.';
        return board.hexes;
    }

    // ── Real frontline classification ────────────────────────────────────────
    // Splits the board into 'ua' / 'ru' sides using the territory-control
    // GeoJSON (same Flask endpoint as the main app). Falls back to a synthetic
    // front when data is unavailable or the board lies too deep in one rear.
    // Cached territory-control GeoJSON (yesterday's date — today may not exist)
    static async fetchControlGeo() {
        if (TerrainLoader._controlGeo) return TerrainLoader._controlGeo;
        const dateStr = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
        const res = await fetch(
            `https://flask-app-kibakefmpq-ew.a.run.app/geojson-by-date?date=${dateStr}`,
            { signal: AbortSignal.timeout(15000) }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        TerrainLoader._controlGeo = await res.json();
        return TerrainLoader._controlGeo;
    }

    async classifyFront(board, opts = {}) {
        const statusEl = document.getElementById('setup-status');
        let assigned = false;
        board.frontNote = null;

        if (!opts.forceProcedural) {
            try {
                if (statusEl) statusEl.textContent = 'Loading real frontline…';
                assigned = this._applyControlPolygons(board, await TerrainLoader.fetchControlGeo());
                if (!assigned) {
                    board.frontNote = 'Point lies deep inside one side\'s territory — using a synthetic front. Try "Random Frontline Point".';
                }
            } catch (e) {
                console.warn('Frontline fetch failed, using synthetic front:', e.message);
                board.frontNote = 'Frontline data unavailable — using a synthetic front.';
            }
        }

        if (!assigned) this._syntheticFront(board);

        // Frontline hexes: any hex with an opposite-side neighbour
        board.hexes.forEach(h => {
            h.isFrontline = h.neighbours.some(nid => {
                const n = board.hexes.get(nid);
                return n && n.side !== h.side;
            });
        });
    }

    _applyControlPolygons(board, geo) {
        const OCCUPIED_FILLS = new Set(['#a52714', '#880e4f']);
        const [minX, minY, maxX, maxY] = board.bbox;

        const polys = (geo.features || []).filter(f => {
            if (f.geometry?.type !== 'Polygon' || !OCCUPIED_FILLS.has(f.properties?.fill)) return false;
            const b = turf.bbox(f);
            return b[0] <= maxX && b[2] >= minX && b[1] <= maxY && b[3] >= minY;
        });
        if (!polys.length) return false;

        let union = polys[0];
        for (let i = 1; i < polys.length; i++) {
            try { union = turf.union(union, polys[i]); } catch (e) { /* skip bad geometry */ }
        }
        let simple = union;
        try { simple = turf.simplify(union, { tolerance: 0.01, highQuality: false }); } catch (e) {}

        let ru = 0, ua = 0;
        board.hexes.forEach(h => {
            h.side = turf.booleanPointInPolygon(turf.point(h.centroid), simple) ? 'ru' : 'ua';
            if (h.side === 'ru') ru++; else ua++;
        });

        // Board too one-sided (point deep in a rear) — let the fallback split it
        if (ru < 20 || ua < 20) return false;

        // Render only the control BOUNDARY crossing the board — clip the line
        // (not the polygon, which would close along the bbox and draw a frame).
        try {
            board.frontGeo = turf.bboxClip(turf.polygonToLine(simple), board.bbox);
        } catch (e) { board.frontGeo = null; }
        return true;
    }

    // Synthetic front: latitude split with a sine wiggle (RU north, UA south).
    // Split at the MEDIAN hex latitude so both sides get equal hex counts —
    // splitting at centerLat skews ~10 hexes to one side (grid row alignment).
    _syntheticFront(board) {
        const lats = [...board.hexes.values()].map(h => h.centroid[1]).sort((a, b) => a - b);
        const median = lats[Math.floor(lats.length / 2)];
        board.hexes.forEach(h => {
            const [lng, lat] = h.centroid;
            h.side = lat > median + 0.02 * Math.sin(lng * 90) ? 'ru' : 'ua';
        });
        board.frontGeo = null;
    }

    // ── Overpass query ───────────────────────────────────────────────────────

    async _fetchOverpass(s, w, n, e) {
        const query = `[out:json][timeout:20];(
  way["natural"="wood"](${s},${w},${n},${e});
  way["landuse"="forest"](${s},${w},${n},${e});
  relation["natural"="wood"](${s},${w},${n},${e});
  way["landuse"="residential"](${s},${w},${n},${e});
  way["place"~"village|town|city"](${s},${w},${n},${e});
  node["place"~"village|town|city"](${s},${w},${n},${e});
  way["landuse"="industrial"](${s},${w},${n},${e});
  way["natural"="wetland"](${s},${w},${n},${e});
  way["waterway"~"river|stream|canal"](${s},${w},${n},${e});
  way["highway"~"motorway|trunk|primary|secondary|tertiary"](${s},${w},${n},${e});
  way["bridge"="yes"](${s},${w},${n},${e});
);out body;>;out skel qt;`;

        const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(22000) });
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        return res.json();
    }

    // ── OSM-based classification ─────────────────────────────────────────────

    // Build (once, cached on osmData) the geometry we test each hex against:
    //  - area features (settlement/forest/industrial/wetland) as real polygons
    //    for point-in-polygon — NOT bounding boxes (a 15 km urban area's bbox
    //    would otherwise mark the whole board as a settlement).
    //  - line features (road/river/bridge) kept as vertex lists for proximity.
    _buildAreas(osmData) {
        if (osmData._areas) return osmData._areas;
        const nodes = {};
        osmData.elements.forEach(el => { if (el.type === 'node') nodes[el.id] = el; });

        const cats = { settlement: [], forest: [], industrial: [], wetland: [] };
        const placeNodes = [];
        const lines = [];

        osmData.elements.forEach(el => {
            const t = el.tags || {};
            if (el.type === 'node') { if (t.place) placeNodes.push(el); return; }
            if (el.type !== 'way' || !el.nodes) return;
            const coords = el.nodes.map(id => nodes[id]).filter(Boolean).map(n => [n.lon, n.lat]);
            if (coords.length < 2) return;
            const bbox = this._coordsBbox(coords);

            const isArea = t.landuse === 'residential' || t.place || t.natural === 'wood' ||
                           t.landuse === 'forest' || t.landuse === 'industrial' || t.natural === 'wetland';
            if (isArea && coords.length >= 3) {
                const ring = coords.slice();
                const a = ring[0], b = ring[ring.length - 1];
                if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
                let poly = null;
                try { poly = turf.polygon([ring]); } catch (e) { /* malformed ring */ }
                if (poly) {
                    const entry = { poly, bbox };
                    if (t.landuse === 'residential' || t.place) cats.settlement.push(entry);
                    else if (t.natural === 'wood' || t.landuse === 'forest') cats.forest.push(entry);
                    else if (t.landuse === 'industrial') cats.industrial.push(entry);
                    else if (t.natural === 'wetland') cats.wetland.push(entry);
                }
            }
            if (t.highway) lines.push({ type: 'road', bbox, coords });
            if (t.waterway === 'river' || t.waterway === 'canal') lines.push({ type: 'river', bbox, coords });
            if (t.bridge === 'yes') lines.push({ type: 'bridge', bbox, coords });
        });

        osmData._areas = { cats, placeNodes, lines };
        return osmData._areas;
    }

    _coordsBbox(coords) {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const [x, y] of coords) {
            if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
            if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
        }
        return [minLng, minLat, maxLng, maxLat];
    }

    _classifyFromOSM(hex, lat, lng, osmData) {
        const A = this._buildAreas(osmData);
        const pt = turf.point([lng, lat]);
        const inArea = entries => entries.some(e =>
            lng >= e.bbox[0] && lng <= e.bbox[2] && lat >= e.bbox[1] && lat <= e.bbox[3] &&
            turf.booleanPointInPolygon(pt, e.poly));

        // Settlement: inside a residential/place polygon, or near a place node
        const NODE_R2 = 0.008 ** 2; // ~0.9 km
        const settled = inArea(A.cats.settlement) ||
            A.placeNodes.some(n => (lng - n.lon) ** 2 + (lat - n.lat) ** 2 < NODE_R2);
        const industrial = inArea(A.cats.industrial);
        const wetland = inArea(A.cats.wetland);
        const forest = inArea(A.cats.forest);

        // Line features: a road/river vertex passing within ~1 km of this hex
        const LINE_R2 = 0.009 ** 2;
        const pad = 0.009;
        let hasRoad = false, hasRiver = false;
        for (const l of A.lines) {
            if (lng < l.bbox[0] - pad || lng > l.bbox[2] + pad ||
                lat < l.bbox[1] - pad || lat > l.bbox[3] + pad) continue;
            const near = l.coords.some(c => (c[0] - lng) ** 2 + (c[1] - lat) ** 2 < LINE_R2);
            if (!near) continue;
            if (l.type === 'road') hasRoad = true;
            else if (l.type === 'river') hasRiver = true;
            else if (l.type === 'bridge') { hex.hasBridge = true; hex.overlays.add('bridge'); }
        }

        hex.hasRoad = hasRoad;
        hex.hasRiver = hasRiver;
        if (hasRoad) hex.overlays.add('road_paved');
        if (hasRiver) hex.overlays.add('river_minor');

        // Terrain only — objectives are assigned scarcely in _ensureSpreadObjectives
        if (settled) hex.terrainType = 'settlement_s1';
        else if (industrial) hex.terrainType = 'industrial';
        else if (wetland) hex.terrainType = 'wetland';
        else if (forest) hex.terrainType = 'forest_light';
        else hex.terrainType = 'open';
    }

    // ── Procedural fallback ───────────────────────────────────────────────────

    _classifyProcedural(hex, centerLat, centerLng) {
        const [lng, lat] = hex.centroid;
        // Deterministic noise from position
        const nx = (lng - centerLng) * 7.3;
        const ny = (lat - centerLat) * 9.1;
        const [p1, p2] = this._noisePhase || [0, 0];
        const n1 = Math.sin(nx * 1.7 + ny * 2.3 + p1) * 0.5 + 0.5;
        const n2 = Math.sin(nx * 3.1 - ny * 1.9 + p2) * 0.5 + 0.5;
        const v = (n1 + n2) / 2;

        if (v > 0.82) {
            hex.terrainType = 'settlement_s1'; // objective assigned later, scarcely
        } else if (v > 0.68) {
            hex.terrainType = 'forest_light';
        } else if (v > 0.58) {
            hex.terrainType = 'forest_dense';
        } else if (v > 0.48) {
            hex.terrainType = 'ridgeline';
        } else if (v > 0.40) {
            hex.terrainType = 'agricultural';
        } else {
            hex.terrainType = 'open';
        }

        // Roads along roughly horizontal bands
        if (Math.abs(Math.sin(lat * 110)) > 0.85) {
            hex.hasRoad = true;
            hex.overlays.add('road_paved');
        }
        // Rivers along roughly vertical bands
        if (Math.abs(Math.sin(lng * 80)) > 0.92) {
            hex.hasRiver = true;
            hex.overlays.add('river_minor');
        }
    }

    // Mark road junctions as a feature (not an objective — _ensureSpreadObjectives
    // decides which features become VP objectives).
    _flagRoadJunctions(board) {
        board.hexes.forEach((hex, hexId) => {
            if (!hex.hasRoad) return;
            const roadNeighbours = hex.neighbours.filter(nid => board.hexes.get(nid)?.hasRoad);
            if (roadNeighbours.length >= 3) hex.isRoadJunction = true;
        });
    }

    // Sole authority on VP objectives: pick a SCARCE, well-spread set (~5) of
    // real terrain features across the contested middle, so holding ground means
    // something. Settlement *terrain* keeps its DEF/cover benefit either way.
    _ensureSpreadObjectives(board) {
        const hexList = [...board.hexes.values()];
        const lats = hexList.map(h => h.centroid[1]);
        const minLat = Math.min(...lats), latRange = Math.max(...lats) - minLat || 1;

        const featureScore = h =>
            h.hasBridge ? 4 :
            h.terrainType && h.terrainType.startsWith('settlement') ? 3 :
            h.isRoadJunction ? 2 :
            h.terrainType === 'ridgeline' || h.terrainType === 'industrial' ? 1 : 0;

        const central = h => { const nl = (h.centroid[1] - minLat) / latRange; return nl > 0.15 && nl < 0.85; };
        let cands = hexList.filter(h => central(h) && featureScore(h) > 0);
        if (cands.length < 3) cands = hexList.filter(central); // sparse map fallback
        if (!cands.length) return;

        const TARGET = Math.min(5, cands.length);
        const d2 = (a, b) => (a.centroid[0] - b.centroid[0]) ** 2 + (a.centroid[1] - b.centroid[1]) ** 2;

        // Seed with the highest-value, most central feature
        const cLng = (Math.min(...hexList.map(h => h.centroid[0])) + Math.max(...hexList.map(h => h.centroid[0]))) / 2;
        const cLat = minLat + latRange / 2;
        cands.sort((a, b) => featureScore(b) - featureScore(a) ||
            ((a.centroid[0] - cLng) ** 2 + (a.centroid[1] - cLat) ** 2) - ((b.centroid[0] - cLng) ** 2 + (b.centroid[1] - cLat) ** 2));
        const chosen = [cands[0]];

        // Greedy farthest-point spread, lightly weighted by feature value
        while (chosen.length < TARGET) {
            let best = null, bestScore = -Infinity;
            for (const c of cands) {
                if (chosen.includes(c)) continue;
                const sep = Math.min(...chosen.map(s => d2(c, s)));
                const score = sep + featureScore(c) * 1e-4;
                if (score > bestScore) { bestScore = score; best = c; }
            }
            if (!best) break;
            chosen.push(best);
        }

        chosen.forEach(h => {
            h.isObjective = true;
            h.objectiveType = h.hasBridge ? 'bridge'
                : (h.terrainType && h.terrainType.startsWith('settlement')) ? 'settlement_s1'
                : h.isRoadJunction ? 'road_junction'
                : 'key_position';
        });
    }

    _flagBridges(board, osmData) {
        if (!osmData) return;
        // A bridge cancels the river crossing penalty; it stays a candidate
        // feature for objective selection but isn't auto-promoted here.
        board.hexes.forEach(hex => {
            if (hex.hasBridge && hex.overlays.has('river_minor')) {
                hex.overlays.delete('river_minor');
                hex.overlays.delete('river_major');
            }
        });
    }
}

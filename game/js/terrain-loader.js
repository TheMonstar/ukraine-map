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

    _classifyFromOSM(hex, lat, lng, osmData) {
        const nodes = {};
        const ways = {};
        osmData.elements.forEach(el => {
            if (el.type === 'node') nodes[el.id] = el;
            if (el.type === 'way') ways[el.id] = el;
        });

        // Build way polygons for PIP test (simplified)
        const check = (tags, keys) => keys.some(k => tags && tags[k]);

        let settled = false;
        let forest = false;
        let industrial = false;
        let wetland = false;
        let hasRoad = false;
        let hasRiver = false;

        // Use bounding box intersection heuristic: if way bbox overlaps hex centroid ±0.015°
        osmData.elements.forEach(el => {
            if (el.type !== 'way' || !el.nodes) return;
            const nodeCoords = el.nodes.map(id => nodes[id]).filter(Boolean);
            if (nodeCoords.length < 2) return;

            const lats = nodeCoords.map(n => n.lat);
            const lngs = nodeCoords.map(n => n.lon);
            const minLat = Math.min(...lats), maxLat = Math.max(...lats);
            const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
            const pad = 0.012; // ~1.2km buffer for hex overlap

            if (lat < minLat - pad || lat > maxLat + pad || lng < minLng - pad || lng > maxLng + pad) return;

            const t = el.tags || {};
            if (t.natural === 'wood' || t.landuse === 'forest') forest = true;
            // Settlements: no pad — centroid must fall inside the residential
            // area itself, otherwise villages smear across neighbouring hexes
            const inBbox = lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
            if ((t.landuse === 'residential' || t.place) && inBbox) settled = true;
            if (t.landuse === 'industrial') industrial = true;
            if (t.natural === 'wetland') wetland = true;
            if (t.waterway === 'river' || t.waterway === 'canal') hasRiver = true;
            if (t.waterway === 'stream') hasRiver = hasRiver; // only major
            if (t.highway) hasRoad = true;
            if (t.bridge === 'yes') { hex.hasBridge = true; hex.overlays.add('bridge'); }
        });

        // Check settlement nodes
        osmData.elements.forEach(el => {
            if (el.type !== 'node') return;
            if (!el.tags?.place) return;
            const d = Math.sqrt((el.lat - lat) ** 2 + (el.lon - lng) ** 2);
            if (d < 0.012) settled = true;
        });

        // Classify
        hex.hasRoad = hasRoad;
        hex.hasRiver = hasRiver;
        if (hasRoad) hex.overlays.add('road_paved');
        if (hasRiver) {
            hex.overlays.add('river_minor');
        }

        if (settled) {
            hex.terrainType = 'settlement_s1';
            hex.isObjective = true;
            hex.objectiveType = 'settlement_s1';
        } else if (industrial) {
            hex.terrainType = 'industrial';
        } else if (wetland) {
            hex.terrainType = 'wetland';
        } else if (forest) {
            hex.terrainType = 'forest_light';
        } else {
            hex.terrainType = 'open';
        }
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
            hex.terrainType = 'settlement_s1';
            hex.isObjective = true;
            hex.objectiveType = 'settlement_s1';
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

    _flagRoadJunctions(board) {
        board.hexes.forEach((hex, hexId) => {
            if (!hex.hasRoad) return;
            const roadNeighbours = hex.neighbours.filter(nid => board.hexes.get(nid)?.hasRoad);
            if (roadNeighbours.length >= 3) {
                hex.isObjective = true;
                hex.objectiveType = hex.objectiveType || 'road_junction';
            }
        });
    }

    // Ensure each longitudinal third of the contested middle band (between the
    // spawn zones) holds at least one objective, so fronts form in several places.
    _ensureSpreadObjectives(board) {
        const hexList = [...board.hexes.values()];
        const lats = hexList.map(h => h.centroid[1]);
        const lngs = hexList.map(h => h.centroid[0]);
        const minLat = Math.min(...lats), latRange = Math.max(...lats) - minLat;
        const minLng = Math.min(...lngs), lngRange = Math.max(...lngs) - minLng;

        for (let third = 0; third < 3; third++) {
            const inSector = hexList.filter(h => {
                const normLat = (h.centroid[1] - minLat) / latRange;
                const normLng = (h.centroid[0] - minLng) / lngRange;
                return normLat > 0.25 && normLat < 0.75 &&
                       normLng >= third / 3 && normLng < (third + 1) / 3;
            });
            if (!inSector.length || inSector.some(h => h.isObjective)) continue;

            // Promote the most defensible/valuable hex: settlement > road > central
            const pick = inSector.find(h => h.terrainType.startsWith('settlement')) ||
                         inSector.find(h => h.hasRoad) ||
                         inSector[Math.floor(inSector.length / 2)];
            pick.isObjective = true;
            pick.objectiveType = 'key_position';
        }
    }

    _flagBridges(board, osmData) {
        if (!osmData) return;
        // Already flagged per-hex during OSM pass; just ensure river hexes with bridge
        // are correctly marked
        board.hexes.forEach(hex => {
            if (hex.hasBridge && hex.overlays.has('river_minor')) {
                hex.isObjective = true;
                hex.objectiveType = hex.objectiveType || 'bridge';
                hex.overlays.delete('river_minor'); // bridge removes river penalty
                hex.overlays.delete('river_major');
            }
        });
    }
}

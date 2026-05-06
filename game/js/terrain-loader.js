'use strict';
// ── terrain-loader.js — OSM terrain classification + elevation ────────────
// Queries Overpass API for the bbox, classifies each hex, then falls back
// to deterministic pseudo-random terrain if API fails.

class TerrainLoader {

    // Main entry: classify all hexes in a HexBoard using OSM data.
    // Returns Map<hexId, terrainData> and mutates board.hexes in place.
    async classifyAll(board) {
        const [minLng, minLat, maxLng, maxLat] = board.bbox;
        const statusEl = document.getElementById('setup-status');
        if (statusEl) statusEl.textContent = 'Loading terrain from OSM…';

        let osmData = null;
        try {
            osmData = await this._fetchOverpass(minLat, minLng, maxLat, maxLng);
        } catch (e) {
            console.warn('Overpass fetch failed, using procedural terrain:', e.message);
        }

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

        if (statusEl) statusEl.textContent = 'Terrain ready.';
        return board.hexes;
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
            if (t.landuse === 'residential' || t.place) settled = true;
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
            if (d < 0.025) settled = true;
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
        const n1 = Math.sin(nx * 1.7 + ny * 2.3) * 0.5 + 0.5;
        const n2 = Math.sin(nx * 3.1 - ny * 1.9) * 0.5 + 0.5;
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

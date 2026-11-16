#!/usr/bin/env node
// Build the static field pack for Capture Mala Tokmachka: everything the 3D viewer
// would otherwise fetch live for the game's fixed frame, so the game page loads
// without Overpass or the live layers.
//
//   node scripts/capture-field.mjs --footprints <microsoft-buildings.geojson>
//
// Writes data/capture/field/heights.bin (the viewer's 257×257 heightmap, Int16
// decimetres, row-major north→south) and data/capture/field/field.json (OSM woods,
// water and fields from the viewer's own Overpass query, the roads from the viewer's
// own road files plus the village lanes from the game's street graph, and Microsoft
// building footprints as the buildings: OSM has only ~50 here). Satellite imagery is not packed: its providers' terms don't allow
// re-hosting, and it streams quickly anyway.
//
// Uses the viewer's own loaders (js/3d/data-sources.js) so the pack matches what the
// live viewer would build. Run it again if the preset frame or GRID_SEGMENTS change.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'capture', 'field');
const GRID_SEGMENTS = 256;                  // js/3d/terrain.js on main
const DEM_ZOOM = 14;

const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
};
const footprintsPath = arg('footprints');
if (!footprintsPath) {
    console.error('usage: node scripts/capture-field.mjs --footprints <microsoft-buildings.geojson>');
    process.exit(2);
}

// the viewer's loaders, made to run in node
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
    const headers = { 'User-Agent': 'map-tools/1.0', ...(opts.headers || {}) };
    const res = await nodeFetch(url, { ...opts, headers });
    // Overpass is often at capacity: the French mirror as a last resort
    if (!res.ok && /overpass/.test(String(url))) {
        const q = new URL(url).searchParams.get('data');
        return nodeFetch('https://overpass.openstreetmap.fr/api/interpreter', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ data: q }),
        });
    }
    return res;
};
const { MALA_TOKMACHKA } = await import('../js/3d/capture/mala-tokmachka.js');
const { makeProjection, latLngToTileFraction } = await import('../js/3d/geo.js');
const { fetchMapFeatures, fetchRoads } = await import('../js/3d/data-sources.js');

const { lat, lng, size } = MALA_TOKMACHKA.frame;
const SCENE_SIZE = size * 1000 + 1000;      // setSceneSize() in js/3d/terrain.js
const SCENE_HALF = SCENE_SIZE / 2;
const GRID_SIZE = GRID_SEGMENTS + 1;
const proj = makeProjection(lat, lng);
const bbox = proj.bbox(SCENE_HALF);

// ── PNG (Terrarium tiles: 8-bit RGB/RGBA, not interlaced) ───────────────────
function decodePng(buf) {
    let pos = 8, width = 0, height = 0, channels = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
            channels = { 2: 3, 6: 4 }[data[9]];
            if (!channels) throw new Error(`unsupported PNG colour type ${data[9]}`);
        } else if (type === 'IDAT') {
            idat.push(data);
        }
        pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
            let v = line[i];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            cur[i] = v & 255;
        }
        for (let x = 0; x < width; x++) {
            for (let k = 0; k < 3; k++) out[(y * width + x) * 4 + k] = cur[x * channels + k];
            out[(y * width + x) * 4 + 3] = 255;
        }
        prev.set(cur);
    }
    return { width, height, data: out };
}

// ── heights: the same sampling as TerrainBuilder._buildHeightmap ────────────
async function buildHeights() {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const corners = [[minLat, minLng], [minLat, maxLng], [maxLat, minLng], [maxLat, maxLng]]
        .map(([a, b]) => latLngToTileFraction(a, b, DEM_ZOOM));
    const range = {
        txMin: Math.floor(Math.min(...corners.map(c => c.fx))), txMax: Math.floor(Math.max(...corners.map(c => c.fx))),
        tyMin: Math.floor(Math.min(...corners.map(c => c.fy))), tyMax: Math.floor(Math.max(...corners.map(c => c.fy))),
    };
    const cols = range.txMax - range.txMin + 1, rows = range.tyMax - range.tyMin + 1;
    const W = cols * 256, H = rows * 256;
    const mosaic = new Uint8Array(W * H * 4);
    for (let ty = range.tyMin; ty <= range.tyMax; ty++) {
        for (let tx = range.txMin; tx <= range.txMax; tx++) {
            const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${tx}/${ty}.png`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${res.status} ${url}`);
            const png = decodePng(Buffer.from(await res.arrayBuffer()));
            for (let y = 0; y < 256; y++) {
                const dst = (((ty - range.tyMin) * 256 + y) * W + (tx - range.txMin) * 256) * 4;
                mosaic.set(png.data.subarray(y * 256 * 4, (y + 1) * 256 * 4), dst);
            }
        }
    }
    const elev = (x, y) => {
        const i = (y * W + x) * 4;
        return mosaic[i] * 256 + mosaic[i + 1] + mosaic[i + 2] / 256 - 32768;
    };
    const heights = new Int16Array(GRID_SIZE * GRID_SIZE);
    for (let iy = 0; iy < GRID_SIZE; iy++) {
        const z = iy * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
        for (let ix = 0; ix < GRID_SIZE; ix++) {
            const x = ix * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
            const p = proj.toLatLng(x, z);
            const { fx, fy } = latLngToTileFraction(p.lat, p.lng, DEM_ZOOM);
            const px = (fx - range.txMin) * 256, py = (fy - range.tyMin) * 256;
            const x0 = Math.max(0, Math.min(W - 1, Math.floor(px))), y0 = Math.max(0, Math.min(H - 1, Math.floor(py)));
            const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
            const ax = Math.min(1, Math.max(0, px - x0)), ay = Math.min(1, Math.max(0, py - y0));
            const top = elev(x0, y0) * (1 - ax) + elev(x1, y0) * ax;
            const bottom = elev(x0, y1) * (1 - ax) + elev(x1, y1) * ax;
            let e = top * (1 - ay) + bottom * ay;
            if (!Number.isFinite(e)) e = 0;
            heights[iy * GRID_SIZE + ix] = Math.round(Math.max(-100, Math.min(3000, e)) * 10);
        }
    }
    return heights;
}

// ── buildings: Microsoft footprints inside the scene ────────────────────────
function buildings() {
    const [w, s, e, n] = bbox;
    const fc = JSON.parse(readFileSync(footprintsPath, 'utf8'));
    const out = [];
    for (const f of fc.features) {
        let ring = f.geometry?.coordinates;
        if (!ring) continue;
        while (Array.isArray(ring[0][0])) ring = ring[0];
        const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
        if (Math.max(...xs) < w || Math.min(...xs) > e || Math.max(...ys) < s || Math.min(...ys) > n) continue;
        const pts = ring.map(([x, y]) => proj.toLocal(y, x));
        let area = 0;
        for (let i = 0; i < pts.length - 1; i++) area += pts[i].x * pts[i + 1].z - pts[i + 1].x * pts[i].z;
        if (Math.abs(area) / 2 < 12) continue;
        out.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])] },
            properties: { building: 'house' },
        });
    }
    return out;
}

const round = v => (Array.isArray(v) ? v.map(round) : typeof v === 'number' ? +v.toFixed(6) : v);
const slim = f => ({ type: 'Feature', geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) }, properties: f.properties });

// ── the village's own lanes: the viewer's road files only carry main roads ─
function villageStreets(mainRoads) {
    const { nodes, edges } = MALA_TOKMACHKA.streets;
    const local = mainRoads.features.flatMap(f => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]))
        .map(line => line.map(([x, y]) => proj.toLocal(y, x)));
    const nearMain = p => local.some(line => line.some((q, i) => {
        if (!i) return false;
        const a = line[i - 1], dx = q.x - a.x, dz = q.z - a.z, L = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L));
        return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z) < 10;
    }));
    return edges.filter(([, , isPath]) => !isPath).map(([a, b, , inner]) => {
        const pts = [nodes[a], ...inner, nodes[b]];
        const mid = pts[Math.floor(pts.length / 2)];
        return { pts, mid: proj.toLocal(mid[0], mid[1]) };
    }).filter(e => !nearMain(e.mid)).map(e => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: e.pts.map(([la, ln]) => [ln, la]) },
        properties: { highway: 'residential' },
    }));
}

const [heights, osm, roads] = await Promise.all([buildHeights(), fetchMapFeatures(bbox), fetchRoads(bbox)]);
const houses = buildings();
const lanes = villageStreets(roads);
const field = {
    version: 1,
    note: 'Generated by scripts/capture-field.mjs: the Capture Mala Tokmachka game field, so the game page needs no live data.',
    attribution: 'Elevation: Mapzen Terrain Tiles (AWS Open Data). Woods, water, fields, roads: © OpenStreetMap contributors (ODbL). Buildings: Microsoft Global ML Building Footprints (CDLA-Permissive-2.0).',
    frame: MALA_TOKMACHKA.frame, sceneSize: SCENE_SIZE, grid: GRID_SEGMENTS, heightScale: 0.1,
    osm: { type: 'FeatureCollection', features: [...osm.features.filter(f => !f.properties?.building).map(slim), ...houses] },
    roads: { type: 'FeatureCollection', features: [...roads.features.map(slim), ...lanes] },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'heights.bin'), Buffer.from(heights.buffer));
writeFileSync(join(OUT, 'field.json'), JSON.stringify(field));
const kb = n => `${Math.round(n / 1024)} KB`;
console.log(`heights ${GRID_SIZE}×${GRID_SIZE} (${kb(heights.byteLength)}), ` +
    `${field.osm.features.length - houses.length} OSM features + ${houses.length} buildings, ${roads.features.length} roads + ${lanes.length} lanes → ` +
    `${kb(JSON.stringify(field).length)} field.json`);

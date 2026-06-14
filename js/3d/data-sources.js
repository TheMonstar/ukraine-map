// Vector data fetchers for the 3D terrain viewer: forest/water/buildings (Overpass),
// buildings (Mapbox vector tiles, preferred), roads (motorlines.json) and
// fortification ditches (app API).

import { latLngToTile } from './geo.js';

const API_BASE_URL = 'https://europe-west1-high-electron-312820.cloudfunctions.net/flask-app';
const APP_STATIC_URL = 'https://storage.googleapis.com/telegram-reader-static/static';
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';

let motorlinesCache = null;
let settlementsCache = null;

function pointsEqual(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}

// Chain way segments into closed rings (used to assemble multipolygon relations).
function assembleRings(ways) {
    const segments = ways.map(w => w.slice());
    const rings = [];
    while (segments.length) {
        let ring = segments.shift();
        let guard = 0;
        while (!pointsEqual(ring[0], ring[ring.length - 1]) && guard++ < segments.length + 1) {
            const ringStart = ring[0], ringEnd = ring[ring.length - 1];
            let found = false;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (pointsEqual(seg[0], ringEnd)) { ring = ring.concat(seg.slice(1)); segments.splice(i, 1); found = true; break; }
                if (pointsEqual(seg[seg.length - 1], ringEnd)) { ring = ring.concat(seg.slice(0, -1).reverse()); segments.splice(i, 1); found = true; break; }
                if (pointsEqual(seg[seg.length - 1], ringStart)) { ring = seg.slice(0, -1).concat(ring); segments.splice(i, 1); found = true; break; }
                if (pointsEqual(seg[0], ringStart)) { ring = seg.slice(1).reverse().concat(ring); segments.splice(i, 1); found = true; break; }
            }
            if (!found) break;
        }
        rings.push(ring);
    }
    return rings;
}

// Convert raw Overpass JSON into a GeoJSON FeatureCollection: forest/water/building polygons
// (including multipolygon relations) and waterway LineStrings.
function osmToGeoJSON(osmData) {
    const nodeMap = new Map();
    const wayMap = new Map();
    osmData.elements.forEach(el => { if (el.type === 'node') nodeMap.set(el.id, [el.lon, el.lat]); });
    osmData.elements.forEach(el => {
        if (el.type === 'way' && el.nodes) {
            wayMap.set(el.id, { coords: el.nodes.map(id => nodeMap.get(id)).filter(Boolean), tags: el.tags || {} });
        }
    });

    const features = [];
    const usedInRelation = new Set();

    osmData.elements.forEach(el => {
        if (el.type !== 'relation' || !el.tags) return;
        const isArea = el.tags.natural === 'water' || el.tags.natural === 'wood' ||
            el.tags.landuse === 'forest' || el.tags.building;
        if (!isArea) return;

        const outerWays = [], innerWays = [];
        (el.members || []).forEach(m => {
            if (m.type !== 'way') return;
            const way = wayMap.get(m.ref);
            if (!way || way.coords.length < 2) return;
            usedInRelation.add(m.ref);
            (m.role === 'inner' ? innerWays : outerWays).push(way.coords);
        });

        const outerRings = assembleRings(outerWays).filter(r => r.length >= 4 && pointsEqual(r[0], r[r.length - 1]));
        const innerRings = assembleRings(innerWays).filter(r => r.length >= 4 && pointsEqual(r[0], r[r.length - 1]));
        outerRings.forEach((ring, idx) => {
            const coordinates = idx === 0 ? [ring, ...innerRings] : [ring];
            features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates }, properties: el.tags });
        });
    });

    osmData.elements.forEach(el => {
        if (el.type !== 'way' || usedInRelation.has(el.id)) return;
        const way = wayMap.get(el.id);
        if (!way || way.coords.length < 2) return;
        const tags = way.tags;
        const closed = pointsEqual(way.coords[0], way.coords[way.coords.length - 1]);

        if (tags.waterway) {
            features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: way.coords }, properties: tags });
        } else if (closed && way.coords.length >= 4 &&
            (tags.natural === 'water' || tags.natural === 'wood' || tags.natural === 'grassland' ||
                tags.landuse === 'forest' || GRASS_LANDUSE.has(tags.landuse) || tags.building)) {
            features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [way.coords] }, properties: tags });
        }
    });

    return { type: 'FeatureCollection', features };
}

// Grass-bearing landuse values fetched for the grass tuft layer.
const GRASS_LANDUSE = new Set(['meadow', 'grass', 'grassland', 'farmland', 'orchard']);

// v2: building relations + grass landuse added to the query — old cache entries lack them.
function cacheKey(bbox) {
    return `3d-osm-features-v2-${bbox.map(v => v.toFixed(4)).join(',')}`;
}

async function fetchOverpass(query) {
    for (const url of [OVERPASS_PRIMARY, OVERPASS_MIRROR]) {
        try {
            const res = await fetch(`${url}?data=${encodeURIComponent(query)}`);
            if (res.ok) return await res.json();
        } catch (e) { /* try next mirror */ }
    }
    throw new Error('Overpass request failed');
}

// Fetch forest, water, waterway and building features in one combined Overpass query, cached per bbox.
export async function fetchMapFeatures(bbox) {
    const key = cacheKey(bbox);
    const cached = sessionStorage.getItem(key);
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { /* corrupt cache entry — refetch */ }
    }

    const [west, south, east, north] = bbox;
    const b = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:60];(` +
        `way["natural"="wood"](${b});relation["natural"="wood"](${b});` +
        `way["landuse"="forest"](${b});` +
        `way["natural"="water"](${b});relation["natural"="water"](${b});` +
        `way["waterway"~"^(river|stream|canal|drain)$"](${b});` +
        `way["building"](${b});relation["building"](${b});` +
        `way["landuse"~"^(meadow|grass|grassland|farmland|orchard)$"](${b});` +
        `way["natural"="grassland"](${b});` +
        `);out body;>;out skel qt;`;

    const osmData = await fetchOverpass(query);
    const geojson = osmToGeoJSON(osmData);

    try {
        const json = JSON.stringify(geojson);
        if (json.length < 4 * 1024 * 1024) sessionStorage.setItem(key, json);
    } catch (e) { /* sessionStorage full — skip caching */ }

    return geojson;
}

// Shoelace area of a [lng,lat] ring — used to pick the least-clipped duplicate of a
// building that spans several vector tiles.
function mvtRingArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(area / 2);
}

// Fetch building footprints from Mapbox Streets vector tiles — the same source the
// main map's `buildings-3d` fill-extrusion layer renders (js/map-3d.js), so coverage
// matches it. Returns null when no token is set or nothing decodes (caller falls
// back to Overpass). MVT decoding via pbf + @mapbox/vector-tile, dynamically
// imported from the CDN so an unreachable CDN degrades gracefully.
export async function fetchMapboxBuildings(bbox) {
    const token = localStorage.getItem('mapboxToken');
    if (!token) return null;

    const key = `3d-mvt-buildings-${bbox.map(v => v.toFixed(4)).join(',')}`;
    const cached = sessionStorage.getItem(key);
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { /* corrupt cache entry — refetch */ }
    }

    const [{ default: Protobuf }, { VectorTile }] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm'),
        import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm')
    ]);

    const [west, south, east, north] = bbox;
    const z = 15; // small buildings get dropped from lower-zoom tiles
    const tMin = latLngToTile(north, west, z);
    const tMax = latLngToTile(south, east, z);

    const tasks = [];
    for (let x = tMin.x; x <= tMax.x; x++) {
        for (let y = tMin.y; y <= tMax.y; y++) {
            tasks.push({ x, y });
        }
    }

    const byId = new Map();   // id → feature, keep the least-clipped copy
    const anonymous = [];     // features without an id (cannot dedupe)
    await Promise.all(tasks.map(async ({ x, y }) => {
        try {
            const res = await fetch(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${z}/${x}/${y}.vector.pbf?access_token=${token}`);
            if (!res.ok) return;
            const layer = new VectorTile(new Protobuf(await res.arrayBuffer())).layers.building;
            if (!layer) return;
            for (let i = 0; i < layer.length; i++) {
                const raw = layer.feature(i);
                if (raw.properties.underground === 'true') continue;
                const gj = raw.toGeoJSON(x, y, z);
                const polys = gj.geometry.type === 'Polygon' ? [gj.geometry.coordinates]
                    : gj.geometry.type === 'MultiPolygon' ? gj.geometry.coordinates : [];
                polys.forEach((coordinates, p) => {
                    if (!coordinates[0] || coordinates[0].length < 4) return;
                    // tiles cover more than bbox — drop buildings beyond the terrain plane
                    if (!bboxIntersects(coordinates, bbox)) return;
                    const feature = {
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates },
                        // `building` tag so BuildingsFeature treats MVT and Overpass alike
                        properties: { ...gj.properties, building: gj.properties.type || 'yes' }
                    };
                    if (raw.id != null) {
                        const id = `${raw.id}/${p}`;
                        const prev = byId.get(id);
                        if (!prev || mvtRingArea(coordinates[0]) > mvtRingArea(prev.geometry.coordinates[0])) {
                            byId.set(id, feature);
                        }
                    } else {
                        anonymous.push(feature);
                    }
                });
            }
        } catch (e) { /* skip unreachable/corrupt tile */ }
    }));

    const features = [...byId.values(), ...anonymous];
    if (!features.length) return null;
    const geojson = { type: 'FeatureCollection', features };

    try {
        const json = JSON.stringify(geojson);
        if (json.length < 4 * 1024 * 1024) sessionStorage.setItem(key, json);
    } catch (e) { /* sessionStorage full — skip caching */ }

    return geojson;
}

// True if any coordinate of a (possibly nested) GeoJSON coordinate array falls inside bbox.
function bboxIntersects(coords, bbox) {
    const [west, south, east, north] = bbox;
    const flat = [];
    (function flatten(arr) {
        if (typeof arr[0] === 'number') { flat.push(arr); return; }
        arr.forEach(flatten);
    })(coords);
    return flat.some(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north);
}

// Fetch the static motorlines dataset (cached across calls) and return features intersecting bbox.
export async function fetchRoads(bbox) {
    if (!motorlinesCache) {
        const res = await fetch(`${APP_STATIC_URL}/motorlines.json`);
        motorlinesCache = await res.json();
    }
    const features = (motorlinesCache.features || []).filter(f => f.geometry && bboxIntersects(f.geometry.coordinates, bbox));
    return { type: 'FeatureCollection', features };
}

// Fetch the static settlements dataset (cached across calls) and return point
// features inside bbox. Same source as the main map (js/app.js).
export async function fetchSettlements(bbox) {
    if (!settlementsCache) {
        const res = await fetch(`${APP_STATIC_URL}/settlements.json`);
        settlementsCache = await res.json();
    }
    const [west, south, east, north] = bbox;
    const features = (settlementsCache.features || []).filter(f => {
        const c = f.geometry?.coordinates;
        return c && c[0] >= west && c[0] <= east && c[1] >= south && c[1] <= north;
    });
    return { type: 'FeatureCollection', features };
}

// Fetch fortification ditches for a given date (YYYY-MM-DD) and return features intersecting bbox.
export async function fetchDitches(date, bbox) {
    const dateParam = date.replace(/-/g, '');
    const res = await fetch(`${API_BASE_URL}/ditches.geojson?date=${dateParam}`);
    if (!res.ok) throw new Error(`ditches fetch failed: ${res.status}`);
    const data = await res.json();
    const features = (data.features || []).filter(f => f.geometry && bboxIntersects(f.geometry.coordinates, bbox));
    return { type: 'FeatureCollection', features };
}

// Capture Mala Tokmachka: the game's fixed field, presaved by scripts/capture-field.mjs
// (heightmap, OSM woods/water/fields, Microsoft buildings, roads and village lanes),
// so the game page loads without Overpass or the viewer's live layers. Only the preset
// frame has a pack; any other frame, a pack that doesn't fit the terrain grid or a failed
// fetch returns null. Satellite imagery is not packed (its providers don't allow
// re-hosting).

import { MALA_TOKMACHKA } from './mala-tokmachka.js';

const BASE = new URL('../../../data/capture/field/', import.meta.url);

export async function loadFieldPack({ lat, lng, size, sceneSize }) {
    const f = MALA_TOKMACHKA.frame;
    if (Math.abs(lat - f.lat) > 1e-6 || Math.abs(lng - f.lng) > 1e-6 || size !== f.size) return null;
    try {
        const [meta, bin] = await Promise.all([
            fetch(new URL('field.json', BASE)).then(r => { if (!r.ok) throw new Error(`field.json ${r.status}`); return r.json(); }),
            fetch(new URL('heights.bin', BASE)).then(r => { if (!r.ok) throw new Error(`heights.bin ${r.status}`); return r.arrayBuffer(); }),
        ]);
        if (meta.version !== 1 || meta.sceneSize !== sceneSize) return null;
        const heights = Float32Array.from(new Int16Array(bin), v => v * meta.heightScale);
        if (heights.length !== (meta.grid + 1) ** 2) return null;
        return { heights, osm: meta.osm, roads: meta.roads, attribution: meta.attribution };
    } catch (err) {
        console.warn('Capture field pack unavailable:', err);
        return null;
    }
}

/** View, time and layer control. */
import * as session from '../session.js';

export async function setView({ place, region, center, zoom, basemap, topo_mode }) {
    if (basemap || topo_mode !== undefined) await session.call('setBasemap', basemap, topo_mode);
    if (!place && !region && !center) {
        if (zoom != null) return session.call('setView', (await session.call('state')).view.center, zoom);
        return session.call('state').then((s) => s.view);
    }
    if (region) return session.call('loadRegion', region, zoom);
    if (center) return session.call('setView', center, zoom);
    if (place) {
        const r = await session.call('resolve', String(place));
        if (!r.found) {
            const alts = (r.alternatives || []).map((a) => a.nameEn || a.name).filter(Boolean);
            throw new Error(`could not resolve "${place}"` + (alts.length ? ` — did you mean: ${alts.join(', ')}?` : ''));
        }
        return session.call('setView', r.coords, zoom ?? 11);
    }
    throw new Error('map_set_view needs one of: place, region, center, basemap or zoom');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function setDates({ start, end }) {
    for (const [k, v] of Object.entries({ start, end })) {
        if (!ISO_DATE.test(String(v))) throw new Error(`${k} must be YYYY-MM-DD, got "${v}"`);
    }
    if (new Date(start) > new Date(end)) throw new Error('start must be on or before end');
    return session.call('setDates', start, end);
}

/** Per-settlement name labels and boundary outlines, addressed by name. */
export function settlementDetail({ places, title = true, boundary = false, color }) {
    if (!places?.length) throw new Error('map_settlement_detail needs `places`');
    return session.call('settlementDetail', places, { title, boundary, color });
}

export function setLayers({ layers }) {
    if (!layers || typeof layers !== 'object' || !Object.keys(layers).length) {
        throw new Error('`layers` must be an object of { layerId: boolean }');
    }
    return session.call('setLayers', layers);
}

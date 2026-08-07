/** Read tools — what is on the map right now. */
import * as session from '../session.js';

export const getState = () => session.call('state');

export async function findPlace({ query, limit = 5 }) {
    const r = await session.call('resolve', query, limit);
    if (!r.found && !r.alternatives?.length) {
        return { found: false, query, hint: 'no settlement or unit matched — try the English name, or a shorter substring' };
    }
    return { query, ...r };
}

const KINDS = ['settlements', 'units', 'events', 'ria_events', 'owl_events', 'modr', 'territory'];

export async function listFeatures({ kind, bbox, limit = 150, viewport_only = true }) {
    if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" — one of ${KINDS.join(', ')}`);
    let box = bbox || null;
    if (!box && viewport_only) box = (await session.call('state')).view.bounds;
    return { kind, bbox: box, ...(await session.call('features', kind, box, limit)) };
}

export const listRegions = () => session.call('regions');
export const listLayers = () => session.call('layerIds');

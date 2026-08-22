/**
 * Drawing tools — semantic tactical verbs on top of DrawingTool primitives.
 *
 * Every shape produced here is a plain JSON object matching exactly what
 * js/draw.js renders, and is tagged `owner: 'ai'` by the bridge so the user's
 * hand drawings are never collateral damage.
 */
import * as session from '../session.js';
import * as geo from '../geo.js';

// Matches MapUMLEngine.colors so AI output speaks the app's existing visual language.
const SIDE_COLORS = {
    ru: '#d0021b',
    ua: '#4a90e2',
    neutral: '#f5a623',
};
const colorFor = (side, override) => override || SIDE_COLORS[side || 'neutral'] || SIDE_COLORS.neutral;

/** Resolves a place name (or a literal [lat, lng]) to coordinates via the page bridge. */
async function resolve(place) {
    if (Array.isArray(place) && place.length === 2 && place.every((n) => typeof n === 'number')) {
        return { coords: place, name: `${place[0].toFixed(4)},${place[1].toFixed(4)}` };
    }
    const r = await session.call('resolve', String(place));
    if (!r.found) {
        const alts = (r.alternatives || []).map((a) => a.nameEn || a.name).filter(Boolean);
        throw new Error(
            `could not resolve "${place}"` + (alts.length ? ` — did you mean: ${alts.join(', ')}?` : '')
        );
    }
    return r;
}

const resolveAll = (places) => Promise.all(places.map(resolve));

/** The app's own icon set — read from images/events/ so the AI cannot invent a name. */
export const ICON_NAMES = [
    'blue_abandoned',
    'blue_aircombat',
    'blue_airdef_w',
    'blue_cruisemissile',
    'blue_death',
    'blue_death_w',
    'blue_drone',
    'blue_explosion',
    'blue_explosion_w',
    'blue_fighting',
    'blue_fire',
    'blue_flag',
    'blue_hospital',
    'blue_intercept',
    'blue_largedrone',
    'blue_other',
    'blue_other_gold',
    'blue_photo',
    'blue_plane',
    'blue_rocket',
    'blue_run',
    'blue_shelling',
    'blue_sunk',
    'blue_tractor',
    'blue_truck',
    'broken_bridge',
    'broken_dam',
    'death_blue',
    'explosion_blue_golden',
    'explosion_red_golden',
    'eyeball',
    'photo_red_golden_all',
    'purple_explosion',
    'purple_fire',
    'purple_power_gold_w',
    'red_abandoned',
    'red_aircombat',
    'red_bombed',
    'red_cluster',
    'red_death',
    'red_drone',
    'red_drone_w',
    'red_explosion',
    'red_explosion_w',
    'red_fighting',
    'red_fire',
    'red_fire_w',
    'red_flag_gold',
    'red_helicopter',
    'red_intercept',
    'red_lancet',
    'red_lancet_w',
    'red_missile_w',
    'red_motorcycle',
    'red_other',
    'red_plane',
    'red_plane_w',
    'red_propaganda',
    'red_rat',
    'red_rocket',
    'red_rocket_w',
    'red_run',
    'red_shahed',
    'red_shahed_w',
    'red_shelling',
    'red_shelling_w',
    'red_tos',
    'red_trap',
    'red_trap_w',
    'red_truck',
    'red_work',
    'shell',
    'truck_blue_golden'
];


/** Text shape whose baseline runs along `bearingRad`; p2 only carries the angle. */
function textShape(at, text, { size = 16, color, bearingRad = 0, halo } = {}) {
    return {
        type: 'text',
        p1: at,
        p2: geo.offsetKm(at, 1, bearingRad),
        text,
        fontSize: size,
        color: color || SIDE_COLORS.neutral,
        ...(halo !== undefined ? { halo } : {}),   // undefined = DrawingTool's auto-contrast halo
    };
}

// ── map_draw_axis ────────────────────────────────────────────────────────────
export async function drawAxis({ from, to, via = [], side, curve = 0, label, color,
                                 thickness = 4, dash = false, style = 'arc', taper = false,
                                 follow = 'none' }) {
    const waypoints = await resolveAll([from, ...via, to]);
    const pts = waypoints.map((w) => w.coords);
    const stroke = colorFor(side, color);
    const shapes = [];

    if (follow === 'terrain' || follow === 'roads' || style === 'freehand') {
        // one continuous path — routed over the DEM or the road graph when asked,
        // so the axis bends around ground instead of ruling straight across it
        shapes.push({
            type: 'freedraw',
            points: await routeThrough(pts, follow, curve),
            head: true, taper, color: stroke, thickness, dash,
        });
    } else {
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (curve) {
                shapes.push({ type: 'arc', p1: a, p2: b, p3: geo.bulgePoint(a, b, curve),
                              head: true, taper, color: stroke, thickness, dash });
            } else if (taper) {
                shapes.push({ type: 'freedraw', points: [a, b], head: true, taper,
                              color: stroke, thickness, dash });
            } else {
                shapes.push({ type: 'arrow', start: a, end: b, color: stroke, thickness, dash });
            }
        }
    }

    if (label) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        const mid = curve ? geo.bulgePoint(a, b, curve * 1.35) : geo.midpoint(a, b);
        shapes.push(textShape(geo.offsetKm(mid, 1.5, geo.bearing(a, b) + Math.PI / 2), label,
                              { size: 18, color: stroke, bearingRad: 0 }));
    }

    const res = await session.call('addShapes', shapes);
    return { ...res, legs: pts.length - 1, waypoints: waypoints.map((w) => w.name), color: stroke };
}

// ── map_encircle ─────────────────────────────────────────────────────────────
export async function encircle({ around, places, radius_km, padding_km = 4, side, fill = true, label, color, thickness = 3, dash = true, pattern, pattern_angle }) {
    const targets = places?.length ? await resolveAll(places) : [await resolve(around)];
    const pts = targets.map((t) => t.coords);
    const stroke = colorFor(side, color);

    const ring = pts.length === 1
        ? geo.circlePolygon(pts[0], radius_km || Math.max(padding_km, 5))
        : geo.hullAround(pts, padding_km);

    const shapes = [{
        type: 'polygon', points: ring, color: stroke, thickness, dash,
        fill: !!fill, fillOpacity: 0.22, pattern, patternAngle: pattern_angle,
    }];

    if (label) {
        const c = geo.centroid(ring);
        const top = geo.offsetKm(c, geo.distanceKm(c, ring[0]) * 1.05, Math.PI / 2);
        shapes.push(textShape(top, label, { size: 18, color: stroke }));
    }

    const res = await session.call('addShapes', shapes);
    return { ...res, encircled: targets.map((t) => t.name), vertices: ring.length, color: stroke };
}

// ── map_area ─────────────────────────────────────────────────────────────────
export async function area({ points, places, fill = true, side, label, color, thickness = 3,
                             dash = false, padding_km = 0, pattern, pattern_angle,
                             follow = 'none', width_km, smooth = true }) {
    let ring;
    let described;
    if (points?.length >= 3) {
        ring = points.map((p) => [p[0], p[1]]);
        described = `${points.length} explicit points`;
    } else if (places?.length >= 2 && (follow !== 'none' || width_km)) {
        // corridor along the route between the places, rather than a hull over them:
        // two places hulled together always come out as a fat lozenge
        const resolved = await resolveAll(places);
        const path = await routeThrough(resolved.map((r) => r.coords), follow, 0);
        ring = geo.corridor(path, width_km || Math.max(padding_km, 6));
        described = `corridor via ${resolved.map((r) => r.name).join(' → ')}${follow !== 'none' ? ` (${follow})` : ''}`;
    } else if (places?.length) {
        const resolved = await resolveAll(places);
        ring = geo.hullAround(resolved.map((r) => r.coords), padding_km);
        described = resolved.map((r) => r.name).join(', ');
    } else {
        throw new Error('map_area needs either `points` (>=3 [lat,lng] pairs) or `places`');
    }
    const stroke = colorFor(side, color);

    const shapes = [{ type: 'polygon', points: ring, color: stroke, thickness, dash,
                      fill: !!fill, fillOpacity: 0.22, pattern,
                      patternAngle: pattern_angle, smooth }];
    if (label) shapes.push(textShape(geo.centroid(ring), label, { size: 18, color: stroke }));

    const res = await session.call('addShapes', shapes);
    return { ...res, from: described, vertices: ring.length, color: stroke };
}

// ── map_line ─────────────────────────────────────────────────────────────────
const LINE_STYLES = {
    phase:    { thickness: 3, dash: true },
    boundary: { thickness: 5, dash: true },
    flank:    { thickness: 3, dash: false },
    plain:    { thickness: 3, dash: false },
};

export async function line({ from, to, kind = 'plain', side, label, color }) {
    const style = LINE_STYLES[kind];
    if (!style) throw new Error(`unknown line kind "${kind}" — use ${Object.keys(LINE_STYLES).join(', ')}`);
    const a = await resolve(from);
    const b = await resolve(to);
    const stroke = colorFor(side, color);

    const shapes = [{ type: 'line', start: a.coords, end: b.coords, color: stroke, ...style }];
    if (label) {
        const mid = geo.midpoint(a.coords, b.coords);
        shapes.push(textShape(geo.offsetKm(mid, 1.5, geo.bearing(a.coords, b.coords) + Math.PI / 2),
                              label, { size: 16, color: stroke }));
    }

    const res = await session.call('addShapes', shapes);
    return { ...res, from: a.name, to: b.name, kind, color: stroke };
}

// ── map_mark ─────────────────────────────────────────────────────────────────
export async function mark({ at, label, side, radius_km = 2, color, thickness = 3 }) {
    const p = await resolve(at);
    const stroke = colorFor(side, color);

    // ellipse p1→p2 is the major axis; p3 sets half-width perpendicular to it
    const west = geo.offsetKm(p.coords, radius_km, Math.PI);
    const east = geo.offsetKm(p.coords, radius_km, 0);
    const shapes = [{
        type: 'ellipse', p1: west, p2: east,
        p3: geo.offsetKm(p.coords, radius_km, Math.PI / 2),
        color: stroke, thickness, dash: false,
    }];
    if (label) {
        shapes.push(textShape(geo.offsetKm(p.coords, radius_km * 1.4, Math.PI / 4), label,
                              { size: 16, color: stroke }));
    }

    const res = await session.call('addShapes', shapes);
    return { ...res, at: p.name, coords: p.coords, color: stroke };
}

// ── map_label ────────────────────────────────────────────────────────────────
export async function label({ at, text, size = 18, bearing_deg = 0, side, color, halo }) {
    const p = await resolve(at);
    const stroke = colorFor(side, color);
    const shape = textShape(p.coords, text, {
        size, color: stroke, bearingRad: (-bearing_deg * Math.PI) / 180, halo,
    });
    const res = await session.call('addShapes', [shape]);
    return { ...res, at: p.name, coords: p.coords, color: stroke };
}

// ── terrain-aware graphics ───────────────────────────────────────────────────

/**
 * Resolves a route between waypoints, optionally following terrain or roads.
 * `none` gives the straight/spline path; the others produce naturally sinuous
 * lines because they are driven by real elevation and real road geometry.
 */
async function routeThrough(pts, follow, curve) {
    if (follow === 'terrain' || follow === 'roads') {
        const out = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const leg = follow === 'roads'
                ? await session.call('roadPath', pts[i], pts[i + 1])
                : await session.call('terrainPath', pts[i], pts[i + 1], {});
            if (leg && leg.length > 1) out.push(...leg.slice(1));
            else out.push(pts[i + 1]);   // no route found — fall back to the direct leg
        }
        return geo.smoothPath(decimate(out), 0, 6);
    }
    return geo.smoothPath(pts, curve);
}

/** Thins a dense path so smoothing and rendering stay cheap. */
function decimate(pts, max = 90) {
    if (pts.length <= max) return pts;
    const step = pts.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
}

/**
 * The real control boundary as a flowing dashed line. This is drawn from the
 * loaded DeepState territory, so it is the actual front — not a hull or a guess.
 */
export async function frontLine({ bbox, date, color = '#c62828', thickness = 3,
                                  dash = true, max_segments = 3, side }) {
    const box = bbox || (await session.call('state')).view.bounds;
    const runs = await session.call('frontLine', box, date);
    if (!runs.length) {
        throw new Error('no control boundary in view — load the territory layer first (map_set_layers { "diff-area": true }) or widen the view');
    }
    const stroke = color || colorFor(side);
    const shapes = runs.slice(0, max_segments).map((run) => ({
        type: 'freedraw',
        points: geo.smoothPath(decimate(run, 140), 0, 4),
        color: stroke, thickness, dash,
    }));
    const res = await session.call('addShapes', shapes);
    return { ...res, segments: shapes.length, vertices: runs[0].length, source: 'DeepState control boundary' };
}

/**
 * A concealed approach route rather than an axis of advance: it hugs treelines,
 * woods, villages and stream corridors, and reports how much of the route is
 * actually under cover so the open crossings can be planned around.
 */
export async function infiltrationRoute({ from, to, via = [], radius_m = 300, cell_m = 40,
                                          avoid_settlements = false, routes = 1, use_terrain = true,
                                          side, color, thickness = 3, label }) {
    const waypoints = await resolveAll([from, ...via, to]);
    const found = await session.call('infiltrationPath', waypoints.map((w) => w.coords),
                                     // waypoints already shape the route, and each leg
                                     // multiplies the search, so alternatives are dropped
                                     { radius_m, cell_m, avoid_settlements, use_terrain,
                                       routes: via.length ? 1 : routes });
    const stroke = color || (side ? colorFor(side) : '#2e7d32');
    const shapes = found.map((r) => ({
        type: 'freedraw',
        points: geo.smoothPath(decimate(r.points, 140), 0, 4),
        head: true, dash: true, color: stroke,
        thickness: r.rank === 1 ? thickness : Math.max(1, thickness - 1),
    }));
    if (label) {
        const best = found[0].points;
        const mid = best[Math.floor(best.length / 2)];
        shapes.push(textShape(mid, label, { size: 16, color: stroke, bearingRad: 0 }));
    }
    const res = await session.call('addShapes', shapes);
    return {
        ...res,
        waypoints: waypoints.map((w) => w.name),
        color: stroke,
        routes: found.map((r) => ({ rank: r.rank, ...r.stats })),
    };
}

/** Elevation readings, so an analysis can be grounded in the actual ground. */
export async function elevation({ places, points }) {
    const coords = points?.length
        ? points
        : (await resolveAll(places || [])).map((r) => r.coords);
    if (!coords.length) throw new Error('map_elevation needs `places` or `points`');
    const metres = await session.call('elevations', coords);
    return coords.map((c, i) => ({ coords: c, elevation_m: metres[i] }));
}

// ── planning graphics ────────────────────────────────────────────────────────

/** Tactical icon from the app's own images/events/ set. */
export async function placeIcon({ at, icon, size = 28, label, label_size }) {
    if (!ICON_NAMES.includes(icon)) {
        const near = ICON_NAMES.filter((n) => n.includes(String(icon).split('_').pop() || '~')).slice(0, 8);
        throw new Error(`unknown icon "${icon}"` + (near.length ? ` — did you mean: ${near.join(', ')}?` : ''));
    }
    const p = await resolve(at);
    const res = await session.call('addShapes', [
        { type: 'icon', at: p.coords, icon, size, label, labelSize: label_size },
    ]);
    return { ...res, at: p.name, coords: p.coords, icon };
}

/** Objective: dashed ring plus a haloed label — the standard "seize this" graphic. */
export async function objective({ at, places, radius_km = 3, padding_km = 3, side, label, color }) {
    const targets = places?.length ? await resolveAll(places) : [await resolve(at)];
    const pts = targets.map((t) => t.coords);
    const stroke = colorFor(side, color);
    const ring = pts.length === 1 ? geo.circlePolygon(pts[0], radius_km) : geo.hullAround(pts, padding_km);

    const shapes = [{ type: 'polygon', points: ring, color: stroke, thickness: 3, dash: true, fill: false }];
    if (label) {
        const c = geo.centroid(ring);
        shapes.push(textShape(geo.offsetKm(c, geo.distanceKm(c, ring[0]) * 1.15, Math.PI / 2),
                              label, { size: 17, color: stroke }));
    }
    const res = await session.call('addShapes', shapes);
    return { ...res, objective: targets.map((t) => t.name), color: stroke };
}

/** Phase line: a dashed polyline through waypoints, labelled at its start. */
export async function phaseLine({ from, to, via = [], label, side, color, thickness = 3 }) {
    const pts = (await resolveAll([from, ...via, to])).map((w) => w.coords);
    const stroke = colorFor(side, color);
    const shapes = [{ type: 'freedraw', points: geo.smoothPath(pts), color: stroke, thickness, dash: true }];
    if (label) {
        shapes.push(textShape(geo.offsetKm(pts[0], 2, Math.PI), label, { size: 16, color: stroke }));
    }
    const res = await session.call('addShapes', shapes);
    return { ...res, kind: 'phase line', color: stroke };
}

/** Unit boundary: a heavy dashed polyline with the formation on each side named. */
export async function boundary({ from, to, via = [], left, right, color, thickness = 5 }) {
    const pts = (await resolveAll([from, ...via, to])).map((w) => w.coords);
    const stroke = color || '#333333';
    const shapes = [{ type: 'freedraw', points: geo.smoothPath(pts), color: stroke, thickness, dash: true }];

    const mid = pts[Math.floor(pts.length / 2)];
    const perp = geo.bearing(pts[0], pts[pts.length - 1]) + Math.PI / 2;
    if (left)  shapes.push(textShape(geo.offsetKm(mid, 4, perp), left, { size: 15, color: stroke }));
    if (right) shapes.push(textShape(geo.offsetKm(mid, 4, perp + Math.PI), right, { size: 15, color: stroke }));

    const res = await session.call('addShapes', shapes);
    return { ...res, kind: 'boundary', color: stroke };
}

// ── map_draw_shapes (escape hatch) ───────────────────────────────────────────
const REQUIRED = {
    freedraw: ['points'],
    polygon: ['points'],
    line: ['start', 'end'],
    arrow: ['start', 'end'],
    ellipse: ['p1', 'p2'],
    rect: ['p1', 'p2'],
    arc: ['p1', 'p2'],
    text: ['p1', 'p2', 'text'],
    icon: ['at', 'icon'],
};

const isLatLng = (v) =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && isFinite(n)) &&
    Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180;

export async function drawShapes({ shapes }) {
    if (!Array.isArray(shapes) || !shapes.length) throw new Error('`shapes` must be a non-empty array');

    shapes.forEach((s, i) => {
        const req = REQUIRED[s.type];
        if (!req) throw new Error(`shape[${i}]: unknown type "${s.type}" — one of ${Object.keys(REQUIRED).join(', ')}`);
        for (const key of req) {
            if (s[key] === undefined) throw new Error(`shape[${i}] (${s.type}): missing "${key}"`);
        }
        for (const key of ['points']) {
            if (s[key] && (!Array.isArray(s[key]) || !s[key].every(isLatLng))) {
                throw new Error(`shape[${i}] (${s.type}): "${key}" must be an array of [lat, lng] pairs`);
            }
        }
        for (const key of ['start', 'end', 'p1', 'p2', 'p3', 'at']) {
            if (s[key] != null && !isLatLng(s[key])) {
                throw new Error(`shape[${i}] (${s.type}): "${key}" must be [lat, lng] — got ${JSON.stringify(s[key])}`);
            }
        }
        if (s.type === 'text' && typeof s.fontSize !== 'number') s.fontSize = 16;
        if (typeof s.color !== 'string') s.color = SIDE_COLORS.neutral;
        if (typeof s.thickness !== 'number' && s.type !== 'text') s.thickness = 3;
    });

    return session.call('addShapes', shapes);
}

export const erase = ({ scope = 'ai', n = 1 }) => session.call('erase', scope, n);
export const undo = () => session.call('undo');

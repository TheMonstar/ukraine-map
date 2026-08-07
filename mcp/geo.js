/**
 * Node-side geometry helpers.
 *
 * COORDINATE CONTRACT — read this before touching anything here:
 *   DrawingTool shapes use [lat, lng].  GeoJSON (settlementsData) uses [lng, lat].
 *   Everything in this file is [lat, lng]. Conversion happens once, in `fromGeoJSON`.
 */

const EARTH_R_KM = 6371.0088;

export const toGeoJSON   = ([lat, lng]) => [lng, lat];
export const fromGeoJSON = ([lng, lat]) => [lat, lng];

/** Degrees of latitude per km (constant), and of longitude per km at a given latitude. */
export function degPerKm(lat) {
    const dLat = 1 / 110.574;
    const dLng = 1 / (111.32 * Math.cos((lat * Math.PI) / 180) || 1e-9);
    return { dLat, dLng };
}

/** Great-circle distance in km between two [lat, lng] points. */
export function distanceKm(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s));
}

/** Initial bearing in radians from a to b, measured on the local flat approximation. */
export function bearing(a, b) {
    const { dLat, dLng } = degPerKm(a[0]);
    return Math.atan2((b[0] - a[0]) / dLat, (b[1] - a[1]) / dLng);
}

/** Midpoint of a and b (flat approximation — fine at frontline scale). */
export const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Moves a point `km` kilometres along `angleRad` (0 = east, CCW positive). */
export function offsetKm(point, km, angleRad) {
    const { dLat, dLng } = degPerKm(point[0]);
    return [point[0] + km * Math.sin(angleRad) * dLat, point[1] + km * Math.cos(angleRad) * dLng];
}

/**
 * Bulge control point for a curved arc from a to b.
 * `curve` is a signed fraction of the chord length; positive bulges to the LEFT
 * of the a→b direction, negative to the right. 0.3 is a comfortable default.
 */
export function bulgePoint(a, b, curve) {
    const mid = midpoint(a, b);
    const h = distanceKm(a, b) * curve;
    return offsetKm(mid, h, bearing(a, b) + Math.PI / 2);
}

/**
 * Catmull-Rom spline through the given waypoints, so a multi-leg axis renders as
 * one continuous sweep. `curve` bows the whole path perpendicular to its chord,
 * matching the sign convention of bulgePoint.
 */
export function smoothPath(points, curve = 0, perSegment = 24) {
    if (points.length < 2) return points.slice();

    let pts = points;
    if (curve && points.length === 2) {
        pts = [points[0], bulgePoint(points[0], points[1], curve), points[1]];
    } else if (curve) {
        const b = bearing(points[0], points[points.length - 1]) + Math.PI / 2;
        const h = distanceKm(points[0], points[points.length - 1]) * curve;
        pts = points.map((p, i) => {
            // bow the interior, pin the endpoints
            const t = i / (points.length - 1);
            const w = Math.sin(t * Math.PI);
            return offsetKm(p, h * w, b);
        });
    }

    // duplicate endpoints so the spline passes through the first and last points
    const ctl = [pts[0], ...pts, pts[pts.length - 1]];
    const out = [];
    for (let i = 1; i < ctl.length - 2; i++) {
        const [p0, p1, p2, p3] = [ctl[i - 1], ctl[i], ctl[i + 1], ctl[i + 2]];
        for (let j = 0; j < perSegment; j++) {
            const t = j / perSegment;
            const t2 = t * t;
            const t3 = t2 * t;
            out.push([0, 1].map((d) => 0.5 * (
                2 * p1[d] +
                (-p0[d] + p2[d]) * t +
                (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
                (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3
            )));
        }
    }
    out.push(pts[pts.length - 1]);
    return out;
}

/** Regular polygon approximating a circle of `radiusKm` around `center`. */
export function circlePolygon(center, radiusKm, segments = 48) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
        pts.push(offsetKm(center, radiusKm, (i / segments) * 2 * Math.PI));
    }
    return pts;
}

/** Convex hull (monotone chain) over [lat, lng] points. Returns CCW in lng/lat space. */
export function convexHull(points) {
    if (points.length < 3) return points.slice();
    // work in (x=lng, y=lat) so cross products have the usual orientation
    const pts = points.map(([lat, lng]) => [lng, lat]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    const build = (src) => {
        const out = [];
        for (const p of src) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
            out.push(p);
        }
        out.pop();
        return out;
    };
    const hull = build(pts).concat(build(pts.slice().reverse()));
    return hull.map(([lng, lat]) => [lat, lng]);
}

/** Pushes every hull vertex `padKm` outward from the centroid. */
export function padOutward(points, padKm) {
    if (!padKm) return points;
    const c = centroid(points);
    return points.map((p) => {
        const d = distanceKm(c, p);
        if (d < 1e-6) return p;
        return offsetKm(p, padKm, bearing(c, p));
    });
}

export function centroid(points) {
    const n = points.length || 1;
    return [
        points.reduce((s, p) => s + p[0], 0) / n,
        points.reduce((s, p) => s + p[1], 0) / n,
    ];
}

/**
 * Hull of a set of places, padded outward — the shape behind `map_encircle`
 * with multiple places and `map_area` with places.
 */
export function hullAround(points, padKm = 0) {
    if (points.length === 1) return circlePolygon(points[0], Math.max(padKm, 1));
    if (points.length === 2) {
        // two points have no area — hull the discs around each, giving a capsule
        const pad = Math.max(padKm, distanceKm(points[0], points[1]) * 0.25);
        return convexHull(
            circlePolygon(points[0], pad, 16).concat(circlePolygon(points[1], pad, 16))
        );
    }
    return padOutward(convexHull(points), padKm);
}

/**
 * Closed ring `widthKm` either side of a path — a corridor that follows the path's
 * own shape. Unlike a convex hull over place points (which collapses two places
 * into a fat lozenge), this traces real geometry, so a zone built on a
 * terrain-routed path inherits the terrain's shape.
 */
export function corridor(path, widthKm) {
    if (path.length < 2) return circlePolygon(path[0] || [0, 0], widthKm);
    const half = widthKm;

    // Offsetting a dense path self-intersects wherever it bends tighter than the
    // corridor is wide, producing a tangled ribbon. Thinning the centreline so
    // consecutive points are at least ~1.5x the half-width apart keeps the two
    // offset sides from crossing.
    const minStep = half * 1.5;
    const spine = [path[0]];
    for (const p of path.slice(1, -1)) {
        if (distanceKm(spine[spine.length - 1], p) >= minStep) spine.push(p);
    }
    spine.push(path[path.length - 1]);
    if (spine.length < 2) spine.splice(0, spine.length, path[0], path[path.length - 1]);

    const left = [], right = [];
    for (let i = 0; i < spine.length; i++) {
        const a = spine[Math.max(0, i - 1)];
        const b = spine[Math.min(spine.length - 1, i + 1)];
        const perp = bearing(a, b) + Math.PI / 2;
        left.push(offsetKm(spine[i], half, perp));
        right.push(offsetKm(spine[i], half, perp + Math.PI));
    }
    path = spine;

    // Round the ends so the corridor reads as a zone, not a cut-off strip.
    // The ring is walked left → endCap → right(reversed) → startCap, so each cap
    // must sweep from the left side to the right side *around the outside*;
    // sweeping the other way folds the outline back on itself and leaves an ear.
    const cap = (p, headingRad) => {
        const arc = [];
        for (let k = 1; k < 6; k++) {
            arc.push(offsetKm(p, half, headingRad + Math.PI / 2 - (k * Math.PI) / 6));
        }
        return arc;
    };
    const last = path.length - 1;
    const endCap   = cap(path[last], bearing(path[last - 1], path[last]));
    const startCap = cap(path[0], bearing(path[1], path[0]));

    return [...left, ...endCap, ...right.reverse(), ...startCap];
}

/** True if [lat, lng] falls inside a {north,south,east,west} bbox. */
export function inBbox([lat, lng], bbox) {
    if (!bbox) return true;
    return lat <= bbox.north && lat >= bbox.south && lng <= bbox.east && lng >= bbox.west;
}

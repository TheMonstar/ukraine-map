// Shared helpers for draping vector features (roads, rivers, ditches, lakes) onto the terrain mesh.
// All geometry is clipped to the terrain plane (±SCENE_HALF) — source features often
// extend far beyond the visible sector.

import * as THREE from 'three';
import { SCENE_HALF, SCENE_SIZE, GRID_SEGMENTS } from './terrain.js';

function insideBounds(p) {
    return Math.abs(p.x) <= SCENE_HALF && Math.abs(p.z) <= SCENE_HALF;
}

// Boundary crossing on segment a→b where exactly one endpoint is inside (bisection).
function boundaryPoint(a, b) {
    let lo = a, hi = b;
    for (let i = 0; i < 24; i++) {
        const mid = { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 };
        if (insideBounds(mid) === insideBounds(lo)) lo = mid; else hi = mid;
    }
    return { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 };
}

// Split a polyline of {x,z} points into runs inside the terrain bounds, with
// boundary intersection points added where the line enters/leaves the sector.
function clipPolyline(pts) {
    const runs = [];
    let current = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (insideBounds(p)) {
            if (i > 0 && !insideBounds(pts[i - 1])) current.push(boundaryPoint(pts[i - 1], p));
            current.push(p);
        } else if (i > 0 && insideBounds(pts[i - 1])) {
            current.push(boundaryPoint(p, pts[i - 1]));
            runs.push(current);
            current = [];
        }
    }
    if (current.length) runs.push(current);
    return runs.filter(r => r.length >= 2);
}

// Sutherland–Hodgman clip of a {x,z} ring against the square terrain bounds.
function clipRing(ring) {
    const edges = [
        p => p.x >= -SCENE_HALF, p => p.x <= SCENE_HALF,
        p => p.z >= -SCENE_HALF, p => p.z <= SCENE_HALF
    ];
    const cross = [
        (a, b) => ({ x: -SCENE_HALF, z: a.z + (b.z - a.z) * (-SCENE_HALF - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: SCENE_HALF, z: a.z + (b.z - a.z) * (SCENE_HALF - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (-SCENE_HALF - a.z) / (b.z - a.z), z: -SCENE_HALF }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (SCENE_HALF - a.z) / (b.z - a.z), z: SCENE_HALF })
    ];
    let out = ring;
    for (let e = 0; e < 4 && out.length; e++) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i], prev = input[(i + input.length - 1) % input.length];
            const curIn = edges[e](cur), prevIn = edges[e](prev);
            if (curIn) {
                if (!prevIn) out.push(cross[e](prev, cur));
                out.push(cur);
            } else if (prevIn) {
                out.push(cross[e](prev, cur));
            }
        }
    }
    return out.length >= 3 ? out : null;
}

// Resample a polyline of {x,z} points (meters) to roughly stepM-meter spacing.
function resamplePolyline(pts, stepM) {
    if (pts.length < 2) return pts.slice();
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    }
    const total = cum[cum.length - 1];
    if (total === 0) return [pts[0]];
    const n = Math.max(1, Math.round(total / stepM));
    const out = [];
    let segIdx = 0;
    for (let i = 0; i <= n; i++) {
        const d = (i / n) * total;
        while (segIdx < cum.length - 2 && cum[segIdx + 1] < d) segIdx++;
        const segStart = cum[segIdx], segEnd = cum[segIdx + 1];
        const t = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0;
        const a = pts[segIdx], b = pts[segIdx + 1];
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
    return out;
}

// Build a flat ribbon mesh (e.g. road or river) draped onto the terrain along a GeoJSON [lng,lat] line.
export function buildDrapedRibbon(lngLatCoords, widthM, liftM, terrain, proj, color) {
    const pts = lngLatCoords.map(([lng, lat]) => proj.toLocal(lat, lng));
    const runs = clipPolyline(pts);
    if (!runs.length) return null;

    const positions = [];
    const uvs = [];
    const indices = [];
    const half = widthM / 2;

    for (const run of runs) {
        const resampled = resamplePolyline(run, 18);
        if (resampled.length < 2) continue;
        const base = positions.length / 3;

        for (let i = 0; i < resampled.length; i++) {
            const p = resampled[i];
            const prev = resampled[Math.max(0, i - 1)];
            const next = resampled[Math.min(resampled.length - 1, i + 1)];
            let dx = next.x - prev.x, dz = next.z - prev.z;
            const len = Math.hypot(dx, dz) || 1;
            dx /= len; dz /= len;
            const nx = -dz, nz = dx;

            const lx = p.x + nx * half, lz = p.z + nz * half;
            const rx = p.x - nx * half, rz = p.z - nz * half;

            positions.push(lx, terrain.sampleHeight(lx, lz) + liftM, lz);
            positions.push(rx, terrain.sampleHeight(rx, rz) + liftM, rz);

            const v = i / (resampled.length - 1);
            uvs.push(0, v, 1, v);
        }

        for (let i = 0; i < resampled.length - 1; i++) {
            const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
            indices.push(a, c, b, b, c, d);
        }
    }
    if (!indices.length) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
        color, roughness: 0.9, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.liftM = liftM;
    mesh.receiveShadow = true;
    return mesh;
}

// Build a flat polygon mesh (e.g. a lake) draped at the lowest terrain height along its outline.
export function buildDrapedPolygon(coordinates, terrain, proj, color, opacity = 0.85) {
    const toClippedVecs = (ring) => {
        const clipped = clipRing(ring.map(([lng, lat]) => proj.toLocal(lat, lng)));
        return clipped && clipped.map(p => new THREE.Vector2(p.x, -p.z));
    };
    const outer = toClippedVecs(coordinates[0]);
    if (!outer) return null;
    const shape = new THREE.Shape(outer);
    coordinates.slice(1).forEach(hole => {
        const vecs = toClippedVecs(hole);
        if (vecs) shape.holes.push(new THREE.Path(vecs));
    });

    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);

    const pos = geometry.attributes.position;
    let minH = Infinity;
    for (let i = 0; i < pos.count; i++) {
        const h = terrain.sampleHeight(pos.getX(i), pos.getZ(i));
        if (h < minH) minH = h;
    }
    const y = (isFinite(minH) ? minH : 0) - 0.3;
    for (let i = 0; i < pos.count; i++) pos.setY(i, y);
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
        color, roughness: 0.15, metalness: 0.05, transparent: true, opacity,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isFlatPolygon = true;
    mesh.receiveShadow = true;
    return mesh;
}

// Ray-casting point-in-polygon against a {x,z} ring (local meters).
function pointInLocalRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
}

// Sutherland–Hodgman clip of a {x,z} ring against an axis-aligned rectangle.
function clipRingToRect(ring, x0, x1, z0, z1) {
    const edges = [p => p.x >= x0, p => p.x <= x1, p => p.z >= z0, p => p.z <= z1];
    const cross = [
        (a, b) => ({ x: x0, z: a.z + (b.z - a.z) * (x0 - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: x1, z: a.z + (b.z - a.z) * (x1 - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (z0 - a.z) / (b.z - a.z), z: z0 }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (z1 - a.z) / (b.z - a.z), z: z1 })
    ];
    let out = ring;
    for (let e = 0; e < 4 && out.length; e++) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i], prev = input[(i + input.length - 1) % input.length];
            const ci = edges[e](cur), pi = edges[e](prev);
            if (ci) { if (!pi) out.push(cross[e](prev, cur)); out.push(cur); }
            else if (pi) { out.push(cross[e](prev, cur)); }
        }
    }
    return out;
}

// Build a translucent, unlit area overlay (e.g. DeepState territory control) that
// hugs the terrain. Interior terrain-grid cells become full draped quads; cells the
// polygon boundary crosses are clipped to the exact edge — so the paint follows the
// surface (no sinking) while the outline stays smooth (no grid stair-steps).
export function buildDrapedOverlay(coordinates, terrain, proj, color, opacity, liftM) {
    const toLocalRing = (ring) => ring.map(([lng, lat]) => proj.toLocal(lat, lng));
    const outer = clipRing(toLocalRing(coordinates[0]));
    if (!outer || outer.length < 3) return null;
    const holes = coordinates.slice(1)
        .map(h => clipRing(toLocalRing(h)))
        .filter(h => h && h.length >= 3);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    outer.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    });

    const cell = SCENE_SIZE / GRID_SEGMENTS;
    const ix0 = Math.max(0, Math.floor((minX + SCENE_HALF) / cell));
    const ix1 = Math.min(GRID_SEGMENTS, Math.ceil((maxX + SCENE_HALF) / cell));
    const iz0 = Math.max(0, Math.floor((minZ + SCENE_HALF) / cell));
    const iz1 = Math.min(GRID_SEGMENTS, Math.ceil((maxZ + SCENE_HALF) / cell));
    const cols = ix1 - ix0, rows = iz1 - iz0;
    if (cols < 1 || rows < 1) return null;

    const corner = (x, z) => pointInLocalRing(x, z, outer) && !holes.some(h => pointInLocalRing(x, z, h));

    const positions = [];
    const drape = (x, z) => { positions.push(x, terrain.sampleHeight(x, z) + liftM, z); return positions.length / 3 - 1; };

    // Shared vertices for full interior quads (keeps the seam with clipped cells crack-free).
    const vIndex = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
    function vid(gi, gj) {
        const k = gj * (cols + 1) + gi;
        if (vIndex[k] === -1) vIndex[k] = drape((ix0 + gi) * cell - SCENE_HALF, (iz0 + gj) * cell - SCENE_HALF);
        return vIndex[k];
    }

    const indices = [];
    for (let gj = 0; gj < rows; gj++) {
        for (let gi = 0; gi < cols; gi++) {
            const x0 = (ix0 + gi) * cell - SCENE_HALF, x1 = x0 + cell;
            const z0 = (iz0 + gj) * cell - SCENE_HALF, z1 = z0 + cell;
            const c00 = corner(x0, z0), c10 = corner(x1, z0), c01 = corner(x0, z1), c11 = corner(x1, z1);
            const cnt = c00 + c10 + c01 + c11;

            if (cnt === 4) {
                const a = vid(gi, gj), b = vid(gi + 1, gj), c = vid(gi, gj + 1), d = vid(gi + 1, gj + 1);
                indices.push(a, c, b, b, c, d);
            } else {
                // Boundary cell (or sliver): clip the polygon to the cell, then triangulate.
                // The clipped piece can be non-convex (a polygon vertex falls inside the
                // cell), so earcut it rather than fan it to avoid overshooting the edge.
                const piece = clipRingToRect(outer, x0, x1, z0, z1);
                if (piece.length < 3) continue;
                const ids = piece.map(p => drape(p.x, p.z));
                const tris = THREE.ShapeUtils.triangulateShape(piece.map(p => new THREE.Vector2(p.x, p.z)), []);
                tris.forEach(t => indices.push(ids[t[0]], ids[t[1]], ids[t[2]]));
            }
        }
    }
    if (!indices.length) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);

    const material = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.liftM = liftM; // re-draped per-vertex on exaggeration change
    return mesh;
}

// Re-drape a ribbon or flat polygon mesh after the terrain exaggeration changes.
export function reDrapeMesh(mesh, terrain) {
    const pos = mesh.geometry.attributes.position;
    if (mesh.userData.isFlatPolygon) {
        let minH = Infinity;
        for (let i = 0; i < pos.count; i++) {
            const h = terrain.sampleHeight(pos.getX(i), pos.getZ(i));
            if (h < minH) minH = h;
        }
        const y = (isFinite(minH) ? minH : 0) - 0.3;
        for (let i = 0; i < pos.count; i++) pos.setY(i, y);
    } else {
        const lift = mesh.userData.liftM || 0;
        for (let i = 0; i < pos.count; i++) {
            pos.setY(i, terrain.sampleHeight(pos.getX(i), pos.getZ(i)) + lift);
        }
        mesh.geometry.computeVertexNormals();
    }
    pos.needsUpdate = true;
}

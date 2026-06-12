// Shared helpers for draping vector features (roads, rivers, ditches, lakes) onto the terrain mesh.
// All geometry is clipped to the terrain plane (±SCENE_HALF) — source features often
// extend far beyond the visible sector.

import * as THREE from 'three';
import { SCENE_HALF } from './terrain.js';

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

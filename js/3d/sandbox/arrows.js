// Terrain-following tactical arrows and phase lines.
//
// The centreline is smoothed with a Catmull-Rom curve and resampled every few metres,
// then every ribbon vertex is dropped onto the terrain with `sampleHeight` — so an arrow
// hugs a ridge instead of tunnelling through it. Materials are unlit (MeshBasicMaterial)
// so red/blue stay saturated at any time of day, with a dark outline underneath for
// contrast against satellite imagery.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clipPolyline, resamplePolyline } from '../ribbon.js';

const SAMPLE_M = 6;          // centreline resample step — short enough to hug relief
const ARROW_LIFT = 0.6;      // above road (0.15–0.5) / ditch ribbons, so no z-fighting
const OUTLINE_LIFT = 0.55;
const HEAD_WIDTH_K = 2.6;    // head width relative to shaft width
const HEAD_LEN_K = 3.2;      // head length relative to shaft width
const TAIL_TAPER = 0.55;     // shaft half-width at the tail, relative to full

export const SIDE_COLORS = { red: '#dc2626', blue: '#2563eb', neutral: '#f8fafc' };

// Smooth + resample a {x,z} polyline. Two points stay a straight line (Catmull-Rom
// through two points would wander).
function smoothPath(pts, stepM = SAMPLE_M) {
    const unique = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.5);
    if (unique.length < 2) return null;
    if (unique.length === 2) return resamplePolyline(unique, stepM);
    const curve = new THREE.CatmullRomCurve3(
        unique.map(p => new THREE.Vector3(p.x, 0, p.z)), false, 'catmullrom', 0.5);
    const length = curve.getLength();
    const n = Math.max(2, Math.min(2000, Math.round(length / stepM)));
    return curve.getSpacedPoints(n).map(v => ({ x: v.x, z: v.z }));
}

function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return d;
}

// Cut a polyline at a distance from its start → { head: pts before, tail: pts after },
// with the split point duplicated into both halves.
function splitAt(pts, distance) {
    const head = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        if (acc + seg >= distance) {
            const t = seg > 0 ? (distance - acc) / seg : 0;
            const cut = {
                x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
                z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t
            };
            head.push(cut);
            return { head, tail: [cut, ...pts.slice(i)] };
        }
        acc += seg;
        head.push(pts[i]);
    }
    return { head, tail: [] };
}

// Break a polyline into dash runs of `dashM` separated by `gapM`.
function splitDashes(pts, dashM, gapM) {
    const runs = [];
    let rest = pts, on = true;
    while (rest.length >= 2) {
        const { head, tail } = splitAt(rest, on ? dashM : gapM);
        if (on && head.length >= 2) runs.push(head);
        rest = tail;
        on = !on;
    }
    return runs;
}

// Draped triangle strip along `pts`, half-width given per-vertex by halfWidthAt(t).
function buildStrip(pts, halfWidthAt, lift, terrain) {
    if (pts.length < 2) return null;
    const positions = [], uvs = [], indices = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        let dx = next.x - prev.x, dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;
        const half = halfWidthAt(i / (pts.length - 1));

        const lx = p.x + nx * half, lz = p.z + nz * half;
        const rx = p.x - nx * half, rz = p.z - nz * half;
        positions.push(lx, terrain.sampleHeight(lx, lz) + lift, lz);
        positions.push(rx, terrain.sampleHeight(rx, rz) + lift, rz);
        const v = i / (pts.length - 1);
        uvs.push(0, v, 1, v);
    }
    for (let i = 0; i < pts.length - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, c, b, b, c, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

// Shaft + head geometry for one clipped run. `grow` widens everything (outline pass).
function buildRunGeometry(run, widthM, grow, lift, terrain, withHead, dash) {
    const half = widthM / 2 + grow;
    const geos = [];

    if (!withHead) {
        const runs = dash ? splitDashes(run, dash[0], dash[1]) : [run];
        runs.forEach(r => {
            const g = buildStrip(r, () => half, lift, terrain);
            if (g) geos.push(g);
        });
        return geos.length ? mergeGeometries(geos) : null;
    }

    const total = pathLength(run);
    const headLen = Math.min(total * 0.4, widthM * HEAD_LEN_K);
    const { head: shaft, tail: point } = splitAt(run, Math.max(0.1, total - headLen));

    if (shaft.length >= 2) {
        const g = buildStrip(shaft, t => half * (TAIL_TAPER + (1 - TAIL_TAPER) * t), lift, terrain);
        if (g) geos.push(g);
    }
    if (point.length >= 2) {
        const headHalf = (widthM * HEAD_WIDTH_K) / 2 + grow;
        // widen the very first row slightly past the shaft so the barbs read as a wedge
        const g = buildStrip(point, t => headHalf * Math.max(0.001, 1 - t), lift, terrain);
        if (g) geos.push(g);
    }
    return geos.length ? mergeGeometries(geos) : null;
}

/**
 * Build an arrow (or headless phase line) draped on the terrain.
 * @param {{x:number,z:number}[]} localPts clicked centreline, local ENU metres
 * @param {object} terrain TerrainBuilder
 * @param {object} opts { widthM, color, head, dashed }
 * @returns {THREE.Group|null} group with `userData` for re-drape and serialisation
 */
export function buildDrapedArrow(localPts, terrain, opts = {}) {
    const { widthM = 24, color = SIDE_COLORS.red, head = true, dashed = false, sampleM = SAMPLE_M } = opts;
    const smooth = smoothPath(localPts, sampleM);
    if (!smooth) return null;
    const runs = clipPolyline(smooth);
    if (!runs.length) return null;

    const group = new THREE.Group();
    group.name = head ? 'arrow' : 'phase-line';
    const dash = dashed ? [Math.max(8, widthM * 1.2), Math.max(5, widthM * 0.8)] : null;

    const addLayer = (grow, lift, col, renderOrder) => {
        const geos = runs
            .map(r => buildRunGeometry(r, widthM, grow, lift, terrain, head, dash))
            .filter(Boolean);
        if (!geos.length) return;
        // depthWrite off: the outline and the fill sit ~5 cm apart, which the depth
        // buffer cannot separate at multi-kilometre view distances — without this they
        // z-fight into stripes. They still depth-test against the terrain, and
        // renderOrder keeps the fill on top of its outline.
        const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({
            color: col, side: THREE.DoubleSide, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        }));
        mesh.userData.liftM = lift;
        mesh.renderOrder = renderOrder;
        group.add(mesh);
    };

    addLayer(Math.max(1.2, widthM * 0.09), OUTLINE_LIFT, 0x0b1120, 1); // outline
    addLayer(0, ARROW_LIFT, color, 2);                                  // fill
    if (!group.children.length) return null;

    group.userData = {
        kind: head ? 'arrow' : 'phaseLine',
        points: localPts.map(p => ({ x: p.x, z: p.z })),
        opts: { widthM, color, head, dashed }
    };
    return group;
}

// Rebuild after the exaggeration slider moves: per-vertex re-drape of both layers.
export function reDrapeArrow(group, terrain) {
    group.children.forEach(mesh => {
        const pos = mesh.geometry.attributes.position;
        const lift = mesh.userData.liftM || 0;
        for (let i = 0; i < pos.count; i++) {
            pos.setY(i, terrain.sampleHeight(pos.getX(i), pos.getZ(i)) + lift);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
    });
}

// Linear obstacle belts: dragon's teeth, barbed-wire concertina and anti-tank ditches.
//
// All three are drawn as a polyline and follow the ground. Teeth are one InstancedMesh
// per lane (the vegetation-layer pattern); the concertina is a TubeGeometry swept over a
// helix around the draped centreline; the ditch is a cross-section swept along it.
//
// A belt can carry several components at once — real fortification lines are built as a
// single complex obstacle, several elements dug and strung in parallel. Each component
// occupies one or more *lanes*, and a lane is just the same builder fed a laterally
// shifted copy of the path (`offsetRun`), so the builders themselves know nothing about
// belts. `laneLayout()` is the only place the arrangement lives.
//
// Re-draping rebuilds the belt from `group.userData.points` rather than shifting
// vertices — the helix and the per-instance rotations both depend on the terrain, and a
// belt is cheap to rebuild.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clipPolyline, resamplePolyline } from '../ribbon.js';

const MAX_BELT_M = 1500;      // vertex-count guard on a single drawn belt

// Teeth
const TOOTH_H = 1.15;
const TOOTH_BASE = 0.75;
const TOOTH_SPACING = 2.0;
const TOOTH_ROWS = [-2.2, 0, 2.2];
const TOOTH_SINK = 0.25;

// Anti-tank ditch
const DITCH_HALF = 3.0;       // half-width at ground level
const DITCH_DEPTH = 3.0;
const DITCH_BERM_W = 2.4;
const DITCH_BERM_H = 1.2;
const DITCH_STEP = 6.0;       // centreline resample — the trough is a smooth sweep

// Wire
const COIL_RADIUS = 0.55;
const COIL_PITCH = 1.2;       // metres of advance per turn
const COIL_TUBE = 0.045;
const STAKE_SPACING = 3.0;
// A full belt carries ~20 wire lanes, so coil tessellation is the single biggest
// triangle cost in the scene. 6 samples per turn on a 3-sided tube is visually
// indistinguishable beyond a few metres and roughly halves the geometry.
const COIL_SAMPLES_PER_TURN = 6;
const COIL_RADIAL = 3;

// Clip to the sector, resample, and attach ground height to every point.
function drapedPath(localPts, terrain, stepM) {
    const runs = clipPolyline(localPts);
    return runs.map(run => resamplePolyline(run, stepM).map(p => ({
        x: p.x, z: p.z, y: terrain.sampleHeight(p.x, p.z)
    }))).filter(r => r.length >= 2);
}

function tangentAt(pts, i) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    return { dx: dx / len, dz: dz / len };
}

function totalLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return d;
}

// Shift a draped run sideways along its own normal, re-grounding as it goes. This is how
// one drawn line becomes many parallel lanes without any builder knowing about it.
function offsetRun(pts, offsetM, terrain) {
    return pts.map((p, i) => {
        const { dx, dz } = tangentAt(pts, i);
        const x = p.x - dz * offsetM;
        const z = p.z + dx * offsetM;
        return { x, z, y: terrain.sampleHeight(x, z) };
    });
}

// ── dragon's teeth ──────────────────────────────────────────────────────────

function buildTeeth(runs, terrain, scale) {
    const slots = [];
    runs.forEach(pts => {
        pts.forEach((p, i) => {
            const { dx, dz } = tangentAt(pts, i);
            const nx = -dz, nz = dx;
            TOOTH_ROWS.forEach((off, row) => {
                // stagger every other row half a spacing along the path
                const shift = (row % 2) ? TOOTH_SPACING * scale * 0.5 : 0;
                const x = p.x + nx * off * scale + dx * shift;
                const z = p.z + nz * off * scale + dz * shift;
                slots.push({ x, z, ry: Math.atan2(dx, dz) });
            });
        });
    });
    if (!slots.length) return null;

    const h = TOOTH_H * scale, base = TOOTH_BASE * scale;
    const geometry = new THREE.CylinderGeometry(base * 0.28, base, h, 4);
    geometry.translate(0, h / 2 - TOOTH_SINK * scale, 0);
    const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xb8b4ad, roughness: 0.95, metalness: 0 }),
        slots.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    slots.forEach((s, i) => {
        const k = 0.85 + Math.random() * 0.3;
        pos.set(s.x, terrain.sampleHeight(s.x, s.z), s.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.ry + Math.PI / 4);
        scl.set(k, k * (0.9 + Math.random() * 0.25), k);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
        const g = 0.72 + Math.random() * 0.25;
        mesh.setColorAt(i, color.setRGB(g, g * 0.99, g * 0.95));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
}

// ── barbed wire ─────────────────────────────────────────────────────────────

// A helix wound around a draped polyline, sampled by arclength.
class ConcertinaCurve extends THREE.Curve {
    constructor(pts, radius, pitch, liftY) {
        super();
        this.pts = pts;
        this.radius = radius;
        this.pitch = pitch;
        this.liftY = liftY;
        this.cum = [0];
        for (let i = 1; i < pts.length; i++) {
            this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
        }
        this.length = this.cum[this.cum.length - 1];
    }
    getPoint(t, target = new THREE.Vector3()) {
        const d = t * this.length;
        let i = 1;
        while (i < this.cum.length - 1 && this.cum[i] < d) i++;
        const a = this.pts[i - 1], b = this.pts[i];
        const seg = this.cum[i] - this.cum[i - 1];
        const f = seg > 0 ? (d - this.cum[i - 1]) / seg : 0;
        const x = a.x + (b.x - a.x) * f;
        const z = a.z + (b.z - a.z) * f;
        const y = a.y + (b.y - a.y) * f;
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const angle = (d / this.pitch) * Math.PI * 2;
        return target.set(
            x - dz * Math.cos(angle) * this.radius,
            y + this.liftY + Math.sin(angle) * this.radius,
            z + dx * Math.cos(angle) * this.radius
        );
    }
}

function buildWire(runs, terrain, scale) {
    const group = new THREE.Group();
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.6, metalness: 0.5 });
    const stakeSlots = [];
    const tubes = [];
    const radius = COIL_RADIUS * scale, pitch = COIL_PITCH * scale;

    runs.forEach(pts => {
        const curve = new ConcertinaCurve(pts, radius, pitch, radius + 0.15 * scale);
        if (curve.length < 2) return;
        const turns = curve.length / pitch;
        const segments = Math.min(4000, Math.max(24, Math.round(turns * COIL_SAMPLES_PER_TURN)));
        tubes.push(new THREE.TubeGeometry(curve, segments, COIL_TUBE * scale, COIL_RADIAL, false));

        let acc = 0;
        for (let i = 1; i < pts.length; i++) {
            acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
            if (acc >= STAKE_SPACING * scale) { acc = 0; stakeSlots.push(pts[i]); }
        }
    });

    // Every coil in the belt becomes one mesh — a belt's wire lanes are all passed in
    // together, so this collapses ~20 draw calls (and 20 shadow draws) into one.
    if (tubes.length) {
        const merged = tubes.length === 1 ? tubes[0] : mergeGeometries(tubes);
        if (tubes.length > 1) tubes.forEach(t => t.dispose());
        const tube = new THREE.Mesh(merged, wireMat);
        tube.castShadow = true;
        group.add(tube);
    }

    if (stakeSlots.length) {
        const geo = new THREE.CylinderGeometry(0.05 * scale, 0.07 * scale, 1.7 * scale, 5);
        geo.translate(0, 0.7 * scale, 0);
        const stakes = new THREE.InstancedMesh(
            geo, new THREE.MeshStandardMaterial({ color: 0x5c5346, roughness: 1 }), stakeSlots.length);
        stakes.castShadow = true;
        const m = new THREE.Matrix4();
        stakeSlots.forEach((p, i) => {
            m.makeTranslation(p.x, terrain.sampleHeight(p.x, p.z), p.z);
            stakes.setMatrixAt(i, m);
        });
        stakes.instanceMatrix.needsUpdate = true;
        group.add(stakes);
    }
    return group.children.length ? group : null;
}

// ── anti-tank ditch ─────────────────────────────────────────────────────────

// Cross-section swept along the path: [across-path offset, height vs ground].
// A trapezoidal trough with the spoil heaped into a berm on one side, which is how
// an anti-tank ditch is actually dug — the berm is the giveaway that reads in a still.
const DITCH_PROFILE = [
    [-(DITCH_HALF + DITCH_BERM_W), DITCH_BERM_H],   // berm crest (spoil side)
    [-DITCH_HALF, 0],                                // near lip
    [-DITCH_HALF * 0.35, -DITCH_DEPTH],              // floor
    [DITCH_HALF * 0.35, -DITCH_DEPTH],               // floor
    [DITCH_HALF, 0]                                  // far lip
];

// Sweep the profile along each run, emitting one longitudinal quad strip per profile
// edge. Each vertex is grounded on the terrain, so the trough follows the relief.
// Per-profile-band shading: freshly turned spoil on the berm is dry and pale, the
// trough floor sits in its own shadow. Baking this in as vertex colour means the cut
// reads at any sun angle and from any camera, not just a raking one.
const DITCH_SHADE = [1.18, 0.95, 0.5, 0.5, 0.85];

// `mirror` flips the profile across the centreline so a ditch on the right-hand flank
// throws its spoil berm outboard, making a two-sided belt read symmetrically.
function buildDitch(runs, terrain, scale, mirror = false) {
    const positions = [], indices = [], uvs = [], colors = [];
    const flip = mirror ? -1 : 1;
    let base = 0;

    runs.forEach(pts => {
        if (pts.length < 2) return;
        const rows = pts.length, cols = DITCH_PROFILE.length;
        let along = 0;

        for (let i = 0; i < rows; i++) {
            const p = pts[i];
            const { dx, dz } = tangentAt(pts, i);
            const nx = -dz, nz = dx;
            if (i > 0) along += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);

            for (let c = 0; c < cols; c++) {
                // Mirroring negates the across-path offset, which would also reverse the
                // quad winding and light the trough from underneath — so walk the profile
                // backwards at the same time, keeping the offsets ascending either way.
                const pi = mirror ? cols - 1 - c : c;
                const [off, dy] = DITCH_PROFILE[pi];
                const x = p.x + nx * off * flip * scale;
                const z = p.z + nz * off * flip * scale;
                // ground height is sampled at each profile point, not at the centreline,
                // so the cut stays true across a side-slope
                positions.push(x, terrain.sampleHeight(x, z) + dy * scale, z);
                uvs.push(c / (cols - 1), along / 12);
                const k = DITCH_SHADE[pi];
                colors.push(k, k * 0.96, k * 0.88);
            }
        }
        for (let i = 0; i < rows - 1; i++) {
            for (let c = 0; c < cols - 1; c++) {
                const a = base + i * cols + c, b = a + 1;
                const d = base + (i + 1) * cols + c, e = d + 1;
                indices.push(a, d, b, b, d, e);
            }
        }
        base += rows * cols;
    });
    if (!indices.length) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Flat shading is what makes the cut read: smooth normals blur the lip and the
    // berm crest into one soft band, so the trough looks like a painted stripe.
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0x6b5b45, vertexColors: true, roughness: 1, metalness: 0,
        side: THREE.DoubleSide, flatShading: true
    }));
    mesh.castShadow = true;      // the berm and the far lip shade the trough
    mesh.receiveShadow = true;
    return mesh;
}

// ── public API ──────────────────────────────────────────────────────────────

const STEP_M = { teeth: TOOTH_SPACING, wire: 1.0, ditch: DITCH_STEP };
const BUILDERS = { teeth: buildTeeth, wire: buildWire, ditch: buildDitch };

const COILS_PER_LANE = 3;     // a wire lane is a group of parallel coils, as built
const COIL_LANE_GAP = 4.0;    // metres between coils within one group
export const DEFAULT_BELT_WIDTH = 30;
export const MAX_DITCHES = 3;

/**
 * Derive the lanes of a composite belt.
 *
 * Ditches are the backbone: how many there are decides the whole cross-section. Working
 * from the enemy side toward the friendly side, the belt is an ordered list of slots one
 * Width apart —
 *
 *   0 ditches   teeth+wire
 *   1 ditch     ditch · teeth+wire
 *   2 ditches   ditch · teeth+wire · ditch
 *   3 ditches   ditch · teeth+wire · ditch · wire · ditch
 *
 * built by: lay the ditches out; insert the teeth just behind the forward ditch; drop a
 * wire lane into any gap left between two adjacent ditches; optionally bookend the whole
 * thing with wire. Offsets come from the slot index, measured from the teeth (so the
 * drawn line is always the teeth centreline) or from the leading slot when there are no
 * teeth — which puts a lone ditch exactly on the line the user drew.
 *
 * Wire also threads between the tooth rows whenever both are present: infantry is the
 * threat wire answers, so it belongs on the teeth rather than strewn through every gap.
 *
 * @returns {{type: string, offset: number, mirror?: boolean}[]}
 */
function laneLayout(opts) {
    // opts always arrives resolved by migrateBeltOpts, so components holds only the
    // non-ditch elements and the ditches are a count
    const components = opts.components || [];
    const hasTeeth = components.includes('teeth');
    const hasWire = components.includes('wire');
    const scale = opts.scale || 1;
    const width = opts.width || DEFAULT_BELT_WIDTH;
    const ditchCount = Math.max(0, Math.min(MAX_DITCHES, opts.ditchCount ?? 0));
    // One handedness for every ditch: a belt faces one way, so all the spoil goes to the
    // same side. 'right' means the friendly side is at positive offsets.
    const mirror = (opts.friendlySide || 'right') === 'right';

    const slots = Array.from({ length: ditchCount }, () => 'ditch');
    if (hasTeeth) slots.splice(ditchCount ? 1 : 0, 0, 'teeth');
    if (hasWire) {
        for (let i = slots.length - 1; i > 0; i--) {
            if (slots[i] === 'ditch' && slots[i - 1] === 'ditch') slots.splice(i, 0, 'wire');
        }
        if (opts.wireFront) slots.unshift('wire');
        if (opts.wireBehind) slots.push('wire');
    }
    // wire ticked on its own has no slots at all — fall back to a single centreline coil
    if (!slots.length) return hasWire ? [{ type: 'wire', offset: 0 }] : [];

    const ref = hasTeeth ? slots.indexOf('teeth') : 0;
    const lanes = [];
    slots.forEach((type, i) => {
        const offset = (i - ref) * width;
        if (type === 'wire') {
            // a wire slot is a group of parallel coils, as they are actually strung
            for (let c = 0; c < COILS_PER_LANE; c++) {
                lanes.push({
                    type: 'wire',
                    offset: offset + (c - (COILS_PER_LANE - 1) / 2) * COIL_LANE_GAP * scale
                });
            }
        } else if (type === 'ditch') {
            lanes.push({ type: 'ditch', offset, mirror });
        } else {
            lanes.push({ type: 'teeth', offset });
        }
    });

    if (hasTeeth && hasWire) {
        for (let i = 0; i < TOOTH_ROWS.length - 1; i++) {
            lanes.push({ type: 'wire', offset: (TOOTH_ROWS[i] + TOOTH_ROWS[i + 1]) / 2 * scale });
        }
    }
    return lanes;
}

function populate(group, terrain) {
    const { points, opts } = group.userData;
    const scale = opts.scale || 1;
    let built = 0;

    // Lanes of the same type and handedness are built in one call, so a builder can
    // merge them: `buildWire` in particular collapses every coil in the belt into a
    // single mesh instead of one draw call per lane.
    const batches = new Map();
    laneLayout(opts).forEach(lane => {
        const step = (STEP_M[lane.type] ?? 1.0) * scale;
        let runs = drapedPath(points, terrain, step);
        // guard against a single enormous drag blowing up vertex counts (per lane, so a
        // belt's budget scales with how many components it actually carries)
        let budget = MAX_BELT_M;
        runs = runs.filter(r => {
            if (budget <= 0) return false;
            budget -= totalLength(r);
            return true;
        });
        if (!runs.length) return;
        if (lane.offset) runs = runs.map(r => offsetRun(r, lane.offset, terrain));

        const key = `${lane.type}:${lane.mirror ? 1 : 0}`;
        const batch = batches.get(key);
        if (batch) batch.runs.push(...runs);
        else batches.set(key, { type: lane.type, mirror: lane.mirror, runs: [...runs] });
    });

    batches.forEach(({ type, mirror, runs }) => {
        const mesh = (BUILDERS[type] || buildWire)(runs, terrain, scale, mirror);
        if (mesh) { group.add(mesh); built++; }
    });
    return built > 0;
}

/**
 * @param {{x:number,z:number}[]} localPts drawn centreline, local ENU metres
 * @param {object} terrain TerrainBuilder
 * @param {object} opts {
 *     type,                  // single-component fallback, and what older saves carry
 *     components,            // ['wire','teeth','ditch'] — any combination
 *     scale,                 // object size; real obstacles are ~1 m tall and vanish in a
 *                            // multi-km overview shot (vegetation does the same for trees)
 *     width,                 // metres from the centreline to the outer ditch lane
 *     ditchesPerSide,        // 1 | 2
 *     ditchSide              // 'left' | 'both' | 'right'
 *   }
 *
 * Options are stored as *semantics*, never as derived lane geometry, so a saved belt
 * rebuilds correctly even if the layout rules change. Obstacles are passive: they belong
 * to no side, so there is deliberately no `side`.
 */
export function buildObstacleBelt(localPts, terrain, opts = {}) {
    const type = STEP_M[opts.type] ? opts.type : 'wire';
    const resolved = migrateBeltOpts(opts, type);
    const group = new THREE.Group();
    const label = resolved.components.length + (resolved.ditchCount ? 1 : 0) > 1
        ? 'belt' : (resolved.components[0] || (resolved.ditchCount ? 'ditch' : type));
    group.name = `obstacle-${label}`;
    group.userData = {
        kind: 'obstacle',
        points: localPts.map(p => ({ x: p.x, z: p.z })),
        opts: resolved
    };
    return populate(group, terrain) ? group : null;
}

/**
 * Normalise belt options, accepting three vintages of saved data:
 *   - current:  { components: ['wire','teeth'], ditchCount, friendlySide, … }
 *   - previous: ditches lived in `components` with `ditchesPerSide` / `ditchSide`
 *   - pre-belt: just { type, scale }
 */
function migrateBeltOpts(opts, type) {
    let components = (opts.components || []).filter(c => c === 'wire' || c === 'teeth');
    let ditchCount = opts.ditchCount;

    if (ditchCount === undefined) {
        const legacy = opts.components || [type];
        // the previous round counted ditches per flank; treat that as the total
        ditchCount = legacy.includes('ditch') ? (opts.ditchesPerSide || 1) : 0;
        if (!opts.components) components = legacy.filter(c => c === 'wire' || c === 'teeth');
    }
    // a bare {type:'wire'|'teeth'} save has no components array at all
    if (!components.length && !ditchCount && type !== 'ditch') components = [type];
    if (!components.length && !ditchCount && type === 'ditch') ditchCount = 1;

    return {
        type,
        components,
        ditchCount: Math.max(0, Math.min(MAX_DITCHES, ditchCount)),
        friendlySide: opts.friendlySide || 'right',
        wireFront: !!opts.wireFront,
        wireBehind: !!opts.wireBehind,
        scale: opts.scale || 1,
        width: opts.width || DEFAULT_BELT_WIDTH
    };
}

export function reDrapeObstacle(group, terrain) {
    [...group.children].forEach(child => {
        group.remove(child);
        child.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    });
    populate(group, terrain);
}

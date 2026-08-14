// Staged building destruction, rubble, scorch and craters.
//
// Buildings live in merged meshes (all walls of one texture style in one BufferGeometry),
// so "destroying" one means rewriting its vertex range in place — collapsing triangles to
// a point makes them zero-area and therefore invisible, with no geometry rebuild. The
// pre-damage vertices are snapshotted into `record._orig` on first mutation (so memory is
// proportional to what you actually destroy) and restored on undo.
//
// States: 0 = intact, 1 = damaged (roof gone, walls broken down to ~60 %), 2 = rubble.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildDrapedOverlay } from '../ribbon.js';

const CUT_FRACTION = 0.6;     // damaged walls survive to this fraction of their height
const JITTER_M = 0.8;         // ragged wall-break line
const SCORCH_TINT = 0.7;      // vertex-colour multiplier on damaged walls

// Deterministic per-vertex pseudo-random in [0,1) — the same index always jitters the
// same way, so re-applying a state (undo/redo, load) reproduces the exact same ruin.
function hashRand(i) {
    const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
}

function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
}

function ringBounds(ring) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    ring.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    });
    return { minX, maxX, minZ, maxZ };
}

// A disc that follows the terrain (fan of ring segments, each vertex sampled).
export function buildDrapedDisc(x, z, radius, terrain, color, opacity = 0.85, lift = 0.12) {
    const RINGS = 3, SEGMENTS = 24;
    const positions = [], indices = [];
    const push = (px, pz) => {
        positions.push(px, terrain.sampleHeight(px, pz) + lift, pz);
        return positions.length / 3 - 1;
    };
    const center = push(x, z);
    const rows = [];
    for (let r = 1; r <= RINGS; r++) {
        const rr = radius * (r / RINGS);
        const row = [];
        for (let s = 0; s < SEGMENTS; s++) {
            const a = (s / SEGMENTS) * Math.PI * 2;
            row.push(push(x + Math.cos(a) * rr, z + Math.sin(a) * rr));
        }
        rows.push(row);
    }
    for (let s = 0; s < SEGMENTS; s++) {
        const n = (s + 1) % SEGMENTS;
        indices.push(center, rows[0][n], rows[0][s]);
        for (let r = 0; r < RINGS - 1; r++) {
            indices.push(rows[r][s], rows[r][n], rows[r + 1][s]);
            indices.push(rows[r][n], rows[r + 1][n], rows[r + 1][s]);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    }));
    mesh.userData.liftM = lift;
    mesh.userData.drapedPerVertex = true;
    return mesh;
}

// Scatter `count` chunks inside a footprint, merged into one mesh. Per-piece vertex
// ranges are kept in userData.pieces so reDrape can shift each chunk independently.
function buildRubble(footprint, terrain, count, maxSize, colorBase) {
    const { minX, maxX, minZ, maxZ } = ringBounds(footprint);
    const geos = [], pieces = [];
    let offset = 0;
    let guard = 0;
    while (geos.length < count && guard++ < count * 12) {
        const x = minX + Math.random() * (maxX - minX);
        const z = minZ + Math.random() * (maxZ - minZ);
        if (!pointInRing(x, z, footprint)) continue;
        const s = maxSize * (0.35 + Math.random() * 0.65);
        const geo = new THREE.BoxGeometry(s, s * (0.3 + Math.random() * 0.5), s * (0.6 + Math.random() * 0.8))
            .toNonIndexed();
        geo.rotateY(Math.random() * Math.PI);
        geo.rotateX((Math.random() - 0.5) * 0.5);
        const y = terrain.sampleHeight(x, z);
        geo.translate(x, y + s * 0.15, z);

        const shade = colorBase * (0.6 + Math.random() * 0.5);
        const n = geo.attributes.position.count;
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            colors[i * 3] = shade; colors[i * 3 + 1] = shade * 0.94; colors[i * 3 + 2] = shade * 0.85;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        geos.push(geo);
        pieces.push({ start: offset, count: n, x, z, groundY: y });
        offset += n;
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos);
    geos.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1, metalness: 0
    }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pieces = pieces;
    return mesh;
}

// Re-ground rubble / scorch / crater geometry after the exaggeration slider moves.
// Three flavours, tagged by userData: per-vertex draped discs, merged rubble with
// per-chunk vertex ranges, and plain objects positioned at a single ground point.
export function reDrapeDebris(root, terrain) {
    root.traverse(o => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        if (o.userData.drapedPerVertex) {
            const lift = o.userData.liftM || 0;
            for (let i = 0; i < pos.count; i++) {
                pos.setY(i, terrain.sampleHeight(pos.getX(i), pos.getZ(i)) + lift);
            }
            pos.needsUpdate = true;
        } else if (o.userData.pieces) {
            o.userData.pieces.forEach(p => {
                const y = terrain.sampleHeight(p.x, p.z);
                const delta = y - p.groundY;
                if (!delta) return;
                for (let i = p.start; i < p.start + p.count; i++) pos.setY(i, pos.getY(i) + delta);
                p.groundY = y;
            });
            pos.needsUpdate = true;
        } else if (o.userData.localX !== undefined) {
            o.position.y = terrain.sampleHeight(o.userData.localX, o.userData.localZ);
        }
        o.geometry.computeBoundingSphere();
    });
}

export class Damage {
    constructor(buildings, terrain, proj) {
        this.buildings = buildings;
        this.terrain = terrain;
        this.proj = proj;
        this.group = new THREE.Group();
        this.group.name = 'sandbox-damage';
        this.debris = new Map();   // record.id → Group of rubble/scorch for that building
        this.craters = [];
    }

    // ── building damage ────────────────────────────────────────────────────

    _snapshot(record) {
        if (record._orig) return;
        const wallPos = this.buildings.wallMeshes[record.wallStyle].geometry.attributes;
        const roofPos = this.buildings.roofMeshes[record.roofStyle].geometry.attributes;
        const slice = (attr, start, count) =>
            attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize);
        record._orig = {
            baseY: record.baseY,
            wallPos: slice(wallPos.position, record.wallStart, record.wallCount),
            roofPos: slice(roofPos.position, record.roofStart, record.roofCount),
            wallColor: wallPos.color && slice(wallPos.color, record.wallStart, record.wallCount)
        };
    }

    _restoreOriginal(record) {
        const orig = record._orig;
        if (!orig) return;
        const wallAttrs = this.buildings.wallMeshes[record.wallStyle].geometry.attributes;
        const roofAttrs = this.buildings.roofMeshes[record.roofStyle].geometry.attributes;
        // The terrain may have been re-draped since the snapshot; shift it back into place.
        const shift = record.baseY - orig.baseY;
        for (let i = 0; i < record.wallCount; i++) {
            const s = i * 3;
            wallAttrs.position.setXYZ(record.wallStart + i,
                orig.wallPos[s], orig.wallPos[s + 1] + shift, orig.wallPos[s + 2]);
        }
        for (let i = 0; i < record.roofCount; i++) {
            const s = i * 3;
            roofAttrs.position.setXYZ(record.roofStart + i,
                orig.roofPos[s], orig.roofPos[s + 1] + shift, orig.roofPos[s + 2]);
        }
        if (orig.wallColor && wallAttrs.color) {
            for (let i = 0; i < record.wallCount; i++) {
                const s = i * 3;
                wallAttrs.color.setXYZ(record.wallStart + i,
                    orig.wallColor[s], orig.wallColor[s + 1], orig.wallColor[s + 2]);
            }
            wallAttrs.color.needsUpdate = true;
        }
        wallAttrs.position.needsUpdate = true;
        roofAttrs.position.needsUpdate = true;
    }

    _collapseRange(attr, start, count, x, y, z) {
        for (let i = start; i < start + count; i++) attr.setXYZ(i, x, y, z);
        attr.needsUpdate = true;
    }

    /**
     * Apply damage state 0 (intact) / 1 (damaged) / 2 (rubble). Idempotent — always
     * restores the original geometry first, so it doubles as the undo path.
     */
    setState(record, state) {
        this._snapshot(record);
        this._restoreOriginal(record);
        this._clearDebris(record);

        const wallMesh = this.buildings.wallMeshes[record.wallStyle];
        const roofMesh = this.buildings.roofMeshes[record.roofStyle];
        const wallPos = wallMesh.geometry.attributes.position;
        const roofPos = roofMesh.geometry.attributes.position;
        const wallColor = wallMesh.geometry.attributes.color;
        const { x: cx, z: cz } = record.centroid;

        if (state >= 1) {
            // roof gone
            this._collapseRange(roofPos, record.roofStart, record.roofCount, cx, record.baseY, cz);
        }
        if (state === 1) {
            const cut = record.baseY + (record.wallTopY - record.baseY) * CUT_FRACTION;
            for (let i = record.wallStart; i < record.wallStart + record.wallCount; i++) {
                const y = wallPos.getY(i);
                if (y > cut) wallPos.setY(i, cut + (hashRand(i) - 0.5) * 2 * JITTER_M);
                if (wallColor) {
                    wallColor.setXYZ(i,
                        wallColor.getX(i) * SCORCH_TINT,
                        wallColor.getY(i) * SCORCH_TINT,
                        wallColor.getZ(i) * SCORCH_TINT);
                }
            }
            wallPos.needsUpdate = true;
            if (wallColor) wallColor.needsUpdate = true;
        }
        if (state === 2) {
            this._collapseRange(wallPos, record.wallStart, record.wallCount, cx, record.baseY, cz);
        }

        wallMesh.geometry.computeBoundingSphere();
        roofMesh.geometry.computeBoundingSphere();
        if (state >= 1) this._addDebris(record, state);

        this._setWalkable(record, state === 2);
        record.damage = state;
        return state;
    }

    // Advance intact → damaged → rubble. Returns the new state.
    hit(record) {
        return this.setState(record, Math.min(2, (record.damage || 0) + 1));
    }

    // Scorched ground clipped to the building's own outline (a circle would swallow
    // the neighbours on any large or L-shaped footprint). Reuses the terrain-grid
    // draped overlay builder, which needs [lng,lat] rings.
    _scorchMesh(record, expandM, color, opacity) {
        const c = record.centroid;
        const ring = record.footprint.map(p => {
            const dx = p.x - c.x, dz = p.z - c.z;
            const len = Math.hypot(dx, dz) || 1;
            const { lat, lng } = this.proj.toLatLng(p.x + dx / len * expandM, p.z + dz / len * expandM);
            return [lng, lat];
        });
        const mesh = buildDrapedOverlay([ring], this.terrain, this.proj, color, opacity, 0.18);
        if (mesh) mesh.userData.drapedPerVertex = true;
        return mesh;
    }

    _addDebris(record, state) {
        const group = new THREE.Group();
        group.userData.recordId = record.id;
        const { minX, maxX, minZ, maxZ } = ringBounds(record.footprint);
        const span = Math.max(maxX - minX, maxZ - minZ);

        if (state === 2) {
            const scorch = this._scorchMesh(record, 3, 0x2a2320, 0.8);
            if (scorch) group.add(scorch);
        }
        const rubble = buildRubble(record.footprint, this.terrain,
            state === 2 ? Math.min(120, 20 + Math.round(span * 1.5)) : Math.min(20, 6 + Math.round(span * 0.4)),
            state === 2 ? Math.min(4.5, 1.8 + span * 0.06) : 1.6,
            state === 2 ? 0.52 : 0.45);
        if (rubble) group.add(rubble);

        this.group.add(group);
        this.debris.set(record.id, group);
    }

    _clearDebris(record) {
        const group = this.debris.get(record.id);
        if (!group) return;
        this.group.remove(group);
        group.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        this.debris.delete(record.id);
    }

    // A flattened building no longer blocks the walk-mode player.
    _setWalkable(record, walkable) {
        const list = this.buildings.footprints;
        const i = list.indexOf(record.footprint);
        if (walkable && i !== -1) list.splice(i, 1);
        else if (!walkable && i === -1) list.push(record.footprint);
    }

    // ── craters ────────────────────────────────────────────────────────────

    addCrater(x, z, radius) {
        const group = new THREE.Group();
        group.name = 'crater';

        group.add(buildDrapedDisc(x, z, radius, this.terrain, 0x1c1712, 0.9));
        group.add(buildDrapedDisc(x, z, radius * 1.55, this.terrain, 0x3a3229, 0.45, 0.1));

        // spall ring: a shallow lathe lip around the hole
        const profile = [];
        for (let i = 0; i <= 5; i++) {
            const t = i / 5;
            profile.push(new THREE.Vector2(radius * (0.85 + 0.5 * t), Math.sin(Math.PI * t) * radius * 0.12));
        }
        const lip = new THREE.Mesh(new THREE.LatheGeometry(profile, 20),
            new THREE.MeshStandardMaterial({ color: 0x4a4034, roughness: 1 }));
        lip.position.set(x, this.terrain.sampleHeight(x, z), z);
        lip.receiveShadow = true;
        lip.userData.localX = x;
        lip.userData.localZ = z;
        group.add(lip);

        const rocks = buildRubble(
            [{ x: x - radius, z: z - radius }, { x: x + radius, z: z - radius },
             { x: x + radius, z: z + radius }, { x: x - radius, z: z + radius }],
            this.terrain, 8, Math.max(0.6, radius * 0.14), 0.45);
        if (rocks) group.add(rocks);

        group.userData = { kind: 'crater', localX: x, localZ: z, radius };
        this.group.add(group);
        this.craters.push(group);
        return group;
    }

    removeCrater(group) {
        this.group.remove(group);
        const i = this.craters.indexOf(group);
        if (i !== -1) this.craters.splice(i, 1);
        group.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    reDrape(terrain) {
        reDrapeDebris(this.group, terrain);
    }

    // Every currently damaged building, for serialisation.
    serialize() {
        return this.buildings.records
            .filter(r => r.damage)
            .map(r => ({ id: r.id, state: r.damage }));
    }

    clear() {
        this.buildings.records.forEach(r => { if (r.damage) this.setState(r, 0); });
        [...this.craters].forEach(c => this.removeCrater(c));
    }
}

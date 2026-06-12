// Instanced grass tufts scattered over meadow/grass/farmland polygons —
// crossed alpha-tested planes with a procedural blade texture.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGrassTexture } from '../textures.js';
import { SCENE_HALF } from '../terrain.js';

const TUFT_CAP = 120000;
const STEP_DENSE = 6;    // m, meadow/grass/grassland (desired; scaled up if over budget)
const STEP_SPARSE = 13;  // m, farmland/orchard
const DENSE_TAGS = new Set(['meadow', 'grass', 'grassland']);

function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
        const intersect = ((zi > z) !== (zj > z)) &&
            (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function pointInPolygon(x, z, rings) {
    if (!pointInRing(x, z, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
        if (pointInRing(x, z, rings[i])) return false;
    }
    return true;
}

// Shoelace area of a local {x,z} ring, in m².
function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return Math.abs(area / 2);
}

// Three crossed vertical planes (60° apart) — wide patches so coverage reads continuous.
function buildTuftGeometry() {
    const planes = [0, 1, 2].map(i => {
        const p = new THREE.PlaneGeometry(2.4, 1.1).toNonIndexed();
        p.translate(0, 0.55, 0);
        p.rotateY(i * Math.PI / 3);
        return p;
    });
    return mergeGeometries(planes);
}

export class GrassFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'grass';
        this.meshes = [];
        this.placements = [];
        this.texture = null;
    }

    // mapFeatures is the shared Overpass FeatureCollection.
    async load(bbox, mapFeatures) {
        this.mapFeatures = mapFeatures;
    }

    build(terrain, proj) {
        const polygons = (this.mapFeatures?.features || []).filter(f =>
            f.geometry?.type === 'Polygon' &&
            (DENSE_TAGS.has(f.properties?.landuse) || f.properties?.natural === 'grassland' ||
                f.properties?.landuse === 'farmland' || f.properties?.landuse === 'orchard') &&
            f.geometry.coordinates[0]?.length >= 4);

        if (!polygons.length) return;

        // Per polygon: local rings, bbox clamped to the terrain plane (fields often
        // extend far beyond it — never place grass outside the visible sector), and
        // an in-bounds area estimate so off-scene field area doesn't eat the budget.
        const prepared = [];
        polygons.forEach(f => {
            const rings = f.geometry.coordinates.map(ring =>
                ring.map(([lng, lat]) => proj.toLocal(lat, lng)));
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            rings[0].forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            });
            const cMinX = Math.max(minX, -SCENE_HALF), cMaxX = Math.min(maxX, SCENE_HALF);
            const cMinZ = Math.max(minZ, -SCENE_HALF), cMaxZ = Math.min(maxZ, SCENE_HALF);
            if (cMinX >= cMaxX || cMinZ >= cMaxZ) return; // fully outside the scene
            const clipFraction = ((cMaxX - cMinX) * (cMaxZ - cMinZ)) /
                Math.max(1, (maxX - minX) * (maxZ - minZ));
            prepared.push({
                rings,
                dense: DENSE_TAGS.has(f.properties.landuse) || f.properties.natural === 'grassland',
                bounds: { minX: cMinX, maxX: cMaxX, minZ: cMinZ, maxZ: cMaxZ },
                area: ringArea(rings[0]) * clipFraction
            });
        });
        if (!prepared.length) return;

        // Scale both steps up together when the desired density would blow the budget,
        // so every field gets grass instead of the first polygons exhausting the cap.
        let denseArea = 0, sparseArea = 0;
        prepared.forEach(p => {
            if (p.dense) denseArea += p.area; else sparseArea += p.area;
        });
        const expected = denseArea / (STEP_DENSE * STEP_DENSE) + sparseArea / (STEP_SPARSE * STEP_SPARSE);
        const scale = expected > TUFT_CAP ? Math.sqrt(expected / TUFT_CAP) : 1;

        const placements = [];
        outer:
        for (const { rings, dense, bounds } of prepared) {
            const step = (dense ? STEP_DENSE : STEP_SPARSE) * scale;
            for (let x = bounds.minX; x <= bounds.maxX; x += step) {
                for (let z = bounds.minZ; z <= bounds.maxZ; z += step) {
                    if (placements.length >= TUFT_CAP) break outer; // safety net only
                    const jx = x + (Math.random() - 0.5) * step * 0.9;
                    const jz = z + (Math.random() - 0.5) * step * 0.9;
                    if (Math.abs(jx) > SCENE_HALF || Math.abs(jz) > SCENE_HALF) continue;
                    if (pointInPolygon(jx, jz, rings)) placements.push({ x: jx, z: jz });
                }
            }
        }

        this.placements = placements;
        if (!placements.length) return;

        this.texture = makeGrassTexture();
        const material = new THREE.MeshStandardMaterial({
            map: this.texture, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1.0
        });
        const mesh = new THREE.InstancedMesh(buildTuftGeometry(), material, placements.length);

        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        placements.forEach((p, i) => {
            dummy.position.set(p.x, terrain.sampleHeight(p.x, p.z), p.z);
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.scale.setScalar(0.7 + Math.random() * 0.8);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            tint.setRGB(0.75 + Math.random() * 0.4, 0.8 + Math.random() * 0.4, 0.7 + Math.random() * 0.3);
            mesh.setColorAt(i, tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.receiveShadow = true; // tufts receive but don't cast — too many for the shadow pass

        this.group.add(mesh);
        this.meshes.push(mesh);
    }

    reDrape(terrain) {
        if (!this.placements.length) return;
        const mesh = this.meshes[0];
        const dummy = new THREE.Object3D();
        this.placements.forEach((p, i) => {
            mesh.getMatrixAt(i, dummy.matrix);
            dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
            dummy.position.y = terrain.sampleHeight(p.x, p.z);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
    }

    dispose() {
        this.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        if (this.texture) this.texture.dispose();
        this.meshes = [];
        this.placements = [];
        this.texture = null;
    }
}

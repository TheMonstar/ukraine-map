import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCENE_HALF } from '../terrain.js';

const TREE_CAP = 25000;
const GRID_STEP = 12;
const TRUNK_COLOR = new THREE.Color('#6b4a2f');
const CONIFER_COLOR = new THREE.Color('#3a5a32');
const DECIDUOUS_COLOR = new THREE.Color('#5a7a3a');

function colorize(geometry, color) {
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
}

// Slightly displace crown vertices for an organic silhouette (shared across instances).
function roughen(geometry, amount) {
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(i,
            pos.getX(i) + (Math.random() - 0.5) * amount,
            pos.getY(i) + (Math.random() - 0.5) * amount,
            pos.getZ(i) + (Math.random() - 0.5) * amount);
    }
    geometry.computeVertexNormals();
    return geometry;
}

// toNonIndexed() because IcosahedronGeometry has no index while Cylinder/Cone do —
// mergeGeometries requires all inputs to be either indexed or non-indexed.

// Conifer: trunk + three stacked cones, base at local origin (y=0).
function buildConiferGeometry() {
    const trunk = colorize(new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6).toNonIndexed(), TRUNK_COLOR);
    trunk.translate(0, 1.2, 0);
    const tiers = [
        [2.6, 3.4, 3.2], // [radius, height, centerY]
        [2.0, 2.8, 5.2],
        [1.3, 2.2, 6.9]
    ].map(([r, h, y], i) => {
        const cone = colorize(new THREE.ConeGeometry(r, h, 8).toNonIndexed(),
            CONIFER_COLOR.clone().offsetHSL(0, 0, i * 0.02));
        cone.translate(0, y, 0);
        return cone;
    });
    return mergeGeometries([trunk, ...tiers]);
}

// Deciduous: trunk + a cluster of roughened blobs, base at local origin (y=0).
function buildDeciduousGeometry() {
    const trunk = colorize(new THREE.CylinderGeometry(0.3, 0.5, 2.6, 6).toNonIndexed(), TRUNK_COLOR);
    trunk.translate(0, 1.3, 0);
    const blobs = [
        [2.3, 0, 4.6, 0],    // [radius, x, y, z]
        [1.6, 1.3, 3.9, 0.4],
        [1.5, -1.2, 4.1, -0.4],
        [1.3, 0.2, 5.8, 0.6]
    ].map(([r, x, y, z], i) => {
        const blob = colorize(roughen(new THREE.IcosahedronGeometry(r, 1).toNonIndexed(), r * 0.25),
            DECIDUOUS_COLOR.clone().offsetHSL(0, 0, (i % 2) * 0.03));
        blob.translate(x, y, z);
        return blob;
    });
    return mergeGeometries([trunk, ...blobs]);
}

// Ray-casting point-in-polygon test against local {x,z} rings (rings[0] = outer, rest = holes).
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

function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return Math.abs(area / 2);
}

export class VegetationFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'vegetation';
        this.meshes = [];
        this.placements = [];
        // Live uniform: trees grow about their base as the camera zooms out (set each frame).
        this.zoomScale = { value: 1 };
    }

    // Dynamic zoom compensation — bigger trees when viewed from far so the canopy
    // still reads and the terrain feels 3D. Scales the geometry, not the positions.
    setZoomScale(k) {
        this.zoomScale.value = k;
    }

    // mapFeatures is the shared Overpass FeatureCollection (already fetched for water/buildings).
    async load(bbox, mapFeatures) {
        this.mapFeatures = mapFeatures;
    }

    build(terrain, proj) {
        const polygons = (this.mapFeatures?.features || []).filter(f =>
            f.geometry?.type === 'Polygon' &&
            (f.properties?.natural === 'wood' || f.properties?.landuse === 'forest') &&
            f.geometry.coordinates[0]?.length >= 4);

        if (!polygons.length) return;

        const polyRings = polygons.map(f => f.geometry.coordinates.map(ring =>
            ring.map(([lng, lat]) => proj.toLocal(lat, lng))));

        // in-bounds area estimate — off-scene forest must not thin the on-scene trees
        let totalArea = 0;
        polyRings.forEach(rings => {
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            rings[0].forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            });
            const cw = Math.min(maxX, SCENE_HALF) - Math.max(minX, -SCENE_HALF);
            const ch = Math.min(maxZ, SCENE_HALF) - Math.max(minZ, -SCENE_HALF);
            if (cw <= 0 || ch <= 0) return;
            totalArea += ringArea(rings[0]) * (cw * ch) / Math.max(1, (maxX - minX) * (maxZ - minZ));
        });

        let step = GRID_STEP;
        if (totalArea / (step * step) > TREE_CAP) {
            step = Math.sqrt(totalArea / TREE_CAP);
        }

        // On bigger maps the cap forces wider tree spacing (sparse canopy). Scale each
        // tree up proportionally so the forest still reads as filled rather than dotted.
        const densityScale = Math.min(3, step / GRID_STEP);

        const placements = [];
        outer:
        for (const rings of polyRings) {
            const outerRing = rings[0];
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            outerRing.forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            });
            // forests often extend past the terrain plane — clamp to the visible sector
            minX = Math.max(minX, -SCENE_HALF); maxX = Math.min(maxX, SCENE_HALF);
            minZ = Math.max(minZ, -SCENE_HALF); maxZ = Math.min(maxZ, SCENE_HALF);
            for (let x = minX; x <= maxX; x += step) {
                for (let z = minZ; z <= maxZ; z += step) {
                    if (placements.length >= TREE_CAP) break outer;
                    const jx = x + (Math.random() - 0.5) * step * 0.8;
                    const jz = z + (Math.random() - 0.5) * step * 0.8;
                    if (Math.abs(jx) > SCENE_HALF || Math.abs(jz) > SCENE_HALF) continue;
                    if (pointInPolygon(jx, jz, rings)) {
                        placements.push({ x: jx, z: jz, type: Math.random() < 0.6 ? 0 : 1 });
                    }
                }
            }
        }

        this.placements = placements;
        if (!placements.length) return;

        const geometries = [buildConiferGeometry(), buildDeciduousGeometry()];
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
        // Scale each tree about its base (origin at y=0) by the live zoom uniform,
        // before the instance matrix is applied — so trees grow in place, not apart.
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uTreeScale = this.zoomScale;
            shader.vertexShader = 'uniform float uTreeScale;\n' + shader.vertexShader
                .replace('#include <begin_vertex>', 'vec3 transformed = position * uTreeScale;');
        };

        const counts = [0, 0];
        placements.forEach(p => counts[p.type]++);

        const meshes = geometries.map((geo, type) => new THREE.InstancedMesh(geo, material, Math.max(1, counts[type])));

        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        const idx = [0, 0];
        placements.forEach(p => {
            dummy.position.set(p.x, terrain.sampleHeight(p.x, p.z), p.z);
            dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
            dummy.scale.setScalar((0.7 + Math.random() * 0.6) * densityScale);
            dummy.updateMatrix();
            const i = idx[p.type]++;
            meshes[p.type].setMatrixAt(i, dummy.matrix);
            // per-tree brightness/hue jitter, multiplied with the vertex colors
            tint.setRGB(0.8 + Math.random() * 0.4, 0.8 + Math.random() * 0.4, 0.8 + Math.random() * 0.3);
            meshes[p.type].setColorAt(i, tint);
        });

        meshes.forEach((m, type) => {
            m.count = counts[type];
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.castShadow = true;
            m.receiveShadow = true;
            this.group.add(m);
            this.meshes.push(m);
        });
    }

    reDrape(terrain) {
        if (!this.placements.length) return;
        const dummy = new THREE.Object3D();
        const idx = [0, 0];
        this.placements.forEach(p => {
            const mesh = this.meshes[p.type];
            const i = idx[p.type]++;
            mesh.getMatrixAt(i, dummy.matrix);
            dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
            dummy.position.y = terrain.sampleHeight(p.x, p.z);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        this.meshes.forEach(m => m.instanceMatrix.needsUpdate = true);
    }

    dispose() {
        this.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        this.meshes = [];
        this.placements = [];
    }
}

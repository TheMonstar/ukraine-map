import * as THREE from 'three';
import { fetchMapFeatures } from '../data-sources.js';
import { buildDrapedRibbon, buildDrapedPolygon, reDrapeMesh } from '../ribbon.js';

const WATERWAY_WIDTH = { river: 20, canal: 10, stream: 5, drain: 3 };
const WATER_COLOR = 0x3b6ea5;
const NORMAL_MAP_URL = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/textures/waternormals.jpg';

// Lazily-loaded, shared across all water meshes; `false` if loading failed (no shimmer, flat color remains).
let sharedNormalMap = null;
function getNormalMap() {
    if (sharedNormalMap !== null) return sharedNormalMap || null;
    sharedNormalMap = new THREE.TextureLoader().load(
        NORMAL_MAP_URL,
        tex => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(25, 25);
        },
        undefined,
        () => { sharedNormalMap = false; }
    );
    return sharedNormalMap;
}

export class WaterFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'water';
        this.meshes = [];
    }

    // mapFeatures may be passed in if already fetched (shared with forest/buildings).
    async load(bbox, mapFeatures) {
        this.mapFeatures = mapFeatures || await fetchMapFeatures(bbox);
    }

    build(terrain, proj) {
        (this.mapFeatures?.features || []).forEach(f => {
            if (f.geometry?.type === 'LineString' && f.properties?.waterway) {
                const width = WATERWAY_WIDTH[f.properties.waterway] || 4;
                const mesh = buildDrapedRibbon(f.geometry.coordinates, width, 0.15, terrain, proj, WATER_COLOR);
                if (mesh) {
                    this._applyWaterMaterial(mesh);
                    this.group.add(mesh);
                    this.meshes.push(mesh);
                }
            } else if (f.geometry?.type === 'Polygon' && f.properties?.natural === 'water') {
                const mesh = buildDrapedPolygon(f.geometry.coordinates, terrain, proj, WATER_COLOR);
                if (mesh) {
                    this._applyWaterMaterial(mesh);
                    this.group.add(mesh);
                    this.meshes.push(mesh);
                }
            }
        });
    }

    _applyWaterMaterial(mesh) {
        mesh.material.roughness = 0.08;
        mesh.material.metalness = 0.15;
        const normalMap = getNormalMap();
        if (normalMap) {
            mesh.material.normalMap = normalMap;
            mesh.material.normalScale = new THREE.Vector2(0.4, 0.4);
            mesh.material.needsUpdate = true;
        }
    }

    // Scrolls the shared normal map to animate ripples (no-op until the texture has loaded).
    update(elapsedSeconds) {
        const tex = sharedNormalMap;
        if (tex) tex.offset.set((elapsedSeconds * 0.01) % 1, (elapsedSeconds * 0.015) % 1);
    }

    reDrape(terrain) {
        this.meshes.forEach(m => reDrapeMesh(m, terrain));
    }

    dispose() {
        this.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        this.meshes = [];
    }
}

import * as THREE from 'three';
import { fetchRoads } from '../data-sources.js';
import { buildDrapedRibbon, reDrapeMesh } from '../ribbon.js';

const STYLE_BY_HIGHWAY = {
    motorway: { width: 14, color: 0x3a3a3a },
    trunk: { width: 10, color: 0x3a3a3a },
    primary: { width: 10, color: 0x4a4540 },
    secondary: { width: 8, color: 0x4a4540 },
    tertiary: { width: 6, color: 0x4a4540 }
};
const DEFAULT_STYLE = { width: 4, color: 0x4a4540 };

export class RoadsFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'roads';
        this.meshes = [];
    }

    async load(bbox) {
        this.featureCollection = await fetchRoads(bbox);
    }

    build(terrain, proj) {
        (this.featureCollection?.features || []).forEach(f => {
            if (f.geometry?.type !== 'LineString') return;
            const style = STYLE_BY_HIGHWAY[f.properties?.highway] || DEFAULT_STYLE;
            const mesh = buildDrapedRibbon(f.geometry.coordinates, style.width, 0.3, terrain, proj, style.color);
            if (mesh) {
                this.group.add(mesh);
                this.meshes.push(mesh);
            }
        });
    }

    reDrape(terrain) {
        this.meshes.forEach(m => reDrapeMesh(m, terrain));
    }

    dispose() {
        this.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        this.meshes = [];
    }
}

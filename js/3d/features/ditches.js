import * as THREE from 'three';
import { fetchDitches } from '../data-sources.js';
import { buildDrapedRibbon, reDrapeMesh } from '../ribbon.js';

const DITCH_COLOR = 0x3d2f1f;
const DITCH_WIDTH = 4;

export class DitchesFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'ditches';
        this.meshes = [];
    }

    async load(bbox, date) {
        try {
            this.featureCollection = await fetchDitches(date, bbox);
        } catch (e) {
            console.warn('Ditches fetch failed:', e);
            this.featureCollection = { type: 'FeatureCollection', features: [] };
        }
    }

    build(terrain, proj) {
        (this.featureCollection?.features || []).forEach(f => {
            const lines = f.geometry?.type === 'LineString' ? [f.geometry.coordinates]
                : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : [];
            lines.forEach(coords => {
                const mesh = buildDrapedRibbon(coords, DITCH_WIDTH, 0.25, terrain, proj, DITCH_COLOR);
                if (mesh) {
                    this.group.add(mesh);
                    this.meshes.push(mesh);
                }
            });
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

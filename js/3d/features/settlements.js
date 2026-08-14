// Flying settlement-name labels: a camera-facing text sprite floating above each
// settlement point. Off by default; toggled via the "Settlement titles" checkbox.

import * as THREE from 'three';
import { fetchSettlements } from '../data-sources.js';
import { SCENE_HALF } from '../terrain.js';
import { makeLabelSprite } from '../sprite-label.js';

const FLOAT_HEIGHT = 80;      // meters above the terrain surface
const LABEL_WORLD_HEIGHT = 70; // sprite height in meters (sizeAttenuation on)

export class SettlementsFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'settlements';
        this.group.visible = false; // opt-in via checkbox
        this.sprites = [];
    }

    async load(bbox) {
        try {
            this.featureCollection = await fetchSettlements(bbox);
        } catch (e) {
            console.warn('Settlements fetch failed:', e);
            this.featureCollection = { type: 'FeatureCollection', features: [] };
        }
    }

    build(terrain, proj) {
        (this.featureCollection?.features || []).forEach(f => {
            const name = f.properties?.['name:en'] || f.properties?.name;
            const coords = f.geometry?.coordinates;
            if (!name || !coords) return;
            const { x, z } = proj.toLocal(coords[1], coords[0]);
            if (Math.abs(x) > SCENE_HALF || Math.abs(z) > SCENE_HALF) return;

            const sprite = makeLabelSprite(name, LABEL_WORLD_HEIGHT);
            sprite.position.set(x, terrain.sampleHeight(x, z) + FLOAT_HEIGHT, z);
            sprite.userData.localX = x;
            sprite.userData.localZ = z;
            this.group.add(sprite);
            this.sprites.push(sprite);
        });
    }

    reDrape(terrain) {
        this.sprites.forEach(s => {
            s.position.y = terrain.sampleHeight(s.userData.localX, s.userData.localZ) + FLOAT_HEIGHT;
        });
    }

    dispose() {
        this.sprites.forEach(s => { s.material.map.dispose(); s.material.dispose(); });
        this.sprites = [];
    }
}

// Flying settlement-name labels: a camera-facing text sprite floating above each
// settlement point. Off by default; toggled via the "Settlement titles" checkbox.

import * as THREE from 'three';
import { fetchSettlements } from '../data-sources.js';
import { SCENE_HALF } from '../terrain.js';

const FLOAT_HEIGHT = 80;      // meters above the terrain surface
const LABEL_WORLD_HEIGHT = 70; // sprite height in meters (sizeAttenuation on)
const FONT_PX = 48;

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Render `text` to a CanvasTexture pill and wrap it in a camera-facing Sprite.
function makeLabelSprite(text) {
    const padX = 18, padY = 12;
    const measure = document.createElement('canvas').getContext('2d');
    const font = `600 ${FONT_PX}px Inter, system-ui, sans-serif`;
    measure.font = font;
    const textW = Math.ceil(measure.measureText(text).width);

    const canvas = document.createElement('canvas');
    canvas.width = textW + padX * 2;
    canvas.height = FONT_PX + padY * 2;
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 12);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 11);
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(text, padX, canvas.height / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;

    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(LABEL_WORLD_HEIGHT * canvas.width / canvas.height, LABEL_WORLD_HEIGHT, 1);
    return sprite;
}

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

            const sprite = makeLabelSprite(name);
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

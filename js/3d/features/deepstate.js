// DeepState territory-control overlay: translucent red (occupied) and grey (grey
// zone) areas draped over the terrain. Same data source as the main map
// (js/utils.js): geojson-by-date, classified by the polygon's stroke color.
// Off by default; toggled via the "DeepState control" checkbox.

import * as THREE from 'three';
import { buildDrapedOverlay, reDrapeMesh } from '../ribbon.js';

const ENDPOINT = 'https://flask-app-kibakefmpq-ew.a.run.app/geojson-by-date';
const TERRITORY_STROKES = new Set(['#bcaaa4', '#a52714', '#880e4f']);
const GREY = 0x9ca3af;
const RED = 0xdc2626;
const OPACITY = 0.45;
const LIFT = 5; // meters above terrain

function colorFor(stroke) {
    return stroke === '#bcaaa4' ? GREY : RED;
}

export class DeepStateFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'deepstate';
        this.group.visible = false; // opt-in via checkbox
        this.meshes = [];
    }

    async load(date) {
        try {
            const res = await fetch(`${ENDPOINT}?date=${date}`);
            if (!res.ok) throw new Error(`deepstate fetch failed: ${res.status}`);
            this.data = await res.json();
        } catch (e) {
            console.warn('DeepState fetch failed:', e);
            this.data = { type: 'FeatureCollection', features: [] };
        }
    }

    build(terrain, proj) {
        (this.data?.features || []).forEach(f => {
            const stroke = (f.properties?.stroke || '').toLowerCase();
            if (!TERRITORY_STROKES.has(stroke)) return;
            const color = colorFor(stroke);
            const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates]
                : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
            polys.forEach(rings => {
                const mesh = buildDrapedOverlay(rings, terrain, proj, color, OPACITY, LIFT);
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

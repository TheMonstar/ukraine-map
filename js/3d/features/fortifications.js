// Built linear obstacles — barbed wire and dragon's teeth — from the PlayFra
// fortification datasets (`https://playframap.github.io/{wire,teeth}.geojson`), the
// same files the 2D map's "Wire" / "Dragon teeth" toggles load via
// `DeepUtils.loadFeatures` (js/utils.js).
//
// These are *surveyed* obstacles, as opposed to the ones the sandbox draw tools place
// by hand — the geometry builders are the same, only the source differs.
//
// Loading is lazy: the source files are several MB, so nothing is fetched until the
// layer's checkbox is ticked for the first time.

import * as THREE from 'three';
import { fetchPlayfraObstacles } from '../data-sources.js';
import { buildObstacleBelt, reDrapeObstacle } from '../sandbox/obstacles.js';

// Real teeth are ~1.1 m tall, i.e. sub-pixel from a multi-km overview. Positions stay
// true; only the objects standing on them are drawn larger so the belt is legible.
// Even at 3× a belt only reads from roughly 1 km and closer — zoom in for detail work.
const DISPLAY_SCALE = 3;

// A dense sector can hold hundreds of separate belts; each is one InstancedMesh, so
// cap the draw calls. Longest-first, so the cap drops only incidental fragments.
const BELT_CAP = 400;

export class FortificationsFeature {
    /** @param {'wire'|'teeth'} type — also the PlayFra file name */
    constructor(type) {
        this.type = type;
        this.group = new THREE.Group();
        this.group.name = `fortifications-${type}`;
        this.group.visible = false;   // opt-in via checkbox
        this.belts = [];
        this.state = 'idle';          // idle → loading → ready | error
    }

    // Part of the shared feature contract, but a no-op: see `ensure()`.
    async load() { }
    build() { }

    /**
     * Fetch and build on first use. Safe to call repeatedly.
     * @returns {Promise<string>} a short status line for the UI
     */
    async ensure(terrain, proj, bbox) {
        if (this.state === 'ready') return `${this.belts.length} ${this.type} belts`;
        if (this.state === 'loading') return 'loading…';
        this.state = 'loading';
        try {
            const fc = await fetchPlayfraObstacles(this.type, bbox);
            this._build(fc, terrain, proj);
            this.state = 'ready';
            return this.belts.length
                ? `${this.belts.length} ${this.type} belts in this sector`
                : `no ${this.type} mapped in this sector`;
        } catch (e) {
            console.warn(`${this.type} fetch failed:`, e);
            this.state = 'error';
            return `${this.type} data unavailable`;
        }
    }

    _build(featureCollection, terrain, proj) {
        // MultiLineString is the only geometry these files use; split into runs and
        // sort longest-first so the belt cap keeps the significant lines.
        const runs = [];
        (featureCollection?.features || []).forEach(f => {
            const g = f.geometry;
            const lines = g?.type === 'MultiLineString' ? g.coordinates
                : g?.type === 'LineString' ? [g.coordinates] : [];
            lines.forEach(coords => {
                if (coords.length >= 2) runs.push(coords);
            });
        });
        runs.sort((a, b) => b.length - a.length);

        runs.slice(0, BELT_CAP).forEach(coords => {
            const pts = coords.map(([lng, lat]) => proj.toLocal(lat, lng));
            const belt = buildObstacleBelt(pts, terrain, { type: this.type, scale: DISPLAY_SCALE });
            if (!belt) return;   // fully outside the sector
            belt.userData.source = 'playfra';
            this.group.add(belt);
            this.belts.push(belt);
        });
        if (runs.length > BELT_CAP) {
            console.info(`${this.type}: ${runs.length} lines in sector, capped at ${BELT_CAP}`);
        }
    }

    reDrape(terrain) {
        this.belts.forEach(b => reDrapeObstacle(b, terrain));
    }

    dispose() {
        this.belts.forEach(b => b.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        }));
        this.belts = [];
    }
}

// River / canal / stream name labels, lying flat on the watercourse.
//
// Analysis names rivers in transliterated English ("Bakhmutka", "Siverskyi Donets"),
// which is exactly OSM's `name:en` — present on 32 of the 35 named rivers across the
// Donbas. Small streams usually only have the local `name`, so that is the fallback,
// same convention as the settlement titles layer.
//
// OSM splits a river into many ways, so labels are grouped by name: one river gets one
// label (or a few spaced along it), not one per fragment.
//
// Labels lie flat and run along the water's local course, like a printed map label,
// flipped where needed so the text never reads mirrored from the default north-up view.

import * as THREE from 'three';
import { fetchMapFeatures } from '../data-sources.js';
import { clipPolyline } from '../ribbon.js';
import { makeLabelPlane } from '../sprite-label.js';

const LIFT = 1.2;             // metres above the ground — the label rests on it
const LABEL_HEIGHT = 45;      // label height in metres (settlement titles use 70)
const LABEL_SPACING = 1600;   // repeat a long river's name every ~1.6 km
const MIN_LENGTH = 150;       // skip watercourses barely clipping the sector
const MAX_LABELS = 24;        // clutter guard
const ACCENT = 'rgba(59, 110, 165, 0.9)';   // matches WATER_COLOR

// Rivers first, then canals, then the small stuff, when the label budget runs out.
const PRIORITY = { river: 0, canal: 1, stream: 2, drain: 3 };

function runLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return d;
}

// `count` points spread evenly along a polyline, each at the centre of its share.
function pointsAlong(pts, count) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    }
    const total = cum[cum.length - 1];
    if (total <= 0) return [pts[0]];
    const out = [];
    for (let i = 0; i < count; i++) {
        const target = total * (i + 0.5) / count;
        let seg = 1;
        while (seg < cum.length - 1 && cum[seg] < target) seg++;
        const spanned = cum[seg] - cum[seg - 1];
        const t = spanned > 0 ? (target - cum[seg - 1]) / spanned : 0;
        const a = pts[seg - 1], b = pts[seg];
        out.push({
            x: a.x + (b.x - a.x) * t,
            z: a.z + (b.z - a.z) * t,
            bearing: Math.atan2(b.x - a.x, b.z - a.z)   // local course of the water
        });
    }
    return out;
}

export class WaterLabelsFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'water-labels';
        this.group.visible = false;   // opt-in via checkbox
        this.labels = [];
    }

    async load(bbox, mapFeatures) {
        this.mapFeatures = mapFeatures || await fetchMapFeatures(bbox);
    }

    build(terrain, proj) {
        // group every in-sector fragment by the name it will be labelled with
        const byName = new Map();
        (this.mapFeatures?.features || []).forEach(f => {
            const props = f.properties;
            if (f.geometry?.type !== 'LineString' || !props?.waterway) return;
            const name = props['name:en'] || props.name;
            if (!name) return;

            const local = f.geometry.coordinates.map(([lng, lat]) => proj.toLocal(lat, lng));
            const runs = clipPolyline(local);
            if (!runs.length) return;

            let entry = byName.get(name);
            if (!entry) {
                entry = { name, runs: [], priority: PRIORITY[props.waterway] ?? 4, length: 0 };
                byName.set(name, entry);
            }
            entry.priority = Math.min(entry.priority, PRIORITY[props.waterway] ?? 4);
            runs.forEach(r => {
                entry.runs.push(r);
                entry.length += runLength(r);
            });
        });

        // rivers before streams, then longest first, so the budget goes to what matters
        const ordered = [...byName.values()]
            .filter(e => e.length >= MIN_LENGTH)
            .sort((a, b) => a.priority - b.priority || b.length - a.length);

        let budget = MAX_LABELS;
        ordered.forEach(entry => {
            if (budget <= 0) return;
            // label the longest fragment; repeat along it if the river crosses the sector
            const run = entry.runs.reduce((best, r) => runLength(r) > runLength(best) ? r : best, entry.runs[0]);
            const count = Math.min(budget, Math.max(1, Math.floor(runLength(run) / LABEL_SPACING)));
            pointsAlong(run, count).forEach(p => {
                const label = makeLabelPlane(entry.name, LABEL_HEIGHT, ACCENT);
                label.position.set(p.x, 0, p.z);
                // The plane's text runs along local +x, so yaw by the bearing measured
                // from +z. Flip 180° when the course heads west, so the text is never
                // mirrored when read from the default (north-up) camera.
                let yaw = p.bearing - Math.PI / 2;
                if (Math.sin(p.bearing) < 0) yaw += Math.PI;
                label.rotation.y = yaw;
                label.userData.localX = p.x;
                label.userData.localZ = p.z;
                this._drape(label, terrain);
                this.group.add(label);
                this.labels.push(label);
                budget--;
            });
        });
    }

    // Ground every plane vertex individually: a flat quad placed at one height would
    // punch through the bank on a sloping valley side.
    _drape(label, terrain) {
        const pos = label.geometry.attributes.position;
        const cos = Math.cos(label.rotation.y), sin = Math.sin(label.rotation.y);
        for (let i = 0; i < pos.count; i++) {
            // local (x, z) → world, applying the label's own yaw
            const lx = pos.getX(i), lz = pos.getZ(i);
            const wx = label.userData.localX + lx * cos + lz * sin;
            const wz = label.userData.localZ - lx * sin + lz * cos;
            // the mesh sits at y = 0 and only yaws, so local y is world height
            pos.setY(i, terrain.sampleHeight(wx, wz) + LIFT);
        }
        pos.needsUpdate = true;
        label.geometry.computeBoundingSphere();
    }

    reDrape(terrain) {
        this.labels.forEach(l => this._drape(l, terrain));
    }

    dispose() {
        this.labels.forEach(l => {
            l.geometry.dispose();
            l.material.map.dispose();
            l.material.dispose();
        });
        this.labels = [];
    }
}

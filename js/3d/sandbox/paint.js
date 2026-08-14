// Paintable terrain overlay: a full-tile mesh carrying a canvas texture you stamp
// soft round dabs into. Used twice — once for red/blue control paint, once for the
// eraser's scorch marks.
//
// The mesh is a clone of the terrain geometry, so it matches the relief exactly at
// every vertex instead of approximating it, and re-draping is a straight Y copy from
// the terrain's own position attribute (heightmap index == vertex index — see
// `_applyHeightToMesh` in terrain.js). The clone gets its own plain 0..1 grid UVs,
// because the terrain's UVs are re-fitted to Mercator once satellite imagery loads.
//
// Soft-edged dabs are what produce the contested gradient: red and blue laid over each
// other blend through the overlap rather than meeting at a hard line.

import * as THREE from 'three';
import { SCENE_SIZE, SCENE_HALF, GRID_SEGMENTS } from '../terrain.js';

const TEX_SIZE = 1024;
const GRID_SIZE = GRID_SEGMENTS + 1;

export class TerrainPaint {
    /**
     * @param {object} terrain TerrainBuilder
     * @param {object} opts { lift, opacity, name }
     */
    constructor(terrain, opts = {}) {
        const { lift = 0.4, opacity = 0.75, name = 'paint' } = opts;
        this.lift = lift;
        this.strokes = [];

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvas.height = TEX_SIZE;
        this.ctx = this.canvas.getContext('2d');

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.anisotropy = 4;

        const geometry = terrain.geometry.clone();
        // plain 0..1 grid UVs — the terrain's own UVs are Mercator-fitted to the
        // satellite tile range and would misalign the paint canvas
        const uv = geometry.attributes.uv;
        for (let iz = 0; iz < GRID_SIZE; iz++) {
            for (let ix = 0; ix < GRID_SIZE; ix++) {
                uv.setXY(iz * GRID_SIZE + ix, ix / GRID_SEGMENTS, 1 - iz / GRID_SEGMENTS);
            }
        }
        uv.needsUpdate = true;

        // same overlay material settings the DeepState control layer uses
        // (buildDrapedOverlay in ribbon.js): unlit, so the colour does not shift with
        // the time-of-day slider, and offset so it wins the z-fight with the terrain.
        this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            map: this.texture, transparent: true, opacity,
            depthWrite: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }));
        this.mesh.name = name;
        this.mesh.renderOrder = 1;
        this.mesh.userData.noPick = true;   // never intercept sandbox picking
        this.reDrape(terrain);
    }

    get group() { return this.mesh; }

    set visible(v) { this.mesh.visible = v; }
    get visible() { return this.mesh.visible; }

    // Local metres → canvas pixels. Note py is NOT flipped here: the vertex UVs below
    // use v = 1 - iz/segments, and CanvasTexture's default flipY already turns that
    // into "canvas row iz". Flipping in both places would mirror the paint in Z.
    _toCanvas(x, z) {
        return {
            px: ((x + SCENE_HALF) / SCENE_SIZE) * TEX_SIZE,
            py: ((z + SCENE_HALF) / SCENE_SIZE) * TEX_SIZE
        };
    }

    _stamp({ x, z, r, color, alpha }) {
        const { px, py } = this._toCanvas(x, z);
        const pr = Math.max(1, (r / SCENE_SIZE) * TEX_SIZE);
        const gradient = this.ctx.createRadialGradient(px, py, 0, px, py, pr);
        // opaque core fading to nothing at the rim — the soft edge is the whole point
        gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
        gradient.addColorStop(0.55, `rgba(${color}, ${alpha * 0.75})`);
        gradient.addColorStop(1, `rgba(${color}, 0)`);
        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.arc(px, py, pr, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * Stamp one dab. `color` is an "r, g, b" string.
     * `record: false` replays without appending to the stroke log.
     */
    paintAt(x, z, r, color, alpha = 0.5, record = true) {
        const dab = { x, z, r, color, alpha };
        this._stamp(dab);
        this.texture.needsUpdate = true;
        if (record) this.strokes.push(dab);
        return dab;
    }

    // Drop the last `count` dabs (one drag = many dabs) and repaint from scratch.
    // Undo has to replay because dabs composite — there is no per-dab erase.
    undoDabs(count) {
        if (count <= 0) return;
        this.strokes.length = Math.max(0, this.strokes.length - count);
        this._replay();
    }

    _replay() {
        this.ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
        this.strokes.forEach(d => this._stamp(d));
        this.texture.needsUpdate = true;
    }

    clear() {
        this.strokes.length = 0;
        this._replay();
    }

    serialize() { return this.strokes.map(d => ({ ...d })); }

    load(strokes) {
        this.strokes = (strokes || []).map(d => ({ ...d }));
        this._replay();
    }

    // Vertex-for-vertex Y copy from the terrain: the clone shares its index layout, so
    // this is exact and needs no height sampling.
    reDrape(terrain) {
        const src = terrain.geometry.attributes.position;
        const dst = this.mesh.geometry.attributes.position;
        for (let i = 0; i < dst.count; i++) dst.setY(i, src.getY(i) + this.lift);
        dst.needsUpdate = true;
        this.mesh.geometry.computeBoundingSphere();
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.texture.dispose();
    }
}

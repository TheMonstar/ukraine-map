// Capture Mala Tokmachka: what the game draws in the 3D scene.
//   • block ownership: one draped overlay over the village with a canvas texture,
//     a fill per block and the lanes between blocks cut out, so the real street
//     pattern reads as the board;
//   • columns: dots strung along their street route (always readable), and up
//     close a few hopping toy soldiers per column;
//   • puffs where columns vanish mid-route (street fights, tractors, Mavics) and a
//     ring where a block changes hands; a dashed route preview while aiming.
// The viewer's own buildings are scenery: nothing here touches them.

import * as THREE from 'three';
import { pointAt } from './streets.js';
import { NEUTRAL, SIDES } from './text.js';

const PX = 2.5;           // m per overlay pixel
const LIFT = 1.5;         // m the overlay floats over the ground
const GRID = 25;          // m between overlay vertices
const LANE = 7;           // m of street left unpainted between blocks
const DOTS = 12;          // dots per column at most
const NEAR = 1200;        // m: toy soldiers within this of the camera
const FIGS_PER = 12;
const FIGS_MAX = 240;
const FIG_SCALE = 6;      // toy soldiers are deliberately oversized

const colorOf = f => (f ? SIDES[f].color : NEUTRAL.color);

function ringTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 20, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function puffTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

export class CaptureView {
    constructor({ scene, terrain, world }) {
        this.scene = scene;
        this.terrain = terrain;
        this.world = world;
        this.group = new THREE.Group();
        this.group.name = 'capture-game';
        scene.add(this.group);
        this.h = (x, z) => terrain.sampleHeight(x, z);
        this._buildOverlay();
        this._buildColumns();
        this._buildFx();
        this.dirty = true;
        this.lastDraw = 0;
        this.prevOwner = null;
        this.prevGroups = new Map();
    }

    // ── block overlay ────────────────────────────────────────────────────────
    _buildOverlay() {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const b of this.world.blocks) {
            for (const p of b.poly) {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            }
        }
        const pad = 40;
        minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
        this.box = { minX, minZ, w: maxX - minX, d: maxZ - minZ };
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(4096, Math.ceil(this.box.w / PX));
        canvas.height = Math.min(4096, Math.ceil(this.box.d / PX));
        this.sx = canvas.width / this.box.w;
        this.sz = canvas.height / this.box.d;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.texture = new THREE.CanvasTexture(canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.anisotropy = 8;

        const geo = new THREE.PlaneGeometry(this.box.w, this.box.d,
            Math.ceil(this.box.w / GRID), Math.ceil(this.box.d / GRID));
        geo.rotateX(-Math.PI / 2);
        geo.translate(minX + this.box.w / 2, 0, minZ + this.box.d / 2);
        this.overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            map: this.texture, transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        }));
        this.overlay.renderOrder = 2;
        this.overlay.name = 'capture-blocks';
        this.overlay.userData.noPick = true;
        this.group.add(this.overlay);
        this._drape();
        // Painted into the ground itself when the viewer has one terrain mesh: a sheet floating
        // 1.5 m up flickers against the ground at a few km (the depth buffer can't tell them
        // apart). The sheet then only serves picking.
        if (this._paintIntoTerrain()) this.overlay.material.visible = false;
    }

    _paintIntoTerrain() {
        const mat = this.terrain.mesh?.material;
        if (!mat || Array.isArray(mat) || !mat.isMeshStandardMaterial) return false;
        const { minX, minZ, w, d } = this.box;
        const uniforms = {
            capMap: { value: this.texture },
            capBox: { value: new THREE.Vector4(minX, minZ, w, d) },
        };
        this.patched = { mat, before: mat.onBeforeCompile, key: mat.customProgramCacheKey };
        const before = mat.onBeforeCompile;
        mat.onBeforeCompile = (shader, renderer) => {
            before?.call(mat, shader, renderer);
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec2 vCapXZ;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCapXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nuniform sampler2D capMap;\nuniform vec4 capBox;\nvarying vec2 vCapXZ;')
                .replace('#include <map_fragment>', `#include <map_fragment>
                {
                    vec2 capUv = (vCapXZ - capBox.xy) / capBox.zw;
                    if (capUv.x >= 0.0 && capUv.x <= 1.0 && capUv.y >= 0.0 && capUv.y <= 1.0) {
                        vec4 capC = texture2D(capMap, vec2(capUv.x, 1.0 - capUv.y));
                        diffuseColor.rgb = mix(diffuseColor.rgb, capC.rgb, capC.a);
                    }
                }`);
        };
        mat.customProgramCacheKey = () => 'capture-blocks';
        mat.needsUpdate = true;
        return true;
    }

    _drape() {
        const pos = this.overlay.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setY(i, this.h(pos.getX(i), pos.getZ(i)) + LIFT);
        pos.needsUpdate = true;
        this.overlay.geometry.computeBoundingSphere();
        this.overlay.geometry.computeBoundingBox();
        this.drapedAt = this.terrain.exaggeration;
    }

    _drawBlocks(st, selected, target) {
        const g = this.ctx, { minX, minZ } = this.box;
        g.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const path = b => {
            g.beginPath();
            b.poly.forEach((p, i) => {
                const x = (p.x - minX) * this.sx, y = (p.z - minZ) * this.sz;
                if (i) g.lineTo(x, y); else g.moveTo(x, y);
            });
            g.closePath();
        };
        g.lineJoin = 'round';
        for (const b of this.world.blocks) {
            const owner = st.blocks[b.id].owner;
            path(b);
            g.globalAlpha = owner ? 0.38 : 0.12;
            g.fillStyle = colorOf(owner);
            g.fill();
            g.globalAlpha = 1;
        }
        // cut the lanes: the streets between blocks stay clear
        g.globalCompositeOperation = 'destination-out';
        g.lineWidth = LANE * this.sx;
        for (const b of this.world.blocks) { path(b); g.stroke(); }
        g.globalCompositeOperation = 'source-over';
        // owned blocks get a crisp edge in their colour, local ones a faint white one
        g.lineWidth = 2;
        for (const b of this.world.blocks) {
            const owner = st.blocks[b.id].owner;
            path(b);
            g.strokeStyle = owner ? colorOf(owner) : 'rgba(255,255,255,0.45)';
            g.stroke();
        }
        const ring = (ids, color, width, dash) => {
            g.lineWidth = width;
            g.strokeStyle = color;
            g.setLineDash(dash);
            for (const id of ids) { path(this.world.blocks[id]); g.stroke(); }
            g.setLineDash([]);
        };
        // gathering points: a bold dashed edge in the side's colour
        for (const [f, r] of Object.entries(st.rally || {})) {
            if (r == null) continue;
            ring([r], colorOf(f), 6, [16, 10]);
        }
        if (selected.size) ring(selected, '#ffffff', 3.5, []);
        if (target != null) ring([target], '#ffffff', 3, [10, 8]);
        this.texture.needsUpdate = true;
    }

    // ── columns ──────────────────────────────────────────────────────────────
    _buildColumns() {
        const cap = 3000;
        const geo = new THREE.BufferGeometry();
        this.dotPos = new Float32Array(cap * 3);
        this.dotCol = new Float32Array(cap * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setDrawRange(0, 0);
        // round dots with a dark rim, tinted per side by the vertex colour
        const dot = document.createElement('canvas');
        dot.width = dot.height = 32;
        const dg = dot.getContext('2d');
        dg.beginPath();
        dg.arc(16, 16, 13, 0, Math.PI * 2);
        dg.fillStyle = '#fff';
        dg.fill();
        dg.lineWidth = 4;
        dg.strokeStyle = 'rgba(0,0,0,0.55)';
        dg.stroke();
        this.dotTex = new THREE.CanvasTexture(dot);
        this.dots = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 8, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true,
            map: this.dotTex, alphaTest: 0.2,
        }));
        this.dots.frustumCulled = false;
        this.dots.renderOrder = 6;
        this.group.add(this.dots);
        this.dotCap = cap;

        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const body = new THREE.BoxGeometry(0.62, 0.95, 0.38).translate(0, 1.02, 0);
        const legs = new THREE.BoxGeometry(0.5, 0.55, 0.3).translate(0, 0.28, 0);
        const head = new THREE.SphereGeometry(0.22, 12, 8).translate(0, 1.72, 0);
        const helmet = new THREE.SphereGeometry(0.27, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.8, 0);
        const make = (geo, color) => {
            const m = new THREE.InstancedMesh(geo, color === undefined ? mat : new THREE.MeshLambertMaterial({ color }), FIGS_MAX);
            m.count = 0;
            m.frustumCulled = false;
            this.group.add(m);
            return m;
        };
        this.figs = {
            body: make(body), legs: make(legs, 0x4b4a3c), head: make(head, 0xf0c8a0), helmet: make(helmet),
        };
        this.figs.body.setColorAt(0, new THREE.Color());
        this.figs.helmet.setColorAt(0, new THREE.Color());
    }

    // ── effects ──────────────────────────────────────────────────────────────
    _buildFx() {
        this.ringTex = ringTexture();
        this.puffTex = puffTexture();
        this.fx = [];
        this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
            color: 0xffffff, dashSize: 14, gapSize: 9, depthTest: false, transparent: true, opacity: 0.95,
        }));
        this.preview.renderOrder = 7;
        this.preview.frustumCulled = false;
        this.preview.visible = false;
        this.group.add(this.preview);
    }

    _spawn(kind, x, z, color) {
        const mat = new THREE.SpriteMaterial({
            map: kind === 'ring' ? this.ringTex : this.puffTex, color, transparent: true, depthTest: false,
        });
        const s = new THREE.Sprite(mat);
        s.position.set(x, this.h(x, z) + (kind === 'ring' ? 12 : 8), z);
        s.renderOrder = 8;
        this.group.add(s);
        this.fx.push({ s, kind, age: 0, life: kind === 'ring' ? 1.2 : 0.9 });
    }

    /** Dashed street route while aiming (null hides it). */
    setPreview(route) {
        if (!route) { this.preview.visible = false; return; }
        const pts = route.pts.map(p => new THREE.Vector3(p.x, this.h(p.x, p.z) + 4, p.z));
        this.preview.geometry.dispose();
        this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        this.preview.computeLineDistances();
        this.preview.visible = true;
    }

    markDirty() { this.dirty = true; }

    /** World position of a column's head, for labels. */
    headOf(g, d) {
        const r = this.world.route(g.from, g.to);
        const p = pointAt(r, Math.min(d, r.len));
        return { x: p.x, y: this.h(p.x, p.z) + 14, z: p.z };
    }

    /**
     * @param st      game state (host's or the guest's mirror)
     * @param dOf     g → distance along its route to draw it at (interpolated)
     * @param camera  for the near/far split
     * @param sel     {selected:Set, target}
     */
    update(dt, st, dOf, camera, sel) {
        if (this.terrain.exaggeration !== this.drapedAt) this._drape();

        // ownership changes: a ring at the block, and a redraw
        const owners = st.blocks.map(b => b.owner);
        if (this.prevOwner) {
            owners.forEach((o, i) => {
                if (o !== this.prevOwner[i]) {
                    const b = this.world.blocks[i];
                    this._spawn('ring', b.x, b.z, new THREE.Color(colorOf(o)));
                    this.dirty = true;
                }
            });
        }
        this.prevOwner = owners;
        const rallyKey = JSON.stringify(st.rally || null);
        if (rallyKey !== this.prevRally) {
            this.prevRally = rallyKey;
            this.dirty = true;
        }
        const now = performance.now();
        if (this.dirty && now - this.lastDraw > 120) {
            this._drawBlocks(st, sel.selected, sel.target);
            this.dirty = false;
            this.lastDraw = now;
        }

        // columns that vanished before reaching their block: a puff where they were
        const seen = new Map();
        for (const g of st.groups) seen.set(g.id, g);
        for (const [id, prev] of this.prevGroups) {
            if (!seen.has(id) && prev.left > 30) this._spawn('puff', prev.x, prev.z, new THREE.Color(colorOf(prev.f)));
        }

        const cam = camera.position;
        let nd = 0;
        const figs = [];
        const nextPrev = new Map();
        const col = new THREE.Color();
        for (const g of st.groups) {
            const r = this.world.route(g.from, g.to);
            const d = Math.min(dOf(g), r.len);
            const head = pointAt(r, d);
            nextPrev.set(g.id, { x: head.x, z: head.z, f: g.f, left: r.len - d });
            col.set(colorOf(g.f));
            const camDist = Math.hypot(cam.x - head.x, cam.y - this.h(head.x, head.z), cam.z - head.z);
            const spacing = Math.max(6, camDist / 140);
            const m = Math.min(DOTS, Math.max(1, Math.ceil(g.n / 3)));
            for (let k = 0; k < m && nd < this.dotCap; k++) {
                const p = k ? pointAt(r, Math.max(0, d - k * spacing)) : head;
                this.dotPos[nd * 3] = p.x;
                this.dotPos[nd * 3 + 1] = this.h(p.x, p.z) + 3;
                this.dotPos[nd * 3 + 2] = p.z;
                this.dotCol[nd * 3] = col.r; this.dotCol[nd * 3 + 1] = col.g; this.dotCol[nd * 3 + 2] = col.b;
                nd++;
            }
            if (camDist < NEAR) figs.push({ g, r, d, camDist });
        }
        this.prevGroups = nextPrev;
        const dg = this.dots.geometry;
        dg.setDrawRange(0, nd);
        dg.attributes.position.needsUpdate = true;
        dg.attributes.color.needsUpdate = true;

        // toy soldiers for the nearest columns
        figs.sort((a, b) => a.camDist - b.camDist);
        const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
        const scl = new THREE.Vector3(FIG_SCALE, FIG_SCALE, FIG_SCALE), pos = new THREE.Vector3();
        let nf = 0;
        const t = now / 1000;
        for (const { g, r, d } of figs) {
            col.set(colorOf(g.f));
            const body = col.clone().multiplyScalar(0.8);
            const count = Math.min(FIGS_PER, Math.max(1, Math.ceil(g.n / 4)));
            for (let k = 0; k < count && nf < FIGS_MAX; k++) {
                const back = Math.floor(k / 2) * 2.4 * FIG_SCALE;
                const p = pointAt(r, Math.max(0, d - back));
                const side = (k % 2 ? 1 : -1) * 0.9 * FIG_SCALE;
                const x = p.x - p.dz * side, z = p.z + p.dx * side;
                const hop = Math.abs(Math.sin(t * 9 + k * 1.7 + g.id)) * 0.35 * FIG_SCALE;
                pos.set(x, this.h(x, z) + hop, z);
                q.setFromAxisAngle(up, Math.atan2(p.dx, p.dz));
                mtx.compose(pos, q, scl);
                for (const part of Object.values(this.figs)) part.setMatrixAt(nf, mtx);
                this.figs.body.setColorAt(nf, body);
                this.figs.helmet.setColorAt(nf, col);
                nf++;
            }
        }
        for (const part of Object.values(this.figs)) {
            part.count = nf;
            part.instanceMatrix.needsUpdate = true;
            if (part.instanceColor) part.instanceColor.needsUpdate = true;
        }

        // effects
        this.fx = this.fx.filter(e => {
            e.age += dt;
            const k = e.age / e.life;
            if (k >= 1) {
                this.group.remove(e.s);
                e.s.material.dispose();
                return false;
            }
            const size = e.kind === 'ring' ? 60 + 260 * k : 25 + 50 * k;
            e.s.scale.set(size, size, 1);
            e.s.material.opacity = 1 - k;
            return true;
        });
    }

    /** Local point under a normalised device coordinate, or null. */
    pick(ndc, camera) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObject(this.overlay, false)[0];
        return hit ? { x: hit.point.x, z: hit.point.z } : null;
    }

    dispose() {
        if (this.patched) {                     // hand the ground its own shader back
            const { mat, before, key } = this.patched;
            mat.onBeforeCompile = before;
            if (key) mat.customProgramCacheKey = key; else delete mat.customProgramCacheKey;
            mat.needsUpdate = true;
            this.patched = null;
        }
        this.scene.remove(this.group);
        this.group.traverse(o => {
            o.geometry?.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this.texture.dispose();
        this.ringTex.dispose();
        this.dotTex.dispose();
        this.puffTex.dispose();
    }
}

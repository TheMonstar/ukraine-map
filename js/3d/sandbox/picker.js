// Pointer picking for the tactical sandbox — the one place that owns a Raycaster.
//
// OrbitControls also listens on the canvas, so a "click" is only reported when the
// pointer went down and up in nearly the same place, quickly: anything else was an
// orbit/pan drag and must not place geometry.

import * as THREE from 'three';

const CLICK_MOVE_PX = 5;
const CLICK_MS = 400;

export class Picker {
    constructor(canvas, camera, terrain, buildings) {
        this.canvas = canvas;
        this.camera = camera;
        this.terrain = terrain;
        this.buildings = buildings;
        this.raycaster = new THREE.Raycaster();
        this.ndc = new THREE.Vector2();
        this.annotationRoot = null;   // set by the sandbox controller
    }

    _setRay(ev) {
        // The camera may have been moved this tick without a render in between —
        // raycasting off a stale matrixWorld silently places things somewhere else.
        this.camera.updateMatrixWorld();
        const rect = this.canvas.getBoundingClientRect();
        this.ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        this.ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.ndc, this.camera);
    }

    // → { x, y, z } in local ENU meters, or null if the ray misses the terrain.
    pickTerrain(ev) {
        this._setRay(ev);
        const hits = this.raycaster.intersectObject(this.terrain.mesh, false);
        return hits.length ? hits[0].point.clone() : null;
    }

    // → { record, mesh, point } for the nearest building surface, or null.
    pickBuilding(ev) {
        this._setRay(ev);
        const meshes = [...this.buildings.wallMeshes, ...this.buildings.roofMeshes].filter(Boolean);
        if (!meshes.length) return null;
        const hits = this.raycaster.intersectObjects(meshes, false);
        for (const hit of hits) {
            const record = this.buildings.buildingAt(hit.object, hit.faceIndex);
            if (record) return { record, mesh: hit.object, point: hit.point.clone() };
        }
        return null;
    }

    // → the top-level annotation Object3D under the cursor, or null.
    pickAnnotation(ev) {
        if (!this.annotationRoot) return null;
        this._setRay(ev);
        const hits = this.raycaster.intersectObjects(this.annotationRoot.children, true);
        for (const hit of hits) {
            let o = hit.object;
            while (o && o.parent !== this.annotationRoot) o = o.parent;
            if (o && !o.userData.noPick) return o;
        }
        return null;
    }

    // Whichever of building / terrain the ray reaches first.
    pickSurface(ev) {
        const building = this.pickBuilding(ev);
        const ground = this.pickTerrain(ev);
        if (building && ground) {
            const camPos = this.camera.position;
            return building.point.distanceToSquared(camPos) <= ground.distanceToSquared(camPos)
                ? { kind: 'building', ...building }
                : { kind: 'terrain', point: ground };
        }
        if (building) return { kind: 'building', ...building };
        if (ground) return { kind: 'terrain', point: ground };
        return null;
    }
}

// Wire click / drag-aware handlers onto the canvas.
// `handlers` = { onClick(ev), onMove(ev), onDragStart(ev), onDrag(ev), onDragEnd(ev), isFreehand() }
// `isEnabled()` gates everything (false while walk/drone/freecam own the pointer).
export function attachPointerHandlers(canvas, handlers, isEnabled) {
    let downX = 0, downY = 0, downAt = 0, dragging = false, freehand = false;

    canvas.addEventListener('pointerdown', ev => {
        if (!isEnabled() || ev.button !== 0) return;
        downX = ev.clientX; downY = ev.clientY; downAt = performance.now();
        dragging = false;
        freehand = !!handlers.isFreehand?.();
    });

    canvas.addEventListener('pointermove', ev => {
        if (!isEnabled()) return;
        handlers.onMove?.(ev);
        if (!downAt || !freehand) return;
        const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (!dragging && moved > CLICK_MOVE_PX) {
            dragging = true;
            handlers.onDragStart?.(ev);
        }
        if (dragging) handlers.onDrag?.(ev);
    });

    const finish = ev => {
        if (!downAt) return;
        const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        const elapsed = performance.now() - downAt;
        downAt = 0;
        if (dragging) {
            dragging = false;
            handlers.onDragEnd?.(ev);
        } else if (isEnabled() && moved <= CLICK_MOVE_PX && elapsed <= CLICK_MS) {
            handlers.onClick?.(ev);
        }
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { downAt = 0; dragging = false; });

    canvas.addEventListener('dblclick', ev => {
        if (isEnabled()) handlers.onDoubleClick?.(ev);
    });

    canvas.addEventListener('contextmenu', ev => {
        if (!isEnabled() || !handlers.onRightClick) return;
        ev.preventDefault();
        handlers.onRightClick(ev);
    });
}

// Freehand capture in screen space: only emit a point every `stepPx`.
export class ScreenSampler {
    constructor(stepPx = 4) {
        this.stepPx = stepPx;
        this.reset();
    }
    reset() { this.lastX = null; this.lastY = null; }
    accept(ev) {
        if (this.lastX === null || Math.hypot(ev.clientX - this.lastX, ev.clientY - this.lastY) >= this.stepPx) {
            this.lastX = ev.clientX; this.lastY = ev.clientY;
            return true;
        }
        return false;
    }
}

// Tactical sandbox controller — the only sandbox module main.js talks to.
//
// Owns the active tool, the annotation group, the undo stack, selection, and
// serialisation. Individual builders (arrows, markers, obstacles, damage, export)
// stay dumb: they take local ENU points and return objects.
//
// Annotations are serialised as lat/lng so a saved scene survives a change of tile
// size or origin; damaged buildings are keyed by footprint centroid (`record.id`),
// since nothing stable survives the building merge.

import * as THREE from 'three';
import { buildDrapedArrow, reDrapeArrow, SIDE_COLORS } from './arrows.js';
import { buildMarker, buildFoxhole, placeMarker, reDrapeMarker, disposeMarker } from './markers.js';
import { buildObstacleBelt, reDrapeObstacle } from './obstacles.js';
import { Damage, reDrapeDebris } from './damage.js';
import { captureScreenshot, downloadJSON, pickJSONFile } from './export.js';
import { Picker, attachPointerHandlers, ScreenSampler } from './picker.js';
import { SYMBOL_TYPES } from './symbols.js';
import { buildUnitIcon, unitIconUrl, UNIT_ICON_COUNTS, SIDE_TO_DIR } from './unit-icons.js';
import { TerrainPaint } from './paint.js';
import { Eraser } from './eraser.js';

const LINE_TOOLS = new Set(['arrow', 'phaseLine', 'wire', 'teeth', 'ditch']);
// Area tools: painted by dragging, with the orbit controls suspended for the stroke.
const BRUSH_TOOLS = new Set(['erase', 'paint']);
const PAINT_RGB = { red: '220, 38, 38', blue: '37, 99, 235', neutral: '148, 163, 184' };
// Only the first ten get a digit shortcut; `screenshot` is toolbar-only.
const TOOL_ORDER = ['select', 'arrow', 'phaseLine', 'marker', 'unit', 'foxhole', 'destroy', 'wire', 'teeth', 'ditch', 'crater', 'erase', 'paint', 'screenshot'];

const HINTS = {
    select: 'Click an annotation to select · Delete removes it · Ctrl+Z undoes',
    arrow: 'Click to add points · double-click or Enter to finish · Esc cancels · Backspace removes last',
    phaseLine: 'Click to add points · double-click or Enter to finish · Esc cancels',
    marker: 'Click ground or a building roof to plant a marker',
    unit: 'Pick a symbol, then click ground or a building roof to place the unit',
    foxhole: 'Click open ground to dig a position',
    destroy: 'Click a building to damage it, again to flatten it · right-click repairs',
    wire: 'Click to trace the wire belt · double-click or Enter to lay it',
    teeth: 'Click to trace the obstacle line · double-click or Enter to place the teeth',
    ditch: 'Click to trace the anti-tank ditch · double-click or Enter to dig it',
    erase: 'Drag over an area to clear trees, flatten buildings and scorch the ground',
    paint: 'Drag to paint control · overlap red and blue for a contested gradient',
    crater: 'Click ground to place an impact crater',
    screenshot: 'Set resolution and title, then press Capture'
};

const SAVE_VERSION = 1;

export class Sandbox {
    constructor(ctx) {
        this.ctx = ctx;   // { canvas, scene, camera, controls, renderer, terrain, proj, buildings, ditches, info }
        this.group = new THREE.Group();
        this.group.name = 'sandbox';
        this.overlay = new THREE.Group();
        this.overlay.name = 'sandbox-overlay';
        this.overlay.userData.noPick = true;
        this.group.add(this.overlay);

        this.damage = new Damage(ctx.buildings, ctx.terrain, ctx.proj);
        this.group.add(this.damage.group);

        // Two full-tile paint overlays sharing one implementation: control markings on
        // top, the eraser's burn marks underneath so control paint reads over them.
        this.scorch = new TerrainPaint(ctx.terrain, { lift: 0.35, opacity: 0.85, name: 'scorch-paint' });
        this.control = new TerrainPaint(ctx.terrain, { lift: 0.7, opacity: 0.6, name: 'control-paint' });
        this.group.add(this.scorch.mesh, this.control.mesh);
        this.eraser = new Eraser({
            vegetation: ctx.vegetation, buildings: ctx.buildings,
            damage: this.damage, scorch: this.scorch
        });

        this.picker = new Picker(ctx.canvas, ctx.camera, ctx.terrain, ctx.buildings);
        this.picker.annotationRoot = this.group;

        this.annotations = [];
        this.undoStack = [];
        this.tool = 'select';
        this.enabled = true;       // false while walk/drone/freecam own the pointer
        this.selected = null;
        this.selectionBox = null;
        this.draft = null;         // { pts: [], preview: Object3D|null, freehand: bool }
        this.sampler = new ScreenSampler(5);
        this.lastPreviewAt = 0;

        this.opts = {
            side: 'red', widthM: 24, symbol: '', label: '', scale: 1,
            craterRadius: 10, freehand: false, unitId: 1,
            brushRadius: 120, paintAlpha: 0.45,
            beltComponents: [], beltWidth: 30, ditchCount: 0,
            friendlySide: 'right', wireFront: false, wireBehind: false,
            shotScale: 2, poster: true, title: ''
        };

        this._bindUI();
        this._bindPointer();
        this._bindKeys();
        this.setTool('select');
        this._updateCount();
    }

    // ── UI wiring ──────────────────────────────────────────────────────────

    _bindUI() {
        const $ = id => document.getElementById(id);
        this.el = {
            toolbar: $('sandbox-toolbar'),
            hint: $('sandbox-hint'),
            options: $('sandbox-options'),
            count: $('sandbox-count')
        };

        this.el.toolbar.querySelectorAll('[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
        });

        const symbolSelect = $('opt-symbol');
        SYMBOL_TYPES.forEach(t => symbolSelect.add(new Option(t[0].toUpperCase() + t.slice(1), t)));

        this.el.toolbar.querySelectorAll('#opt-side button').forEach(btn => {
            btn.addEventListener('click', () => {
                this.opts.side = btn.dataset.value;
                this.el.toolbar.querySelectorAll('#opt-side button')
                    .forEach(b => b.classList.toggle('active', b === btn));
                this._buildUnitPalette();   // RU and UA have different symbol sets
            });
        });

        this.el.palette = $('opt-unit-palette');
        this._buildUnitPalette();

        $('opt-width').addEventListener('input', e => { this.opts.widthM = parseFloat(e.target.value); });
        symbolSelect.addEventListener('change', e => { this.opts.symbol = e.target.value; });
        $('opt-label').addEventListener('input', e => { this.opts.label = e.target.value; });
        $('opt-scale').addEventListener('input', e => { this.opts.scale = parseFloat(e.target.value); });
        $('opt-crater').addEventListener('change', e => { this.opts.craterRadius = parseFloat(e.target.value); });
        $('opt-brush').addEventListener('input', e => { this.opts.brushRadius = parseFloat(e.target.value); });
        ['wire', 'teeth'].forEach(type => {
            $(`opt-belt-${type}`).addEventListener('change', () => this._readBelt());
        });
        $('opt-wire-front').addEventListener('change', e => { this.opts.wireFront = e.target.checked; });
        $('opt-wire-behind').addEventListener('change', e => { this.opts.wireBehind = e.target.checked; });
        $('opt-belt-width').addEventListener('input', e => { this.opts.beltWidth = parseFloat(e.target.value); });
        this._bindSeg('opt-ditch-count', v => { this.opts.ditchCount = parseInt(v, 10); this._readBelt(); });
        this._bindSeg('opt-friendly-side', v => { this.opts.friendlySide = v; });
        $('opt-paint-alpha').addEventListener('input', e => { this.opts.paintAlpha = parseFloat(e.target.value); });
        $('opt-freehand').addEventListener('change', e => { this.opts.freehand = e.target.checked; });
        $('opt-shot-scale').addEventListener('change', e => { this.opts.shotScale = parseFloat(e.target.value); });
        $('opt-poster').addEventListener('change', e => { this.opts.poster = e.target.checked; });
        $('opt-title').addEventListener('input', e => { this.opts.title = e.target.value; });

        $('opt-capture').addEventListener('click', () => this.capture());
        $('opt-ditch-line').addEventListener('click', () => this.lineDitches());
        $('sandbox-undo').addEventListener('click', () => this.undo());
        $('sandbox-clear').addEventListener('click', () => this.clearAll());
        $('sandbox-save').addEventListener('click', () => this.save());
        $('sandbox-load').addEventListener('click', () => this.load());
    }

    // Segmented button group: highlight the clicked button, report its value.
    _bindSeg(id, onPick) {
        const buttons = [...document.querySelectorAll(`#${id} button`)];
        buttons.forEach(btn => btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.toggle('active', b === btn));
            onPick(btn.dataset.value);
        }));
    }

    // The Wire/Teeth tick-boxes plus the ditch count are the real selection; the
    // Wire/Teeth/Ditch tool buttons are presets that set them to a single element, so
    // those tools behave exactly as they did before belts existed.
    _readBelt() {
        this.opts.beltComponents = ['wire', 'teeth']
            .filter(t => document.getElementById(`opt-belt-${t}`).checked);
        // sub-rows only matter when the thing they configure is actually in the belt
        document.getElementById('opt-wire-row')
            .classList.toggle('hidden', !this.opts.beltComponents.includes('wire'));
        document.getElementById('opt-friendly-row')
            .classList.toggle('hidden', !this.opts.ditchCount);
        return this.opts.beltComponents;
    }

    _setBelt(components, ditchCount) {
        ['wire', 'teeth'].forEach(t => {
            document.getElementById(`opt-belt-${t}`).checked = components.includes(t);
        });
        this.opts.ditchCount = ditchCount;
        document.querySelectorAll('#opt-ditch-count button').forEach(b =>
            b.classList.toggle('active', b.dataset.value === String(ditchCount)));
        this._readBelt();
    }

    // What a drawn belt should actually contain right now.
    _beltOpts() {
        const components = this.opts.beltComponents;
        // nothing ticked and no ditches: fall back to the active tool
        const empty = !components.length && !this.opts.ditchCount;
        return {
            type: this.tool,
            components: empty && this.tool !== 'ditch' ? [this.tool] : components,
            ditchCount: empty && this.tool === 'ditch' ? 1 : this.opts.ditchCount,
            friendlySide: this.opts.friendlySide,
            wireFront: this.opts.wireFront,
            wireBehind: this.opts.wireBehind,
            scale: this.opts.scale,
            width: this.opts.beltWidth
        };
    }

    // Thumbnails of every icon in `images/<side>/`, the same PNGs the main map's
    // unit markers use. Selection is kept when switching sides if the id exists there.
    _buildUnitPalette() {
        const dir = SIDE_TO_DIR[this.opts.side] || 'ru';
        const count = UNIT_ICON_COUNTS[dir] || 0;
        if (this.opts.unitId > count) this.opts.unitId = 1;
        this.el.palette.innerHTML = '';
        for (let id = 1; id <= count; id++) {
            const img = document.createElement('img');
            img.src = unitIconUrl(dir, id);
            img.alt = `${dir.toUpperCase()} symbol ${id}`;
            img.title = img.alt;
            img.loading = 'lazy';
            img.dataset.id = String(id);
            img.classList.toggle('selected', id === this.opts.unitId);
            img.addEventListener('click', () => {
                this.opts.unitId = id;
                this.el.palette.querySelectorAll('img')
                    .forEach(other => other.classList.toggle('selected', other === img));
            });
            this.el.palette.appendChild(img);
        }
    }

    setTool(tool) {
        this._cancelDraft();
        // Wire / Teeth / Ditch double as belt-component presets: picking one sets the
        // tick-boxes to exactly that component, which is the pre-belt behaviour.
        if (['wire', 'teeth', 'ditch'].includes(tool) && tool !== this.tool) {
            if (tool === 'ditch') this._setBelt([], 1);
            else this._setBelt([tool], 0);
        }
        this.tool = tool;
        this.el.toolbar.querySelectorAll('[data-tool]').forEach(b =>
            b.classList.toggle('active', b.dataset.tool === tool));
        this.el.options.querySelectorAll('.opt').forEach(opt => {
            const forTools = (opt.dataset.for || '').split(' ');
            opt.classList.toggle('hidden', !forTools.includes(tool));
        });
        // the generic data-for loop above re-shows every row for this tool, so re-apply
        // the rule that the ditch sub-row only appears when Ditch is actually ticked
        this._readBelt();
        this.el.hint.textContent = HINTS[tool] || '';
        if (tool !== 'select') this.select(null);
        this.ctx.canvas.style.cursor = tool === 'select' ? '' : 'crosshair';
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.el.toolbar.classList.toggle('disabled', !enabled);
        if (!enabled) { this._cancelDraft(); this.select(null); }
    }

    _updateCount() {
        const damaged = this.ctx.buildings.records.filter(r => r.damage).length;
        const cleared = this.ctx.vegetation?.hidden?.size || 0;
        this.el.count.textContent = `${this.annotations.length} annotation${this.annotations.length === 1 ? '' : 's'}` +
            (damaged ? ` · ${damaged} building${damaged === 1 ? '' : 's'} hit` : '') +
            (cleared ? ` · ${cleared} tree${cleared === 1 ? '' : 's'} cleared` : '');
    }

    // ── pointer / keyboard ─────────────────────────────────────────────────

    _bindPointer() {
        // Capture phase: for any drag tool we must stop OrbitControls before it starts
        // orbiting — it sees pointerdown first otherwise.
        this.ctx.canvas.addEventListener('pointerdown', ev => {
            if (this._dragActive() && ev.button === 0) this.ctx.controls.enabled = false;
        }, { capture: true });

        attachPointerHandlers(this.ctx.canvas, {
            isFreehand: () => this._dragActive(),
            onClick: ev => this._onClick(ev),
            onMove: ev => this._onMove(ev),
            onDoubleClick: () => this._commitDraft(),
            onRightClick: ev => this._onRightClick(ev),
            onDragStart: ev => {
                this._cancelDraft();                    // drop any half-clicked polyline
                this.ctx.controls.enabled = false;      // _cancelDraft re-enables orbit
                this.sampler.reset();
                if (this._brushActive()) { this._beginBrush(); this._onBrushDrag(ev); return; }
                this.draft = { pts: [], preview: null, freehand: true };
                this._onDrag(ev);
            },
            onDrag: ev => (this._brushActive() ? this._onBrushDrag(ev) : this._onDrag(ev)),
            onDragEnd: () => {
                this.ctx.controls.enabled = true;
                if (this._brushActive()) { this._endBrush(); return; }
                this._commitDraft();
            }
        }, () => this.enabled);
    }

    _brushActive() {
        return this.enabled && BRUSH_TOOLS.has(this.tool);
    }

    // Any pointer drag we own rather than OrbitControls: freehand line drawing, or a brush.
    _dragActive() {
        return this._brushActive() ||
            (this.enabled && this.opts.freehand && LINE_TOOLS.has(this.tool));
    }

    // ── area brushes ───────────────────────────────────────────────────────

    _beginBrush() {
        if (this.tool === 'erase') this.eraser.begin();
        else this.brushStroke = { dabs: 0 };
        this.lastDab = null;
    }

    _onBrushDrag(ev) {
        const hit = this.picker.pickTerrain(ev);
        if (!hit) return;
        const r = this.opts.brushRadius;
        // Space dabs out along the drag: stamping every pointermove would pile hundreds
        // of overlapping gradients onto the same spot and crawl.
        if (this.lastDab && Math.hypot(hit.x - this.lastDab.x, hit.z - this.lastDab.z) < r * 0.25) return;
        this.lastDab = { x: hit.x, z: hit.z };

        if (this.tool === 'erase') {
            this.eraser.dab(hit.x, hit.z, r);
            this._updateCount();
        } else {
            const rgb = PAINT_RGB[this.opts.side] || PAINT_RGB.red;
            this.control.paintAt(hit.x, hit.z, r, rgb, this.opts.paintAlpha);
            this.brushStroke.dabs++;
        }
    }

    _endBrush() {
        if (this.tool === 'erase') {
            const undo = this.eraser.end();
            if (undo) this._pushUndo(() => { undo(); this._updateCount(); });
        } else if (this.brushStroke?.dabs) {
            const count = this.brushStroke.dabs;
            this._pushUndo(() => this.control.undoDabs(count));
        }
        this.brushStroke = null;
        this.lastDab = null;
        this._updateCount();
    }

    _bindKeys() {
        window.addEventListener('keydown', ev => {
            if (!this.enabled) return;
            // Only *text entry* should swallow shortcuts. A focused checkbox or slider
            // is still an HTMLInputElement, and treating those as typing would kill
            // Ctrl+Z and the tool keys after every layer toggle or slider drag.
            const el = ev.target;
            const typing = el instanceof HTMLTextAreaElement || el?.isContentEditable ||
                (el instanceof HTMLInputElement &&
                    !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(el.type));
            if (typing) return;

            if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyZ') { ev.preventDefault(); this.undo(); return; }
            if (ev.code === 'Escape') { this._cancelDraft(); this.select(null); this.setTool('select'); return; }
            if (ev.code === 'Enter') { this._commitDraft(); return; }
            if (ev.code === 'Backspace' && this.draft?.pts.length) {
                ev.preventDefault();
                this.draft.pts.pop();
                this._refreshPreview();
                return;
            }
            if (ev.code === 'Delete' || ev.code === 'KeyX') { this.deleteSelected(); return; }
            const digit = ev.code.match(/^Digit([0-9])$/);
            if (digit) {
                const i = digit[1] === '0' ? 9 : parseInt(digit[1], 10) - 1;
                if (TOOL_ORDER[i]) this.setTool(TOOL_ORDER[i]);
            }
        });
    }

    _onClick(ev) {
        if (LINE_TOOLS.has(this.tool)) {
            const hit = this.picker.pickTerrain(ev);
            if (!hit) return;
            if (!this.draft) this.draft = { pts: [], preview: null, freehand: false };
            this.draft.pts.push({ x: hit.x, z: hit.z });
            this._refreshPreview();
            return;
        }
        if (BRUSH_TOOLS.has(this.tool)) {
            // a click without a drag should still stamp once, not silently do nothing
            this._beginBrush();
            this._onBrushDrag(ev);
            this._endBrush();
            return;
        }
        switch (this.tool) {
            case 'select': this.select(this.picker.pickAnnotation(ev)); break;
            case 'marker': this._placeMarkerAt(ev, 'marker'); break;
            case 'unit': this._placeMarkerAt(ev, 'unit'); break;
            case 'foxhole': this._placeMarkerAt(ev, 'foxhole'); break;
            case 'destroy': this._destroyAt(ev); break;
            case 'crater': this._craterAt(ev); break;
        }
    }

    _onRightClick(ev) {
        if (this.tool === 'destroy') {
            const hit = this.picker.pickBuilding(ev);
            if (!hit) return;
            const prev = hit.record.damage || 0;
            if (!prev) return;
            this.damage.setState(hit.record, prev - 1);
            this._pushUndo(() => this.damage.setState(hit.record, prev));
            this._updateCount();
        } else if (this.draft) {
            this._cancelDraft();
        }
    }

    _onMove(ev) {
        if (!this.draft || this.draft.freehand || !this.draft.pts.length) return;
        const now = performance.now();
        if (now - this.lastPreviewAt < 33) return;   // ~30 Hz
        this.lastPreviewAt = now;
        const hit = this.picker.pickTerrain(ev);
        this._refreshPreview(hit ? { x: hit.x, z: hit.z } : null);
    }

    _onDrag(ev) {
        if (!this.sampler.accept(ev)) return;
        const hit = this.picker.pickTerrain(ev);
        if (!hit) return;
        this.draft.pts.push({ x: hit.x, z: hit.z });
        const now = performance.now();
        if (now - this.lastPreviewAt > 60) {
            this.lastPreviewAt = now;
            this._refreshPreview();
        }
    }

    // ── draft line preview ─────────────────────────────────────────────────

    _refreshPreview(hoverPoint = null) {
        if (this.draft?.preview) {
            this.overlay.remove(this.draft.preview);
            this._disposeObject(this.draft.preview);
            this.draft.preview = null;
        }
        if (!this.draft) return;
        const pts = hoverPoint ? [...this.draft.pts, hoverPoint] : this.draft.pts;
        if (pts.length < 2) return;
        // Always a cheap thin line, whatever the tool — the real belt/arrow is only
        // built on commit, so dragging stays smooth.
        const preview = buildDrapedArrow(pts, this.ctx.terrain, {
            widthM: this.tool === 'arrow' ? this.opts.widthM : 6,
            color: SIDE_COLORS[this.opts.side] || SIDE_COLORS.red,
            head: this.tool === 'arrow',
            dashed: this.tool !== 'arrow',
            sampleM: 12
        });
        if (!preview) return;
        preview.userData.noPick = true;
        preview.children.forEach(m => { m.material.transparent = true; m.material.opacity = 0.55; });
        this.overlay.add(preview);
        this.draft.preview = preview;
    }

    _cancelDraft() {
        if (this.draft?.preview) {
            this.overlay.remove(this.draft.preview);
            this._disposeObject(this.draft.preview);
        }
        this.draft = null;
        this.ctx.controls.enabled = true;
    }

    _commitDraft() {
        const draft = this.draft;
        if (!draft || draft.pts.length < 2) { this._cancelDraft(); return; }
        const pts = draft.pts;
        this._cancelDraft();

        let object = null;
        if (this.tool === 'arrow' || this.tool === 'phaseLine') {
            object = buildDrapedArrow(pts, this.ctx.terrain, {
                widthM: this.opts.widthM,
                color: SIDE_COLORS[this.opts.side] || SIDE_COLORS.red,
                head: this.tool === 'arrow',
                dashed: this.tool === 'phaseLine'
            });
        } else {
            object = buildObstacleBelt(pts, this.ctx.terrain, this._beltOpts());
        }
        if (object) this._addAnnotation(object);
    }

    // ── placement tools ────────────────────────────────────────────────────

    // `kind` is 'marker' | 'unit' | 'foxhole'. Foxholes are dug into open ground, so
    // they only pick the terrain; the other two can also sit on a building roof.
    _placeMarkerAt(ev, kind) {
        const hit = kind === 'foxhole'
            ? (p => p && { kind: 'terrain', point: p })(this.picker.pickTerrain(ev))
            : this.picker.pickSurface(ev);
        if (!hit) return;
        const { x, z } = hit.point;
        let object;
        if (kind === 'foxhole') {
            object = buildFoxhole({ side: this.opts.side, scale: this.opts.scale });
        } else if (kind === 'unit') {
            object = buildUnitIcon({
                side: this.opts.side,
                id: this.opts.unitId,
                label: this.opts.label,
                scale: this.opts.scale
            });
        } else {
            object = buildMarker({
                side: this.opts.side,
                symbol: this.opts.symbol || null,
                label: this.opts.label,
                scale: this.opts.scale
            });
        }
        placeMarker(object, x, z, this.ctx.terrain, hit.kind === 'building' ? { record: hit.record } : null);
        this._addAnnotation(object);
    }

    _destroyAt(ev) {
        const hit = this.picker.pickBuilding(ev);
        if (hit) this.damageRecord(hit.record);
    }

    // Advance one damage stage on a specific building, with an undo entry.
    damageRecord(record) {
        const prev = record.damage || 0;
        if (prev >= 2) return;
        this.damage.hit(record);
        this._pushUndo(() => this.damage.setState(record, prev));
        this._updateCount();
    }

    _craterAt(ev) {
        const hit = this.picker.pickTerrain(ev);
        if (!hit) return;
        // re-parented out of damage.group by _addAnnotation, so it joins selection/undo
        this._addAnnotation(this.damage.addCrater(hit.x, hit.z, this.opts.craterRadius));
    }

    // Lay wire and teeth along every fortification line already in the sector.
    lineDitches() {
        const features = this.ctx.ditches?.featureCollection?.features || [];
        if (!features.length) {
            this.el.hint.textContent = 'No ditch features loaded for this sector.';
            return;
        }
        const beltOpts = this._beltOpts();
        const type = [...beltOpts.components,
            beltOpts.ditchCount ? `${beltOpts.ditchCount}×ditch` : null].filter(Boolean).join('+');
        const made = [];
        const lines = [];
        features.forEach(f => {
            if (f.geometry?.type === 'LineString') lines.push(f.geometry.coordinates);
            else if (f.geometry?.type === 'MultiLineString') lines.push(...f.geometry.coordinates);
        });
        lines.forEach(coords => {
            const pts = coords.map(([lng, lat]) => this.ctx.proj.toLocal(lat, lng));
            const belt = buildObstacleBelt(pts, this.ctx.terrain, beltOpts);
            if (belt) { this.group.add(belt); this.annotations.push(belt); made.push(belt); }
        });
        if (!made.length) return;
        this._pushUndo(() => made.forEach(b => this._removeAnnotation(b)));
        this._updateCount();
        this.el.hint.textContent = `Laid ${made.length} ${type} belt${made.length === 1 ? '' : 's'} along the ditches.`;
    }

    // ── annotation bookkeeping ─────────────────────────────────────────────

    _addAnnotation(object) {
        this.group.add(object);
        this.annotations.push(object);
        this._pushUndo(() => this._removeAnnotation(object));
        this._updateCount();
        return object;
    }

    _removeAnnotation(object) {
        const i = this.annotations.indexOf(object);
        if (i !== -1) this.annotations.splice(i, 1);
        if (this.selected === object) this.select(null);
        if (object.userData.kind === 'crater') {
            this.damage.group.add(object);   // hand it back so removeCrater can clean up
            this.damage.removeCrater(object);
        } else {
            this.group.remove(object);
            this._disposeObject(object);
        }
        this._updateCount();
    }

    _disposeObject(object) {
        if (['marker', 'unit', 'foxhole'].includes(object.userData.kind)) {
            disposeMarker(object);
            return;
        }
        object.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
    }

    _pushUndo(undo) {
        this.undoStack.push(undo);
        if (this.undoStack.length > 200) this.undoStack.shift();
        this._autosave();
    }

    undo() {
        const entry = this.undoStack.pop();
        if (!entry) return;
        entry();
        this._updateCount();
        this._autosave();
    }

    select(object) {
        if (this.selectionBox) {
            this.overlay.remove(this.selectionBox);
            this.selectionBox.geometry.dispose();
            this.selectionBox.material.dispose();
            this.selectionBox = null;
        }
        this.selected = object || null;
        if (this.selected) {
            this.selectionBox = new THREE.BoxHelper(this.selected, 0xfacc15);
            this.selectionBox.userData.noPick = true;
            this.overlay.add(this.selectionBox);
        }
    }

    deleteSelected() {
        const object = this.selected;
        if (!object) return;
        this._removeAnnotation(object);
        this._autosave();
    }

    clearAll() {
        [...this.annotations].forEach(o => this._removeAnnotation(o));
        this.eraser.clear();      // un-hide trees before damage.clear restores buildings
        this.control.clear();
        this.scorch.clear();
        this.damage.clear();
        this.undoStack.length = 0;
        this._updateCount();
        this._autosave();
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    // Markers keep a constant on-screen size, like a map pin: a 22 m marker is ~5 px
    // from a 4 km overview and ~200 px from street level. Screen height is
    // proportional to worldHeight / distance, so scaling by distance cancels out.
    // (The vegetation layer solves the same readability problem with `setZoomScale`.)
    update() {
        const camPos = this.ctx.camera.position;
        this.annotations.forEach(object => {
            if (object.userData.kind !== 'marker' && object.userData.kind !== 'unit') return;
            const k = THREE.MathUtils.clamp(object.position.distanceTo(camPos) / 400, 0.6, 15);
            object.scale.setScalar(k);
        });
        if (this.selectionBox) this.selectionBox.update();
    }

    reDrape(terrain) {
        this.annotations.forEach(object => {
            switch (object.userData.kind) {
                case 'arrow':
                case 'phaseLine': reDrapeArrow(object, terrain); break;
                case 'obstacle': reDrapeObstacle(object, terrain); break;
                case 'marker':
                case 'unit':
                case 'foxhole': reDrapeMarker(object, terrain); break;
                case 'crater': reDrapeDebris(object, terrain); break;
            }
        });
        this.damage.reDrape(terrain);
        this.scorch.reDrape(terrain);
        this.control.reDrape(terrain);
        if (this.selected) this.select(this.selected);   // refresh the selection box
    }

    capture() {
        const { renderer, scene, camera, controls, info } = this.ctx;
        captureScreenshot({ renderer, scene, camera, controls }, {
            scale: this.opts.shotScale,
            poster: this.opts.poster,
            title: this.opts.title || info.title,
            subtitle: info.subtitle
        });
    }

    // ── save / load ────────────────────────────────────────────────────────

    _storageKey() {
        const { lat, lng, size } = this.ctx.info;
        return `3d-sandbox-${lat.toFixed(4)}_${lng.toFixed(4)}_${size}`;
    }

    serialize() {
        const toLL = p => {
            const { lat, lng } = this.ctx.proj.toLatLng(p.x, p.z);
            return [lng, lat];
        };
        const annotations = this.annotations.map(object => {
            const u = object.userData;
            switch (u.kind) {
                case 'arrow':
                case 'phaseLine':
                case 'obstacle':
                    return { kind: u.kind, points: u.points.map(toLL), opts: u.opts };
                case 'marker':
                case 'unit':
                case 'foxhole':
                    return {
                        kind: u.kind, at: toLL({ x: u.localX, z: u.localZ }),
                        opts: u.opts, buildingId: u.buildingId || null
                    };
                case 'crater':
                    return { kind: 'crater', at: toLL({ x: u.localX, z: u.localZ }), radius: u.radius };
                default: return null;
            }
        }).filter(Boolean);

        const { lat, lng, size } = this.ctx.info;
        return {
            version: SAVE_VERSION, origin: { lat, lng, size }, annotations,
            damage: this.damage.serialize(),
            control: this.control.serialize(),
            // erased areas are saved as circles, not tree indices — see eraser.js
            erase: this.eraser.serialize()
        };
    }

    deserialize(data) {
        if (!data || data.version !== SAVE_VERSION) {
            console.warn('Sandbox: unsupported save version', data?.version);
            return 0;
        }
        const toLocal = ([lng, lat]) => this.ctx.proj.toLocal(lat, lng);
        const byId = new Map(this.ctx.buildings.records.map(r => [r.id, r]));
        let restored = 0, missed = 0;

        (data.annotations || []).forEach(a => {
            let object = null;
            if (a.kind === 'arrow' || a.kind === 'phaseLine') {
                object = buildDrapedArrow(a.points.map(toLocal), this.ctx.terrain, a.opts);
            } else if (a.kind === 'obstacle') {
                object = buildObstacleBelt(a.points.map(toLocal), this.ctx.terrain, a.opts);
            } else if (a.kind === 'marker' || a.kind === 'unit' || a.kind === 'foxhole') {
                const { x, z } = toLocal(a.at);
                object = a.kind === 'foxhole' ? buildFoxhole(a.opts)
                    : a.kind === 'unit' ? buildUnitIcon(a.opts)
                        : buildMarker(a.opts);
                const record = a.buildingId ? byId.get(a.buildingId) : null;
                placeMarker(object, x, z, this.ctx.terrain, record ? { record } : null);
            } else if (a.kind === 'crater') {
                const { x, z } = toLocal(a.at);
                object = this.damage.addCrater(x, z, a.radius);
                this.group.add(object);
            }
            if (!object) { missed++; return; }
            if (a.kind !== 'crater') this.group.add(object);
            this.annotations.push(object);
            restored++;
        });

        (data.damage || []).forEach(d => {
            const record = byId.get(d.id);
            if (record) { this.damage.setState(record, d.state); restored++; }
            else missed++;
        });

        if (data.control?.length) { this.control.load(data.control); restored += data.control.length; }
        if (data.erase?.length) { this.eraser.load(data.erase); restored += data.erase.length; }

        if (missed) console.warn(`Sandbox: skipped ${missed} item(s) that did not match this scene.`);
        this.undoStack.length = 0;
        this._updateCount();
        return restored;
    }

    save() {
        const { lat, lng } = this.ctx.info;
        downloadJSON(this.serialize(), `sandbox-${lat.toFixed(4)}_${lng.toFixed(4)}.json`);
    }

    async load() {
        const data = await pickJSONFile();
        if (!data) return;
        this.clearAll();
        const n = this.deserialize(data);
        this.el.hint.textContent = `Loaded ${n} item(s).`;
        this._autosave();
    }

    _autosave() {
        clearTimeout(this._autosaveTimer);
        this._autosaveTimer = setTimeout(() => {
            try {
                localStorage.setItem(this._storageKey(), JSON.stringify(this.serialize()));
            } catch (e) {
                console.warn('Sandbox autosave failed:', e);
            }
        }, 800);
    }

    // Offer to restore the last autosave for this exact tile.
    restoreAutosave() {
        let raw;
        try {
            raw = localStorage.getItem(this._storageKey());
        } catch (e) { return; }
        if (!raw) return;
        let data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        const count = (data.annotations?.length || 0) + (data.damage?.length || 0);
        if (!count) return;
        if (!confirm(`Restore your previous sandbox for this sector (${count} item(s))?`)) {
            try { localStorage.removeItem(this._storageKey()); } catch (e) { /* ignore */ }
            return;
        }
        this.deserialize(data);
    }
}

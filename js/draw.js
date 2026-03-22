/**
 * DrawingTool — canvas overlay drawing for Leaflet maps
 *
 * Modes: freedraw, line, arrow, ellipse, rect, arc, eraser
 *
 * Ellipse / Rect / Arc use a two-drag interaction:
 *   Drag 1 — define the main axis (p1 → p2)
 *   Drag 2 — define perpendicular width / bulge (p3); drag farther to stretch wider
 *
 * The dash flag applies a dashed stroke to any shape.
 */
class DrawingTool {
    constructor(map) {
        this.map  = map;
        this.shapes = [];
        this.active = false;
        this.mode   = 'freedraw';
        this.color  = '#ff0000';
        this.thickness = 3;
        this.dash   = false;

        // state machine: 'idle' | 'p1drag' | 'p2wait' | 'p2drag'
        this._state   = 'idle';
        this._current = null;

        this._setupCanvas();
        this._bindMapEvents();
    }

    // ── setup ───────────────────────────────────────────────

    _setupCanvas() {
        const container = this.map.getContainer();
        this.canvas = document.createElement('canvas');
        const c = this.canvas;
        c.style.position    = 'absolute';
        c.style.top         = '0';
        c.style.left        = '0';
        c.style.zIndex      = '500';
        c.style.pointerEvents = 'none';
        c.style.cursor      = 'crosshair';
        container.appendChild(c);
        this.ctx = c.getContext('2d');
        this._resize();
    }

    _resize() {
        const container = this.map.getContainer();
        this.canvas.width  = container.clientWidth;
        this.canvas.height = container.clientHeight;
    }

    _bindMapEvents() {
        this.map.on('move zoom resize', () => {
            this._resize();
            this._render();
        });
    }

    // ── public API ──────────────────────────────────────────

    enable() {
        if (this.active) return;
        this.active = true;
        this.canvas.style.pointerEvents = 'auto';
        this.map.dragging.disable();
        this.map.scrollWheelZoom.disable();
        this._state   = 'idle';
        this._current = null;

        const c = this.canvas;
        this._bDown  = this._onDown.bind(this);
        this._bMove  = this._onMove.bind(this);
        this._bUp    = this._onUp.bind(this);
        this._bLeave = this._onLeave.bind(this);
        c.addEventListener('mousedown',  this._bDown);
        c.addEventListener('mousemove',  this._bMove);
        c.addEventListener('mouseup',    this._bUp);
        c.addEventListener('mouseleave', this._bLeave);
        c.addEventListener('touchstart', this._bDown, { passive: false });
        c.addEventListener('touchmove',  this._bMove, { passive: false });
        c.addEventListener('touchend',   this._bUp);
        this._render();
    }

    disable() {
        if (!this.active) return;
        this.active = false;
        this.canvas.style.pointerEvents = 'none';
        this.map.dragging.enable();
        this.map.scrollWheelZoom.enable();
        this._hideTextInput();
        this._state   = 'idle';
        this._current = null;

        const c = this.canvas;
        c.removeEventListener('mousedown',  this._bDown);
        c.removeEventListener('mousemove',  this._bMove);
        c.removeEventListener('mouseup',    this._bUp);
        c.removeEventListener('mouseleave', this._bLeave);
        c.removeEventListener('touchstart', this._bDown);
        c.removeEventListener('touchmove',  this._bMove);
        c.removeEventListener('touchend',   this._bUp);
        this._render();
    }

    setMode(mode) {
        this._hideTextInput();
        this.mode     = mode;
        this._state   = 'idle';
        this._current = null;
        this.canvas.style.cursor = mode === 'eraser' ? 'cell' : 'crosshair';
        this._render();
    }

    setColor(color)     { this.color = color; }
    setThickness(t)     { this.thickness = Number(t); }
    setDash(on)         { this.dash = Boolean(on); }

    undo() {
        if (this._state === 'p2wait' || this._state === 'p1drag' || this._state === 'p2drag') {
            this._state   = 'idle';
            this._current = null;
        } else {
            this.shapes.pop();
        }
        this._render();
    }

    clear() {
        this.shapes   = [];
        this._state   = 'idle';
        this._current = null;
        this._render();
    }

    // ── event helpers ───────────────────────────────────────

    _eventPoint(e) {
        e.preventDefault();
        const src  = (e.touches && e.touches[0]) || e;
        const rect = this.canvas.getBoundingClientRect();
        return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    _toLl(pt) { return this.map.containerPointToLatLng(L.point(pt.x, pt.y)); }
    _toPx(ll) { const p = this.map.latLngToContainerPoint(ll); return { x: p.x, y: p.y }; }

    _isTwoPhase() { return this.mode === 'ellipse' || this.mode === 'rect'; }

    // ── mouse handlers ──────────────────────────────────────

    _onDown(e) {
        const pt = this._eventPoint(e);

        if (this.mode === 'eraser') { this._state = 'p1drag'; this._eraseAt(pt); return; }

        if (this.mode === 'freedraw') {
            this._state   = 'p1drag';
            this._current = { type: 'freedraw', points: [this._toLl(pt)], color: this.color, thickness: this.thickness, dash: this.dash };
            return;
        }

        if (this.mode === 'line' || this.mode === 'arrow') {
            this._state   = 'p1drag';
            const ll      = this._toLl(pt);
            this._current = { type: this.mode, start: ll, end: ll, color: this.color, thickness: this.thickness, dash: this.dash };
            return;
        }

        // Text: drag to set anchor + angle, then type
        if (this.mode === 'text' && this._state === 'idle') {
            this._state   = 'p1drag';
            const ll      = this._toLl(pt);
            this._current = { type: 'text', p1: ll, p2: ll, text: '', fontSize: this.thickness, color: this.color };
            return;
        }

        // Arc: single drag, A→B→C path; B = furthest point from A-C
        if (this.mode === 'arc') {
            this._state   = 'p1drag';
            const ll      = this._toLl(pt);
            this._current = { type: 'arc', p1: ll, p2: ll, p3: null, _pts: [pt], color: this.color, thickness: this.thickness, dash: this.dash };
            return;
        }

        if (this._isTwoPhase()) {
            if (this._state === 'idle') {
                this._state   = 'p1drag';
                const ll      = this._toLl(pt);
                this._current = { type: this.mode, p1: ll, p2: ll, p3: null, color: this.color, thickness: this.thickness, dash: this.dash };
            } else if (this._state === 'p2wait') {
                this._state = 'p2drag';
                this._current.p3 = this._toLl(pt);
            }
        }
    }

    _onMove(e) {
        const pt = this._eventPoint(e);

        if (this.mode === 'eraser') { if (this._state === 'p1drag') this._eraseAt(pt); return; }
        if (!this._current) return;

        if (this.mode === 'freedraw' && this._state === 'p1drag') {
            this._current.points.push(this._toLl(pt));
            this._render(); return;
        }

        if ((this.mode === 'line' || this.mode === 'arrow') && this._state === 'p1drag') {
            this._current.end = this._toLl(pt);
            this._render(); return;
        }

        if (this.mode === 'text' && this._state === 'p1drag') {
            this._current.p2 = this._toLl(pt);
            this._render(); return;
        }

        if (this.mode === 'arc' && this._state === 'p1drag') {
            this._current._pts.push(pt);
            // p2 = current endpoint; p3 = furthest point from p1-p2 line (live preview)
            this._current.p2 = this._toLl(pt);
            this._current.p3 = this._arcFurthestBulge(this._current._pts);
            this._render(); return;
        }

        if (this._isTwoPhase()) {
            if (this._state === 'p1drag') {
                this._current.p2 = this._toLl(pt);
                this._render();
            } else if (this._state === 'p2wait' || this._state === 'p2drag') {
                this._current.p3 = this._toLl(pt);
                this._render();
            }
        }
    }

    _onUp(e) {
        if (this.mode === 'eraser') { this._state = 'idle'; return; }
        if (!this._current) { this._state = 'idle'; return; }

        if (this.mode === 'freedraw') {
            if (this._current.points.length > 1) this.shapes.push(this._current);
            this._current = null; this._state = 'idle'; this._render(); return;
        }

        if (this.mode === 'line' || this.mode === 'arrow') {
            const s  = this._toPx(this._current.start);
            const en = this._toPx(this._current.end);
            if (Math.hypot(en.x - s.x, en.y - s.y) > 3) this.shapes.push(this._current);
            this._current = null; this._state = 'idle'; this._render(); return;
        }

        if (this.mode === 'text') {
            if (this._state === 'p1drag') {
                const p1px = this._toPx(this._current.p1);
                const p2px = this._toPx(this._current.p2);
                const angle = Math.hypot(p2px.x - p1px.x, p2px.y - p1px.y) > 5
                    ? Math.atan2(p2px.y - p1px.y, p2px.x - p1px.x)
                    : 0;
                this._state = 'text_input';
                this._showTextInput(p1px, angle);
            }
            return;
        }

        if (this.mode === 'arc') {
            const p1px = this._toPx(this._current.p1);
            const p2px = this._toPx(this._current.p2);
            if (Math.hypot(p2px.x - p1px.x, p2px.y - p1px.y) > 3) {
                const { p1, p2, p3, color, thickness, dash } = this._current;
                this.shapes.push({ type: 'arc', p1, p2, p3, color, thickness, dash });
            }
            this._current = null; this._state = 'idle'; this._render(); return;
        }

        if (this._isTwoPhase()) {
            if (this._state === 'p1drag') {
                const p1px = this._toPx(this._current.p1);
                const p2px = this._toPx(this._current.p2);
                if (Math.hypot(p2px.x - p1px.x, p2px.y - p1px.y) > 3) {
                    this._state = 'p2wait';
                } else {
                    this._current = null; this._state = 'idle';
                }
                this._render();
            } else if (this._state === 'p2drag') {
                this.shapes.push({ ...this._current });
                this._current = null; this._state = 'idle'; this._render();
            }
        }
    }

    _onLeave(e) {
        if (this._state === 'p1drag' && !this._isTwoPhase()) {
            this._onUp(e);
        }
    }

    // ── arc bulge helper ────────────────────────────────────

    /**
     * Given an array of pixel points (the freehand path), returns the latlng
     * of the point with the greatest perpendicular distance from the A-C chord.
     * A = pts[0], C = pts[last].
     */
    _arcFurthestBulge(pts) {
        if (pts.length < 2) return null;
        const A = pts[0];
        const C = pts[pts.length - 1];
        const dx = C.x - A.x, dy = C.y - A.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) return null;

        let maxDist = 0;
        let bulge   = null;
        for (const pt of pts) {
            // signed perpendicular distance from pt to line A-C
            const d = ((pt.x - A.x) * dy - (pt.y - A.y) * dx) / len;
            if (Math.abs(d) > Math.abs(maxDist)) {
                maxDist = d;
                bulge   = pt;
            }
        }
        return bulge ? this._toLl(bulge) : null;
    }

    // ── eraser ──────────────────────────────────────────────

    _eraseAt(pt) {
        const threshold = 15;
        this.shapes = this.shapes.filter(s => !this._hitTest(s, pt, threshold));
        this._render();
    }

    _hitTest(shape, pt, threshold) {
        if (shape.type === 'freedraw') {
            return shape.points.some(ll => {
                const p = this._toPx(ll);
                return Math.hypot(p.x - pt.x, p.y - pt.y) < threshold;
            });
        }
        if (shape.type === 'line' || shape.type === 'arrow') {
            return this._distToSegment(pt, this._toPx(shape.start), this._toPx(shape.end)) < threshold;
        }
        if (shape.type === 'text') {
            const p = this._toPx(shape.p1);
            return Math.hypot(p.x - pt.x, p.y - pt.y) < threshold * 2;
        }
        if (shape.type === 'ellipse' || shape.type === 'rect' || shape.type === 'arc') {
            const p1 = this._toPx(shape.p1);
            const p2 = this._toPx(shape.p2);
            const cx = (p1.x + p2.x) / 2;
            const cy = (p1.y + p2.y) / 2;
            return Math.hypot(cx - pt.x, cy - pt.y) < threshold * 3;
        }
        return false;
    }

    _distToSegment(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    // ── arc geometry ─────────────────────────────────────────

    /**
     * Returns { cx, cy, r, a1, a2, anticlockwise } for canvas.arc(),
     * given chord endpoints p1, p2 and a bulge-control point p3 (all in pixel space).
     * h = signed distance from p3 to the chord line (positive = toward perp direction).
     */
    _arcParams(p1, p2, p3) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) return null;

        // unit perp (90° CCW from chord direction)
        const px = -dy / len;
        const py =  dx / len;

        // signed bulge height from chord
        const h = (p3.x - mx) * px + (p3.y - my) * py;

        if (Math.abs(h) < 0.5) return null; // degenerate flat arc

        const halfChord = len / 2;
        // R signed: R = (halfChord² + h²) / (2h)
        const R = (halfChord * halfChord + h * h) / (2 * h);

        // center = M + (h - R) * perpUnit
        const cx = mx + (h - R) * px;
        const cy = my + (h - R) * py;
        const r  = Math.abs(R);

        const a1 = Math.atan2(p1.y - cy, p1.x - cx);
        const a2 = Math.atan2(p2.y - cy, p2.x - cx);

        // anticlockwise=true → decreasing angle (short arc) when h > 0
        return { cx, cy, r, a1, a2, anticlockwise: h > 0 };
    }

    // ── render ──────────────────────────────────────────────

    _render() {
        const { canvas, ctx } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const shape of this.shapes) this._drawShape(ctx, shape, false);
        if (this._current) this._drawShape(ctx, this._current, true);
    }

    _drawShape(ctx, shape, preview) {
        ctx.save();
        ctx.strokeStyle  = shape.color;
        ctx.lineWidth    = shape.thickness;
        ctx.lineCap      = 'round';
        ctx.lineJoin     = 'round';
        ctx.globalAlpha  = preview ? 0.65 : 1;
        ctx.setLineDash(shape.dash ? [Math.max(8, shape.thickness * 3), Math.max(5, shape.thickness * 2)] : []);

        if      (shape.type === 'freedraw') this._drawFreeDraw(ctx, shape);
        else if (shape.type === 'line')     this._drawLine(ctx, shape);
        else if (shape.type === 'arrow')    this._drawArrow(ctx, shape);
        else if (shape.type === 'ellipse')  this._drawEllipse(ctx, shape, preview);
        else if (shape.type === 'rect')     this._drawRect(ctx, shape, preview);
        else if (shape.type === 'arc')      this._drawArc(ctx, shape, preview);
        else if (shape.type === 'text')     this._drawText(ctx, shape, preview);

        ctx.restore();
    }

    _drawFreeDraw(ctx, shape) {
        if (shape.points.length < 2) return;
        ctx.beginPath();
        const f = this._toPx(shape.points[0]);
        ctx.moveTo(f.x, f.y);
        for (let i = 1; i < shape.points.length; i++) {
            const p = this._toPx(shape.points[i]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
    }

    _drawLine(ctx, shape) {
        const s = this._toPx(shape.start);
        const e = this._toPx(shape.end);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        ctx.stroke();
    }

    _drawArrow(ctx, shape) {
        const s = this._toPx(shape.start);
        const e = this._toPx(shape.end);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        ctx.stroke();

        const angle = Math.atan2(e.y - s.y, e.x - s.x);
        const size  = Math.max(12, shape.thickness * 4);
        ctx.setLineDash([]); // always solid arrowhead
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x - size * Math.cos(angle - Math.PI / 6), e.y - size * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x - size * Math.cos(angle + Math.PI / 6), e.y - size * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
    }

    _twoPhaseMetrics(shape) {
        const p1 = this._toPx(shape.p1);
        const p2 = this._toPx(shape.p2);
        const cx      = (p1.x + p2.x) / 2;
        const cy      = (p1.y + p2.y) / 2;
        const dx      = p2.x - p1.x;
        const dy      = p2.y - p1.y;
        const halfLen = Math.hypot(dx, dy) / 2;
        const angle   = Math.atan2(dy, dx);
        let halfWidth = halfLen * 0.4; // default when p3 not yet set
        if (shape.p3) {
            const p3 = this._toPx(shape.p3);
            halfWidth = Math.max(1, this._distToSegment(p3, p1, p2));
        }
        return { p1, p2, cx, cy, halfLen, halfWidth, angle };
    }

    _drawAxisGuide(ctx, p1, p2) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
    }

    _drawEllipse(ctx, shape, preview) {
        const { p1, p2, cx, cy, halfLen: rx, halfWidth: ry, angle } = this._twoPhaseMetrics(shape);
        if (rx < 2) return;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, Math.max(1, ry), angle, 0, Math.PI * 2);
        ctx.stroke();
        if (preview && !shape.p3) this._drawAxisGuide(ctx, p1, p2);
    }

    _drawRect(ctx, shape, preview) {
        const { p1, p2, cx, cy, halfLen, halfWidth, angle } = this._twoPhaseMetrics(shape);
        if (halfLen < 2) return;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.rect(-halfLen, -halfWidth, halfLen * 2, halfWidth * 2);
        ctx.stroke();
        ctx.restore();
        if (preview && !shape.p3) this._drawAxisGuide(ctx, p1, p2);
    }

    _drawArc(ctx, shape, preview) {
        const p1 = this._toPx(shape.p1);
        const p2 = this._toPx(shape.p2);

        let p3;
        if (shape.p3) {
            p3 = this._toPx(shape.p3);
        } else {
            // default preview: small bulge perpendicular to chord
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy);
            const px = -dy / len, py = dx / len;
            const defaultH = len * 0.25;
            p3 = { x: mx + px * defaultH, y: my + py * defaultH };
        }

        const params = this._arcParams(p1, p2, p3);
        if (!params) {
            // degenerate: draw straight line
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
            return;
        }
        const { cx, cy, r, a1, a2, anticlockwise } = params;
        ctx.beginPath();
        ctx.arc(cx, cy, r, a1, a2, anticlockwise);
        ctx.stroke();

        if (preview && !shape.p3) this._drawAxisGuide(ctx, p1, p2);
    }
    // ── text input overlay ──────────────────────────────────

    _showTextInput(p1px, angle) {
        this._hideTextInput();
        const shape     = this._current;
        const fontSize  = shape.fontSize;
        const container = this.map.getContainer();

        const wrap = document.createElement('div');
        wrap.className = 'draw-text-wrap';
        wrap.style.left            = p1px.x + 'px';
        wrap.style.top             = (p1px.y - fontSize * 0.6) + 'px';
        wrap.style.transformOrigin = '0 50%';
        wrap.style.transform       = `rotate(${angle}rad)`;

        const input = document.createElement('input');
        input.type  = 'text';
        input.className            = 'draw-text-input';
        input.style.color          = shape.color;
        input.style.fontSize       = fontSize + 'px';
        input.style.caretColor     = shape.color;
        input.style.borderBottomColor = shape.color;

        wrap.appendChild(input);
        container.appendChild(wrap);
        this._textWrap = wrap;

        // focus after paint so the input is in the DOM
        requestAnimationFrame(() => input.focus());

        const commit = () => {
            if (!this._textWrap) return; // already handled
            const text = input.value.trim();
            if (text) {
                shape.text = text;
                this.shapes.push({ type: 'text', p1: shape.p1, p2: shape.p2, text, fontSize, color: shape.color });
            }
            this._hideTextInput();
            this._current = null;
            this._state   = 'idle';
            this._render();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { this._hideTextInput(); this._current = null; this._state = 'idle'; this._render(); }
        });
        input.addEventListener('blur', commit);
    }

    _hideTextInput() {
        if (this._textWrap) { this._textWrap.remove(); this._textWrap = null; }
    }

    // ── text renderer ───────────────────────────────────────

    _drawText(ctx, shape, preview) {
        const p1    = this._toPx(shape.p1);
        const p2    = this._toPx(shape.p2);
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        // direction guide while dragging (before input)
        if (preview && !shape.text) {
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.globalAlpha = 0.4;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (!shape.text) return;

        ctx.save();
        ctx.translate(p1.x, p1.y);
        ctx.rotate(angle);
        ctx.font         = `${shape.fontSize}px Helvetica, Arial, sans-serif`;
        ctx.fillStyle    = shape.color;
        ctx.textBaseline = 'alphabetic';
        ctx.setLineDash([]);
        ctx.fillText(shape.text, 0, 0);
        ctx.restore();
    }
}

window.DrawingTool = DrawingTool;

/**
 * DrawingTool — canvas overlay drawing for Leaflet maps
 *
 * Modes: freedraw, freearea (lasso), line, arrow, ellipse, rect, arc, polygon, text, eraser
 *
 * Ellipse / Rect / Arc use a two-drag interaction:
 *   Drag 1 — define the main axis (p1 → p2)
 *   Drag 2 — define perpendicular width / bulge (p3); drag farther to stretch wider
 *
 * Polygon is click-per-vertex: double-click or Enter closes it, Escape aborts.
 * Freearea is a freehand lasso: drag a loop and the interior is filled/hatched.
 *
 * Flags: dash (any shape), fill + pattern (polygon), head + taper (freedraw / arc),
 * halo + bold (text). `icon` shapes are placed programmatically from images/events/.
 *
 * The canvas backing store is scaled by devicePixelRatio; all drawing code works
 * in CSS pixels.
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
        this.fill   = false;
        this.head   = false;   // arrowhead on freedraw / arc
        this.taper  = false;   // wedge-shaped axis arrows
        this.pattern      = null;  // null | 'hatch' | 'crosshatch' | 'dots'
        this.patternAngle = 45;

        this._patternCache = new Map();   // `${kind}:${color}` → CanvasPattern
        this._imageCache   = new Map();   // icon name → HTMLImageElement

        // state machine: 'idle' | 'p1drag' | 'p2wait' | 'p2drag' | 'poly'
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

    /**
     * Sizes the backing store to the device pixel ratio so strokes, halos and
     * hatch patterns stay crisp on retina displays and in 2x poster exports.
     * All drawing code keeps working in CSS pixels — the transform handles the rest.
     */
    _resize() {
        const container = this.map.getContainer();
        const w = container.clientWidth;
        const h = container.clientHeight;
        const dpr = window.devicePixelRatio || 1;

        this.cssWidth  = w;
        this.cssHeight = h;
        this.dpr       = dpr;

        this.canvas.width  = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width  = w + 'px';
        this.canvas.style.height = h + 'px';
        // setting .width/.height resets the context, so re-apply the scale every time
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._patternCache?.clear();
    }

    _bindMapEvents() {
        this.map.on('move zoom resize rotate', () => {
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
        this._bDbl   = this._onDblClick.bind(this);
        this._bKey   = this._onKeyDown.bind(this);
        c.addEventListener('mousedown',  this._bDown);
        c.addEventListener('mousemove',  this._bMove);
        c.addEventListener('mouseup',    this._bUp);
        c.addEventListener('mouseleave', this._bLeave);
        c.addEventListener('dblclick',   this._bDbl);
        c.addEventListener('touchstart', this._bDown, { passive: false });
        c.addEventListener('touchmove',  this._bMove, { passive: false });
        c.addEventListener('touchend',   this._bUp);
        document.addEventListener('keydown', this._bKey);
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
        c.removeEventListener('dblclick',   this._bDbl);
        c.removeEventListener('touchstart', this._bDown);
        c.removeEventListener('touchmove',  this._bMove);
        c.removeEventListener('touchend',   this._bUp);
        document.removeEventListener('keydown', this._bKey);
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
    setFill(on)         { this.fill = Boolean(on); }
    setHead(on)         { this.head = Boolean(on); }
    setTaper(on)        { this.taper = Boolean(on); }
    setPattern(kind)    { this.pattern = kind || null; }
    setPatternAngle(a)  { this.patternAngle = Number(a) || 0; }

    /** Evenly thins a dense freehand path, always keeping both endpoints. */
    static _thin(points, max) {
        if (points.length <= max) return points;
        const step = points.length / max;
        const out = [];
        for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
        out.push(points[points.length - 1]);
        return out;
    }

    undo() {
        if (this._state === 'poly') {
            this._current.points.pop();
            if (!this._current.points.length) { this._current = null; this._state = 'idle'; }
        } else if (this._state === 'p2wait' || this._state === 'p1drag' || this._state === 'p2drag') {
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
            this._current = { type: 'freedraw', points: [this._toLl(pt)], color: this.color, thickness: this.thickness, dash: this.dash, head: this.head, taper: this.taper };
            return;
        }

        // Lasso: freehand drag whose interior gets filled/hatched on release
        if (this.mode === 'freearea') {
            this._state   = 'p1drag';
            this._current = { type: 'polygon', points: [this._toLl(pt)], smooth: false,
                              color: this.color, thickness: this.thickness, dash: this.dash,
                              fill: this.fill, fillOpacity: 0.25,
                              pattern: this.pattern, patternAngle: this.patternAngle };
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

        // Polygon: one click per vertex; dblclick / Enter closes, Escape aborts
        if (this.mode === 'polygon') {
            const ll = this._toLl(pt);
            if (this._state === 'idle') {
                this._state   = 'poly';
                this._current = { type: 'polygon', points: [ll], _hover: ll,
                                  color: this.color, thickness: this.thickness, dash: this.dash,
                                  fill: this.fill, fillOpacity: 0.25 };
            } else {
                this._current.points.push(ll);
            }
            this._render();
            return;
        }

        // Arc: single drag, A→B→C path; B = furthest point from A-C
        if (this.mode === 'arc') {
            this._state   = 'p1drag';
            const ll      = this._toLl(pt);
            this._current = { type: 'arc', p1: ll, p2: ll, p3: null, _pts: [pt], color: this.color, thickness: this.thickness, dash: this.dash, head: this.head, taper: this.taper };
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

        if ((this.mode === 'freedraw' || this.mode === 'freearea') && this._state === 'p1drag') {
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

        if (this.mode === 'polygon' && this._state === 'poly') {
            this._current._hover = this._toLl(pt);
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
        if (this.mode === 'polygon') return; // vertices are committed on mousedown
        if (!this._current) { this._state = 'idle'; return; }

        if (this.mode === 'freedraw') {
            if (this._current.points.length > 1) this.shapes.push(this._current);
            this._current = null; this._state = 'idle'; this._render(); return;
        }

        if (this.mode === 'freearea') {
            // the path is closed implicitly by _drawPolygon; thin it so the fill
            // pattern and any later smoothing stay cheap on a long freehand drag
            if (this._current.points.length > 6) {
                this._current.points = DrawingTool._thin(this._current.points, 400);
                this.shapes.push(this._current);
            }
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
                const { p1, p2, p3, color, thickness, dash, head, taper } = this._current;
                this.shapes.push({ type: 'arc', p1, p2, p3, color, thickness, dash, head, taper });
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

    _onDblClick(e) {
        if (this.mode === 'polygon' && this._state === 'poly') {
            e.preventDefault();
            this._closePolygon();
        }
    }

    _onKeyDown(e) {
        if (this._state !== 'poly') return;
        if (e.key === 'Enter')  { e.preventDefault(); this._closePolygon(); }
        if (e.key === 'Escape') { this._current = null; this._state = 'idle'; this._render(); }
    }

    /** Commits the in-progress polygon (>= 3 vertices), dropping the dblclick duplicate. */
    _closePolygon() {
        const pts = this._current.points;
        // a double-click fires two mousedowns, each of which added a vertex on
        // top of the previous one — drop every coincident trailing vertex
        while (pts.length > 1) {
            const a = this._toPx(pts[pts.length - 1]);
            const b = this._toPx(pts[pts.length - 2]);
            if (Math.hypot(a.x - b.x, a.y - b.y) >= 4) break;
            pts.pop();
        }
        if (pts.length >= 3) {
            const { color, thickness, dash, fill, fillOpacity } = this._current;
            this.shapes.push({ type: 'polygon', points: pts, color, thickness, dash, fill, fillOpacity });
        }
        this._current = null;
        this._state   = 'idle';
        this._render();
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
        if (shape.type === 'freedraw' || shape.type === 'polygon') {
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
        if (shape.type === 'icon') {
            const p = this._toPx(shape.at);
            return Math.hypot(p.x - pt.x, p.y - pt.y) < Math.max(threshold, (shape.size || 28) / 2);
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
        const { ctx } = this;
        // CSS pixels — the context is scaled by dpr in _resize()
        ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
        for (const shape of this.shapes) this._drawShape(ctx, shape, false);
        if (this._current) this._drawShape(ctx, this._current, true);
    }

    _drawShape(ctx, shape, preview) {
        ctx.save();
        ctx.strokeStyle  = shape.color;
        // filled arrowheads and tapered wedges fill without setting their own style
        ctx.fillStyle    = shape.color;
        ctx.lineWidth    = shape.thickness;
        ctx.lineCap      = 'round';
        ctx.lineJoin     = 'round';
        ctx.globalAlpha  = preview ? 0.65 : 1;
        ctx.setLineDash(shape.dash ? [Math.max(8, shape.thickness * 3), Math.max(5, shape.thickness * 2)] : []);

        if      (shape.type === 'freedraw') this._drawFreeDraw(ctx, shape);
        else if (shape.type === 'polygon')  this._drawPolygon(ctx, shape, preview);
        else if (shape.type === 'line')     this._drawLine(ctx, shape);
        else if (shape.type === 'arrow')    this._drawArrow(ctx, shape);
        else if (shape.type === 'ellipse')  this._drawEllipse(ctx, shape, preview);
        else if (shape.type === 'rect')     this._drawRect(ctx, shape, preview);
        else if (shape.type === 'arc')      this._drawArc(ctx, shape, preview);
        else if (shape.type === 'text')     this._drawText(ctx, shape, preview);
        else if (shape.type === 'icon')     this._drawIcon(ctx, shape);

        ctx.restore();
    }

    _drawFreeDraw(ctx, shape) {
        if (shape.points.length < 2) return;
        const px = shape.points.map(ll => this._toPx(ll));

        if (shape.taper) {
            this._strokeTapered(ctx, px, shape);
        } else {
            ctx.beginPath();
            ctx.moveTo(px[0].x, px[0].y);
            for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
            ctx.stroke();
        }

        if (shape.head) {
            const tip = px[px.length - 1];
            const prev = this._headAnchor(px);
            this._arrowHead(ctx, tip, Math.atan2(tip.y - prev.y, tip.x - prev.x),
                            shape.thickness * (shape.taper ? 1.6 : 1), !!shape.taper);
        }
    }

    /**
     * Last point far enough back along the path to give a stable heading — using
     * the immediately preceding point makes the arrowhead jitter on dense freehand paths.
     */
    _headAnchor(px) {
        const tip = px[px.length - 1];
        for (let i = px.length - 2; i >= 0; i--) {
            if (Math.hypot(tip.x - px[i].x, tip.y - px[i].y) > 12) return px[i];
        }
        return px[0];
    }

    /**
     * Wedge-shaped stroke: width ramps from thin at the origin to `thickness`
     * at the tip. Built as a filled polygon by offsetting along the path normal.
     */
    _strokeTapered(ctx, px, shape) {
        if (px.length < 2) return;
        const maxW = shape.thickness * 1.6;
        const minW = Math.max(0.6, shape.thickness * 0.18);

        // cumulative length, so the ramp follows arc length rather than point index
        const cum = [0];
        for (let i = 1; i < px.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y));
        }
        const total = cum[cum.length - 1] || 1;

        const left = [], right = [];
        for (let i = 0; i < px.length; i++) {
            const a = px[Math.max(0, i - 1)];
            const b = px[Math.min(px.length - 1, i + 1)];
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const nx = -(b.y - a.y) / len;
            const ny =  (b.x - a.x) / len;
            const w = (minW + (maxW - minW) * (cum[i] / total)) / 2;
            left.push({ x: px[i].x + nx * w, y: px[i].y + ny * w });
            right.push({ x: px[i].x - nx * w, y: px[i].y - ny * w });
        }

        ctx.save();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(left[0].x, left[0].y);
        for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
        for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
        ctx.closePath();
        ctx.fillStyle = shape.color;
        ctx.fill();
        ctx.restore();
    }

    _drawPolygon(ctx, shape, preview) {
        const pts = shape.points || [];
        if (!pts.length) return;
        // while drawing, the cursor position is the rubber-band closing vertex
        const all = preview && shape._hover ? pts.concat([shape._hover]) : pts;
        if (all.length < 2) return;

        const px = all.map(ll => this._toPx(ll));
        ctx.beginPath();
        if (shape.smooth !== false && px.length > 2) {
            this._closedSpline(ctx, px);
        } else {
            ctx.moveTo(px[0].x, px[0].y);
            for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
        }
        ctx.closePath();

        if (shape.fill) {
            const pattern = shape.pattern && shape.pattern !== 'solid'
                ? this._patternFor(shape.pattern, shape.color, shape.patternAngle)
                : null;
            ctx.save();
            // a patterned tile is mostly transparent already, so it needs far more
            // alpha than a flat fill — but not full, or it buries the terrain
            ctx.globalAlpha = (preview ? 0.65 : 1) *
                (pattern ? (shape.patternOpacity ?? 0.55) : (shape.fillOpacity ?? 0.25));
            ctx.fillStyle   = pattern || shape.color;
            ctx.fill();
            ctx.restore();
        }
        ctx.stroke();
    }

    /**
     * Rounded closed outline through pixel points, using quadratic segments between
     * edge midpoints. Convex hulls and buffers come out of the geometry code as
     * straight-edged polygons; without this an area zone reads as a crude slab
     * rather than a hand-drawn operational boundary.
     */
    _closedSpline(ctx, px) {
        const n = px.length;
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        let m = mid(px[n - 1], px[0]);
        ctx.moveTo(m.x, m.y);
        for (let i = 0; i < n; i++) {
            const cur = px[i];
            const next = px[(i + 1) % n];
            m = mid(cur, next);
            ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y);
        }
    }

    /**
     * Repeating fill tile for hatch / crosshatch / dots, memoised per kind+colour.
     * The tile is built at dpr resolution so the pattern stays sharp when the
     * context is scaled; cleared by _resize() whenever dpr changes.
     */
    _patternFor(kind, color, angleDeg = 45) {
        const key = `${kind}:${color}:${angleDeg}`;
        if (this._patternCache.has(key)) return this._patternCache.get(key);

        const dpr = this.dpr || 1;
        const size = 9;
        const tile = document.createElement('canvas');
        tile.width = tile.height = Math.round(size * dpr);
        const t = tile.getContext('2d');
        t.scale(dpr, dpr);
        t.strokeStyle = color;
        t.fillStyle   = color;
        t.lineWidth   = 1;
        t.lineCap     = 'square';

        if (kind === 'dots') {
            t.beginPath();
            t.arc(size / 2, size / 2, 1.4, 0, Math.PI * 2);
            t.fill();
        } else {
            // Lines are drawn across an oversized rotated field so the pattern tiles
            // seamlessly at any angle — a single stroke would clip at the tile edge.
            const angles = kind === 'crosshatch' ? [angleDeg, angleDeg + 90] : [angleDeg];
            for (const a of angles) {
                t.save();
                t.translate(size / 2, size / 2);
                t.rotate((a * Math.PI) / 180);
                for (let off = -size * 2; off <= size * 2; off += size) {
                    t.beginPath();
                    t.moveTo(off, -size * 2);
                    t.lineTo(off, size * 2);
                    t.stroke();
                }
                t.restore();
            }
        }

        const pattern = this.ctx.createPattern(tile, 'repeat');
        this._patternCache.set(key, pattern);
        return pattern;
    }

    /** Tactical icon from images/events/, centred on `at`, with an optional caption. */
    _drawIcon(ctx, shape) {
        const img = this._icon(shape.icon);
        if (!img || !img.complete || !img.naturalWidth) return;

        const p = this._toPx(shape.at);
        const size = shape.size || 28;
        ctx.save();
        ctx.setLineDash([]);
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);

        if (shape.label) {
            const fontSize = shape.labelSize || 13;
            ctx.font         = `700 ${fontSize}px Helvetica, Arial, sans-serif`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            this._haloText(ctx, shape.label, p.x, p.y + size / 2 + 3, {
                color: shape.labelColor || '#111',
                halo: shape.halo ?? '#fff',
                haloWidth: fontSize / 4,
            });
        }
        ctx.restore();
    }

    /** Lazily loads and caches an icon, re-rendering once it decodes. */
    _icon(name) {
        if (!name || !/^[\w-]+$/.test(name)) return null;
        if (this._imageCache.has(name)) return this._imageCache.get(name);

        const img = new Image();
        img.onload = () => this._render();
        img.onerror = () => console.warn(`[draw] missing icon: images/events/${name}.png`);
        img.src = `images/events/${name}.png`;
        this._imageCache.set(name, img);
        return img;
    }

    /** White halo for dark text, dark halo for light text — so a white label stays visible. */
    _autoHalo(color) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
        if (!m) return '#fff';
        const n = parseInt(m[1], 16);
        const lum = 0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255);
        return lum > 170 ? '#1a1a1a' : '#fff';
    }

    /** Stroked-then-filled text, so labels stay readable over any basemap. */
    _haloText(ctx, text, x, y, { color, halo, haloWidth }) {
        ctx.setLineDash([]);   // a dashed strokeText would look broken
        if (halo) {
            ctx.lineJoin   = 'round';
            ctx.miterLimit = 2;
            ctx.lineWidth  = haloWidth;
            ctx.strokeStyle = halo;
            ctx.strokeText(text, x, y);
        }
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
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

        this._arrowHead(ctx, e, Math.atan2(e.y - s.y, e.x - s.x), shape.thickness);
    }

    /**
     * Arrowhead at pixel point `tip`, pointing along `angle` (radians).
     * `filled` draws a solid triangle — used for tapered axis arrows, where two
     * thin strokes would look detached from the wedge they cap.
     */
    _arrowHead(ctx, tip, angle, thickness, filled = false) {
        const size = Math.max(12, thickness * 4);
        const lx = tip.x - size * Math.cos(angle - Math.PI / 6);
        const ly = tip.y - size * Math.sin(angle - Math.PI / 6);
        const rx = tip.x - size * Math.cos(angle + Math.PI / 6);
        const ry = tip.y - size * Math.sin(angle + Math.PI / 6);

        ctx.setLineDash([]); // always solid arrowhead
        ctx.beginPath();
        if (filled) {
            ctx.moveTo(tip.x, tip.y);
            ctx.lineTo(lx, ly);
            ctx.lineTo(rx, ry);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.moveTo(tip.x, tip.y); ctx.lineTo(lx, ly);
            ctx.moveTo(tip.x, tip.y); ctx.lineTo(rx, ry);
            ctx.stroke();
        }
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
            if (shape.head) this._arrowHead(ctx, p2, Math.atan2(p2.y - p1.y, p2.x - p1.x), shape.thickness);
            return;
        }
        const { cx, cy, r, a1, a2, anticlockwise } = params;

        if (shape.taper) {
            // sample the arc into points and reuse the wedge renderer
            let sweep = a2 - a1;
            if (anticlockwise) { while (sweep > 0) sweep -= 2 * Math.PI; }
            else               { while (sweep < 0) sweep += 2 * Math.PI; }
            const steps = Math.max(12, Math.min(180, Math.round(Math.abs(sweep) * r / 4)));
            const pts = [];
            for (let i = 0; i <= steps; i++) {
                const a = a1 + (sweep * i) / steps;
                pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
            }
            this._strokeTapered(ctx, pts, shape);
        } else {
            ctx.beginPath();
            ctx.arc(cx, cy, r, a1, a2, anticlockwise);
            ctx.stroke();
        }

        if (shape.head) {
            // tangent at p2, oriented along the direction of travel around the arc
            const tx = anticlockwise ?  Math.sin(a2) : -Math.sin(a2);
            const ty = anticlockwise ? -Math.cos(a2) :  Math.cos(a2);
            this._arrowHead(ctx, p2, Math.atan2(ty, tx),
                            shape.thickness * (shape.taper ? 1.6 : 1), !!shape.taper);
        }

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
        const weight = shape.bold === false ? '' : '700 ';
        ctx.font         = `${weight}${shape.fontSize}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign    = 'left';
        this._haloText(ctx, shape.text, 0, 0, {
            color: shape.color,
            halo: shape.halo === null ? null : (shape.halo ?? this._autoHalo(shape.color)),
            haloWidth: shape.haloWidth ?? shape.fontSize / 5,
        });
        ctx.restore();
    }
}

window.DrawingTool = DrawingTool;

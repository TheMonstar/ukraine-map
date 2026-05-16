/**
 * map-3d.js — local-only Mapbox GL JS 3D view overlay
 * Gitignored. Adds a "3D" button to the top bar.
 * Drawing is implemented as GL sources/layers (not a canvas overlay)
 * so shapes render correctly on the pitched 3D terrain.
 */

(function () {
    const MAPBOX_GL_VERSION = '3.10.0';
    const ARROW_HEAD_PX = 18; // arrowhead leg length in screen pixels
    const ELLIPSE_STEPS = 72; // polygon approximation for ellipse

    // ── Draw3D ────────────────────────────────────────────────────────────────
    // Shapes are stored as GeoJSON and rendered as GL layers so they follow
    // the map projection and terrain correctly in 3D.

    class Draw3D {
        constructor(glMap) {
            this.glMap    = glMap;
            this.enabled  = false;
            this.mode     = 'freedraw';
            this.color    = '#ff4444';
            this.width    = 3;
            this._shapes  = [];   // committed Feature arrays
            this._preview = null; // Feature[] being drawn right now
            this._drawing = false;
            this._startPx = null;
            this._freePts = [];
            this._uid     = 0;
            this._toolbar = null;
            this._toolBtns = {};

            this._paintedBuildings = new Map(); // featureId → color
            this._paintStack       = [];        // featureId order for undo

            this._onDown  = this._onDown.bind(this);
            this._onMove  = this._onMove.bind(this);
            this._onUp    = this._onUp.bind(this);
        }

        // ── public API ────────────────────────────────────────────────────────

        init() {
            this._addGLLayers();
            this._buildToolbar();
        }

        enable() {
            if (this.enabled) return;
            this.enabled = true;
            const c = this.glMap.getCanvas();
            c.style.cursor = 'crosshair';
            this.glMap.dragPan.disable();
            this.glMap.scrollZoom.disable();
            c.addEventListener('mousedown',  this._onDown);
            c.addEventListener('mousemove',  this._onMove);
            c.addEventListener('mouseup',    this._onUp);
            c.addEventListener('mouseleave', this._onUp);
            if (this._toolbar) this._toolbar.style.display = 'flex';
        }

        disable() {
            if (!this.enabled) return;
            this.enabled  = false;
            this._drawing = false;
            this._preview = null;
            this._flush();
            const c = this.glMap.getCanvas();
            c.style.cursor = '';
            this.glMap.dragPan.enable();
            this.glMap.scrollZoom.enable();
            c.removeEventListener('mousedown',  this._onDown);
            c.removeEventListener('mousemove',  this._onMove);
            c.removeEventListener('mouseup',    this._onUp);
            c.removeEventListener('mouseleave', this._onUp);
            if (this._toolbar) this._toolbar.style.display = 'none';
        }

        setMode(mode) {
            // map sidebar mode names → our modes
            const MAP = { line: 'line', arrow: 'arrow', ellipse: 'ellipse',
                          rect: 'rect', freedraw: 'freedraw' };
            this.mode = MAP[mode] || 'freedraw';
            this._highlightTool(this.mode);
        }

        setColor(c) {
            this.color = c;
            if (this._colorInput) this._colorInput.value = c;
        }

        setWidth(w) { this.width = Number(w) || 3; }

        undo() {
            if (this._paintStack.length) {
                this._unpaintBuilding(this._paintStack.pop());
            } else {
                this._shapes.pop();
                this._flush();
            }
        }

        clear() {
            this._shapes  = [];
            this._preview = null;
            [...this._paintStack].forEach(id => this._unpaintBuilding(id));
            this._paintStack = [];
            this._paintedBuildings.clear();
            this._flush();
        }

        // ── mouse handlers ────────────────────────────────────────────────────

        _onDown(e) {
            if (!this.enabled) return;
            e.preventDefault();
            if (this.mode === 'building') {
                this._paintBuilding(this._clientPx(e));
                return;
            }
            this._drawing = true;
            this._startPx = this._clientPx(e);
            if (this.mode === 'freedraw') {
                this._freePts = [this._toLngLat(this._startPx)];
            }
        }

        _onMove(e) {
            if (!this.enabled || !this._drawing) return;
            const px  = this._clientPx(e);
            const cur = this._toLngLat(px);

            switch (this.mode) {
                case 'freedraw':
                    this._freePts.push(cur);
                    this._preview = this._freePts.length > 1
                        ? [this._lineFeature(this._freePts)]
                        : null;
                    break;
                case 'line':
                    this._preview = [this._lineFeature([this._toLngLat(this._startPx), cur])];
                    break;
                case 'arrow':
                    this._preview = this._buildArrow(this._startPx, px);
                    break;
                case 'ellipse':
                    this._preview = [this._buildEllipse(this._startPx, px)];
                    break;
                case 'rect':
                    this._preview = [this._buildRect(this._startPx, px)];
                    break;
            }
            this._flush();
        }

        _onUp(e) {
            if (!this.enabled || !this._drawing) return;
            this._drawing = false;
            if (this._preview && this._preview.length) {
                const id = `s${this._uid++}`;
                this._preview.forEach(f => { f.properties._shapeId = id; });
                this._shapes.push(...this._preview);
            }
            this._preview = null;
            this._flush();
        }

        // ── shape builders ────────────────────────────────────────────────────

        _lineFeature(lngLats) {
            return {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: lngLats },
                properties: { _t: 'line', color: this.color, width: this.width }
            };
        }

        _fillFeature(rings) {
            return {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: rings },
                properties: { _t: 'fill', color: this.color, width: this.width }
            };
        }

        _buildArrow(startPx, endPx) {
            const start = this._toLngLat(startPx);
            const end   = this._toLngLat(endPx);
            const dx = endPx.x - startPx.x;
            const dy = endPx.y - startPx.y;
            const len = Math.hypot(dx, dy);
            if (len < 2) return [this._lineFeature([start, end])];

            const ang = Math.atan2(dy, dx);
            const tip1 = this._toLngLat({
                x: endPx.x - ARROW_HEAD_PX * Math.cos(ang - Math.PI / 6),
                y: endPx.y - ARROW_HEAD_PX * Math.sin(ang - Math.PI / 6)
            });
            const tip2 = this._toLngLat({
                x: endPx.x - ARROW_HEAD_PX * Math.cos(ang + Math.PI / 6),
                y: endPx.y - ARROW_HEAD_PX * Math.sin(ang + Math.PI / 6)
            });
            return [
                this._lineFeature([start, end]),
                this._lineFeature([tip1, end, tip2])
            ];
        }

        _buildEllipse(centerPx, edgePx) {
            const rx = Math.abs(edgePx.x - centerPx.x);
            const ry = Math.abs(edgePx.y - centerPx.y);
            const r  = Math.max(rx, ry, 1);
            const rx2 = rx || r;
            const ry2 = ry || r;
            const pts = [];
            for (let i = 0; i <= ELLIPSE_STEPS; i++) {
                const a = (i / ELLIPSE_STEPS) * 2 * Math.PI;
                pts.push(this._toLngLat({
                    x: centerPx.x + rx2 * Math.cos(a),
                    y: centerPx.y + ry2 * Math.sin(a)
                }));
            }
            return this._fillFeature([pts]);
        }

        _buildRect(p1, p2) {
            const corners = [
                this._toLngLat({ x: p1.x, y: p1.y }),
                this._toLngLat({ x: p2.x, y: p1.y }),
                this._toLngLat({ x: p2.x, y: p2.y }),
                this._toLngLat({ x: p1.x, y: p2.y }),
                this._toLngLat({ x: p1.x, y: p1.y }),
            ];
            return this._fillFeature([corners]);
        }

        // ── GL layers ─────────────────────────────────────────────────────────

        _addGLLayers() {
            this.glMap.addSource('draw3d', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });

            // filled shapes (ellipse, rect)
            this.glMap.addLayer({
                id: 'draw3d-fill', type: 'fill', source: 'draw3d',
                filter: ['==', ['get', '_t'], 'fill'],
                paint: {
                    'fill-color':   ['get', 'color'],
                    'fill-opacity': 0.25
                }
            });
            this.glMap.addLayer({
                id: 'draw3d-fill-stroke', type: 'line', source: 'draw3d',
                filter: ['==', ['get', '_t'], 'fill'],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': ['get', 'width']
                }
            });

            // lines (freedraw, line, arrow)
            this.glMap.addLayer({
                id: 'draw3d-line', type: 'line', source: 'draw3d',
                filter: ['==', ['get', '_t'], 'line'],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': ['get', 'width']
                }
            });
        }

        _flush() {
            const src = this.glMap.getSource('draw3d');
            if (!src) return;
            const features = [...this._shapes, ...(this._preview || [])];
            src.setData({ type: 'FeatureCollection', features });
        }

        // ── toolbar ───────────────────────────────────────────────────────────

        _buildToolbar() {
            const bar = document.createElement('div');
            Object.assign(bar.style, {
                position:   'absolute',
                bottom:     '44px',
                left:       '50%',
                transform:  'translateX(-50%)',
                display:    'none',
                alignItems: 'center',
                gap:        '4px',
                background: 'rgba(18,18,18,0.92)',
                borderRadius: '8px',
                padding:    '5px 10px',
                zIndex:     '10',
                boxShadow:  '0 2px 12px rgba(0,0,0,0.65)',
                userSelect: 'none',
                whiteSpace: 'nowrap',
            });

            const tools = [
                { mode: 'freedraw', label: '✏', title: 'Free draw' },
                { mode: 'line',     label: '╱',  title: 'Line' },
                { mode: 'arrow',    label: '→',  title: 'Arrow' },
                { mode: 'ellipse',  label: '⬭',  title: 'Ellipse / Circle' },
                { mode: 'rect',     label: '▭',  title: 'Rectangle' },
                { mode: 'building', label: '🪣', title: 'Paint building' },
            ];

            tools.forEach(({ mode, label, title }) => {
                const btn = this._btn(label, title);
                btn.addEventListener('click', () => {
                    this.mode = mode;
                    this._highlightTool(mode);
                });
                bar.appendChild(btn);
                this._toolBtns[mode] = btn;
            });

            this._sep(bar);

            // color picker
            const ci = document.createElement('input');
            ci.type  = 'color';
            ci.value = this.color;
            Object.assign(ci.style, {
                width: '28px', height: '28px', padding: '0',
                border: '1px solid #555', borderRadius: '4px',
                cursor: 'pointer', background: 'none', flexShrink: '0'
            });
            ci.addEventListener('input', () => { this.color = ci.value; });
            bar.appendChild(ci);
            this._colorInput = ci;

            // width
            const wi = document.createElement('input');
            wi.type  = 'range';
            wi.min   = '1'; wi.max = '12'; wi.value = String(this.width);
            wi.title = 'Line width';
            Object.assign(wi.style, { width: '60px', cursor: 'pointer', accentColor: '#2563eb' });
            wi.addEventListener('input', () => { this.width = Number(wi.value); });
            bar.appendChild(wi);

            this._sep(bar);

            const undoBtn = this._btn('↩', 'Undo');
            undoBtn.addEventListener('click', () => this.undo());
            bar.appendChild(undoBtn);

            const clearBtn = this._btn('🗑', 'Clear all');
            clearBtn.addEventListener('click', () => {
                if (this._shapes.length && confirm('Clear all drawings?')) this.clear();
            });
            bar.appendChild(clearBtn);

            this.glMap.getContainer().appendChild(bar);
            this._toolbar = bar;
            this._highlightTool('freedraw');
        }

        _btn(label, title) {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            Object.assign(b.style, {
                background: 'transparent', border: '1px solid #555',
                borderRadius: '5px', color: '#ddd', cursor: 'pointer',
                fontSize: '15px', padding: '3px 8px', minWidth: '30px',
                lineHeight: '1.4', transition: 'background 0.1s'
            });
            return b;
        }

        // ── building paint ────────────────────────────────────────────────────

        _paintBuilding(px) {
            const features = this.glMap.queryRenderedFeatures([px.x, px.y], { layers: ['buildings-3d'] });
            if (!features.length) return;
            const f = features[0];
            if (f.id == null) return;
            this._paintedBuildings.set(f.id, this.color);
            this._paintStack.push(f.id);
            this.glMap.setFeatureState(
                { source: 'composite', sourceLayer: 'building', id: f.id },
                { painted: true, color: this.color }
            );
        }

        _unpaintBuilding(id) {
            this._paintedBuildings.delete(id);
            this.glMap.setFeatureState(
                { source: 'composite', sourceLayer: 'building', id },
                { painted: false, color: null }
            );
        }

        _sep(bar) {
            const s = document.createElement('div');
            Object.assign(s.style, {
                width: '1px', height: '20px', background: '#555', margin: '0 2px', flexShrink: '0'
            });
            bar.appendChild(s);
        }

        _highlightTool(mode) {
            Object.entries(this._toolBtns).forEach(([m, b]) => {
                const active = m === mode;
                b.style.background = active ? '#2563eb' : 'transparent';
                b.style.color      = active ? '#fff'    : '#ddd';
            });
        }

        // ── coord helpers ─────────────────────────────────────────────────────

        _clientPx(e) {
            const r = this.glMap.getCanvas().getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        _toLngLat(px) {
            const ll = this.glMap.unproject([px.x, px.y]);
            return [ll.lng, ll.lat];
        }
    }

    // ── Map3DView ─────────────────────────────────────────────────────────────

    class Map3DView {
        constructor(dashboard) {
            this.dashboard    = dashboard;
            this.glMap        = null;
            this.draw3d       = null;
            this.active       = false;
            this.container    = null;
            this.btn          = null;
            this.glLoaded     = false;
            this.glLoading    = false;
            this._rotPlaying  = false;
            this._rotFrame    = null;
            this._rotSpeed    = 0.15; // degrees per animation frame
            this._keysDown    = new Set();
            this._wasdFrame   = null;
            this._onKeyDown   = null;
            this._onKeyUp     = null;
        }

        init() {
            this._createContainer();
            this._createButton();
            this._bindDrawSidebar();
        }

        // ── DOM setup ─────────────────────────────────────────────────────────

        _createContainer() {
            const mapEl = document.getElementById('map');
            const parent = mapEl ? mapEl.parentElement : document.querySelector('.main-content');
            if (!parent) return;

            this.container = document.createElement('div');
            this.container.id = 'map-3d-container';
            Object.assign(this.container.style, {
                position: 'absolute',
                top: '0', left: '0', right: '0', bottom: '0',
                display: 'none',
                zIndex: '500'
            });
            if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
            parent.appendChild(this.container);
        }

        _createButton() {
            if (!this.dashboard.mapboxToken) return;

            const btn = document.createElement('button');
            btn.id = 'btn-3d-view';
            btn.textContent = '3D';
            btn.title = 'Toggle 3D terrain view';
            btn.className = 'top-bar-btn';
            Object.assign(btn.style, { fontWeight: '700', letterSpacing: '0.5px', minWidth: '32px' });

            const topBar = document.querySelector('.top-bar-inner');
            if (topBar) {
                topBar.appendChild(btn);
            } else {
                Object.assign(btn.style, {
                    position: 'fixed', top: '8px', right: '8px', zIndex: '9999',
                    padding: '4px 10px', background: '#222', color: '#fff',
                    border: '1px solid #555', borderRadius: '4px', cursor: 'pointer'
                });
                document.body.appendChild(btn);
            }
            btn.addEventListener('click', () => this.toggle());
            this.btn = btn;
        }

        // ── Wire sidebar #draw-enable + tools → Draw3D ────────────────────────

        _bindDrawSidebar() {
            const forward = (fn) => (...args) => {
                if (this.active && this.draw3d) fn(...args);
            };

            const drawEnableEl = document.getElementById('draw-enable');
            if (drawEnableEl) {
                drawEnableEl.addEventListener('change', forward(() => {
                    drawEnableEl.checked ? this.draw3d.enable() : this.draw3d.disable();
                }));
            }

            document.querySelectorAll('.draw-tool-btn').forEach(b => {
                b.addEventListener('click', forward(() => this.draw3d.setMode(b.dataset.mode)));
            });

            document.querySelectorAll('.draw-preset').forEach(b => {
                b.addEventListener('click', forward(() => this.draw3d.setColor(b.dataset.color)));
            });

            const colorEl = document.getElementById('draw-color');
            if (colorEl) colorEl.addEventListener('input', forward(() => this.draw3d.setColor(colorEl.value)));

            const thickEl = document.getElementById('draw-thickness');
            if (thickEl) thickEl.addEventListener('input', forward(() => this.draw3d.setWidth(thickEl.value)));

            const undoEl = document.getElementById('draw-undo');
            if (undoEl) undoEl.addEventListener('click', forward(() => this.draw3d.undo()));

            const clearEl = document.getElementById('draw-clear');
            if (clearEl) clearEl.addEventListener('click', forward(() => this.draw3d.clear()));
        }

        _syncDrawState() {
            if (!this.draw3d) return;
            const src = this.dashboard.drawTool;
            if (src) {
                this.draw3d.setColor(src.color);
                this.draw3d.setWidth(src.thickness);
                this.draw3d.setMode(src.mode);
            }
            const drawEnableEl = document.getElementById('draw-enable');
            if (drawEnableEl && drawEnableEl.checked) this.draw3d.enable();
        }

        // ── Toggle ────────────────────────────────────────────────────────────

        toggle() {
            this.active ? this._hide() : this._show();
        }

        _show() {
            this.active = true;
            if (this.container) this.container.style.display = 'block';
            if (this.btn) { this.btn.style.background = '#2563eb'; this.btn.style.color = '#fff'; }
            this._startWASD();

            this._ensureMapboxGL(() => {
                const center = this.dashboard.map.getCenter();
                const zoom   = this.dashboard.map.getZoom();
                if (!this.glMap) {
                    this._initGLMap(center, zoom);
                } else {
                    this.glMap.setCenter([center.lng, center.lat]);
                    this.glMap.setZoom(zoom);
                    if (this.glLoaded) { this._refreshSources(); this._syncDrawState(); }
                }
            });
        }

        _hide() {
            this.active = false;
            if (this.container) this.container.style.display = 'none';
            if (this.btn)       { this.btn.style.background = ''; this.btn.style.color = ''; }
            if (this.draw3d) this.draw3d.disable();
            this._stopRotation();
            this._stopWASD();
            if (this.glMap) {
                const c = this.glMap.getCenter();
                this.dashboard.map.setView([c.lat, c.lng], Math.round(this.glMap.getZoom()), { animate: false });
            }
        }

        // ── Load Mapbox GL JS lazily ───────────────────────────────────────────

        _ensureMapboxGL(cb) {
            if (window.mapboxgl) { cb(); return; }
            if (this.glLoading) {
                const prev = this._onGLReady;
                this._onGLReady = () => { prev && prev(); cb(); };
                return;
            }
            this.glLoading  = true;
            this._onGLReady = cb;

            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            link.href = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}/mapbox-gl.css`;
            document.head.appendChild(link);

            const script = document.createElement('script');
            script.src = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}/mapbox-gl.js`;
            script.onload = () => {
                this.glLoading = false;
                const fn = this._onGLReady; this._onGLReady = null; fn && fn();
            };
            script.onerror = () => { console.error('[map-3d] mapbox-gl.js failed to load'); this.glLoading = false; };
            document.head.appendChild(script);
        }

        // ── GL map init ───────────────────────────────────────────────────────

        _initGLMap(center, zoom) {
            mapboxgl.accessToken = this.dashboard.mapboxToken;
            this.glMap = new mapboxgl.Map({
                container: this.container,
                style:     'mapbox://styles/mapbox/satellite-streets-v12',
                center:    [center.lng, center.lat],
                zoom,
                pitch:   55,
                bearing: -15,
                antialias: true
            });

            this.glMap.addControl(new mapboxgl.NavigationControl(), 'top-right');
            this.glMap.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

            this.glMap.on('load', () => {
                this.glLoaded = true;
                this._addTerrain();
                this._addAtmosphere();
                this._addDataLayers();
                this.draw3d = new Draw3D(this.glMap);
                this.draw3d.init();
                this._buildRotationControl();
                this._syncDrawState();
            });

            // stop rotation when user manually drags the map
            this.glMap.on('mousedown', () => {
                if (this._rotPlaying) this._stopRotation();
            });
        }

        // ── Rotation control ──────────────────────────────────────────────────

        _buildRotationControl() {
            const panel = document.createElement('div');
            Object.assign(panel.style, {
                position:   'absolute',
                bottom:     '44px',
                right:      '10px',
                display:    'flex',
                alignItems: 'center',
                gap:        '6px',
                background: 'rgba(18,18,18,0.92)',
                borderRadius: '8px',
                padding:    '5px 10px',
                zIndex:     '10',
                boxShadow:  '0 2px 12px rgba(0,0,0,0.65)',
                userSelect: 'none',
            });

            // play / pause button
            const playBtn = document.createElement('button');
            playBtn.title = 'Start / stop rotation';
            Object.assign(playBtn.style, {
                background: 'transparent', border: '1px solid #555',
                borderRadius: '5px', color: '#ddd', cursor: 'pointer',
                fontSize: '15px', padding: '3px 8px', minWidth: '30px',
                lineHeight: '1.4',
            });
            const setPlayIcon = () => {
                playBtn.textContent = this._rotPlaying ? '⏸' : '▶';
                playBtn.style.background = this._rotPlaying ? '#2563eb' : 'transparent';
                playBtn.style.color      = this._rotPlaying ? '#fff'    : '#ddd';
            };
            setPlayIcon();
            playBtn.addEventListener('click', () => {
                this._rotPlaying ? this._stopRotation() : this._startRotation();
                setPlayIcon();
            });
            panel.appendChild(playBtn);
            this._rotPlayBtn = playBtn;
            this._rotSetIcon = setPlayIcon;

            // speed label
            const label = document.createElement('span');
            label.textContent = 'Speed';
            Object.assign(label.style, { color: '#aaa', fontSize: '11px', whiteSpace: 'nowrap' });
            panel.appendChild(label);

            // speed slider  (0.05 – 1.0 deg/frame)
            const slider = document.createElement('input');
            slider.type  = 'range';
            slider.min   = '1';
            slider.max   = '20';
            slider.step  = '1';
            slider.value = String(Math.round(this._rotSpeed * 100)); // 1–20 maps to 0.01–0.20
            slider.title = 'Rotation speed';
            Object.assign(slider.style, { width: '70px', cursor: 'pointer', accentColor: '#2563eb' });
            slider.addEventListener('input', () => {
                this._rotSpeed = Number(slider.value) / 100;
            });
            panel.appendChild(slider);

            // exaggeration label + slider
            const exLabel = document.createElement('span');
            exLabel.textContent = 'Elev';
            Object.assign(exLabel.style, { color: '#aaa', fontSize: '11px', whiteSpace: 'nowrap' });
            panel.appendChild(exLabel);

            const exSlider = document.createElement('input');
            exSlider.type  = 'range';
            exSlider.min   = '1';
            exSlider.max   = '10';
            exSlider.step  = '0.5';
            exSlider.value = '6';
            exSlider.title = 'Terrain exaggeration';
            Object.assign(exSlider.style, { width: '70px', cursor: 'pointer', accentColor: '#2563eb' });
            exSlider.addEventListener('input', () => {
                this.glMap.setTerrain({ source: 'mapbox-dem', exaggeration: Number(exSlider.value) });
            });
            panel.appendChild(exSlider);

            // separator
            const sep = document.createElement('div');
            Object.assign(sep.style, { width: '1px', height: '20px', background: '#555' });
            panel.appendChild(sep);

            // rotation-center toggle
            const centerBtn = document.createElement('button');
            centerBtn.title = 'Show / hide rotation center';
            centerBtn.textContent = '⊕';
            Object.assign(centerBtn.style, {
                background: 'transparent', border: '1px solid #555',
                borderRadius: '5px', color: '#ddd', cursor: 'pointer',
                fontSize: '15px', padding: '3px 8px', minWidth: '30px', lineHeight: '1.4',
            });
            let centerVisible = false;
            const updateCenterBtn = () => {
                centerBtn.style.background = centerVisible ? '#2563eb' : 'transparent';
                centerBtn.style.color      = centerVisible ? '#fff'    : '#ddd';
                this._rotCenterEl.style.display = centerVisible ? 'block' : 'none';
            };
            centerBtn.addEventListener('click', () => {
                centerVisible = !centerVisible;
                updateCenterBtn();
            });
            panel.appendChild(centerBtn);

            // center marker — crosshair SVG pinned to the middle of the container
            const marker = document.createElement('div');
            Object.assign(marker.style, {
                position:      'absolute',
                top:           '50%',
                left:          '50%',
                transform:     'translate(-50%, -50%)',
                pointerEvents: 'none',
                display:       'none',
                zIndex:        '20',
            });
            marker.innerHTML = `
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="20" cy="20" r="4" fill="rgba(255,255,255,0.9)" stroke="#2563eb" stroke-width="1.5"/>
                    <line x1="20" y1="2"  x2="20" y2="12" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="20" y1="28" x2="20" y2="38" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="2"  y1="20" x2="12" y2="20" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="28" y1="20" x2="38" y2="20" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
                </svg>`;
            this.glMap.getContainer().appendChild(marker);
            this._rotCenterEl = marker;

            this.glMap.getContainer().appendChild(panel);
        }

        _startRotation() {
            this._rotPlaying = true;
            const step = () => {
                if (!this._rotPlaying) return;
                this.glMap.setBearing((this.glMap.getBearing() + this._rotSpeed) % 360);
                this._rotFrame = requestAnimationFrame(step);
            };
            this._rotFrame = requestAnimationFrame(step);
        }

        _stopRotation() {
            this._rotPlaying = false;
            if (this._rotFrame) { cancelAnimationFrame(this._rotFrame); this._rotFrame = null; }
            if (this._rotSetIcon) this._rotSetIcon();
        }

        // ── WASD / QE keyboard controls ───────────────────────────────────────

        _startWASD() {
            this._onKeyDown = (e) => {
                const tag = document.activeElement?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                const k = e.key.toLowerCase();
                if (['w','a','s','d','q','e'].includes(k)) {
                    e.preventDefault();
                    this._keysDown.add(k);
                    if (!this._wasdFrame) this._wasdTick();
                }
            };
            this._onKeyUp = (e) => {
                this._keysDown.delete(e.key.toLowerCase());
            };
            document.addEventListener('keydown', this._onKeyDown);
            document.addEventListener('keyup',   this._onKeyUp);
        }

        _stopWASD() {
            if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
            if (this._onKeyUp)   document.removeEventListener('keyup',   this._onKeyUp);
            this._onKeyDown = null;
            this._onKeyUp   = null;
            this._keysDown.clear();
            if (this._wasdFrame) { cancelAnimationFrame(this._wasdFrame); this._wasdFrame = null; }
        }

        _wasdTick() {
            if (!this._keysDown.size || !this.glMap) { this._wasdFrame = null; return; }
            const speed    = 5;   // px per frame
            const rotStep  = 1.5; // degrees per frame
            let dx = 0, dy = 0;
            if (this._keysDown.has('w')) dy -= speed;
            if (this._keysDown.has('s')) dy += speed;
            if (this._keysDown.has('a')) dx -= speed;
            if (this._keysDown.has('d')) dx += speed;
            if (dx || dy) this.glMap.panBy([dx, dy], { duration: 0, animate: false });
            if (this._keysDown.has('q') || this._keysDown.has('e')) {
                const delta = this._keysDown.has('e') ? rotStep : -rotStep;
                this.glMap.setBearing(this.glMap.getBearing() + delta);
                if (this._rotPlaying) this._stopRotation();
            }
            this._wasdFrame = requestAnimationFrame(() => this._wasdTick());
        }

        // ── Terrain & atmosphere ──────────────────────────────────────────────

        _addTerrain() {
            this.glMap.addSource('mapbox-dem', {
                type: 'raster-dem',
                url:  'mapbox://mapbox.mapbox-terrain-dem-v1',
                tileSize: 512, maxzoom: 14
            });
            this.glMap.setTerrain({ source: 'mapbox-dem', exaggeration: 6 });
        }

        _addAtmosphere() {
            this.glMap.setFog({
                color:          'rgb(186,210,235)',
                'high-color':   'rgb(36,92,223)',
                'horizon-blend': 0.02,
                'space-color':  'rgb(11,11,25)',
                'star-intensity': 0.4
            });
        }

        // ── Data layers ───────────────────────────────────────────────────────

        _addDataLayers() {
            this._addLayerGroup('deep',    this._getLayerGeoJSON(this.dashboard.deepLayer),        '#cc2200', 0.35);
            this._addLayerGroup('russia',  this._getLayerGeoJSON(this.dashboard.russiaOverlay),    '#ff4400', 0.25);
            this._addLayerGroup('suriyak', this._getLayerGeoJSON(this.dashboard.suriyakOverlay),   '#4466ff', 0.25);
            this._addLayerGroup('creamy',  this._getLayerGeoJSON(this.dashboard.creamyOverlay),    '#ff8800', 0.22);
            this._addFrontline();
            this._addDitches();
            this._addBuildings3D();
            if (document.getElementById('forest-overlay')?.checked) this._addForest3D();
        }

        _addLayerGroup(id, geojson, color, opacity) {
            this.glMap.addSource(id, { type: 'geojson', data: geojson || this._emptyFC() });
            this.glMap.addLayer({ id: `${id}-fill`, type: 'fill',   source: id, paint: { 'fill-color': color, 'fill-opacity': opacity } });
            this.glMap.addLayer({ id: `${id}-line`, type: 'line',   source: id, paint: { 'line-color': color, 'line-width': 1.5, 'line-opacity': 0.8 } });
        }

        _addFrontline() {
            this.glMap.addSource('frontline', { type: 'geojson', data: this._getFrontlineGeoJSON() });
            this.glMap.addLayer({
                id: 'frontline-line', type: 'line', source: 'frontline',
                paint: { 'line-color': '#ffdd00', 'line-width': 2.5, 'line-opacity': 0.9, 'line-dasharray': [4, 2] }
            });
        }

        _addDitches() {
            const dg = this._getLayerGeoJSON(this.dashboard.featureDitchesLayer)      || this._emptyFC();
            const ds = this._getLayerGeoJSON(this.dashboard.featureDitchesStartLayer) || this._emptyFC();

            // flat lines — always added first so failures below don't break them
            this.glMap.addSource('ditches',       { type: 'geojson', data: dg });
            this.glMap.addSource('ditches-start', { type: 'geojson', data: ds });
            this.glMap.addLayer({ id: 'ditches-line',       type: 'line', source: 'ditches',       layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff2222', 'line-width': 1.8 } });
            this.glMap.addLayer({ id: 'ditches-start-line', type: 'line', source: 'ditches-start', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#4fc3f7', 'line-width': 1.8 } });

            // 3D extrusion — isolated so a turf/GL error doesn't break the lines above
            try {
                this.glMap.addSource('ditches-3d',       { type: 'geojson', data: this._bufferLines(dg) });
                this.glMap.addSource('ditches-start-3d', { type: 'geojson', data: this._bufferLines(ds) });
                this.glMap.addLayer({ id: 'ditches-3d-dip',       type: 'fill', source: 'ditches-3d',       paint: { 'fill-color': '#1a0000', 'fill-opacity': 0.82 } });
                this.glMap.addLayer({ id: 'ditches-start-3d-dip', type: 'fill', source: 'ditches-start-3d', paint: { 'fill-color': '#001a22', 'fill-opacity': 0.82 } });
                this.glMap.addLayer({ id: 'ditches-3d-edge',       type: 'line', source: 'ditches-3d',       paint: { 'line-color': '#cc1111', 'line-width': 0.6, 'line-opacity': 0.7 } });
                this.glMap.addLayer({ id: 'ditches-start-3d-edge', type: 'line', source: 'ditches-start-3d', paint: { 'line-color': '#29a8d4', 'line-width': 0.6, 'line-opacity': 0.7 } });
            } catch (e) { console.warn('[map-3d] ditch extrusion setup failed:', e); }
        }

        _cleanLines(geojson) {
            const ok = v => typeof v === 'number' && isFinite(v);
            const validCoord = c => Array.isArray(c) && ok(c[0]) && ok(c[1]);
            const features = [];
            for (const f of geojson.features) {
                if (!f || !f.geometry) continue;
                const { type, coordinates } = f.geometry;
                if (type === 'LineString') {
                    const pts = coordinates.filter(validCoord);
                    if (pts.length >= 2) features.push({ ...f, geometry: { type, coordinates: pts } });
                } else if (type === 'MultiLineString') {
                    const lines = coordinates.map(l => l.filter(validCoord)).filter(l => l.length >= 2);
                    if (lines.length) features.push({ ...f, geometry: { type, coordinates: lines } });
                }
            }
            return { type: 'FeatureCollection', features };
        }

        _bufferLines(geojson) {
            if (!geojson || !geojson.features || !geojson.features.length) return this._emptyFC();
            try {
                const clean = this._cleanLines(geojson);
                if (!clean.features.length) return this._emptyFC();
                const result = turf.buffer(clean, 0.001, { units: 'kilometers' }); // 1m each side = 2m wide
                if (!result) return this._emptyFC();
                result.features = result.features.filter(f => f && f.geometry);
                return result.features.length ? result : this._emptyFC();
            } catch (e) {
                console.warn('[map-3d] turf.buffer failed:', e);
                return this._emptyFC();
            }
        }

        updateDitches3D() {
            if (!this.glLoaded || !this.glMap) return;
            const dg = this._getLayerGeoJSON(this.dashboard.featureDitchesLayer)      || this._emptyFC();
            const ds = this._getLayerGeoJSON(this.dashboard.featureDitchesStartLayer) || this._emptyFC();
            try {
                this.glMap.getSource('ditches')         ?.setData(dg);
                this.glMap.getSource('ditches-start')   ?.setData(ds);
                this.glMap.getSource('ditches-3d')      ?.setData(this._bufferLines(dg));
                this.glMap.getSource('ditches-start-3d')?.setData(this._bufferLines(ds));
            } catch (e) { console.warn('[map-3d] updateDitches3D failed:', e); }
        }

        _refreshSources() {
            const pairs = [
                ['deep',   this.dashboard.deepLayer],
                ['russia', this.dashboard.russiaOverlay],
                ['suriyak',this.dashboard.suriyakOverlay],
                ['creamy', this.dashboard.creamyOverlay],
            ];
            for (const [id, layer] of pairs) {
                const src = this.glMap.getSource(id);
                if (src) src.setData(this._getLayerGeoJSON(layer) || this._emptyFC());
            }
            const fs = this.glMap.getSource('frontline');
            if (fs) fs.setData(this._getFrontlineGeoJSON());
            if (document.getElementById('forest-overlay')?.checked) this._addForest3D();
            this.updateDitches3D();
        }

        // ── 3D settlement buildings ───────────────────────────────────────────

        _addBuildings3D() {
            this.glMap.addLayer({
                id: 'buildings-3d',
                type: 'fill-extrusion',
                source: 'composite',
                'source-layer': 'building',
                filter: ['==', 'extrude', 'true'],
                minzoom: 14,
                paint: {
                    'fill-extrusion-color': [
                        'case',
                        ['boolean', ['feature-state', 'painted'], false],
                        ['coalesce', ['feature-state', 'color'], '#ff4444'],
                        ['interpolate', ['linear'], ['coalesce', ['get', 'height'], 0],
                            0,  '#c8b89a',
                            10, '#b8a58a',
                            30, '#a89278',
                            80, '#9a8068']
                    ],
                    'fill-extrusion-height': [
                        'interpolate', ['linear'], ['zoom'],
                        14, 0,
                        14.5, ['coalesce', ['get', 'height'], 6]
                    ],
                    'fill-extrusion-base': [
                        'interpolate', ['linear'], ['zoom'],
                        14, 0,
                        14.5, ['coalesce', ['get', 'min_height'], 0]
                    ],
                    'fill-extrusion-opacity': 0.85,
                    'fill-extrusion-ambient-occlusion-intensity': 0.5,
                    'fill-extrusion-ambient-occlusion-radius': 3,
                }
            });
        }

        // ── 3D forest treelines ───────────────────────────────────────────────

        _forestToTreePoints(geojson) {
            if (!geojson || !geojson.features || !geojson.features.length) return this._emptyFC();
            const pts = [];
            for (const feature of geojson.features) {
                try {
                    const area = turf.area(feature); // m²
                    // finer grid for narrow windbreaks, coarser for large forests
                    const spacingKm = area < 15000 ? 0.01 : area < 120000 ? 0.02 : 0.04;
                    const bb = turf.bbox(feature);
                    const grid = turf.pointGrid(bb, spacingKm, { units: 'kilometers' });
                    const inside = turf.pointsWithinPolygon(grid, feature);
                    const arr = inside.features;

                    if (arr.length) {
                        const step = arr.length > 500 ? Math.ceil(arr.length / 500) : 1;
                        for (let i = 0; i < arr.length; i += step) pts.push(arr[i]);
                    } else {
                        // grid missed entirely (very narrow / diagonal feature) — walk the centerline
                        const [x0, y0, x1, y1] = bb;
                        const step = 0.00009; // ≈ 10 m in degrees
                        if ((x1 - x0) >= (y1 - y0)) {
                            const midY = (y0 + y1) / 2;
                            for (let x = x0; x <= x1; x += step) {
                                const p = turf.point([x, midY]);
                                if (turf.booleanPointInPolygon(p, feature)) pts.push(p);
                            }
                        } else {
                            const midX = (x0 + x1) / 2;
                            for (let y = y0; y <= y1; y += step) {
                                const p = turf.point([midX, y]);
                                if (turf.booleanPointInPolygon(p, feature)) pts.push(p);
                            }
                        }
                    }
                } catch { /* skip malformed polygon */ }
            }
            return { type: 'FeatureCollection', features: pts };
        }

        _addForest3D() {
            const data    = this._getLayerGeoJSON(this.dashboard.forestLayer) || this._emptyFC();
            const treePts = this._forestToTreePoints(data);

            if (this.glMap.getSource('forest3d')) {
                this.glMap.getSource('forest3d').setData(data);
                this.glMap.getSource('forest3d-trees')?.setData(treePts);
                return;
            }

            this.glMap.addSource('forest3d',       { type: 'geojson', data });
            this.glMap.addSource('forest3d-trees',  { type: 'geojson', data: treePts });

            // faint polygon fill so the area reads as forest even when zoomed out
            this.glMap.addLayer({
                id: 'forest3d-fill', type: 'fill', source: 'forest3d',
                paint: { 'fill-color': '#1a3d1a', 'fill-opacity': 0.18 }
            });

            // individual tree crowns — pitch-aligned so they lie flat on the terrain
            this.glMap.addLayer({
                id: 'forest3d-crowns', type: 'circle', source: 'forest3d-trees',
                paint: {
                    'circle-radius':           ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 8, 17, 18],
                    'circle-color':            ['interpolate', ['linear'], ['zoom'], 9, '#2a5e2a', 15, '#3a7a3a'],
                    'circle-opacity':          0.88,
                    'circle-stroke-width':     ['interpolate', ['linear'], ['zoom'], 10, 0, 13, 0.6],
                    'circle-stroke-color':     '#153d15',
                    'circle-pitch-alignment':  'map',
                    'circle-pitch-scale':      'map',
                }
            });
        }

        _removeForest3D() {
            for (const id of ['forest3d-fill', 'forest3d-crowns', 'forest3d-extrusion']) {
                if (this.glMap.getLayer(id)) this.glMap.removeLayer(id);
            }
            for (const id of ['forest3d', 'forest3d-trees']) {
                if (this.glMap.getSource(id)) this.glMap.removeSource(id);
            }
        }

        updateForest3D(enabled) {
            if (!this.glLoaded || !this.glMap) return;
            if (enabled) this._addForest3D();
            else this._removeForest3D();
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        _getLayerGeoJSON(layer) {
            if (!layer) return null;
            try {
                const g = layer.toGeoJSON();
                return (g.features && g.features.length) ? g : null;
            } catch { return null; }
        }

        _getFrontlineGeoJSON() {
            if (!this.dashboard.frontlineLayer) return this._emptyFC();
            try { return this.dashboard.frontlineLayer.toGeoJSON(); } catch { return this._emptyFC(); }
        }

        _emptyFC() { return { type: 'FeatureCollection', features: [] }; }
    }

    // ── Block duplicate init from app.js window.onload ────────────────────────
    const _appOnload = window.onload;
    window.onload = function () {
        if (!window.dashboard && _appOnload) _appOnload.call(this);
    };

    // ── Auto-init ─────────────────────────────────────────────────────────────

    function tryInit() {
        const db = window.dashboard;
        if (db && db.map) {
            window._map3DView = new Map3DView(db);
            window._map3DView.init();
        } else {
            setTimeout(tryInit, 300);
        }
    }

    tryInit();
})();

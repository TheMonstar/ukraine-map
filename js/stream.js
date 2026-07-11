/**
 * MapStreamer — presenter/viewer live map mirroring over PeerJS data channels.
 * Presenter runs a 1s diff loop against dashboard.serializeSession() output;
 * viewer applies incoming sections without touching any existing handlers.
 */
class MapStreamer {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.peer = null;
        this.connections = [];
        this.viewerConn = null;
        this.loopTimer = null;
        this._lastSent = {};
        this.role = null;
    }

    // ── shared ───────────────────────────────────────────────
    _status(msg) {
        const el = this.dashboard.getEl('stream-status');
        if (!el) return;
        el.style.display = msg ? 'block' : 'none';
        el.textContent = msg || '';
    }

    _snapshot() {
        const s = this.dashboard.serializeSession();
        return {
            view: s.view,
            dates: s.dates,
            basemap: s.basemap,
            toggles: s.toggles,
            drawings: s.drawings,
            mapUml: s.mapUml,
            zones: this.dashboard.extractedZoneLayer
                ? this.dashboard.extractedZoneLayer.toGeoJSON()
                : null
        };
    }

    // ── presenter ────────────────────────────────────────────
    startPresenting() {
        if (this.role) this.stop();

        this.peer = new Peer();

        this.peer.on('open', (id) => {
            const link = `${location.origin}${location.pathname}#follow=${id}`;
            const input = this.dashboard.getEl('stream-link');
            if (input) input.value = link;
            this._status('Presenting — 0 viewers');
            this._loop();
        });

        this.peer.on('connection', (conn) => {
            conn.on('open', () => {
                this.connections.push(conn);
                conn.send({ type: 'full', state: this._snapshot() });
                this._updateViewerCount();
            });
            conn.on('close', () => {
                this.connections = this.connections.filter(c => c !== conn);
                this._updateViewerCount();
            });
            conn.on('data', () => {}); // viewers only send 'hello'; ignore
        });

        this.peer.on('error', (err) => this._status(`Peer error: ${err.type}`));

        this.role = 'presenter';
    }

    _loop() {
        this.loopTimer = setInterval(() => {
            if (!this.connections.length) return;
            const snap = this._snapshot();
            const patch = {};
            for (const [k, v] of Object.entries(snap)) {
                const json = JSON.stringify(v);
                if (json !== this._lastSent[k]) {
                    this._lastSent[k] = json;
                    patch[k] = v;
                }
            }
            if (Object.keys(patch).length) {
                this.connections.forEach(c => c.send({ type: 'patch', sections: patch }));
            }
        }, 1000);
    }

    _updateViewerCount() {
        const n = this.connections.length;
        this._status(`Presenting — ${n} viewer${n === 1 ? '' : 's'}`);
    }

    // ── viewer ───────────────────────────────────────────────
    join(presenterId) {
        if (this.role) this.stop();

        this.peer = new Peer();

        this.peer.on('open', () => {
            this.viewerConn = this.peer.connect(presenterId);

            this.viewerConn.on('open', () => {
                this.viewerConn.send({ type: 'hello' });
                this._status('Following presenter');
            });

            this.viewerConn.on('data', (msg) => {
                if (msg.type === 'full') this._applySections(msg.state);
                else if (msg.type === 'patch') this._applySections(msg.sections);
            });

            this.viewerConn.on('close', () => this._status('Presenter disconnected'));
        });

        this.peer.on('error', (err) => this._status(`Connection failed: ${err.type}`));

        this.role = 'viewer';
    }

    _applySections(sections) {
        const dashboard = this.dashboard;

        if (sections.view) {
            const followEl = dashboard.getEl('stream-follow-view');
            if (!followEl || followEl.checked) {
                // animate:false — rAF-driven animations stall in backgrounded tabs,
                // leaving the viewer permanently stuck at the old view
                dashboard.map.setView([sections.view.lat, sections.view.lng], sections.view.zoom, { animate: false });
            }
        }

        if (sections.basemap && dashboard.mapStyles[sections.basemap]) {
            const sel = dashboard.getEl('map-style');
            if (sel && sel.value !== sections.basemap) {
                sel.value = sections.basemap;
                sel.dispatchEvent(new Event('change'));
            }
        }

        if (sections.dates?.min && sections.dates?.max) {
            dashboard.minDate = new Date(sections.dates.min);
            dashboard.maxDate = new Date(sections.dates.max);
            const ds = dashboard.getEl('date-start');
            if (ds) ds.valueAsDate = dashboard.minDate;
            const de = dashboard.getEl('date-end');
            if (de) de.valueAsDate = dashboard.maxDate;
            dashboard.initSlider(dashboard.minDate, dashboard.maxDate,
                sections.dates.start ? new Date(sections.dates.start) : 0,
                sections.dates.end ? new Date(sections.dates.end) : 0);
        }

        if (sections.toggles) {
            for (const [id, checked] of Object.entries(sections.toggles)) {
                if (id === 'custom-kml-overlay') continue;
                const el = dashboard.getEl(id);
                if (el && typeof checked === 'boolean' && el.checked !== checked) {
                    el.checked = checked;
                    el.dispatchEvent(new Event('change'));
                }
            }
        }

        if (Array.isArray(sections.drawings) && dashboard.drawTool) {
            dashboard.drawTool.shapes = sections.drawings;
            dashboard.drawTool._render();
        }

        if (sections.mapUml) {
            const uml = dashboard.getEl('map-uml-input');
            if (uml) uml.value = sections.mapUml;
            if (dashboard.mapUmlEngine) {
                dashboard.mapUmlEngine.renderScript(sections.mapUml).catch(console.warn);
            }
        }

        if ('zones' in sections) {
            if (!sections.zones) {
                dashboard.setExtractedZones([]);
            } else {
                dashboard.setExtractedZones(sections.zones.features);
            }
        }
    }

    stop() {
        clearInterval(this.loopTimer);
        this.loopTimer = null;
        this.connections.forEach(c => c.close());
        this.connections = [];
        if (this.viewerConn) this.viewerConn.close();
        this.viewerConn = null;
        if (this.peer) this.peer.destroy();
        this.peer = null;
        this.role = null;
        this._lastSent = {};
        const input = this.dashboard.getEl('stream-link');
        if (input) input.value = '';
        this._status(null);
    }
}

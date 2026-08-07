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
        this.canDraw = false;        // viewer: granted co-host rights
        this.pendingRequests = [];    // host: peer ids awaiting accept/deny
        this.drawLoopTimer = null;    // co-host send loop
        this._lastSentDraw = null;    // co-host: JSON of last sent own-shapes
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
            topoMode: s.topoMode,
            toggles: s.toggles,
            drawings: s.drawings,
            mapUml: s.mapUml,
            poster: s.poster,
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
                this.pendingRequests = this.pendingRequests.filter(p => p !== conn.peer);
                if (conn._canDraw) this._dropCohostShapes(conn.peer);
                this._renderRequests();
                this._renderCohosts();
                this._updateViewerCount();
            });
            conn.on('data', (msg) => {
                if (msg?.type === 'draw-request') {
                    if (!this.pendingRequests.includes(conn.peer)) {
                        this.pendingRequests.push(conn.peer);
                        this._renderRequests();
                    }
                } else if (msg?.type === 'draw' && conn._canDraw) {
                    const shapes = Array.isArray(msg.shapes) ? msg.shapes : [];
                    shapes.forEach(s => { s.owner = conn.peer; });
                    const dt = this.dashboard.drawTool;
                    dt.shapes = dt.shapes.filter(s => s.owner !== conn.peer).concat(shapes);
                    dt._render();
                }
            });
        });

        this.peer.on('error', (err) => this._status(`Peer error: ${err.type}`));

        this.role = 'presenter';
    }

    _loop() {
        this.loopTimer = setInterval(() => {
            const myId = this.peer?.id;
            this.dashboard.drawTool.shapes.forEach(s => { if (!s.owner) s.owner = myId; });
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

    acceptRequest(peerId) {
        this.pendingRequests = this.pendingRequests.filter(p => p !== peerId);
        const conn = this.connections.find(c => c.peer === peerId);
        if (conn) { conn._canDraw = true; conn.send({ type: 'role', canDraw: true }); }
        this._renderRequests();
        this._renderCohosts();
    }

    denyRequest(peerId) {
        this.pendingRequests = this.pendingRequests.filter(p => p !== peerId);
        const conn = this.connections.find(c => c.peer === peerId);
        if (conn) conn.send({ type: 'role', canDraw: false });
        this._renderRequests();
    }

    revokeCohost(peerId) {
        const conn = this.connections.find(c => c.peer === peerId);
        if (conn) { conn._canDraw = false; conn.send({ type: 'role', canDraw: false }); }
        this._dropCohostShapes(peerId);
        this._renderCohosts();
    }

    _dropCohostShapes(peerId) {
        const dt = this.dashboard.drawTool;
        dt.shapes = dt.shapes.filter(s => s.owner !== peerId);
        dt._render();
    }

    _renderRequests() {
        const div = this.dashboard.getEl('stream-requests');
        if (!div) return;
        div.innerHTML = this.pendingRequests.map(p =>
            `<div class="btn-row"><span class="small-label">✏️ ${p.slice(0, 8)}…</span>
             <button class="btn btn-sm" data-accept="${p}">Accept</button>
             <button class="btn btn-sm btn-danger" data-deny="${p}">Deny</button></div>`).join('');
        div.querySelectorAll('[data-accept]').forEach(b =>
            b.addEventListener('click', () => this.acceptRequest(b.dataset.accept)));
        div.querySelectorAll('[data-deny]').forEach(b =>
            b.addEventListener('click', () => this.denyRequest(b.dataset.deny)));
    }

    _renderCohosts() {
        const div = this.dashboard.getEl('stream-cohosts');
        if (!div) return;
        const cohosts = this.connections.filter(c => c._canDraw);
        div.innerHTML = cohosts.map(c =>
            `<div class="btn-row"><span class="small-label">🖊 ${c.peer.slice(0, 8)}…</span>
             <button class="btn btn-sm btn-danger" data-revoke="${c.peer}">Revoke</button></div>`).join('');
        div.querySelectorAll('[data-revoke]').forEach(b =>
            b.addEventListener('click', () => this.revokeCohost(b.dataset.revoke)));
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
                else if (msg.type === 'role') {
                    this.canDraw = !!msg.canDraw;
                    if (this.canDraw) {
                        this._status('Following presenter — drawing enabled');
                        this._startDrawLoop();
                    } else {
                        this._status('Following presenter');
                        this._stopDrawLoop();
                    }
                }
            });

            this.viewerConn.on('close', () => this._status('Presenter disconnected'));
        });

        this.peer.on('error', (err) => this._status(`Connection failed: ${err.type}`));

        this.role = 'viewer';
    }

    requestDraw() {
        if (this.role !== 'viewer' || !this.viewerConn?.open) return;
        this.viewerConn.send({ type: 'draw-request' });
        this._status('Draw request sent…');
    }

    _startDrawLoop() {
        this._stopDrawLoop();
        this.drawLoopTimer = setInterval(() => {
            if (!this.viewerConn?.open) return;
            const myId = this.peer.id;
            const dt = this.dashboard.drawTool;
            dt.shapes.forEach(s => { if (!s.owner) s.owner = myId; });
            const mine = dt.shapes.filter(s => s.owner === myId);
            const json = JSON.stringify(mine);
            if (json !== this._lastSentDraw) {
                this._lastSentDraw = json;
                this.viewerConn.send({ type: 'draw', shapes: mine });
            }
        }, 1000);
    }

    _stopDrawLoop() {
        clearInterval(this.drawLoopTimer);
        this.drawLoopTimer = null;
        this._lastSentDraw = null;
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

        if (sections.topoMode) {
            const topoSel = dashboard.getEl('topo-mode');
            if (topoSel && topoSel.value !== sections.topoMode) {
                topoSel.value = sections.topoMode;
                topoSel.dispatchEvent(new Event('change'));
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
            if (this.canDraw && this.peer) {
                const myId = this.peer.id;
                dashboard.drawTool.shapes.forEach(s => { if (!s.owner) s.owner = myId; });
                const mine = dashboard.drawTool.shapes.filter(s => s.owner === myId);
                dashboard.drawTool.shapes = sections.drawings.filter(s => s.owner !== myId).concat(mine);
            } else {
                dashboard.drawTool.shapes = sections.drawings;
            }
            dashboard.drawTool._render();
        }

        if ('poster' in sections && dashboard.poster) {
            dashboard.poster.restore(sections.poster);
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
        this._stopDrawLoop();
        this.canDraw = false;
        this.pendingRequests = [];
        const input = this.dashboard.getEl('stream-link');
        if (input) input.value = '';
        const requestsDiv = this.dashboard.getEl('stream-requests');
        if (requestsDiv) requestsDiv.innerHTML = '';
        const cohostsDiv = this.dashboard.getEl('stream-cohosts');
        if (cohostsDiv) cohostsDiv.innerHTML = '';
        this._status(null);
    }
}

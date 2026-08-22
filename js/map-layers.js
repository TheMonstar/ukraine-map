const ISW_LABEL_MAP = {
    "Assessed Russian Infiltration Areas in Ukraine": ["RU", "CONTESTED"],
    "Assessed Russian-controlled Ukrainian Territory": ["RU", "HOLD"],
    "Russian Advances in Russia": ["RU", "HOLD"],
    "AssessedRussianAdvancesinUkraine_V2": ["RU", "HOLD"],
    "Assessed_Russian_Gains_in_the_Past_24_Hours": ["RU", "HOLD"],
    "Claimed Russian Advances in Russia": ["OTHER", "UNKNOWN"],
    "Claimed Ukrainian Counteroffensives": ["UA", "HOLD"],
    "ClaimedRussianTerritoryinUkraine_V2": ["OTHER", "UNKNOWN"],
    "ClaimedUkrainianCounteroffensivesinthePast24HoursV2": ["OTHER", "UNKNOWN"],
    "DonbasBeforeFeb24_2022": ["RU", "HOLD"],
    "MDS_ClaimedUkrainianCounteroffensives_V2": ["OTHER", "UNKNOWN"],
    "MDS_Claimed_Limit_of_Ukrainian_AdvanceV2": ["OTHER", "UNKNOWN"]
};

function suriyakLabel(label) {
    const UA_POLYGON_IDS = [108, 111];

    if (label == null) {
        return ["OTHER", "UNKNOWN"];
    }

    const text = String(label).trim();
    if (
        text.includes("Kursk") ||
        text.includes("Belgorod")
    ) {
        return ["OTHER", "UNKNOWN"];
    }

    if (text.includes("Ukrainian Armed Forces")) {
        return ["UA", "HOLD"];
    }

    if (
        text.includes("Russian Armed Forces") ||
        text.includes("Russian Forces") ||
        text.includes("People's Republic")
    ) {
        return ["RU", "HOLD"];
    }

    const match = text.match(/Pol.gono\s+(\d+)/);
    if (match) {
        const num = parseInt(match[1], 10);
        if (UA_POLYGON_IDS.includes(num)) {
            return ["UA", "HOLD"];
        }
        return ["RU", "HOLD"];
    }

    return ["OTHER", "UNKNOWN"];
}

class MapLayers {
    /**
     * Marker container for the GSUA and MoDR feeds. Cluster options are fixed at
     * construction, so toggling clustering means building a new layer.
     * featureGroup (not layerGroup) because updateMap calls getBounds() on it.
     */
    static makeMarkerLayer(clustered, extraOptions = {}) {
        return clustered
            ? L.markerClusterGroup({
                maxClusterRadius: 40,
                spiderfyDistanceMultiplier: 1.5,
                spiderfyOnMaxZoom: true,
                zoomToBoundsOnClick: true,
                ...extraOptions
            })
            : L.featureGroup();
    }

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.sourcesManifest = null;
        this.sourcesManifestPromise = null;
    }

    initMap() {
        const dashboard = this.dashboard;

        dashboard.map = L.map('map', {
            rotate: true,
            bearing: 0,
            rotateControl: false, // custom control matching this app's dark theme, wired in ui-bindings.js
            touchRotate: true,
            shiftKeyRotate: true
        }).setView([49.0, 37.0], 6);

        dashboard.currentBaseStyle = 'esri-elevation';
        dashboard.currentTileLayer = L.tileLayer(dashboard.mapStyles['esri-elevation'].url, {
            attribution: dashboard.mapStyles['esri-elevation'].attribution
        }).addTo(dashboard.map);

        // Own pane for the GSUA/MoDR heat surfaces. `isolation: isolate` keeps
        // their screen blending between themselves, so blue over red reads
        // purple while the pane as a whole still composites normally over the
        // basemap. Between overlayPane (400) and markerPane (600).
        const heatPane = dashboard.map.createPane('sourceHeat');
        heatPane.style.zIndex = 450;
        heatPane.style.isolation = 'isolate';
        heatPane.style.pointerEvents = 'none';

        dashboard.markers = MapLayers.makeMarkerLayer(dashboard.markerDisplayMode() === 'cluster');
        dashboard.map.addLayer(dashboard.markers);

        dashboard.ungroupedMarkers = L.layerGroup();

        dashboard.frontlineLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.clusterLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.deepLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.positionChangeLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDitchesLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDitchesStartLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureWireLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDragonLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureMotorLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureRailwayLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.eventsLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.modrLayer = MapLayers.makeMarkerLayer(
            dashboard.markerDisplayMode() === 'cluster', { disableClusteringAtZoom: 11 }
        ).addTo(dashboard.map);
        dashboard.riaEventsLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.owlEventsLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.losLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.forestLayer = null;
        dashboard.settlementsLayer.addTo(dashboard.map);
        dashboard.settlementBordersLayer.addTo(dashboard.map);
        dashboard.settlementBufferLayer.addTo(dashboard.map);
        dashboard.settlementLocalBoundariesLayer.addTo(dashboard.map);
        dashboard.settlementPopupBoundariesLayer.addTo(dashboard.map);
        dashboard.settlementNamesLayer.addTo(dashboard.map);

        dashboard.map.on('zoomend moveend', () => {
            if (dashboard.isChecked('settlements-border')) {
                dashboard.renderSettlementBoundaries();
            }
        });

        // labels size by population tier, so re-render when the zoom changes
        dashboard.map.on('zoomend', () => {
            if (dashboard.isChecked('show-settlement-names')) {
                dashboard.settlements.renderSettlementNames();
            }
            dashboard.rescaleSourceHeatmaps();
        });

        dashboard.initPolygonSelection();
    }

    setBaseLayer(style) {
        const dashboard = this.dashboard;
        const cfg = dashboard.mapStyles[style];
        // Only dated imagery can be compared; tear the swipe down without
        // letting it reset the base layer we are about to set.
        if (!cfg.dated && dashboard.nasaCompare) {
            this.disableNasaCompare(false);
            const cb = dashboard.getEl('nasa-compare');
            if (cb) cb.checked = false;
        }
        if (dashboard.currentTileLayer) {
            dashboard.map.removeLayer(dashboard.currentTileLayer);
        }
        dashboard.currentBaseStyle = style;
        let url = cfg.url;
        if (cfg.dated && dashboard.endDate) {
            // While comparing, the base layer holds the *start* date and the
            // clipped overlay pane holds the end date.
            url = this.gibsUrlForDate(dashboard.nasaCompare ? dashboard.startDate : dashboard.endDate, style);
        }
        dashboard.currentTileLayer = L.tileLayer(url, {
            attribution: cfg.attribution,
            maxNativeZoom: cfg.maxNativeZoom
        }).addTo(dashboard.map);
        dashboard.currentTileLayer.bringToBack();
        if (dashboard.topoTileLayer) dashboard.topoTileLayer.bringToBack();
        dashboard.currentTileLayer.bringToBack();
    }

    /** GIBS tile URL for a given Date — swaps the /YYYY-MM-DD/ path segment. */
    gibsUrlForDate(date, style) {
        const d = date || this.dashboard.endDate || new Date();
        const cfg = this.dashboard.mapStyles[style || this.dashboard.currentBaseStyle];
        return cfg.url.replace(/\/\d{4}-\d{2}-\d{2}\//, `/${MapLayers.isoDate(d)}/`);
    }

    static isoDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * Worldview-style swipe: a second GIBS layer for the slider's end date sits
     * in its own pane above the basemap, clipped to the area right of a
     * draggable divider. The basemap below it carries the start date.
     */
    enableNasaCompare() {
        const dashboard = this.dashboard;
        const map = dashboard.map;
        if (dashboard.nasaCompareLayer) return;

        dashboard.nasaCompare = true;
        // leaflet-rotate nests tilePane inside a leaflet-rotate-pane, so the
        // compare pane must be created in that same parent — a sibling of the
        // rotate pane would paint underneath the whole basemap.
        const paneParent = map.getPane('tilePane').parentElement;
        let pane = map.getPane('nasa-compare');
        if (!pane) {
            pane = map.createPane('nasa-compare', paneParent);
            pane.style.zIndex = 250; // above tilePane (200), below overlayPane (400)
        } else if (pane.parentElement !== paneParent) {
            paneParent.appendChild(pane);
        }

        const style = dashboard.currentBaseStyle;
        dashboard.nasaCompareLayer = L.tileLayer(this.gibsUrlForDate(dashboard.endDate, style), {
            pane: 'nasa-compare',
            attribution: dashboard.mapStyles[style].attribution,
            maxNativeZoom: dashboard.mapStyles[style].maxNativeZoom
        }).addTo(map);

        // Base layer flips to the start date now that compare is on.
        this.setBaseLayer(style);

        this._buildNasaSwipeHandle();
        this._nasaClipHandler = () => this._updateNasaClip();
        map.on('move zoom zoomend resize viewreset', this._nasaClipHandler);
        this._updateNasaClip();
        this.refreshNasaCompare();
    }

    disableNasaCompare(resetBase = true) {
        const dashboard = this.dashboard;
        const map = dashboard.map;
        if (!dashboard.nasaCompare && !dashboard.nasaCompareLayer) return;

        dashboard.nasaCompare = false;
        if (this._nasaClipHandler) {
            map.off('move zoom zoomend resize viewreset', this._nasaClipHandler);
            this._nasaClipHandler = null;
        }
        if (dashboard.nasaCompareLayer) {
            map.removeLayer(dashboard.nasaCompareLayer);
            dashboard.nasaCompareLayer = null;
        }
        const pane = map.getPane('nasa-compare');
        if (pane) pane.style.clip = '';
        if (this._nasaSwipeEl) {
            this._nasaSwipeEl.remove();
            this._nasaSwipeEl = null;
        }
        if (resetBase) this.setBaseLayer(dashboard.currentBaseStyle);
    }

    /** Point the compare layer at the current end date and relabel the divider. */
    refreshNasaCompare() {
        const dashboard = this.dashboard;
        if (!dashboard.nasaCompareLayer) return;
        dashboard.nasaCompareLayer.setUrl(this.gibsUrlForDate(dashboard.endDate));
        if (this._nasaSwipeEl) {
            this._nasaSwipeEl.querySelector('.nasa-swipe-a').textContent = MapLayers.isoDate(dashboard.startDate);
            this._nasaSwipeEl.querySelector('.nasa-swipe-b').textContent = MapLayers.isoDate(dashboard.endDate);
        }
    }

    /**
     * Clip the compare pane in layer-point space so the divider stays put on
     * screen while the map pans (the leaflet-side-by-side technique).
     * Note: the rect is axis-aligned in layer space, so with a non-zero map
     * bearing the cut rotates with the map instead of staying vertical.
     */
    _updateNasaClip() {
        const map = this.dashboard.map;
        const pane = map.getPane('nasa-compare');
        if (!pane) return;
        const size = map.getSize();
        const nw = map.containerPointToLayerPoint([0, 0]);
        const se = map.containerPointToLayerPoint([size.x, size.y]);
        const x = nw.x + size.x * this.dashboard.nasaSwipePos;
        pane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    }

    _buildNasaSwipeHandle() {
        const dashboard = this.dashboard;
        const container = dashboard.map.getContainer().parentElement;
        const el = document.createElement('div');
        el.id = 'nasa-swipe';
        el.innerHTML = '<span class="nasa-swipe-label nasa-swipe-a"></span>' +
            '<span class="nasa-swipe-grip">\u21c4</span>' +
            '<span class="nasa-swipe-label nasa-swipe-b"></span>';
        el.style.left = `${dashboard.nasaSwipePos * 100}%`;
        container.appendChild(el);
        this._nasaSwipeEl = el;

        const grip = el.querySelector('.nasa-swipe-grip');
        const onMove = (e) => {
            const rect = container.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            dashboard.nasaSwipePos = pos;
            el.style.left = `${pos * 100}%`;
            this._updateNasaClip();
        };
        const onUp = (e) => {
            grip.releasePointerCapture?.(e.pointerId);
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onUp);
            dashboard.map.dragging.enable();
        };
        grip.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            dashboard.map.dragging.disable();
            grip.setPointerCapture?.(e.pointerId);
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
        });
    }

    static ELEV_STOPS = [
        [-5,  70, 170, 210],
        [0,   80, 200, 130],
        [20,  120, 210, 100],
        [50,  170, 220, 80],
        [90,  210, 220, 70],
        [130, 240, 210, 80],
        [170, 245, 185, 120],
        [220, 245, 160, 155],
        [270, 240, 155, 170],
        [320, 245, 180, 190],
        [360, 255, 225, 220]
    ];

    static elevColor(e, min, max, mode) {
        const t01 = max > min ? Math.max(0, Math.min(1, (e - min) / (max - min))) : 0.5;
        if (mode === 'bw') {
            const v = Math.round(t01 * 255);
            return [v, v, v, 255];
        }
        if (mode === 'black-transparent') {
            // low elevation opaque black, high elevation transparent (basemap shows through)
            return [0, 0, 0, Math.round((1 - t01) * 255)];
        }
        const stops = MapLayers.ELEV_STOPS;
        const mapped = stops[0][0] + t01 * (stops[stops.length - 1][0] - stops[0][0]);
        if (mapped <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3], 255];
        for (let i = 1; i < stops.length; i++) {
            if (mapped <= stops[i][0]) {
                const f = (mapped - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
                return [
                    Math.round(stops[i - 1][1] + f * (stops[i][1] - stops[i - 1][1])),
                    Math.round(stops[i - 1][2] + f * (stops[i][2] - stops[i - 1][2])),
                    Math.round(stops[i - 1][3] + f * (stops[i][3] - stops[i - 1][3])),
                    255
                ];
            }
        }
        const last = stops[stops.length - 1];
        return [last[1], last[2], last[3], 255];
    }

    static _colorTile(tile, min, max, mode) {
        const elevData = tile._elevData;
        if (!elevData) return;
        const w = tile.width, h = tile.height;
        const ctx = tile.getContext('2d');
        const imageData = ctx.createImageData(w, h);
        const d = imageData.data;
        for (let j = 0, i = 0; j < elevData.length; j++, i += 4) {
            const [r, g, b, a] = MapLayers.elevColor(elevData[j], min, max, mode);
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
        }
        ctx.putImageData(imageData, 0, 0);
    }

    scheduleTopographicOverlayLoad() {
        const dashboard = this.dashboard;
        if (dashboard.topoTileLayer) return;

        const self = this;
        const HypsometricLayer = L.GridLayer.extend({
            createTile(coords, done) {
                const tile = document.createElement('canvas');
                const size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;
                const ctx = tile.getContext('2d');
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, size.x, size.y);
                    const srcData = ctx.getImageData(0, 0, size.x, size.y).data;
                    const elevData = new Float32Array(size.x * size.y);
                    let tMin = Infinity, tMax = -Infinity;
                    for (let i = 0, j = 0; i < srcData.length; i += 4, j++) {
                        const elev = (srcData[i] * 256 + srcData[i + 1] + srcData[i + 2] / 256) - 32768;
                        elevData[j] = elev;
                        if (elev < tMin) tMin = elev;
                        if (elev > tMax) tMax = elev;
                    }
                    tile._elevData = elevData;
                    tile._elevMin = tMin;
                    tile._elevMax = tMax;
                    const range = self._topoRange || { min: -5, max: 360 };
                    MapLayers._colorTile(tile, range.min, range.max, self.dashboard.getEl('topo-mode')?.value);
                    done(null, tile);
                    self._scheduleTopoRecolor();
                };
                img.onerror = () => done(null, tile);
                img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${coords.z}/${coords.x}/${coords.y}.png`;
                return tile;
            }
        });

        dashboard.topoTileLayer = new HypsometricLayer({
            opacity: 0.85,
            maxZoom: 15,
            attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>'
        }).addTo(dashboard.map);
        dashboard.topoTileLayer.bringToBack();
        if (dashboard.currentTileLayer) dashboard.currentTileLayer.bringToBack();

        const legend = L.control({ position: 'topright' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'legend elev-legend');
            div.id = 'elev-legend';
            return div;
        };
        legend.addTo(dashboard.map);
        dashboard.topoLegend = legend;

        this._topoRecolorHandler = () => this._scheduleTopoRecolor();
        dashboard.map.on('moveend zoomend rotate', this._topoRecolorHandler);
    }

    _scheduleTopoRecolor() {
        clearTimeout(this._topoRecolorTimer);
        this._topoRecolorTimer = setTimeout(() => this._recolorTopo(), 200);
    }

    _recolorTopo() {
        const dashboard = this.dashboard;
        const layer = dashboard.topoTileLayer;
        if (!layer || !layer._tiles) return;

        const tiles = [];
        const samples = [];
        const zoom = dashboard.map.getZoom();
        for (const key in layer._tiles) {
            const t = layer._tiles[key];
            if (t.current && t.el._elevData && t.coords && t.coords.z === zoom) {
                tiles.push(t.el);
                const ed = t.el._elevData;
                for (let i = 0; i < ed.length; i += 64) {
                    samples.push(ed[i]);
                }
            }
        }
        if (!samples.length) return;

        samples.sort((a, b) => a - b);
        const p = (pct) => samples[Math.floor(pct * (samples.length - 1))];
        const gMin = Math.max(p(0.02), -50);
        const gMax = Math.min(p(0.98), 600);
        if (gMax <= gMin) return;

        this._topoRange = { min: gMin, max: gMax };
        const mode = this.dashboard.getEl('topo-mode')?.value;
        for (const tile of tiles) {
            MapLayers._colorTile(tile, gMin, gMax, mode);
        }
        this._updateElevLegend(gMin, gMax);
    }

    _updateElevLegend(min, max) {
        const div = document.getElementById('elev-legend');
        if (!div) return;
        const mode = this.dashboard.getEl('topo-mode')?.value;
        const steps = 10;
        let rows = '';
        for (let i = steps; i >= 0; i--) {
            const elev = min + (i / steps) * (max - min);
            const [r, g, b, a] = MapLayers.elevColor(elev, min, max, mode);
            rows += `<div style="display:flex;align-items:center;gap:4px;margin:1px 0;">
                <span style="width:24px;height:14px;display:inline-block;background:rgb(${r},${g},${b});opacity:${(a / 255).toFixed(2)};border:1px solid rgba(0,0,0,0.15);"></span>
                <span style="font-size:11px;">${Math.round(elev)} m</span>
            </div>`;
        }
        div.innerHTML = rows;
    }

    clearTopographicOverlay() {
        const dashboard = this.dashboard;
        if (this._topoRecolorHandler) {
            dashboard.map.off('moveend zoomend rotate', this._topoRecolorHandler);
            this._topoRecolorHandler = null;
        }
        clearTimeout(this._topoRecolorTimer);
        this._topoRange = null;
        if (dashboard.topoTileLayer) {
            dashboard.map.removeLayer(dashboard.topoTileLayer);
            dashboard.topoTileLayer = null;
        }
        if (dashboard.topoLegend) {
            dashboard.map.removeControl(dashboard.topoLegend);
            dashboard.topoLegend = null;
        }
    }

    async toggleRussiaOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                console.log('Loading Russia.geojson overlay...');
                const response = await fetch('https://playframap.github.io/data/Russia.geojson');
                const russiaData = await response.json();

                if (!dashboard.russiaOverlay) {
                    dashboard.russiaOverlay = L.layerGroup().addTo(dashboard.map);
                }

                const polygonsToMerge = [];
                russiaData.features.forEach(feature => {
                    polygonsToMerge.push(...GeometryUtils.toTurfPolygons(feature.geometry));
                });

                if (polygonsToMerge.length > 0) {
                    console.log(`Merging ${polygonsToMerge.length} Russia polygons...`);
                    let merged = polygonsToMerge[0];
                    for (let i = 1; i < polygonsToMerge.length; i++) {
                        try {
                            merged = turf.union(merged, polygonsToMerge[i]);
                        } catch (err) {
                            console.warn(`Warning: Could not merge polygon ${i}`);
                        }
                    }
                    dashboard.russiaMergedPolygon = merged;
                    console.log('✓ Russia polygons merged for comparison');
                }

                L.geoJSON(russiaData, {
                    style: function () {
                        return {
                            color: '#ff0000',
                            weight: 2,
                            fillColor: '#ff0000',
                            fillOpacity: 0.1
                        };
                    },
                    onEachFeature: function (feature, layer) {
                        if (feature.properties) {
                            let tooltipContent = '';
                            for (const [key, value] of Object.entries(feature.properties)) {
                                tooltipContent += `<strong>${key}:</strong> ${value}<br>`;
                            }
                            if (tooltipContent) {
                                layer.bindTooltip(tooltipContent);
                            }
                        }
                    }
                }).addTo(dashboard.russiaOverlay);

                console.log('✓ Russia overlay loaded successfully');
            } catch (error) {
                console.error('Error loading Russia overlay:', error);
                alert('Failed to load Russia overlay. Check console for details.');
            }
        } else if (dashboard.russiaOverlay) {
            dashboard.russiaOverlay.clearLayers();
            dashboard.russiaMergedPolygon = null;
        }
    }

    async toggleUkraineOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                console.log('Loading Ukraine.geojson overlay...');
                const response = await fetch('https://playframap.github.io/data/Ukraine.geojson');
                const ukraineData = await response.json();

                if (!dashboard.ukraineOverlay) {
                    dashboard.ukraineOverlay = L.layerGroup().addTo(dashboard.map);
                }

                const polygonsToMerge = [];
                ukraineData.features.forEach(feature => {
                    polygonsToMerge.push(...GeometryUtils.toTurfPolygons(feature.geometry));
                });

                if (polygonsToMerge.length > 0) {
                    console.log(`Merging ${polygonsToMerge.length} Ukraine polygons...`);
                    let merged = polygonsToMerge[0];
                    for (let i = 1; i < polygonsToMerge.length; i++) {
                        try {
                            merged = turf.union(merged, polygonsToMerge[i]);
                        } catch (err) {
                            console.warn(`Warning: Could not merge polygon ${i}`);
                        }
                    }
                    dashboard.ukraineMergedPolygon = merged;
                    console.log('✓ Ukraine polygons merged for comparison');
                }

                L.geoJSON(ukraineData, {
                    style: function () {
                        return {
                            color: '#0000ff',
                            weight: 2,
                            fillColor: '#0000ff',
                            fillOpacity: 0.1
                        };
                    },
                    onEachFeature: function (feature, layer) {
                        if (feature.properties) {
                            let tooltipContent = '';
                            for (const [key, value] of Object.entries(feature.properties)) {
                                tooltipContent += `<strong>${key}:</strong> ${value}<br>`;
                            }
                            if (tooltipContent) {
                                layer.bindTooltip(tooltipContent);
                            }
                        }
                    }
                }).addTo(dashboard.ukraineOverlay);

                console.log('✓ Ukraine overlay loaded successfully');
            } catch (error) {
                console.error('Error loading Ukraine overlay:', error);
                alert('Failed to load Ukraine overlay. Check console for details.');
            }
        } else if (dashboard.ukraineOverlay) {
            dashboard.ukraineOverlay.clearLayers();
            dashboard.ukraineMergedPolygon = null;
        }
    }

    async toggleAmkOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                await this.toggleManifestKmlOverlay('AMK', 'amkOverlay', 'amkMergedPolygon');
            } catch (error) {
                console.error('Error loading AMK overlay:', error);
                alert('Failed to load AMK overlay. Check console for details.');
            }
        } else if (dashboard.amkOverlay) {
            dashboard.amkOverlay.clearLayers();
        }
    }

    async toggleOwlOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                console.log('Loading owl.json overlay...');
                const response = await fetch('owl.json');
                const owlData = await response.json();

                console.log(`Total features in owl.json: ${owlData.features.length}`);

                const filteredFeatures = owlData.features.filter(feature => {
                    const props = feature.properties || {};
                    const fill = props.fill || '';

                    const isPurple = fill === '#9c27b0';
                    const isRed = fill === '#a52714';
                    const isCustom = fill === '#c2185b';

                    return isPurple || isRed || isCustom;
                });

                console.log(`Filtered to ${filteredFeatures.length} features (purple or red polygons)`);

                const polygonsToMerge = [];
                filteredFeatures.forEach(feature => {
                    polygonsToMerge.push(...GeometryUtils.toTurfPolygons(feature.geometry));
                });

                console.log(`Merging ${polygonsToMerge.length} polygons...`);

                let mergedPolygon = null;
                if (polygonsToMerge.length > 0) {
                    mergedPolygon = polygonsToMerge[0];

                    for (let i = 1; i < polygonsToMerge.length; i++) {
                        if (i % 50 === 0) {
                            console.log(`  Merging progress: ${i}/${polygonsToMerge.length}`);
                        }
                        try {
                            mergedPolygon = turf.union(mergedPolygon, polygonsToMerge[i]);
                        } catch (err) {
                            console.warn(`  Warning: Could not merge polygon ${i}: ${err.message}`);
                        }
                    }

                    console.log('✓ Polygons merged successfully');

                    try {
                        const area = turf.area(mergedPolygon);
                        const areaKm2 = (area / 1000000).toFixed(2);
                        console.log(`Total area: ${areaKm2} km²`);
                    } catch (error) {
                        console.log('Area calculation: N/A');
                    }
                }

                if (!dashboard.owlOverlay) {
                    dashboard.owlOverlay = L.layerGroup().addTo(dashboard.map);
                }

                if (mergedPolygon) {
                    L.geoJSON(mergedPolygon, {
                        style: function () {
                            return {
                                color: '#9c27b0',
                                weight: 2,
                                fillColor: '#9c27b0',
                                fillOpacity: 0.2,
                                opacity: 0.8
                            };
                        },
                        onEachFeature: function (feature, layer) {
                            const tooltipContent = `
                                <strong>OWL Territory</strong><br>
                                Features merged: ${filteredFeatures.length}<br>
                                Polygons merged: ${polygonsToMerge.length}
                            `;
                            layer.bindTooltip(tooltipContent);
                        }
                    }).addTo(dashboard.owlOverlay);

                    dashboard.owlMergedPolygon = mergedPolygon;

                    console.log('✓ OWL overlay loaded successfully');
                } else {
                    console.warn('No polygons to display');
                }

            } catch (error) {
                console.error('Error loading OWL overlay:', error);
                alert('Failed to load OWL overlay. Check console for details.');
            }
        } else if (dashboard.owlOverlay) {
            dashboard.owlOverlay.clearLayers();
        }
    }

    async toggleRadovOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                await this.toggleManifestKmlOverlay('RADOV', 'radovOverlay', 'radovMergedPolygon');
            } catch (error) {
                console.error('Error loading Radov overlay:', error);
                alert(`Failed to load Radov overlay: ${error.message}`);
            }
        } else if (dashboard.radovOverlay) {
            dashboard.radovOverlay.clearLayers();
            dashboard.radovMergedPolygon = null;
        }
    }

    async toggleIswOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                await this.toggleManifestKmlOverlay('ISW', 'iswOverlay', 'iswMergedPolygon');
            } catch (error) {
                console.error('Error loading ISW overlay:', error);
                alert(`Failed to load ISW overlay: ${error.message}`);
            }
        } else if (dashboard.iswOverlay) {
            dashboard.iswOverlay.clearLayers();
            dashboard.iswMergedPolygon = null;
        }
    }

    async toggleSuriyakOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            try {
                await this.toggleManifestKmlOverlay('suriyak', 'suriyakOverlay', 'suriyakMergedPolygon');
            } catch (error) {
                console.error('Error loading Suriyak overlay:', error);
                alert(`Failed to load Suriyak overlay: ${error.message}`);
            }
        } else if (dashboard.suriyakOverlay) {
            dashboard.suriyakOverlay.clearLayers();
            dashboard.suriyakMergedPolygon = null;
        }
    }

    /**
     * RIA overlay — a single dated GeoJSON of extracted control-zone polygons
     * (produced by an offline extraction pipeline from the RIA briefing-map
     * SVG), keyed by the currently selected end date. Same fetch-by-date
     * pattern as toggleCreamyOverlay, but the source is already GeoJSON.
     */
    static _riaDateStr(date) {
        const d = new Date(date);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    }

    /** Fetch a day's RIA zones GeoJSON (raw, unmerged). */
    async _loadRiaZones(dateStr) {
        const url = `${API_BASE_URL}/daily/${dateStr}/zones-${dateStr}.geojson`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return resp.json();
    }

    /** Fetch + union a day's RIA zones into a single polygon (or null). */
    async _loadRiaMerged(dateStr) {
        const geojson = await this._loadRiaZones(dateStr);
        const polys = [];
        (geojson.features || []).forEach(f => {
            if (f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
                polys.push(...GeometryUtils.toTurfPolygons(f.geometry));
            }
        });
        let merged = polys[0] || null;
        for (let i = 1; i < polys.length; i++) {
            try { merged = turf.union(merged, polys[i]); }
            catch (e) { /* keep partial union */ }
        }
        return merged;
    }

    /**
     * Gains/losses between two dates' RIA zones, in the same {gains, losses,
     * net} shape as getManifestDiffAreaKm2 — used for the "Total" stats line.
     */
    async getRiaDiffAreaKm2(startDate, endDate) {
        const result = { gains: 0, losses: 0, net: 0, gainsGeom: null, lossesGeom: null };
        let startUnion = null, endUnion = null;
        try { startUnion = await this._loadRiaMerged(MapLayers._riaDateStr(startDate)); }
        catch (e) { console.warn('RIA diff: start load failed:', e); }
        try { endUnion = await this._loadRiaMerged(MapLayers._riaDateStr(endDate)); }
        catch (e) { console.warn('RIA diff: end load failed:', e); }

        if (!startUnion && !endUnion) return result;

        if (startUnion && endUnion) {
            try {
                const diff = turf.difference(endUnion, startUnion);
                if (diff) { result.gains = turf.area(diff) / 1e6; result.gainsGeom = diff; }
            } catch (e) { result.gains = turf.area(endUnion) / 1e6; result.gainsGeom = endUnion; }
            try {
                const reverseDiff = turf.difference(startUnion, endUnion);
                if (reverseDiff) { result.losses = turf.area(reverseDiff) / 1e6; result.lossesGeom = reverseDiff; }
            } catch (e) { /* ignore */ }
        } else if (endUnion) {
            result.gains = turf.area(endUnion) / 1e6;
            result.gainsGeom = endUnion;
        } else if (startUnion) {
            result.losses = turf.area(startUnion) / 1e6;
            result.lossesGeom = startUnion;
        }

        result.net = result.gains - result.losses;
        return result;
    }

    async toggleRiaOverlay(enabled) {
        const dashboard = this.dashboard;
        if (!dashboard.riaOverlay) {
            dashboard.riaOverlay = L.layerGroup().addTo(dashboard.map);
        }
        dashboard.riaOverlay.clearLayers();
        dashboard.riaMergedPolygon = null;
        if (!enabled) return;

        const endDate = dashboard.endDate || dashboard.maxDate || new Date();
        const startDate = dashboard.startDate || dashboard.minDate;
        const diffEnabled = dashboard.isChecked('diff-highlight');
        const endStr = MapLayers._riaDateStr(endDate);

        let endMerged;
        try {
            endMerged = await this._loadRiaMerged(endStr);
            dashboard.riaMergedPolygon = endMerged;
        } catch (error) {
            console.warn(`RIA overlay: failed to load zones for ${endStr}:`, error);
            const cb = dashboard.getEl('ria-overlay');
            if (cb) cb.checked = false;
            alert(`Failed to load RIA zones for ${endStr}: ${error.message}`);
            return;
        }

        const startStr = startDate ? MapLayers._riaDateStr(startDate) : null;

        // Difference mode: color-distinguish gains (red) / losses (blue) between
        // start and end dates, matching the Suriyak/AMK/ISW/Radov diff style.
        if (diffEnabled && startStr && startStr !== endStr) {
            let startMerged = null;
            try {
                startMerged = await this._loadRiaMerged(startStr);
            } catch (e) {
                console.warn('RIA: failed to load startDate layer:', e);
            }

            const startFeature = startMerged ? { type: 'Feature', properties: {}, geometry: startMerged.geometry || startMerged } : null;
            const endFeature = endMerged ? { type: 'Feature', properties: {}, geometry: endMerged.geometry || endMerged } : null;

            let gains = null, losses = null;
            if (startFeature && endFeature) {
                try { gains = turf.difference(endFeature, startFeature); }
                catch (e) { gains = endFeature; }
                try { losses = turf.difference(startFeature, endFeature); }
                catch (e) { /* ignore */ }
            } else if (endFeature) {
                gains = endFeature;
            } else if (startFeature) {
                losses = startFeature;
            }

            if (startFeature) {
                L.geoJSON(startFeature, {
                    style: { color: '#FF655C', weight: 1, fillColor: '#FF655C', fillOpacity: 0.2 }
                }).bindTooltip('RIA start').addTo(dashboard.riaOverlay);
            }
            if (gains) {
                const gainsKm2 = turf.area(gains) / 1e6;
                L.geoJSON(gains, {
                    style: { color: 'red', weight: 2, fillColor: 'red', fillOpacity: 0.5 }
                }).bindTooltip(`Gains: ${gainsKm2.toFixed(2)} km²`).addTo(dashboard.riaOverlay);
            }
            if (losses) {
                const lossesKm2 = turf.area(losses) / 1e6;
                L.geoJSON(losses, {
                    style: { color: 'blue', weight: 2, fillColor: 'blue', fillOpacity: 0.5 }
                }).bindTooltip(`Losses: ${lossesKm2.toFixed(2)} km²`).addTo(dashboard.riaOverlay);
            }
        } else if (endMerged) {
            L.geoJSON({ type: 'Feature', properties: {}, geometry: endMerged.geometry || endMerged }, {
                style: { color: '#FF655C', weight: 2, fillColor: '#FF655C', fillOpacity: 0.35 }
            }).addTo(dashboard.riaOverlay);
        }
    }

    async toggleCreamyOverlay(enabled) {
        const dashboard = this.dashboard;
        if (!dashboard.creamyOverlay) {
            dashboard.creamyOverlay = L.layerGroup().addTo(dashboard.map);
        }
        dashboard.creamyOverlay.clearLayers();
        if (!enabled) return;

        const fmt = (date) => {
            const d = new Date(date);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}${m}${day}`;
        };

        const loadKml = async (dateStr) => {
            const url = `${API_BASE_URL}/daily/${dateStr}/creamycaprice_${dateStr}.kml`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
            const text = await resp.text();
            const kml = new DOMParser().parseFromString(text, 'text/xml');
            return toGeoJSON.kml(kml);
        };

        const endDate = dashboard.endDate || dashboard.maxDate;
        const startDate = dashboard.startDate || dashboard.minDate;
        const diffEnabled = dashboard.isChecked('diff-highlight');

        try {
            const endStr = fmt(endDate);
            const endGeoJSON = await loadKml(endStr);
            L.geoJSON(endGeoJSON, {
                style: () => ({ color: '#ff9800', weight: 2, opacity: 0.9, dashArray: null })
            }).addTo(dashboard.creamyOverlay);
        } catch (e) {
            console.warn('Creamy: failed to load endDate layer:', e);
        }

        if (diffEnabled && startDate) {
            try {
                const startStr = fmt(startDate);
                const startGeoJSON = await loadKml(startStr);
                L.geoJSON(startGeoJSON, {
                    style: () => ({ color: '#ff9800', weight: 2, opacity: 0.6, dashArray: '6 4' })
                }).addTo(dashboard.creamyOverlay);
            } catch (e) {
                console.warn('Creamy: failed to load startDate layer:', e);
            }
        }
    }

    async toggleManifestKmlOverlay(sourceKey, overlayKey, mergedKey) {
        const dashboard = this.dashboard;
        const startDate = dashboard.startDate || new Date();
        const endDate = dashboard.endDate || startDate;
        const diffEnabled = dashboard.isChecked('diff-highlight');

        const endData = await this.loadManifestDataByDate(sourceKey, endDate);
        if (!endData || !endData.features || endData.features.length === 0) {
            throw new Error(`No features found in ${sourceKey} KML data.`);
        }

        const startData = diffEnabled ? await this.loadManifestDataByDate(sourceKey, startDate) : null;

        if (!dashboard[overlayKey]) {
            dashboard[overlayKey] = L.layerGroup().addTo(dashboard.map);
        } else {
            dashboard[overlayKey].clearLayers();
        }

        const { ruUnion: endRuUnion, nonRuFeatures: endNonRu } = this.extractKmlFeatures(endData, sourceKey);
        dashboard[mergedKey] = endRuUnion || null;

        const normalizedKey = (sourceKey || '').toUpperCase();
        const forceRed = normalizedKey === 'AMK';
        const styleFeature = function (feature) {
            const props = feature?.properties || {};
            const name = props.name || '';
            const stroke = props.stroke || props['stroke-color'];
            const fill = props.fill || props['fill-color'];
            const strokeWidth = Number(props['stroke-width']);
            const strokeOpacity = Number(props['stroke-opacity']);
            const fillOpacity = Number(props['fill-opacity']);

            let forcedColor = null;
            if (forceRed) {
                forcedColor = '#ff0000';
            }
            if (name.startsWith('RU')) {
                forcedColor = '#ff0000';
            } else if (name.startsWith('UA')) {
                forcedColor = '#0000ff';
            }

            const baseStroke = forcedColor || stroke || '#ff7a18';
            const baseFill = forcedColor || fill || stroke || '#ff7a18';

            return {
                color: baseStroke,
                weight: Number.isFinite(strokeWidth) ? strokeWidth : 2,
                opacity: Number.isFinite(strokeOpacity) ? strokeOpacity : 1,
                fillColor: baseFill,
                fillOpacity: Number.isFinite(fillOpacity) ? fillOpacity : 0.12
            };
        };

        if (diffEnabled && startData) {
            const { ruUnion: startRuUnion } = this.extractKmlFeatures(startData, sourceKey);
            const startFeature = startRuUnion ? {
                type: 'Feature',
                properties: { name: 'RU start' },
                geometry: startRuUnion.geometry || startRuUnion
            } : null;
            const endFeature = endRuUnion ? {
                type: 'Feature',
                properties: { name: 'RU end' },
                geometry: endRuUnion.geometry || endRuUnion
            } : null;

            let difference = null;
            let reverseDifference = null;

            // Calculate gains (end - start)
            if (startRuUnion && endRuUnion) {
                try {
                    difference = turf.difference(endFeature, startFeature);
                    console.log(`${sourceKey}: Calculated gains (red)`, difference ? 'exists' : 'null');
                } catch (error) {
                    console.warn(`${sourceKey} diff failed, using end union:`, error);
                    difference = endFeature;
                }

                // Calculate losses (start - end)
                try {
                    reverseDifference = turf.difference(startFeature, endFeature);
                    console.log(`${sourceKey}: Calculated losses (blue)`, reverseDifference ? 'exists' : 'null');
                } catch (error) {
                    console.warn(`${sourceKey} reverse diff failed:`, error);
                }
            } else if (endRuUnion) {
                difference = endFeature;
                console.log(`${sourceKey}: No start data, all end shown as gains`);
            } else if (startRuUnion) {
                reverseDifference = startFeature;
                console.log(`${sourceKey}: No end data, all start shown as losses`);
            }

            if (startFeature) {
                L.geoJSON(startFeature, {
                    style: function () {
                        return {
                            color: '#ff0000',
                            weight: 1,
                            fillColor: '#ff0000',
                            fillOpacity: 0.2
                        };
                    },
                    onEachFeature: function (_feature, layer) {
                        layer.bindTooltip('RU start');
                    }
                }).addTo(dashboard[overlayKey]);
            }

            // Render gains in red
            if (difference) {
                const gainsArea = turf.area(difference) / 1000000; // Convert m² to km²
                console.log(`📈 ${sourceKey} Gains: ${gainsArea.toFixed(2)} km²`);

                L.geoJSON(difference, {
                    style: function () {
                        return {
                            color: 'red',
                            weight: 2,
                            fillColor: 'red',
                            fillOpacity: 0.5
                        };
                    },
                    onEachFeature: function (_feature, layer) {
                        layer.bindTooltip(`Gains: ${gainsArea.toFixed(2)} km²`);
                    }
                }).addTo(dashboard[overlayKey]);
            }

            // Render losses in blue
            if (reverseDifference) {
                const lossesArea = turf.area(reverseDifference) / 1000000; // Convert m² to km²
                console.log(`📉 ${sourceKey} Losses: ${lossesArea.toFixed(2)} km²`);

                L.geoJSON(reverseDifference, {
                    style: function () {
                        return {
                            color: 'blue',
                            weight: 2,
                            fillColor: 'blue',
                            fillOpacity: 0.5
                        };
                    },
                    onEachFeature: function (_feature, layer) {
                        layer.bindTooltip(`Losses: ${lossesArea.toFixed(2)} km²`);
                    }
                }).addTo(dashboard[overlayKey]);
            }
        } else if (dashboard[mergedKey]) {
            L.geoJSON({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    properties: { name: 'RU merged' },
                    geometry: dashboard[mergedKey].geometry || dashboard[mergedKey]
                }]
            }, {
                style: styleFeature,
                onEachFeature: function (_feature, layer) {
                    layer.bindTooltip('RU merged');
                }
            }).addTo(dashboard[overlayKey]);
        }

        if (endNonRu.length && !forceRed) {
            L.geoJSON({
                type: 'FeatureCollection',
                features: endNonRu
            }, {
                style: styleFeature,
                onEachFeature: function (feature, layer) {
                    const name = feature?.properties?.name;
                    if (name) {
                        layer.bindTooltip(name);
                    }
                }
            }).addTo(dashboard[overlayKey]);
        }

        console.log(`✓ ${sourceKey} overlay loaded successfully`);
    }

    async getManifestDiffAreaKm2(sourceKey, startDate, endDate) {
        const startData = await this.loadManifestDataByDate(sourceKey, startDate);
        const endData = await this.loadManifestDataByDate(sourceKey, endDate);

        const { ruUnion: startUnion } = this.extractKmlFeatures(startData, sourceKey);
        const { ruUnion: endUnion } = this.extractKmlFeatures(endData, sourceKey);

        const result = { gains: 0, losses: 0, net: 0, gainsGeom: null, lossesGeom: null };

        if (!endUnion && !startUnion) {
            return result;
        }

        const startFeature = startUnion ? {
            type: 'Feature',
            geometry: startUnion.geometry || startUnion,
            properties: {}
        } : null;

        const endFeature = endUnion ? {
            type: 'Feature',
            geometry: endUnion.geometry || endUnion,
            properties: {}
        } : null;

        // Calculate gains (end - start)
        if (endFeature && startFeature) {
            try {
                const difference = turf.difference(endFeature, startFeature);
                if (difference) {
                    result.gains = turf.area(difference) / 1000000;
                    result.gainsGeom = difference;
                }
            } catch (error) {
                console.warn(`${sourceKey} gains calculation failed:`, error);
                if (endFeature) {
                    result.gains = turf.area(endFeature) / 1000000;
                    result.gainsGeom = endFeature;
                }
            }
        } else if (endFeature) {
            result.gains = turf.area(endFeature) / 1000000;
            result.gainsGeom = endFeature;
        }

        // Calculate losses (start - end)
        if (startFeature && endFeature) {
            try {
                const reverseDifference = turf.difference(startFeature, endFeature);
                if (reverseDifference) {
                    result.losses = turf.area(reverseDifference) / 1000000;
                    result.lossesGeom = reverseDifference;
                }
            } catch (error) {
                console.warn(`${sourceKey} losses calculation failed:`, error);
            }
        } else if (startFeature) {
            result.losses = turf.area(startFeature) / 1000000;
            result.lossesGeom = startFeature;
        }

        result.net = result.gains - result.losses;

        return result;
    }

    async loadSourcesManifest() {
        if (this.sourcesManifest) {
            return this.sourcesManifest;
        }
        if (this.sourcesManifestPromise) {
            return this.sourcesManifestPromise;
        }
        const manifestUrl = 'https://ukraineviews.org/data/manifest.json';
        this.sourcesManifestPromise = fetch(manifestUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                this.sourcesManifest = data;
                return data;
            })
            .catch(error => {
                this.sourcesManifestPromise = null;
                throw error;
            });
        return this.sourcesManifestPromise;
    }

    getManifestFiles(sourceKey, manifest) {
        const sources = manifest?.sources || {};
        const normalizedKey = sourceKey.toUpperCase();
        const aliasKey = normalizedKey === 'SURIAK' ? 'suriyak' : normalizedKey;
        const entry = sources[sourceKey] || sources[normalizedKey] || sources[aliasKey];
        const files = entry?.files || [];
        return files.slice();
    }

    parseDateFromFilename(filePath) {
        const match = filePath.match(/_(\d{4})_(\d{2})_(\d{2})\./);
        if (!match) {
            return null;
        }
        const [_, year, month, day] = match;
        return new Date(`${year}-${month}-${day}T00:00:00Z`);
    }

    pickClosestFile(files, targetDate) {
        if (!files.length) {
            return null;
        }
        const candidates = files
            .map(file => ({
                file,
                date: this.parseDateFromFilename(file)
            }))
            .filter(item => item.date instanceof Date && !Number.isNaN(item.date.valueOf()));

        if (!candidates.length) {
            return files[files.length - 1];
        }

        const target = targetDate instanceof Date ? targetDate : new Date();
        let closest = candidates[0];
        let minDiff = Math.abs(candidates[0].date - target);

        for (let i = 1; i < candidates.length; i++) {
            const diff = Math.abs(candidates[i].date - target);
            if (diff < minDiff) {
                minDiff = diff;
                closest = candidates[i];
            }
        }

        return closest.file;
    }
    formatDateToYYYYMMDD = (date) => {
        const year = date.getFullYear();
        // Month is 0-indexed (0 is January), so add 1
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        // Concatenate without separators
        return `${year}${month}${day}`;
    }
    
    async loadManifestDataByDate(sourceKey, date) {
        const manifest = await this.loadSourcesManifest();
        const files = this.getManifestFiles(sourceKey, manifest);
        if (!files.length) {
            throw new Error(`No files listed for ${sourceKey} in manifest.`);
        }
        const filePath = this.pickClosestFile(files, date);
        if (!filePath) {
            throw new Error(`No dated files found for ${sourceKey}.`);
        }
        const url = `${API_BASE_URL}/daily/${this.formatDateToYYYYMMDD(date)}/${sourceKey}_${this.formatDateToYYYYMMDD(date)}.kml`;
        console.log(`Loading ${sourceKey} data: ${url}`);

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const lowerPath = filePath.toLowerCase();
        if (lowerPath.includes('.kml') || lowerPath.includes('.klm')) {
            const kmlText = await response.text();
            const kmlDoc = new DOMParser().parseFromString(kmlText, 'text/xml');
            return this.parseKmlToGeoJSON(kmlDoc);
        }

        if (lowerPath.includes('.geojson.gz') || lowerPath.includes('.json.gz')) {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('gzip decompression not supported in this browser.');
            }
            const ds = new DecompressionStream('gzip');
            const decompressedStream = response.body.pipeThrough(ds);
            const decompressedText = await new Response(decompressedStream).text();
            return JSON.parse(decompressedText);
        }

        if (lowerPath.endsWith('.geojson') || lowerPath.endsWith('.json')) {
            return await response.json();
        }

        throw new Error(`Unsupported file type for ${sourceKey}: ${filePath}`);
    }

    extractKmlFeatures(kmlData, sourceKey) {
        const normalizedKey = (sourceKey || '').toUpperCase();
        const allFeatures = kmlData.features || [];
        if (normalizedKey === 'AMK') {
            const filtered = allFeatures.filter(feature => {
                const name = feature?.properties?._src_name || feature?.properties?.name || '';
                if (name.includes('Bryansk') || name.includes('Kursk') || name.includes('Belgorod')) {
                    return false;
                }
                if (name.includes('Russian-controlled') || name.includes('pre-invasion')) {
                    return true;
                }
                return false;
            });
            return {
                ruUnion: this.mergeFeaturePolygons(filtered),
                nonRuFeatures: []
            };
        }
        if (normalizedKey === 'ISW') {
            const ruFeatures = allFeatures.filter(feature => {
                const name = feature?.properties?._src_name || '';
                const mapping = ISW_LABEL_MAP[name];
                return mapping && mapping[0] === 'RU';
            });
            return {
                ruUnion: this.mergeFeaturePolygons(ruFeatures),
                nonRuFeatures: []
            };
        }
        if (normalizedKey === 'SURIYAK') {
            const ruFeatures = allFeatures.filter(feature => {
                const label = feature?.properties?._src_name || feature?.properties?.name || '';
                const mapping = suriyakLabel(label);
                return mapping[0] === 'RU';
            });
            return {
                ruUnion: this.mergeFeaturePolygons(ruFeatures),
                nonRuFeatures: []
            };
        }

        const visibleFeatures = allFeatures.filter(feature => {
            const name = feature?.properties?.name || '';
            return !name.startsWith('UA');
        });

        const ruFeatures = visibleFeatures.filter(feature => {
            const name = feature?.properties?.name || '';
            return name.startsWith('RU');
        });

        const nonRuFeatures = visibleFeatures.filter(feature => {
            const name = feature?.properties?.name || '';
            return !name.startsWith('RU');
        });

        return {
            ruUnion: this.mergeFeaturePolygons(ruFeatures),
            nonRuFeatures
        };
    }

    mergeFeaturePolygons(features) {
        const polygonsToMerge = [];
        (features || []).forEach(feature => {
            polygonsToMerge.push(...GeometryUtils.toTurfPolygons(feature.geometry));
        });

        if (!polygonsToMerge.length) {
            return null;
        }

        let merged = polygonsToMerge[0];
        for (let i = 1; i < polygonsToMerge.length; i++) {
            try {
                merged = turf.union(merged, polygonsToMerge[i]);
            } catch (err) {
                console.warn(`Warning: Could not merge KML polygon ${i}`);
            }
        }

        return merged;
    }

    parseKmlToGeoJSON(kmlDoc) {
        if (typeof toGeoJSON !== 'undefined' && toGeoJSON?.kml) {
            return toGeoJSON.kml(kmlDoc);
        }

        const placemarks = Array.from(kmlDoc.getElementsByTagName('Placemark'));
        const features = [];

        const textOf = (el, tag) => {
            const node = el.getElementsByTagName(tag)[0];
            return node ? node.textContent.trim() : '';
        };

        const parseCoords = (text) => {
            return text
                .trim()
                .split(/\s+/)
                .map(pair => pair.trim())
                .filter(Boolean)
                .map(pair => {
                    const [lng, lat] = pair.split(',').map(Number);
                    return [lng, lat];
                })
                .filter(coord => Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
        };

        const geometryFromElement = (el) => {
            const multi = el.getElementsByTagName('MultiGeometry')[0];
            if (multi) {
                const subGeometries = [];
                ['Point', 'LineString', 'Polygon'].forEach(tag => {
                    Array.from(multi.getElementsByTagName(tag)).forEach(child => {
                        const geom = geometryFromElement(child);
                        if (geom) {
                            if (geom.type === 'GeometryCollection') {
                                subGeometries.push(...geom.geometries);
                            } else {
                                subGeometries.push(geom);
                            }
                        }
                    });
                });
                if (!subGeometries.length) {
                    return null;
                }
                return { type: 'GeometryCollection', geometries: subGeometries };
            }

            if (el.tagName === 'Point' || el.getElementsByTagName('Point')[0]) {
                const pointEl = el.tagName === 'Point' ? el : el.getElementsByTagName('Point')[0];
                const coordsEl = pointEl.getElementsByTagName('coordinates')[0];
                if (!coordsEl) return null;
                const coords = parseCoords(coordsEl.textContent);
                if (!coords.length) return null;
                return { type: 'Point', coordinates: coords[0] };
            }

            if (el.tagName === 'LineString' || el.getElementsByTagName('LineString')[0]) {
                const lineEl = el.tagName === 'LineString' ? el : el.getElementsByTagName('LineString')[0];
                const coordsEl = lineEl.getElementsByTagName('coordinates')[0];
                if (!coordsEl) return null;
                const coords = parseCoords(coordsEl.textContent);
                if (coords.length < 2) return null;
                return { type: 'LineString', coordinates: coords };
            }

            if (el.tagName === 'Polygon' || el.getElementsByTagName('Polygon')[0]) {
                const polygonEl = el.tagName === 'Polygon' ? el : el.getElementsByTagName('Polygon')[0];
                const outer = polygonEl.getElementsByTagName('outerBoundaryIs')[0];
                if (!outer) return null;
                const outerCoordsEl = outer.getElementsByTagName('coordinates')[0];
                if (!outerCoordsEl) return null;
                const outerCoords = parseCoords(outerCoordsEl.textContent);
                if (outerCoords.length < 4) return null;

                const rings = [outerCoords];
                Array.from(polygonEl.getElementsByTagName('innerBoundaryIs')).forEach(inner => {
                    const innerCoordsEl = inner.getElementsByTagName('coordinates')[0];
                    if (!innerCoordsEl) return;
                    const innerCoords = parseCoords(innerCoordsEl.textContent);
                    if (innerCoords.length >= 4) {
                        rings.push(innerCoords);
                    }
                });

                return { type: 'Polygon', coordinates: rings };
            }

            return null;
        };

        placemarks.forEach(placemark => {
            const geometry = geometryFromElement(placemark);
            if (!geometry) return;
            const properties = {
                name: textOf(placemark, 'name'),
                description: textOf(placemark, 'description')
            };

            if (geometry.type === 'GeometryCollection') {
                geometry.geometries.forEach(subGeom => {
                    features.push({
                        type: 'Feature',
                        properties,
                        geometry: subGeom
                    });
                });
            } else {
                features.push({
                    type: 'Feature',
                    properties,
                    geometry
                });
            }
        });

        return {
            type: 'FeatureCollection',
            features
        };
    }

    // Sentinel-1 overlay removed in public version

    /**
     * Is this payload GeoJSON rather than KML? The URL extension alone is not
     * enough — API endpoints serve GeoJSON from paths like
     * `/frontline-geojson?date=…` with no extension at all. Prefer the declared
     * content type, fall back to the extension, then sniff the body.
     */
    static looksLikeGeoJson(source, text, contentType = '') {
        if (/json/i.test(contentType)) return true;
        if (/xml|kml/i.test(contentType)) return false;

        const path = String(source || '').split(/[?#]/)[0].toLowerCase();
        if (path.endsWith('.geojson') || path.endsWith('.json')) return true;
        if (path.endsWith('.kml')) return false;

        return /^\s*[{[]/.test(text || '');
    }

    async loadCustomKml(url) {
        const dashboard = this.dashboard;
        try {
            console.log(`Loading custom layer from: ${url}`);

            // Store the URL for future reference
            dashboard.customKmlUrl = url;

            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

            const contentType = response.headers.get('content-type') || '';
            const text = await response.text();

            this.processCustomKmlText(text, MapLayers.looksLikeGeoJson(url, text, contentType));
        } catch (error) {
            console.error('Error loading custom KML:', error);
            alert(`Failed to load custom layer: ${error.message}`);
        }
    }

    async loadCustomKmlFile(file) {
        const dashboard = this.dashboard;
        try {
            console.log(`Loading custom layer from file: ${file.name}`);

            // Local files have no URL; clear any previously stored one
            dashboard.customKmlUrl = '';

            const text = await file.text();

            this.processCustomKmlText(text, MapLayers.looksLikeGeoJson(file.name, text, file.type));
        } catch (error) {
            console.error('Error loading custom KML file:', error);
            alert(`Failed to load custom layer file: ${error.message}`);
        }
    }

    processCustomKmlText(text, isGeoJson) {
        const dashboard = this.dashboard;
        try {
            let geojson;
            if (isGeoJson) {
                // Parse as GeoJSON directly
                geojson = JSON.parse(text);
                console.log('Detected GeoJSON format');
            } else {
                // Parse as KML
                const parser = new DOMParser();
                const kmlDoc = parser.parseFromString(text, 'text/xml');
                geojson = this.parseKmlToGeoJSON(kmlDoc);
                console.log('Detected KML format');
            }

            // A misdetected format parses "successfully" into nothing, which
            // used to surface as a silent no-op or a confusing forEach crash
            if (!geojson || !Array.isArray(geojson.features)) {
                throw new Error('no FeatureCollection found — is this KML or GeoJSON?');
            }
            if (!geojson.features.length) {
                throw new Error('parsed correctly but contains 0 features');
            }

            // Store the GeoJSON data for layer comparison
            const polygonsToMerge = [];
            geojson.features.forEach(feature => {
                polygonsToMerge.push(...GeometryUtils.toTurfPolygons(feature.geometry));
            });

            if (polygonsToMerge.length > 0) {
                console.log(`Merging ${polygonsToMerge.length} custom KML polygons...`);
                let merged = polygonsToMerge[0];
                for (let i = 1; i < polygonsToMerge.length; i++) {
                    try {
                        merged = turf.union(merged, polygonsToMerge[i]);
                    } catch (err) {
                        console.warn(`Warning: Could not merge polygon ${i}`);
                    }
                }
                dashboard.customKmlMergedPolygon = merged;
                console.log('✓ Custom KML polygons merged for comparison');
            }

            // Store parsed GeoJSON for rendering
            dashboard.customKmlData = geojson;

            console.log(`✓ Custom KML loaded: ${geojson.features.length} features`);

            // Automatically enable the overlay
            const customOverlayToggle = dashboard.getEl('custom-kml-overlay');
            if (customOverlayToggle && !customOverlayToggle.checked) {
                customOverlayToggle.checked = true;
                this.toggleCustomKmlOverlay(true);
            } else if (customOverlayToggle?.checked) {
                // If already enabled, refresh the display
                this.toggleCustomKmlOverlay(true);
            }

        } catch (error) {
            console.error('Error parsing custom KML:', error);
            alert(`Failed to parse custom layer: ${error.message}`);
        }
    }

    async toggleCustomKmlOverlay(enabled) {
        const dashboard = this.dashboard;
        if (enabled) {
            if (!dashboard.customKmlData) {
                alert('Please load a custom KML file first.');
                const customOverlayToggle = dashboard.getEl('custom-kml-overlay');
                if (customOverlayToggle) {
                    customOverlayToggle.checked = false;
                }
                return;
            }

            if (!dashboard.customKmlOverlay) {
                dashboard.customKmlOverlay = L.layerGroup().addTo(dashboard.map);
            }

            dashboard.customKmlOverlay.clearLayers();

            // Get colors from UI
            const capturedColor = dashboard.getEl('color-captured')?.value || '#ff0000';
            const greyColor = dashboard.getEl('color-grey')?.value || '#808080';
            const controlledColor = dashboard.getEl('color-controlled')?.value || '#0000ff';

            // Function to determine color based on feature properties
            const getFeatureColor = (feature) => {
                const name = (feature.properties?.name || '').toLowerCase();
                const description = (feature.properties?.description || '').toLowerCase();
                const combined = name + ' ' + description;

                if (combined.includes('captured') || combined.includes('russian') || combined.includes('occupied')) {
                    return capturedColor;
                } else if (combined.includes('grey') || combined.includes('contested') || combined.includes('neutral')) {
                    return greyColor;
                } else if (combined.includes('controlled') || combined.includes('ukrainian') || combined.includes('liberated')) {
                    return controlledColor;
                }

                // Default color
                return capturedColor;
            };

            const eventFilterMode = dashboard.getEl('custom-kml-event-filter')?.value || 'all';
            const eventRadiusM = Number(dashboard.getEl('custom-kml-event-radius')?.value) || 50;
            const renderData = eventFilterMode === 'all'
                ? dashboard.customKmlData
                : {
                    ...dashboard.customKmlData,
                    features: this.filterFeaturesByEventProximity(
                        dashboard.customKmlData.features, eventFilterMode, eventRadiusM)
                };

            L.geoJSON(renderData, {
                style: function (feature) {
                    const color = getFeatureColor(feature);
                    return {
                        color: color,
                        weight: 2,
                        fillColor: color,
                        fillOpacity: 0.3
                    };
                },
                onEachFeature: function (feature, layer) {
                    if (feature.properties) {
                        let tooltipContent = '';
                        if (feature.properties.name) {
                            tooltipContent += `<strong>Name:</strong> ${feature.properties.name}<br>`;
                        }
                        if (feature.properties.description) {
                            tooltipContent += `<strong>Description:</strong> ${feature.properties.description}<br>`;
                        }
                        if (tooltipContent) {
                            layer.bindTooltip(tooltipContent);
                        }
                    }
                }
            }).addTo(dashboard.customKmlOverlay);

            console.log(`✓ Custom KML overlay displayed (${renderData.features.length}/${dashboard.customKmlData.features.length} features)`);
        } else if (dashboard.customKmlOverlay) {
            dashboard.customKmlOverlay.clearLayers();
        }
    }

    /**
     * Keep only custom-layer features that are within (mode 'near') or beyond
     * (mode 'far') radiusM of a currently visible event. Features are tested by
     * their centroid — exact for the Point features this is meant for.
     * Events are bucketed into a grid so the test stays linear-ish on large layers.
     */
    /**
     * Every visible event marker, from all four feeds, as {lat, lon}.
     * Each feed contributes only when its layer toggle is on, and each one's
     * own category/name filters are respected.
     */
    visibleEventPoints() {
        const dashboard = this.dashboard;
        const points = [];
        const push = (list, lonKey) => list.forEach(e => {
            const lat = e.lat, lon = e[lonKey];
            if (lat && lon) points.push({ lat, lon });
        });

        if (dashboard.isChecked('feature-events')) push(dashboard.filteredEventsData(), 'lon');
        if (dashboard.isChecked('feature-ria-events')) push(dashboard.filteredRiaEventsData(), 'lng');
        if (dashboard.isChecked('feature-owl-events')) push(dashboard.filteredOwlEventsData(), 'lng');
        if (dashboard.isChecked('feature-modr')) push(dashboard.modrData || [], 'lng');

        return points;
    }

    filterFeaturesByEventProximity(features, mode, radiusM) {
        const events = this.visibleEventPoints();
        console.log(`Custom layer event filter: ${events.length} event points, radius ${radiusM} m`);
        if (!events.length) return mode === 'near' ? [] : features;

        // Cell ≥ radiusM in both axes anywhere in Ukraine (cos(53°) ≈ 0.6),
        // so a ±1 cell scan always covers the search circle
        const cellLat = radiusM / 111320;
        const cellLon = cellLat / 0.6;
        const key = (gy, gx) => `${gy}|${gx}`;
        const grid = new Map();
        events.forEach(e => {
            const k = key(Math.floor(e.lat / cellLat), Math.floor(e.lon / cellLon));
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(e);
        });

        const isNear = (lat, lon) => {
            const gy = Math.floor(lat / cellLat);
            const gx = Math.floor(lon / cellLon);
            const cosLat = Math.cos(lat * Math.PI / 180);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const bucket = grid.get(key(gy + dy, gx + dx));
                    if (!bucket) continue;
                    for (const e of bucket) {
                        const dLat = (e.lat - lat) * 111320;
                        const dLon = (e.lon - lon) * 111320 * cosLat;
                        if (dLat * dLat + dLon * dLon <= radiusM * radiusM) return true;
                    }
                }
            }
            return false;
        };

        return features.filter(f => {
            if (!f.geometry) return false;
            let lon, lat;
            if (f.geometry.type === 'Point') {
                [lon, lat] = f.geometry.coordinates;
            } else {
                try {
                    [lon, lat] = turf.centroid(f).geometry.coordinates;
                } catch (err) {
                    return false;
                }
            }
            return isNear(lat, lon) === (mode === 'near');
        });
    }

    /**
     * NASA FIRMS fire detections over Ukraine (bbox 22,44,41,53) for the
     * last N days. Requires a free FIRMS MAP_KEY (stored like the Mapbox
     * token). CSV parsed with PapaParse; points rendered on a canvas
     * renderer, colored by fire radiative power.
     */
    async toggleFirmsOverlay(enabled) {
        const dashboard = this.dashboard;
        const status = (msg) => {
            const el = dashboard.getEl('firms-status');
            if (!el) return;
            el.style.display = msg ? 'block' : 'none';
            el.textContent = msg || '';
        };

        if (!enabled) {
            if (dashboard.firmsOverlay) dashboard.firmsOverlay.clearLayers();
            status(null);
            return;
        }

        const key = dashboard.getEl('firms-key')?.value?.trim();
        if (!key) {
            status('Enter a FIRMS map key first');
            const cb = dashboard.getEl('firms-overlay');
            if (cb) cb.checked = false;
            return;
        }
        const selected = dashboard.getEl('firms-source')?.value || 'ALL_VIIRS';
        const sources = selected === 'ALL_VIIRS'
            ? ['VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA21_NRT']
            : [selected];
        const days = parseInt(dashboard.getEl('firms-days')?.value ?? '2', 10);

        status('⏳ Loading fire detections…');
        if (!(this._firmsCache instanceof Map)) this._firmsCache = new Map();

        const loadSource = async (source) => {
            const cacheKey = `${source}/${days}`;
            const cached = this._firmsCache.get(cacheKey);
            if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
                return cached.rows; // NRT data updates slowly — 10-min cache
            }
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/22,44,41,53/${days}`;
            const resp = await fetch(url);
            const text = await resp.text();
            if (!resp.ok) throw new Error(text.slice(0, 120) || `HTTP ${resp.status}`);
            const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
            this._firmsCache.set(cacheKey, { rows, at: Date.now() });
            return rows;
        };

        const results = await Promise.allSettled(sources.map(loadSource));
        const rows = [];
        let failures = 0;
        let firstError = null;
        for (const res of results) {
            if (res.status === 'fulfilled') {
                rows.push(...res.value);
            } else {
                failures++;
                if (!firstError) firstError = res.reason;
                console.error('FIRMS source failed:', res.reason);
            }
        }

        if (failures === sources.length) {
            status(firstError instanceof TypeError
                ? 'FIRMS blocked by CORS — needs a proxy'
                : `FIRMS error: ${firstError?.message ?? 'unknown'}`);
            const cb = dashboard.getEl('firms-overlay');
            if (cb) cb.checked = false;
            return;
        }

        if (!dashboard.firmsOverlay) {
            dashboard.firmsRenderer = L.canvas({ padding: 0.3 }); // thousands of points → canvas
            dashboard.firmsOverlay = L.layerGroup().addTo(dashboard.map);
            dashboard.map.attributionControl.addAttribution('Fires: NASA FIRMS');
        }
        dashboard.firmsOverlay.clearLayers();

        let plotted = 0;
        for (const r of rows) {
            const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            const frp = parseFloat(r.frp) || 0;
            // color by fire radiative power: yellow → orange → red
            const color = frp > 20 ? '#d32f2f' : frp > 5 ? '#f57c00' : '#fbc02d';
            const time = String(r.acq_time ?? '').padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2');
            L.circleMarker([lat, lng], {
                renderer: dashboard.firmsRenderer,
                radius: 4, color, weight: 1, fillColor: color, fillOpacity: 0.7
            }).bindTooltip(
                `<strong>${r.acq_date} ${time} UTC</strong><br>` +
                `${r.satellite || source} | FRP ${frp} MW | conf ${r.confidence}`
            ).addTo(dashboard.firmsOverlay);
            plotted++;
        }
        status(`${plotted.toLocaleString()} detections, last ${days} day${days > 1 ? 's' : ''}` +
            (failures ? ` (${failures} source${failures > 1 ? 's' : ''} failed)` : ''));
    }
}

window.MapLayers = MapLayers;

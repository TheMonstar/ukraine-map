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
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.sourcesManifest = null;
        this.sourcesManifestPromise = null;
    }

    initMap() {
        const dashboard = this.dashboard;

        dashboard.map = L.map('map').setView([49.0, 37.0], 6);

        dashboard.currentTileLayer = L.tileLayer(dashboard.mapStyles['esri-elevation'].url, {
            attribution: dashboard.mapStyles['esri-elevation'].attribution
        }).addTo(dashboard.map);

        dashboard.markers = L.markerClusterGroup({
            maxClusterRadius: 40,
            spiderfyDistanceMultiplier: 1.5,
            spiderfyOnMaxZoom: true,
            zoomToBoundsOnClick: true
        });
        dashboard.map.addLayer(dashboard.markers);

        dashboard.ungroupedMarkers = L.layerGroup();

        dashboard.frontlineLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.clusterLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.deepLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDitchesLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDitchesStartLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureWireLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureDragonLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureMotorLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.featureRailwayLayer = L.layerGroup().addTo(dashboard.map);
        dashboard.eventsLayer = L.layerGroup().addTo(dashboard.map);
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

        dashboard.initPolygonSelection();
    }

    setBaseLayer(style) {
        const dashboard = this.dashboard;
        if (dashboard.currentTileLayer) {
            dashboard.map.removeLayer(dashboard.currentTileLayer);
        }
        let url = dashboard.mapStyles[style].url;
        if (style === 'nasa-gibs' && dashboard.endDate) {
            const d = dashboard.endDate;
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            url = url.replace(/\/\d{4}-\d{2}-\d{2}\//, `/${dateStr}/`);
        }
        dashboard.currentTileLayer = L.tileLayer(url, {
            attribution: dashboard.mapStyles[style].attribution
        }).addTo(dashboard.map);
        dashboard.currentTileLayer.bringToBack();
        if (dashboard.topoTileLayer) dashboard.topoTileLayer.bringToBack();
        dashboard.currentTileLayer.bringToBack();
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

    static elevColor(e, min, max, bw) {
        const t01 = max > min ? Math.max(0, Math.min(1, (e - min) / (max - min))) : 0.5;
        if (bw) {
            const v = Math.round(t01 * 255);
            return [v, v, v];
        }
        const stops = MapLayers.ELEV_STOPS;
        const mapped = stops[0][0] + t01 * (stops[stops.length - 1][0] - stops[0][0]);
        if (mapped <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
        for (let i = 1; i < stops.length; i++) {
            if (mapped <= stops[i][0]) {
                const f = (mapped - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
                return [
                    Math.round(stops[i - 1][1] + f * (stops[i][1] - stops[i - 1][1])),
                    Math.round(stops[i - 1][2] + f * (stops[i][2] - stops[i - 1][2])),
                    Math.round(stops[i - 1][3] + f * (stops[i][3] - stops[i - 1][3]))
                ];
            }
        }
        const last = stops[stops.length - 1];
        return [last[1], last[2], last[3]];
    }

    static _colorTile(tile, min, max, bw) {
        const elevData = tile._elevData;
        if (!elevData) return;
        const w = tile.width, h = tile.height;
        const ctx = tile.getContext('2d');
        const imageData = ctx.createImageData(w, h);
        const d = imageData.data;
        for (let j = 0, i = 0; j < elevData.length; j++, i += 4) {
            const [r, g, b] = MapLayers.elevColor(elevData[j], min, max, bw);
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
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
                    MapLayers._colorTile(tile, range.min, range.max, self.dashboard.isChecked('topo-bw'));
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
        dashboard.map.on('moveend zoomend', this._topoRecolorHandler);
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
        const bw = this.dashboard.isChecked('topo-bw');
        for (const tile of tiles) {
            MapLayers._colorTile(tile, gMin, gMax, bw);
        }
        this._updateElevLegend(gMin, gMax);
    }

    _updateElevLegend(min, max) {
        const div = document.getElementById('elev-legend');
        if (!div) return;
        const bw = this.dashboard.isChecked('topo-bw');
        const steps = 10;
        let rows = '';
        for (let i = steps; i >= 0; i--) {
            const elev = min + (i / steps) * (max - min);
            const [r, g, b] = MapLayers.elevColor(elev, min, max, bw);
            rows += `<div style="display:flex;align-items:center;gap:4px;margin:1px 0;">
                <span style="width:24px;height:14px;display:inline-block;background:rgb(${r},${g},${b});border:1px solid rgba(0,0,0,0.15);"></span>
                <span style="font-size:11px;">${Math.round(elev)} m</span>
            </div>`;
        }
        div.innerHTML = rows;
    }

    clearTopographicOverlay() {
        const dashboard = this.dashboard;
        if (this._topoRecolorHandler) {
            dashboard.map.off('moveend zoomend', this._topoRecolorHandler);
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

        const result = { gains: 0, losses: 0, net: 0 };

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
                }
            } catch (error) {
                console.warn(`${sourceKey} gains calculation failed:`, error);
                if (endFeature) {
                    result.gains = turf.area(endFeature) / 1000000;
                }
            }
        } else if (endFeature) {
            result.gains = turf.area(endFeature) / 1000000;
        }

        // Calculate losses (start - end)
        if (startFeature && endFeature) {
            try {
                const reverseDifference = turf.difference(startFeature, endFeature);
                if (reverseDifference) {
                    result.losses = turf.area(reverseDifference) / 1000000;
                }
            } catch (error) {
                console.warn(`${sourceKey} losses calculation failed:`, error);
            }
        } else if (startFeature) {
            result.losses = turf.area(startFeature) / 1000000;
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

    async loadCustomKml(url) {
        const dashboard = this.dashboard;
        try {
            console.log(`Loading custom layer from: ${url}`);

            // Store the URL for future reference
            dashboard.customKmlUrl = url;

            const response = await fetch(url);

            // Detect if it's GeoJSON or KML based on URL extension or content
            const isGeoJson = url.toLowerCase().endsWith('.geojson') || url.toLowerCase().endsWith('.json');
            const text = await response.text();

            this.processCustomKmlText(text, isGeoJson);
        } catch (error) {
            console.error('Error loading custom KML:', error);
            alert('Failed to load custom KML. Check console for details.');
        }
    }

    async loadCustomKmlFile(file) {
        const dashboard = this.dashboard;
        try {
            console.log(`Loading custom layer from file: ${file.name}`);

            // Local files have no URL; clear any previously stored one
            dashboard.customKmlUrl = '';

            const name = file.name.toLowerCase();
            const isGeoJson = name.endsWith('.geojson') || name.endsWith('.json');
            const text = await file.text();

            this.processCustomKmlText(text, isGeoJson);
        } catch (error) {
            console.error('Error loading custom KML file:', error);
            alert('Failed to load custom KML file. Check console for details.');
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
            alert('Failed to parse custom KML. Check console for details.');
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

            L.geoJSON(dashboard.customKmlData, {
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

            console.log('✓ Custom KML overlay displayed');
        } else if (dashboard.customKmlOverlay) {
            dashboard.customKmlOverlay.clearLayers();
        }
    }
}

window.MapLayers = MapLayers;

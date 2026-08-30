class Settlements {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.filterCache = { key: null, settlements: null };
        this.popupBoundaryLayers = new Map();
        this.popupTitleLayers = new Map();
        this.timelineDataCache = new Map();
        this.timelineResolvedDataCache = new Map();
        this.timelineRenderVersion = 0;
        this.progressHeatRenderVersion = 0;
    }

    toggleSettlementsDisplay() {
        const settlementLegend = this.dashboard.getEl('settlement-legend');
        if (this.dashboard.isChecked('show-settlements')) {
            this.displaySettlements();
            this.buildLegend();
            if (settlementLegend) {
                settlementLegend.style.display = 'block';
            }
        } else {
            this.dashboard.settlementsLayer.clearLayers();
            if (settlementLegend) {
                settlementLegend.style.display = 'none';
            }
        }
    }

    parsePopulation(value) {
        if (!value) return 0;
        return parseInt(String(value).replace(/\D/g, '')) || 0;
    }

    getSettlementStyle(population) {
        // Callers that already parsed pass the number straight through
        const pop = typeof population === 'number' ? population : this.parsePopulation(population);

        if (pop < 1000) {
            return { color: '#4a90e2', radius: 3, label: 'Small village' };
        }
        if (pop < 5000) {
            return { color: '#7ed321', radius: 4, label: 'Village' };
        }
        if (pop < 10000) {
            return { color: '#f5a623', radius: 5, label: 'Large village' };
        }
        if (pop < 25000) {
            return { color: '#d0021b', radius: 6, label: 'Town' };
        }
        if (pop < 100000) {
            return { color: '#9013fe', radius: 7, label: 'Large town' };
        }
        return { color: '#50e3c2', radius: 8, label: 'City' };
    }

    buildLegend() {
        const legendEl = this.dashboard.getEl('settlement-legend');
        if (!legendEl || !this.dashboard.settlementsData?.features) return;

        const brackets = [
            { max: 1000,   color: '#4a90e2', label: '< 1,000',     count: 0 },
            { max: 5000,   color: '#7ed321', label: '1k – 5k',     count: 0 },
            { max: 10000,  color: '#f5a623', label: '5k – 10k',    count: 0 },
            { max: 25000,  color: '#d0021b', label: '10k – 25k',   count: 0 },
            { max: 100000, color: '#9013fe', label: '25k – 100k',  count: 0 },
            { max: Infinity, color: '#50e3c2', label: '≥ 100k',    count: 0 },
        ];

        for (const f of this.dashboard.settlementsData.features) {
            const pop = this.parsePopulation(f.properties.population);
            const bracket = brackets.find(b => pop < b.max);
            if (bracket) bracket.count++;
        }

        const rows = brackets.map(b =>
            `<div class="legend-item">
                <div class="legend-color" style="background:${b.color};"></div>
                <span>${b.label}</span>
                <span style="margin-left:auto;opacity:0.7;font-size:11px;">${b.count.toLocaleString()}</span>
            </div>`
        ).join('');

        legendEl.innerHTML = `<h3 class="panel-title">Settlement Legend</h3><div class="legend-content">${rows}</div>`;
    }

    displaySettlements() {
        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) {
            console.warn('No settlements data available');
            return;
        }

        this.dashboard.settlementsLayer.clearLayers();

        const settlementsToShow = this.getFilteredSettlements();

        settlementsToShow.forEach(settlement => {
            const coords = settlement.geometry.coordinates;
            const population = this.parsePopulation(settlement.properties.population);
            const style = this.getSettlementStyle(population);

            const marker = L.circleMarker([coords[1], coords[0]], {
                radius: style.radius,
                fillColor: style.color,
                color: '#ffffff',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            });

            // Built on open, not up front: eagerly rendering ~1.5 KB of HTML for
            // every one of ~29k settlements cost tens of MB of retained strings.
            marker.bindPopup(() => this._settlementPopupHtml(settlement, style, population));
            this.dashboard.settlementsLayer.addLayer(marker);
        });
    }

    _settlementPopupHtml(settlement, style, population) {
        const coords = settlement.geometry.coordinates;
        const props = settlement.properties;
        const osmId = props.osm_id;
        const escapedName = (props.name || '').replace(/'/g, "\\'");
        const escapedNameEn = (props['name:en'] || '').replace(/'/g, "\\'");
        const displayTitle = escapedNameEn || escapedName;
        let popupContent = `
            <div class="settlement-popup">
                <div class="settlement-name">${props['name:en'] || props.name || 'Unknown'}</div>
                ${props.name ? `<div class="settlement-info">UA: ${props.name}</div>` : ''}
                ${props.place ? `<div class="settlement-info">Type: ${props.place}</div>` : ''}
                <div class="settlement-info">Category: ${style.label}</div>
                ${props.population ? `<div class="settlement-info">Population: ${population.toLocaleString()}</div>` : ''}
                <div class="settlement-info">Coordinates: ${coords[1].toFixed(6)}, ${coords[0].toFixed(6)}</div>
                ${this._settlementTimelinePopupHtml(settlement)}
                <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #ddd;">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin-bottom:4px;">
                        <input type="checkbox" ${this.popupTitleLayers.has(osmId) ? 'checked' : ''}
                            onchange="window.dashboard.settlements.togglePopupTitle(this, '${osmId}', ${coords[1]}, ${coords[0]}, '${displayTitle}')">
                        Show title on map
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
                        <input type="checkbox" ${this.popupBoundaryLayers.has(osmId) ? 'checked' : ''}
                            onchange="window.dashboard.settlements.togglePopupBoundary(this, '${osmId}', '${props.osm_type}')">
                        Highlight boundary
                        <input type="color" value="${this.popupBoundaryLayers.get(osmId)?.options?.color || '#ff6600'}"
                            style="width:28px;height:20px;padding:0;border:1px solid #ccc;cursor:pointer;border-radius:3px;"
                            onchange="window.dashboard.settlements.updatePopupBoundaryColor('${osmId}', this.value)">
                    </label>
                </div>
                <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #ddd;">
                    ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                    <button
                        onclick="window.markerAdjuster && window.markerAdjuster.pickSettlementLocation(${coords[1]}, ${coords[0]}, '${escapedName}', '${escapedNameEn}')"
                        style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%; margin-top: 5px;"
                    >
                        Pick Location
                    </button>
                </div>
            </div>
        `;

        return popupContent;
    }

    filterSettlementsByRadius() {
        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) {
            return;
        }

        const clusterRadius = parseInt(this.dashboard.getEl('clusterRadius')?.value, 10) || 20;

        this.dashboard.filteredSettlements = this.dashboard.settlementsData.features.filter(settlement => {
            const population = this.parsePopulation(settlement.properties.population);
            return population >= clusterRadius;
        });

        if (this.dashboard.isChecked('show-settlements')) {
            this.displaySettlements();
        }
    }

    getFilteredSettlements() {
        const key = this.getFilterKey();
        if (this.filterCache.key === key && this.filterCache.settlements) {
            return this.filterCache.settlements;
        }

        let settlementsToShow = this.dashboard.isChecked('filter-settlements-radius')
            ? this.dashboard.filteredSettlements
            : this.dashboard.settlementsData.features;

        const searchInRegionsOnly = this.dashboard.isChecked('search-in-regions');
        if (searchInRegionsOnly && this.dashboard.selectRegions.length > 0) {
            settlementsToShow = settlementsToShow.filter(settlement =>
                this.dashboard.isSettlementInSelectedRegions(settlement.geometry.coordinates)
            );
        }

        const searchInPredefinedRegionOnly = this.dashboard.isChecked('search-in-predefined-region');
        if (searchInPredefinedRegionOnly && this.dashboard.currentPredefinedRegion) {
            settlementsToShow = settlementsToShow.filter(settlement =>
                this.dashboard.isSettlementInPredefinedRegion(settlement.geometry.coordinates, this.dashboard.currentPredefinedRegion)
            );
        }

        const searchInPolygonsOnly = this.dashboard.isChecked('search-in-polygons');
        if (searchInPolygonsOnly && this.dashboard.selectedPolygons.length > 0) {
            settlementsToShow = settlementsToShow.filter(settlement =>
                this.dashboard.isSettlementInSelectedPolygons(settlement.geometry.coordinates)
            );
        }

        this.filterCache = { key, settlements: settlementsToShow };
        return settlementsToShow;
    }

    getFilterKey() {
        const regionKey = this.dashboard.selectRegions.slice().sort().join('|');
        const predefined = this.dashboard.currentPredefinedRegion || '';
        const searchInRegionsOnly = this.dashboard.isChecked('search-in-regions');
        const searchInPredefinedRegionOnly = this.dashboard.isChecked('search-in-predefined-region');
        const searchInPolygonsOnly = this.dashboard.isChecked('search-in-polygons');
        const radiusFilter = this.dashboard.isChecked('filter-settlements-radius');
        const radiusValue = this.dashboard.getEl('clusterRadius')?.value || '';
        const dataLen = this.dashboard.settlementsData?.features?.length || 0;

        return [
            regionKey,
            predefined,
            searchInRegionsOnly ? 'r1' : 'r0',
            searchInPredefinedRegionOnly ? 'p1' : 'p0',
            searchInPolygonsOnly ? 's1' : 's0',
            `rv:${radiusFilter ? radiusValue : 'off'}`,
            `pv:${this.dashboard.polygonVersion}`,
            `sv:${this.dashboard.regionSelectionVersion}`,
            `dl:${dataLen}`
        ].join('|');
    }

    toggleSettlementBoundaries() {
        if (this.dashboard.isChecked('settlements-border')) {
            this.renderSettlementBoundaries();
        } else {
            this.dashboard.settlementBordersLayer.clearLayers();
            this.dashboard.renderedBoundaries.clear();
        }
    }

    showBoundariesLoader() {
        const loader = this.dashboard.getEl('settlement-boundaries-loader');
        if (loader) {
            loader.classList.add('active');
            this.updateBoundariesLoader(0, 'Starting...');
        }
    }

    updateBoundariesLoader(percentage, text) {
        const progressBar = this.dashboard.getEl('boundaries-progress-bar');
        const loaderText = this.dashboard.getEl('boundaries-loader-text');

        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
            progressBar.textContent = `${percentage}%`;
        }

        if (loaderText && text) {
            loaderText.textContent = text;
        }
    }

    hideBoundariesLoader() {
        const loader = this.dashboard.getEl('settlement-boundaries-loader');
        if (loader) {
            setTimeout(() => {
                loader.classList.remove('active');
            }, 500);
        }
    }

    async fetchSettlementBoundary(osm_id, osm_type) {
        const cacheKey = `${osm_type}_${osm_id}`;
        if (this.dashboard.settlementBoundariesCache.has(cacheKey)) {
            return this.dashboard.settlementBoundariesCache.get(cacheKey);
        }

        const boundariesData = await this.dashboard.loadSettlementBoundariesData();
        if (boundariesData && boundariesData[cacheKey]) {
            const offlineData = boundariesData[cacheKey];
            if (offlineData && offlineData.boundary) {
                this.dashboard.settlementBoundariesCache.set(cacheKey, offlineData.boundary);
                return offlineData.boundary;
            }
        }

        try {
            const nodeType = osm_type === 'nodes' ? 'N' : (osm_type === 'ways' ? 'W' : 'R');
            const nodeDetailsUrl = `https://nominatim.openstreetmap.org/details?osmtype=${nodeType}&osmid=${osm_id}&addressdetails=1&entrances=1&hierarchy=0&group_hierarchy=1&format=json`;

            console.log(`Fetching node details for ${cacheKey}:`, nodeDetailsUrl);
            const nodeResponse = await fetch(nodeDetailsUrl);

            if (!nodeResponse.ok) {
                console.warn(`Failed to fetch node details for ${cacheKey}`);
                return null;
            }

            const nodeData = await nodeResponse.json();

            let relation = null;

            if (nodeData.address && Array.isArray(nodeData.address)) {
                relation = nodeData.address.find(el =>
                    el.rank_address === 16 && (el.osm_type === "R" || el.osm_type === "W")
                );
            }

            if (!relation) {
                console.log(`No relation found for ${cacheKey}`);
                this.dashboard.settlementBoundariesCache.set(cacheKey, null);
                return null;
            }

            const relationUrl = `https://nominatim.openstreetmap.org/details?osmtype=${relation.osm_type}&osmid=${relation.osm_id}&polygon_geojson=1&format=json`;

            console.log(`Fetching relation geometry for ${cacheKey}:`, relationUrl);
            const relationResponse = await fetch(relationUrl);

            if (!relationResponse.ok) {
                console.warn(`Failed to fetch relation geometry for ${cacheKey}`);
                return null;
            }

            const relationData = await relationResponse.json();

            if (relationData.geometry && relationData.geometry.coordinates) {
                const result = {
                    type: relationData.geometry.type,
                    coordinates: relationData.geometry.coordinates
                };

                this.dashboard.settlementBoundariesCache.set(cacheKey, result);
                return result;
            }

            console.log(`No geometry found for ${cacheKey}`);
            this.dashboard.settlementBoundariesCache.set(cacheKey, null);
            return null;

        } catch (error) {
            console.error(`Error fetching settlement boundary for ${cacheKey}:`, error);
            return null;
        }
    }

    async renderSettlementBoundaries() {
        const currentZoom = this.dashboard.map.getZoom();
        if (currentZoom < 10) {
            console.log('Zoom level too low for settlement boundaries');
            this.dashboard.settlementBordersLayer.clearLayers();
            this.dashboard.renderedBoundaries.clear();
            return;
        }

        const bounds = this.dashboard.map.getBounds();

        let visibleSettlements = [];

        if (this.dashboard.isChecked('show-settlements')) {
            const settlementsToShow = this.getFilteredSettlements();

            visibleSettlements = settlementsToShow.filter(settlement => {
                const coords = settlement.geometry.coordinates;
                const latLng = L.latLng(coords[1], coords[0]);
                return bounds.contains(latLng);
            });
        } else {
            let source = this.dashboard.settlementsData.features;
            if (this.dashboard.isChecked('filter-settlements-radius')) {
                const clusterRadius = parseInt(this.dashboard.getEl('clusterRadius')?.value, 10) || 20;
                source = source.filter(s => this.parsePopulation(s.properties.population) >= clusterRadius);
            }
            visibleSettlements = source.filter(settlement => {
                const coords = settlement.geometry.coordinates;
                const latLng = L.latLng(coords[1], coords[0]);
                return bounds.contains(latLng);
            });
        }

        const newSettlements = visibleSettlements.filter(settlement => {
            const key = `${settlement.properties.osm_type}_${settlement.properties.osm_id}`;
            return !this.dashboard.renderedBoundaries.has(key);
        });

        console.log(`Total visible: ${visibleSettlements.length}, Already rendered: ${visibleSettlements.length - newSettlements.length}, New: ${newSettlements.length}`);

        if (newSettlements.length === 0) {
            console.log('No new boundaries to render');
            return;
        }

        this.showBoundariesLoader();

        const MAX_CONCURRENT = 3;
        let processed = 0;

        for (let i = 0; i < newSettlements.length; i += MAX_CONCURRENT) {
            const batch = newSettlements.slice(i, i + MAX_CONCURRENT);

            const results = await Promise.all(
                batch.map(settlement =>
                    this.fetchSettlementBoundary(settlement.properties.osm_id, settlement.properties.osm_type)
                )
            );

            results.forEach((geometry, idx) => {
                const settlement = batch[idx];
                const props = settlement.properties;
                const key = `${props.osm_type}_${props.osm_id}`;

                if (geometry && geometry.coordinates) {
                    try {
                        let polygonLayer;

                        if (geometry.type === 'Polygon') {
                            const coords = geometry.coordinates[0].map(coord => [coord[1], coord[0]]);
                            polygonLayer = L.polygon(coords, {
                                color: '#5f5151',
                                weight: 2,
                                fillOpacity: 0.1,
                                fillColor: '#5f5151'
                            });
                        } else if (geometry.type === 'MultiPolygon') {
                            const allCoords = geometry.coordinates.map(polygon =>
                                polygon[0].map(coord => [coord[1], coord[0]])
                            );
                            polygonLayer = L.polygon(allCoords, {
                                color: '#5f5151',
                                weight: 2,
                                fillOpacity: 0.1,
                                fillColor: '#5f5151'
                            });
                        }

                        if (polygonLayer) {
                            const settlementLat = settlement.geometry.coordinates[1];
                            const settlementLng = settlement.geometry.coordinates[0];
                            const popupContent = `
                                <div class="settlement-popup">
                                    <div class="settlement-name">${props.name || 'Unknown'}</div>
                                    ${props['name:en'] ? `<div class="settlement-info">English: ${props['name:en']}</div>` : ''}
                                    ${props.place ? `<div class="settlement-info">Type: ${props.place}</div>` : ''}
                                    ${props.population ? `<div class="settlement-info">Population: ${props.population.toLocaleString()}</div>` : ''}
                                    <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd;">
                                        ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                        <button
                                            onclick="window.markerAdjuster && window.markerAdjuster.pickSettlementLocation(${settlementLat}, ${settlementLng}, '${(props.name || '').replace(/'/g, "\\'")}', '${(props['name:en'] || '').replace(/'/g, "\\'")}')"
                                            style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%; margin-top: 5px;"
                                        >
                                            Pick Location
                                        </button>
                                    </div>
                                </div>
                            `;

                            polygonLayer.bindPopup(popupContent);
                            this.dashboard.settlementBordersLayer.addLayer(polygonLayer);

                            this.dashboard.renderedBoundaries.add(key);
                        }
                    } catch (error) {
                        console.error('Error creating polygon for settlement:', props.name, error);
                    }
                }
            });

            processed += batch.length;
            const progress = Math.round((processed / newSettlements.length) * 100);

            this.updateBoundariesLoader(progress, `Processed ${processed}/${newSettlements.length} settlements`);
            console.log(`Processed ${processed}/${newSettlements.length} settlements`);

            if (i + MAX_CONCURRENT < newSettlements.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        this.hideBoundariesLoader();
        console.log('Settlement boundaries rendering complete');
    }

    togglePopupTitle(checkbox, osmId, lat, lng, name) {
        if (checkbox.checked) {
            const label = L.marker([lat, lng], {
                icon: this._makeLabelIcon(name),
                interactive: false
            });
            label.addTo(this.dashboard.settlementNamesLayer);
            this.popupTitleLayers.set(osmId, label);
        } else {
            const layer = this.popupTitleLayers.get(osmId);
            if (layer) {
                this.dashboard.settlementNamesLayer.removeLayer(layer);
                this.popupTitleLayers.delete(osmId);
            }
        }
    }

    async togglePopupBoundary(checkbox, osmId, osmType = 'nodes') {
        if (checkbox.checked) {
            const color = checkbox.closest('label').querySelector('input[type=color]')?.value || '#ff6600';
            let geometry = await this.fetchSettlementBoundary(osmId, osmType);
            if (!geometry?.coordinates?.length) {
                checkbox.checked = false;
                return;
            }
            this._renderPopupBoundary(osmId, geometry, color);
        } else {
            const layer = this.popupBoundaryLayers.get(osmId);
            if (layer) {
                this.dashboard.settlementPopupBoundariesLayer.removeLayer(layer);
                this.popupBoundaryLayers.delete(osmId);
            }
        }
    }

    _renderPopupBoundary(osmId, geometry, color) {
        const existing = this.popupBoundaryLayers.get(osmId);
        if (existing) {
            this.dashboard.settlementPopupBoundariesLayer.removeLayer(existing);
        }
        let polygonLayer;
        try {
            if (geometry.type === 'Polygon') {
                const coords = geometry.coordinates[0].map(c => [c[1], c[0]]);
                polygonLayer = L.polygon(coords, { color, weight: 2, fillOpacity: 0.15, fillColor: color });
            } else if (geometry.type === 'MultiPolygon') {
                const allCoords = geometry.coordinates.map(p => p[0].map(c => [c[1], c[0]]));
                polygonLayer = L.polygon(allCoords, { color, weight: 2, fillOpacity: 0.15, fillColor: color });
            }
        } catch (e) {
            console.error('Error rendering popup boundary', e);
        }
        if (polygonLayer) {
            polygonLayer.addTo(this.dashboard.settlementPopupBoundariesLayer);
            this.popupBoundaryLayers.set(osmId, polygonLayer);
        }
    }

    updatePopupBoundaryColor(osmId, color) {
        const layer = this.popupBoundaryLayers.get(osmId);
        if (layer) {
            layer.setStyle({ color, fillColor: color });
        }
    }

    clearManualLayers() {
        this.dashboard.settlementPopupBoundariesLayer.clearLayers();
        this.popupBoundaryLayers.clear();
        this.dashboard.settlementNamesLayer.clearLayers();
        this.popupTitleLayers.clear();
    }

    toggleLocalBoundaries() {
        if (this.dashboard.isChecked('show-settlement-boundaries')) {
            this.renderLocalBoundaries();
        } else {
            this.dashboard.settlementLocalBoundariesLayer.clearLayers();
        }
    }

    async renderLocalBoundaries() {
        const data = await this.dashboard.loadSettlementBoundariesData();
        if (!data) return;

        // The checkbox may have been switched back off during the download
        if (!this.dashboard.isChecked('show-settlement-boundaries')) return;

        const minPop = this._getLocalBoundaryMinPop();

        this.dashboard.settlementLocalBoundariesLayer.clearLayers();

        const color = this.dashboard.getEl('settlement-boundary-color')?.value || '#ff6600';

        let count = 0;
        for (const [key, entry] of Object.entries(data)) {
            if (!entry?.boundary?.coordinates?.length) continue;
            const pop = this.parsePopulation(entry.population);
            if (pop < minPop) continue;

            try {
                const { type, coordinates } = entry.boundary;
                let layer;
                if (type === 'Polygon') {
                    layer = L.polygon(coordinates[0].map(c => [c[1], c[0]]), { color, weight: 2, fillOpacity: 0.15, fillColor: color });
                } else if (type === 'MultiPolygon') {
                    layer = L.polygon(coordinates.map(p => p[0].map(c => [c[1], c[0]])), { color, weight: 2, fillOpacity: 0.15, fillColor: color });
                }
                if (layer) layer.addTo(this.dashboard.settlementLocalBoundariesLayer);
                count++;
            } catch (e) { /* skip invalid geometry */ }
        }
        console.log(`Rendered ${count} local boundaries (min pop: ${minPop})`);
    }

    toggleSettlementNames() {
        if (this.dashboard.isChecked('show-settlement-names')) {
            if (this.dashboard.getEl('show-settlement-timeline')?.value) {
                this.dashboard.settlementNamesLayer.clearLayers();
                this.popupTitleLayers.clear();
                this.renderSettlementTimeline();
            } else {
                this.renderSettlementNames();
            }
        } else {
            this.dashboard.settlementNamesLayer.clearLayers();
            this.popupTitleLayers.clear();
            if (this.dashboard.getEl('show-settlement-timeline')?.value) {
                this.renderSettlementTimeline();
            }
        }
    }

    /**
     * Settlement name label. Dark text with a white halo so it reads on both light
     * basemaps and satellite imagery — plain white text was near-invisible on Carto.
     * Size tier follows population, matching the bands in getSettlementStyle().
     */
    _makeLabelIcon(name, pop = 0) {
        const tier = pop >= 50000 ? 'tier-city'
                   : pop >= 10000 ? 'tier-town'
                   : 'tier-village';
        return L.divIcon({
            className: '',
            html: `<div class="settlement-label ${tier}">${name}</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });
    }

    renderSettlementNames() {
        this.dashboard.settlementNamesLayer.clearLayers();
        this.popupTitleLayers.clear();

        if (!this.dashboard.settlementsData?.features) return;

        const minPop = this._getLocalBoundaryMinPop();

        for (const feature of this.dashboard.settlementsData.features) {
            const props = feature.properties;
            const pop = this.parsePopulation(props.population);
            if (pop < minPop) continue;

            const [lng, lat] = feature.geometry.coordinates;
            const name = props['name:en'] || props.name || '';
            const osmId = props.osm_id;

            const label = L.marker([lat, lng], {
                icon: this._makeLabelIcon(name, pop),
                interactive: false
            });
            label.addTo(this.dashboard.settlementNamesLayer);
            this.popupTitleLayers.set(osmId, label);
        }
    }

    _getLocalBoundaryMinPop() {
        const slider = this.dashboard.getEl('settlement-label-pop-slider');
        return Math.max(10000, parseInt(slider?.value) || 10000);
    }

    handleSettlementSearch(searchTerm) {
        const resultsContainer = this.dashboard.getEl('settlement-search-results');
        if (!resultsContainer) {
            return;
        }

        if (!searchTerm.trim() || searchTerm.length < 2) {
            resultsContainer.style.display = 'none';
            return;
        }

        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) {
            resultsContainer.innerHTML = '<div class="settlement-result-item">No settlements data available</div>';
            resultsContainer.style.display = 'block';
            return;
        }

        const searchInRegionsOnly = this.dashboard.isChecked('search-in-regions');
        const searchInPredefinedRegionOnly = this.dashboard.isChecked('search-in-predefined-region');
        const searchInPolygonsOnly = this.dashboard.isChecked('search-in-polygons');

        let searchResults = this.dashboard.settlementsData.features.filter(settlement => {
            const props = settlement.properties;
            const localName = (props.name || '').toLowerCase();
            const englishName = (props['name:en'] || '').toLowerCase();
            const searchLower = searchTerm.toLowerCase();

            const nameMatch = localName.includes(searchLower) || englishName.includes(searchLower);

            if (!nameMatch) return false;

            if (searchInRegionsOnly && !this.dashboard.isSettlementInSelectedRegions(settlement.geometry.coordinates)) {
                return false;
            }

            if (searchInPredefinedRegionOnly && this.dashboard.currentPredefinedRegion) {
                if (!this.dashboard.isSettlementInPredefinedRegion(settlement.geometry.coordinates, this.dashboard.currentPredefinedRegion)) {
                    return false;
                }
            }

            if (searchInPolygonsOnly && this.dashboard.selectedPolygons.length > 0) {
                return this.dashboard.isSettlementInSelectedPolygons(settlement.geometry.coordinates);
            }

            return true;
        });

        if ((searchInRegionsOnly && this.dashboard.selectRegions.length > 0) ||
            (searchInPredefinedRegionOnly && this.dashboard.currentPredefinedRegion) ||
            (searchInPolygonsOnly && this.dashboard.selectedPolygons.length > 0)) {
            searchResults = searchResults.map(settlement => {
                const coords = settlement.geometry.coordinates;
                let inRegion = 'Unknown region';

                if (searchInPolygonsOnly && this.dashboard.selectedPolygons.length > 0) {
                    if (this.dashboard.isSettlementInSelectedPolygons(coords)) {
                        inRegion = `Selected Polygon (${this.dashboard.selectedPolygons.length} polygon${this.dashboard.selectedPolygons.length > 1 ? 's' : ''})`;
                    }
                } else if (searchInPredefinedRegionOnly && this.dashboard.currentPredefinedRegion) {
                    if (this.dashboard.isSettlementInPredefinedRegion(coords, this.dashboard.currentPredefinedRegion)) {
                        inRegion = this.dashboard.currentPredefinedRegion;
                    }
                } else if (searchInRegionsOnly && this.dashboard.selectRegions.length > 0) {
                    for (const regionName of this.dashboard.selectRegions) {
                        if (this.dashboard.regionPolygons[regionName]) {
                            try {
                                const polygon = this.dashboard.regionPolygonCache.get(regionName);
                                if (!polygon) {
                                    continue;
                                }
                                const point = turf.point([coords[0], coords[1]]);
                                if (turf.booleanPointInPolygon(point, polygon)) {
                                    inRegion = regionName;
                                    break;
                                }
                            } catch (error) {
                                // Continue to next region
                            }
                        }
                    }
                }

                return { ...settlement, regionContext: inRegion };
            });
        }

        searchResults = searchResults.slice(0, 10);

        if (searchResults.length === 0) {
            let noResultsMsg = 'No settlements found';

            if (searchInPolygonsOnly && this.dashboard.selectedPolygons.length > 0) {
                noResultsMsg = `No settlements found in ${this.dashboard.selectedPolygons.length} selected polygon${this.dashboard.selectedPolygons.length > 1 ? 's' : ''}`;
            } else if (searchInPredefinedRegionOnly && this.dashboard.currentPredefinedRegion) {
                noResultsMsg = `No settlements found in predefined region: ${this.dashboard.currentPredefinedRegion}`;
            } else if (searchInRegionsOnly && this.dashboard.selectRegions.length > 0) {
                noResultsMsg = `No settlements found in selected regions: ${this.dashboard.selectRegions.join(', ')}`;
            }

            resultsContainer.innerHTML = `<div class="settlement-result-item">${noResultsMsg}</div>`;
            resultsContainer.style.display = 'block';
            return;
        }

        resultsContainer.innerHTML = '';
        searchResults.forEach(settlementData => {
            const settlement = settlementData.properties ? settlementData : settlementData;
            const props = settlement.properties || settlementData.properties;
            const coords = settlement.geometry ? settlement.geometry.coordinates : settlementData.geometry.coordinates;
            const regionContext = settlementData.regionContext;

            const resultItem = document.createElement('div');
            resultItem.className = 'settlement-result-item';

            let regionInfo = '';
            if ((searchInRegionsOnly || searchInPredefinedRegionOnly || searchInPolygonsOnly) && regionContext) {
                const label = regionContext.includes('Polygon') ? 'Area' : 'Region';
                regionInfo = ` • ${label}: ${regionContext}`;
            }

            resultItem.innerHTML = `
                <div class="settlement-name">${props.name || 'Unknown'}</div>
                <div class="settlement-info">
                    ${props['name:en'] ? `${props['name:en']} • ` : ''}
                    ${props.place || 'Settlement'} •
                    Pop: ${props.population || 'Unknown'}${regionInfo}
                </div>
            `;

            resultItem.addEventListener('click', () => {
                this.dashboard.map.setView([coords[1], coords[0]], 14);

                if (!this.dashboard.isChecked('show-settlements')) {
                    const showSettlements = this.dashboard.getEl('show-settlements');
                    if (showSettlements) {
                        showSettlements.checked = true;
                    }
                    this.displaySettlements();
                }

                this.dashboard.settlementsLayer.eachLayer(layer => {
                    if (layer.getLatLng().lat === coords[1] && layer.getLatLng().lng === coords[0]) {
                        layer.openPopup();
                    }
                });

                resultsContainer.style.display = 'none';
                const settlementSearch = this.dashboard.getEl('settlement-search');
                if (settlementSearch) {
                    settlementSearch.value = props.name || props['name:en'] || '';
                }
            });

            resultsContainer.appendChild(resultItem);
        });

        resultsContainer.style.display = 'block';
    }

    _isTimelineDate(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            Number.isFinite(Date.parse(`${value}T00:00:00Z`));
    }

    _normalizeDeepStateTimeline(data) {
        if (!data || !Array.isArray(data.settlements)) {
            throw new Error('DeepState timeline has an invalid settlements array');
        }

        const episodes = [];
        data.settlements.forEach((settlement, settlementIndex) => {
            const coordinates = settlement?.coordinates;
            if (!Array.isArray(coordinates) || coordinates.length < 2 ||
                !coordinates.every(Number.isFinite) || !Array.isArray(settlement.events)) return;

            const events = settlement.events
                .filter(event => this._isTimelineDate(event?.date) && typeof event.status === 'string')
                .slice()
                .sort((left, right) => left.date.localeCompare(right.date));
            const capturedDates = new Set();
            const settlementId = `deepstate:${settlement.settlementId || settlementIndex}`;
            const localName = settlement.name_uk || settlement.name || '';
            const englishName = settlement.name_en || settlement.name || '';
            const currentStateSince = events[events.length - 1]?.date || null;

            events.forEach((event, index) => {
                if (event.status !== 'contested' && event.status !== 'infiltration') return;
                const next = events[index + 1] || null;
                const capturedAt = next?.status === 'occupied' ? next.date : null;
                if (capturedAt) capturedDates.add(capturedAt);
                episodes.push({
                    id: `deepstate:${settlementIndex}:${event.date}`,
                    settlementId,
                    sourceSettlementId: settlement.settlementId || null,
                    source: 'DeepState',
                    name: localName,
                    nameEn: englishName,
                    population: null,
                    coordinates: coordinates.slice(0, 2),
                    infiltratedAt: event.date,
                    contestedFrom: event.date,
                    contestedTo: next?.date || null,
                    capturedAt,
                    currentState: settlement.currentStatus || next?.status || 'contested',
                    currentStateSince,
                    endState: next?.status || settlement.currentStatus || 'contested',
                    startPercent: Number.isFinite(event.occupiedPercent) ? event.occupiedPercent : null,
                    endPercent: Number.isFinite(next?.occupiedPercent) ? next.occupiedPercent : null
                });
            });

            // A settlement may jump straight from controlled to occupied without a
            // contested transition. Preserve that capture as a standalone episode.
            events.forEach((event, index) => {
                if (event.status !== 'occupied' || capturedDates.has(event.date)) return;
                episodes.push({
                    id: `deepstate:${settlementIndex}:capture:${event.date}`,
                    settlementId,
                    sourceSettlementId: settlement.settlementId || null,
                    source: 'DeepState',
                    name: localName,
                    nameEn: englishName,
                    population: null,
                    coordinates: coordinates.slice(0, 2),
                    infiltratedAt: null,
                    contestedFrom: null,
                    contestedTo: null,
                    capturedAt: event.date,
                    currentState: settlement.currentStatus || 'occupied',
                    currentStateSince,
                    endState: 'occupied',
                    startPercent: null,
                    endPercent: Number.isFinite(event.occupiedPercent) ? event.occupiedPercent : null,
                    previousStatus: events[index - 1]?.status || event.previousStatus || null
                });
            });
        });
        return episodes;
    }

    _normalizeRiaTimeline(data) {
        if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
            throw new Error('RIA timeline is not a valid FeatureCollection');
        }

        return data.features.flatMap((feature, index) => {
            const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
            const props = feature?.properties || {};
            if (!Array.isArray(coordinates) || coordinates.length < 2 ||
                !coordinates.every(Number.isFinite) || !this._isTimelineDate(props.started)) return [];

            return [{
                id: `ria:${props.settlement_id || index}:${props.started}`,
                settlementId: `ria:${props.settlement_id || index}`,
                sourceSettlementId: props.settlement_id || null,
                source: 'RIA',
                name: props.name || '',
                nameEn: props.name_en || '',
                population: Number.isFinite(props.population) ? props.population : null,
                coordinates: coordinates.slice(0, 2),
                infiltratedAt: props.started,
                contestedFrom: props.started,
                contestedTo: this._isTimelineDate(props.ended) ? props.ended : null,
                capturedAt: this._isTimelineDate(props.ended) ? props.ended : null,
                currentState: this._isTimelineDate(props.ended) ? 'occupied' : 'contested',
                currentStateSince: this._isTimelineDate(props.ended) ? props.ended : props.started,
                endState: this._isTimelineDate(props.ended) ? 'occupied' : 'contested',
                startPercent: Number.isFinite(props.start_coverage_percent) ? props.start_coverage_percent : null,
                endPercent: Number.isFinite(props.end_coverage_percent) ? props.end_coverage_percent : null,
                durationDays: Number.isFinite(props.duration_days) ? props.duration_days : null
            }];
        });
    }

    loadSettlementTimeline(source) {
        if (this.timelineDataCache.has(source)) return this.timelineDataCache.get(source);

        const config = {
            deepstate: {
                url: `${APP_STATIC_URL}/settlement-status-timeline.json`,
                normalize: data => this._normalizeDeepStateTimeline(data)
            },
            ria: {
                url: `${APP_STATIC_URL}/ria-settlement-fights.geojson`,
                normalize: data => this._normalizeRiaTimeline(data)
            }
        }[source];
        if (!config) return Promise.reject(new Error(`Unknown settlement timeline source: ${source}`));

        const request = fetch(config.url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(data => {
                const normalized = config.normalize(data);
                this.timelineResolvedDataCache.set(source, normalized);
                return normalized;
            })
            .catch(error => {
                this.timelineDataCache.delete(source);
                this.timelineResolvedDataCache.delete(source);
                throw error;
            });
        this.timelineDataCache.set(source, request);
        return request;
    }

    _escapeTimelineHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    _timelineDurationDays(from, to) {
        if (!this._isTimelineDate(from)) return null;
        const end = this._isTimelineDate(to) ? to : new Date().toISOString().slice(0, 10);
        return Math.max(0, Math.round(
            (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
        ));
    }

    _timelineEpisodesForSettlement(settlement, source) {
        const episodes = this.timelineResolvedDataCache.get(source);
        if (!episodes) return null;

        const props = settlement?.properties || {};
        const osmId = props.osm_id == null ? '' : String(props.osm_id);
        const osmType = String(props.osm_type || '').toLowerCase();
        const candidates = new Set([osmId]);
        if (osmId && osmType) {
            candidates.add(`${osmType}_${osmId}`);
            candidates.add(`${osmType.endsWith('s') ? osmType : `${osmType}s`}_${osmId}`);
        }

        let matches = osmId
            ? episodes.filter(episode => candidates.has(String(episode.sourceSettlementId || '')))
            : [];
        if (matches.length) return matches;

        const coordinates = settlement?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
        matches = episodes.filter(episode =>
            Math.abs(episode.coordinates[0] - coordinates[0]) <= 0.0001 &&
            Math.abs(episode.coordinates[1] - coordinates[1]) <= 0.0001
        );
        return matches;
    }

    _settlementTimelinePopupHtml(settlement) {
        const source = this.dashboard.getEl('show-settlement-timeline')?.value || '';
        if (!source) return '';

        const episodes = this._timelineEpisodesForSettlement(settlement, source);
        if (episodes === null) {
            return `<div class="settlement-timeline-popup"><strong>Timeline</strong><div>Loading…</div></div>`;
        }
        if (!episodes.length) return '';

        const sorted = episodes.slice().sort((left, right) => {
            const leftDate = left.contestedFrom || left.capturedAt || '';
            const rightDate = right.contestedFrom || right.capturedAt || '';
            return leftDate.localeCompare(rightDate);
        });
        const rows = sorted.map(episode => {
            const parts = [];
            if (episode.infiltratedAt) parts.push(`Infiltrated ${episode.infiltratedAt}`);
            if (episode.contestedFrom) {
                const duration = Number.isFinite(episode.durationDays)
                    ? episode.durationDays
                    : this._timelineDurationDays(episode.contestedFrom, episode.contestedTo);
                let contested = `Contested ${episode.contestedFrom} → ${episode.contestedTo || 'Ongoing'}`;
                if (duration !== null) contested += ` (${duration} day${duration === 1 ? '' : 's'})`;
                parts.push(contested);
            }
            if (episode.capturedAt) parts.push(`Captured ${episode.capturedAt}`);

            const percentages = [];
            if (episode.startPercent !== null) percentages.push(`start ${episode.startPercent}%`);
            if (episode.endPercent !== null) percentages.push(`end ${episode.endPercent}%`);
            return `<div class="settlement-timeline-popup-event">` +
                `${parts.map(part => `<div>${this._escapeTimelineHtml(part)}</div>`).join('')}` +
                `${percentages.length ? `<small>${this._escapeTimelineHtml(percentages.join(', '))}</small>` : ''}` +
                `</div>`;
        }).join('');
        const sourceLabel = source === 'ria' ? 'RIA' : 'DeepState';

        return `<div class="settlement-timeline-popup">` +
            `<strong>${sourceLabel} timeline</strong>${rows}</div>`;
    }

    _timelineTooltip(group, status) {
        const first = group.episodes[0];
        const name = this._escapeTimelineHtml(first.nameEn || first.name || 'Unknown settlement');
        const localName = first.name && first.name !== first.nameEn
            ? `<div class="timeline-tooltip-local-name">${this._escapeTimelineHtml(first.name)}</div>` : '';
        const population = Number.isFinite(first.population)
            ? `<span>${first.population.toLocaleString()} people</span>` : '';
        const sourceClass = first.source === 'RIA' ? 'ria' : 'deepstate';
        const rows = group.episodes.map((episode, index) => {
            const started = episode.contestedFrom || episode.infiltratedAt || episode.capturedAt;
            const startedLabel = episode.contestedFrom ? 'Contested started' : 'Captured';
            const state = episode.currentState;
            const stateLabel = this._timelineStateLabel(state);
            const stateClass = this._timelineStateClass(state);
            const stateSince = episode.currentStateSince;
            const duration = episode.contestedFrom
                ? (Number.isFinite(episode.durationDays)
                    ? episode.durationDays
                    : this._timelineDurationDays(episode.contestedFrom, episode.contestedTo))
                : null;
            const coverage = [];
            if (episode.startPercent !== null) coverage.push(`${episode.startPercent}% start`);
            if (episode.endPercent !== null) coverage.push(`${episode.endPercent}% end`);

            return `<div class="timeline-tooltip-fight${index ? ' timeline-tooltip-fight-separator' : ''}">` +
                `<div class="timeline-tooltip-row"><span>${startedLabel}</span><strong>${this._escapeTimelineHtml(started || 'Unknown')}</strong></div>` +
                `<div class="timeline-tooltip-row"><span>Current state</span>` +
                    `<strong class="timeline-state-badge ${stateClass}">${this._escapeTimelineHtml(stateLabel)}` +
                    `${stateSince ? `<small>since ${this._escapeTimelineHtml(stateSince)}</small>` : ''}</strong></div>` +
                `${duration !== null || coverage.length ? `<div class="timeline-tooltip-meta">` +
                    `${duration !== null ? `<span>${duration} day${duration === 1 ? '' : 's'}</span>` : ''}` +
                    `${coverage.map(item => `<span>${this._escapeTimelineHtml(item)}</span>`).join('')}` +
                    `</div>` : ''}` +
                `</div>`;
        }).join('');

        return `<div class="settlement-timeline-tooltip">` +
            `<div class="timeline-tooltip-header"><div><strong>${name}</strong>${localName}</div>` +
            `<span class="timeline-source-badge ${sourceClass}">${this._escapeTimelineHtml(first.source)}</span></div>` +
            `${population ? `<div class="timeline-tooltip-population">${population}</div>` : ''}${rows}</div>`;
    }

    _timelineStateLabel(state) {
        return {
            infiltration: 'Infiltrated',
            contested: 'Contested',
            occupied: 'Captured',
            liberated: 'Liberated',
            controlled: 'Controlled'
        }[state] || 'Unknown';
    }

    _timelineStateClass(state) {
        if (state === 'occupied') return 'captured';
        if (state === 'infiltration' || state === 'contested') return 'contested';
        if (state === 'liberated' || state === 'controlled') return 'controlled';
        return 'unknown';
    }

    _timelineLabelIcon(group) {
        const first = group.episodes[0];
        const name = this._escapeTimelineHtml(first.nameEn || first.name || 'Unknown settlement');
        const ranges = group.episodes.map(episode => {
            const from = episode.contestedFrom || episode.infiltratedAt || episode.capturedAt;
            if (!from) return '';
            const to = episode.contestedTo || (episode.contestedFrom ? 'Ongoing' : episode.capturedAt);
            return to && to !== from ? `${from} – ${to}` : from;
        }).filter(Boolean);
        const dates = [...new Set(ranges)]
            .map(range => `<div class="settlement-timeline-label-dates">${this._escapeTimelineHtml(range)}</div>`)
            .join('');

        return L.divIcon({
            className: '',
            html: `<div class="settlement-label settlement-timeline-map-label"><div>${name}</div>${dates}</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });
    }

    async renderSettlementTimeline() {
        const dashboard = this.dashboard;
        const renderVersion = ++this.timelineRenderVersion;
        const select = dashboard.getEl('show-settlement-timeline');
        const source = select?.value || '';
        dashboard.settlementTimelineLayer.clearLayers();
        if (!source) return;

        const status = document.querySelector('input[name="settlement-timeline-status"]:checked')?.value || 'infiltrated';
        const dateField = {
            infiltrated: 'infiltratedAt',
            contested: 'contestedFrom',
            captured: 'capturedAt'
        }[status];
        const rangeStart = dashboard.startDate || dashboard.minDate;
        const rangeEnd = dashboard.endDate || dashboard.maxDate;
        if (!rangeStart || !rangeEnd) return;
        const startDate = MapLayers.isoDate(rangeStart);
        const endDate = MapLayers.isoDate(rangeEnd);

        try {
            const episodes = await this.loadSettlementTimeline(source);
            // The selection may have changed while the request was in flight.
            if (renderVersion !== this.timelineRenderVersion || (select?.value || '') !== source) return;

            const groups = new Map();
            episodes.forEach(episode => {
                const transitionDate = episode[dateField];
                const matchesRange = status === 'contested'
                    ? this._isTimelineDate(episode.contestedFrom) &&
                        episode.contestedFrom <= endDate &&
                        (!this._isTimelineDate(episode.contestedTo) || episode.contestedTo >= startDate)
                    : this._isTimelineDate(transitionDate) && transitionDate >= startDate && transitionDate <= endDate;
                if (!matchesRange) return;
                const key = episode.settlementId || `${episode.coordinates.join(',')}:${episode.name}`;
                if (!groups.has(key)) groups.set(key, { episodes: [] });
                groups.get(key).episodes.push(episode);
            });

            const color = {
                infiltrated: '#ff9800',
                contested: '#ffc107',
                captured: '#f44336'
            }[status];
            groups.forEach(group => {
                group.episodes.sort((left, right) => left[dateField].localeCompare(right[dateField]));
                const [lng, lat] = group.episodes[0].coordinates;
                const marker = L.circleMarker([lat, lng], {
                    radius: 6,
                    fillColor: color,
                    color: '#111827',
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.85
                });
                marker.bindTooltip(() => this._timelineTooltip(group, status), {
                    direction: 'top',
                    offset: [0, -8],
                    className: 'settlement-timeline-tooltip-shell'
                });
                marker.addTo(dashboard.settlementTimelineLayer);

                if (dashboard.isChecked('show-settlement-names')) {
                    L.marker([lat, lng], {
                        icon: this._timelineLabelIcon(group),
                        interactive: false
                    }).addTo(dashboard.settlementTimelineLayer);
                }
            });
            dashboard.setText(
                'settlement-timeline-result-count',
                `${groups.size.toLocaleString()} settlement${groups.size === 1 ? '' : 's'}`
            );
            console.log(`Displayed ${groups.size} ${source} settlement ${status} fights`);
        } catch (error) {
            console.error(`Failed to load ${source} settlement timeline:`, error);
            dashboard.settlementTimelineLayer.clearLayers();
            if (renderVersion === this.timelineRenderVersion && (select?.value || '') === source) {
                select.value = '';
                const controls = dashboard.getEl('settlement-timeline-status-controls');
                if (controls) controls.style.display = 'none';
                dashboard.setText('settlement-timeline-result-count', 'Unavailable');
                if (dashboard.isChecked('show-settlement-names')) this.renderSettlementNames();
                alert(`Failed to load the ${source === 'ria' ? 'RIA' : 'DeepState'} settlement timeline.`);
            }
        }
    }

    _progressHeatColor(days) {
        if (days <= 14) return '#fff7bc';
        if (days <= 30) return '#fec44f';
        if (days <= 60) return '#fe9929';
        if (days <= 90) return '#ec7014';
        if (days <= 180) return '#cc4c02';
        return '#7f0000';
    }

    _median(values) {
        if (!values.length) return null;
        const sorted = values.slice().sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    _progressHeatSamples(episodes, metric, startDate, endDate) {
        return episodes.flatMap(episode => {
            if (!this._isTimelineDate(episode.contestedFrom)) return [];

            let duration = null;
            if (metric === 'completed') {
                if (!this._isTimelineDate(episode.capturedAt) ||
                    episode.capturedAt < startDate || episode.capturedAt > endDate) return [];
                duration = Number.isFinite(episode.durationDays)
                    ? episode.durationDays
                    : this._timelineDurationDays(episode.contestedFrom, episode.capturedAt);
            } else {
                // Reconstruct the state at the selected range end. This includes a
                // fight whose eventual transition is after that date, and lets long
                // fights begin before the selected range without being discarded.
                if (episode.contestedFrom > endDate ||
                    (this._isTimelineDate(episode.contestedTo) && episode.contestedTo <= endDate)) return [];
                duration = this._timelineDurationDays(episode.contestedFrom, endDate);
            }
            if (!Number.isFinite(duration) || duration < 0) return [];

            return [{
                coordinates: episode.coordinates,
                duration,
                settlementId: episode.settlementId,
                name: episode.nameEn || episode.name || 'Unknown settlement'
            }];
        });
    }

    async renderSettlementProgressHeatmap() {
        const dashboard = this.dashboard;
        const layer = dashboard.settlementProgressHeatLayer;
        const summary = dashboard.getEl('settlement-progress-summary');
        const renderVersion = ++this.progressHeatRenderVersion;
        layer.clearLayers();

        if (!dashboard.isChecked('settlement-progress-heatmap')) {
            if (summary) summary.style.display = 'none';
            return;
        }

        const source = dashboard.getEl('settlement-progress-source')?.value || 'deepstate';
        const metric = dashboard.getEl('settlement-progress-metric')?.value || 'completed';
        const hexInput = dashboard.getEl('settlement-progress-hex-size');
        const minInput = dashboard.getEl('settlement-progress-min-samples');
        const hexSize = Math.min(80, Math.max(10, parseInt(hexInput?.value, 10) || 30));
        const minSamples = Math.min(20, Math.max(1, parseInt(minInput?.value, 10) || 2));
        if (hexInput) hexInput.value = hexSize;
        if (minInput) minInput.value = minSamples;

        const rangeStart = dashboard.startDate || dashboard.minDate;
        const rangeEnd = dashboard.endDate || dashboard.maxDate;
        if (!rangeStart || !rangeEnd) return;
        const startDate = MapLayers.isoDate(rangeStart);
        const endDate = MapLayers.isoDate(rangeEnd);
        if (summary) {
            summary.style.display = 'block';
            summary.textContent = 'Loading settlement fights…';
        }

        try {
            const episodes = await this.loadSettlementTimeline(source);
            if (renderVersion !== this.progressHeatRenderVersion ||
                !dashboard.isChecked('settlement-progress-heatmap')) return;

            const samples = this._progressHeatSamples(episodes, metric, startDate, endDate);
            const grid = turf.hexGrid([22, 44, 41.5, 53], hexSize, { units: 'kilometers' });
            const renderedFeatures = [];

            grid.features.forEach(hex => {
                const bounds = turf.bbox(hex);
                const bucket = samples.filter(sample => {
                    const [lng, lat] = sample.coordinates;
                    if (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3]) return false;
                    return turf.booleanPointInPolygon(turf.point(sample.coordinates), hex);
                });
                if (bucket.length < minSamples) return;

                const durations = bucket.map(sample => sample.duration);
                const median = this._median(durations);
                hex.properties = {
                    median,
                    fights: bucket.length,
                    settlements: new Set(bucket.map(sample => sample.settlementId)).size,
                    minimum: Math.min(...durations),
                    maximum: Math.max(...durations)
                };
                renderedFeatures.push(hex);
            });

            const sourceLabel = source === 'ria' ? 'RIA' : 'DeepState';
            const metricLabel = metric === 'completed' ? 'Completed captures' : 'Ongoing fights';
            L.geoJSON(turf.featureCollection(renderedFeatures), {
                style: feature => ({
                    color: '#713f12',
                    weight: 0.8,
                    opacity: 0.7,
                    fillColor: this._progressHeatColor(feature.properties.median),
                    fillOpacity: 0.62
                }),
                onEachFeature: (feature, hexLayer) => {
                    const props = feature.properties;
                    const median = Number.isInteger(props.median) ? props.median : props.median.toFixed(1);
                    const tooltip = `<div class="settlement-progress-heat-tooltip">` +
                        `<strong>${this._escapeTimelineHtml(sourceLabel)} · ${this._escapeTimelineHtml(metricLabel)}</strong>` +
                        `<div>Median: <b>${median} days</b></div>` +
                        `<div>${props.fights} fight${props.fights === 1 ? '' : 's'} · ` +
                            `${props.settlements} settlement${props.settlements === 1 ? '' : 's'}</div>` +
                        `<small>Range ${props.minimum}–${props.maximum} days</small></div>`;
                    hexLayer.bindTooltip(tooltip, { sticky: true, className: 'settlement-progress-heat-tooltip-shell' });
                }
            }).addTo(layer);

            if (summary) {
                if (!renderedFeatures.length) {
                    summary.textContent = `No cells have at least ${minSamples} qualifying fights.`;
                } else {
                    summary.innerHTML = `<div>${renderedFeatures.length.toLocaleString()} cells · ` +
                        `${samples.length.toLocaleString()} qualifying fights</div>` +
                        `<div class="settlement-progress-gradient" aria-hidden="true"></div>` +
                        `<div class="settlement-progress-scale"><span>≤14d faster</span><span>&gt;180d slower</span></div>`;
                }
            }
        } catch (error) {
            console.error(`Failed to render ${source} settlement progress heatmap:`, error);
            layer.clearLayers();
            if (renderVersion === this.progressHeatRenderVersion && summary) {
                summary.style.display = 'block';
                summary.textContent = 'Settlement progress heatmap unavailable.';
            }
        }
    }

    getBufferRadiusKm(population) {
        const pop = this.parsePopulation(population);
        if (pop >= 50000) return 7;
        if (pop >= 25000) return 5;
        if (pop >= 10000) return 3;
        if (pop >= 5000) return 2;
        if (pop >= 3000) return 1;
        return 0;
    }

    async toggleSettlementBuffers() {
        this.dashboard.settlementBufferLayer.clearLayers();

        if (!this.dashboard.isChecked('settlement-buffers')) return;
        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) return;

        const bounds = this.dashboard.map.getBounds();

        let source = this.dashboard.isChecked('show-settlements')
            ? this.getFilteredSettlements()
            : this.dashboard.settlementsData.features;

        if (this.dashboard.isChecked('filter-settlements-radius')) {
            const clusterRadius = parseInt(this.dashboard.getEl('clusterRadius')?.value, 10) || 20;
            source = source.filter(s => this.parsePopulation(s.properties.population) >= clusterRadius);
        }

        // Collect settlements that qualify for a buffer and are in view
        const candidates = [];
        for (const settlement of source) {
            const coords = settlement.geometry.coordinates;
            const latLng = L.latLng(coords[1], coords[0]);
            if (!bounds.contains(latLng)) continue;

            const pop = this.parsePopulation(settlement.properties.population);
            const radiusKm = this.getBufferRadiusKm(pop);
            if (radiusKm === 0) continue;

            candidates.push({ settlement, radiusKm, pop });
        }

        if (candidates.length === 0) return;

        this.showBoundariesLoader();
        this.updateBoundariesLoader(0, `Buffering ${candidates.length} settlements...`);

        // Fetch boundaries and build buffers
        const buffered = [];
        const MAX_CONCURRENT = 3;

        for (let i = 0; i < candidates.length; i += MAX_CONCURRENT) {
            const batch = candidates.slice(i, i + MAX_CONCURRENT);

            const results = await Promise.all(
                batch.map(({ settlement }) =>
                    this.fetchSettlementBoundary(settlement.properties.osm_id, settlement.properties.osm_type)
                )
            );

            results.forEach((geometry, idx) => {
                const { settlement, radiusKm, pop } = batch[idx];
                let baseGeom;

                if (geometry && geometry.coordinates) {
                    // Use the actual boundary polygon
                    baseGeom = { type: geometry.type, coordinates: geometry.coordinates };
                } else {
                    // Fallback to point if no boundary available
                    const coords = settlement.geometry.coordinates;
                    baseGeom = turf.point([coords[0], coords[1]]).geometry;
                }

                try {
                    const feature = { type: 'Feature', geometry: baseGeom, properties: {} };
                    const buffer = turf.buffer(feature, radiusKm, { units: 'kilometers' });
                    buffer.properties = {
                        name: settlement.properties.name || 'Unknown',
                        population: pop,
                        radiusKm
                    };
                    buffered.push(buffer);
                } catch (e) {
                    console.warn(`Buffer failed for ${settlement.properties.name}:`, e.message);
                }
            });

            const progress = Math.round(((i + batch.length) / candidates.length) * 100);
            this.updateBoundariesLoader(progress, `Buffered ${i + batch.length}/${candidates.length} settlements`);

            if (i + MAX_CONCURRENT < candidates.length) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        if (buffered.length === 0) {
            this.hideBoundariesLoader();
            return;
        }

        // Merge intersecting buffers using iterative union
        let merged = [buffered[0]];
        for (let i = 1; i < buffered.length; i++) {
            let didMerge = false;
            for (let j = 0; j < merged.length; j++) {
                try {
                    if (turf.booleanOverlap(buffered[i], merged[j]) ||
                        turf.booleanContains(merged[j], buffered[i]) ||
                        turf.booleanContains(buffered[i], merged[j])) {
                        merged[j] = turf.union(merged[j], buffered[i]);
                        didMerge = true;
                        break;
                    }
                } catch (e) {
                    // Skip merge errors
                }
            }
            if (!didMerge) {
                merged.push(buffered[i]);
            }
        }

        // Second pass: merge any newly overlapping results
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < merged.length; i++) {
                for (let j = i + 1; j < merged.length; j++) {
                    try {
                        if (turf.booleanOverlap(merged[i], merged[j]) ||
                            turf.booleanContains(merged[i], merged[j]) ||
                            turf.booleanContains(merged[j], merged[i])) {
                            merged[i] = turf.union(merged[i], merged[j]);
                            merged.splice(j, 1);
                            changed = true;
                            break;
                        }
                    } catch (e) {
                        // Skip merge errors
                    }
                }
                if (changed) break;
            }
        }

        // Render merged buffers
        for (const poly of merged) {
            const layer = L.geoJSON(poly, {
                style: {
                    color: '#f5a623',
                    weight: 2,
                    fillOpacity: 0.15,
                    fillColor: '#f5a623',
                    dashArray: '5,5'
                }
            });
            this.dashboard.settlementBufferLayer.addLayer(layer);
        }

        this.hideBoundariesLoader();
        console.log(`Settlement buffers: ${buffered.length} settlements -> ${merged.length} merged zones`);
    }
}

window.Settlements = Settlements;

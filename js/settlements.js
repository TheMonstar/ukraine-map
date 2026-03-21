class Settlements {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.filterCache = { key: null, settlements: null };
    }

    toggleSettlementsDisplay() {
        const settlementLegend = this.dashboard.getEl('settlement-legend');
        if (this.dashboard.isChecked('show-settlements')) {
            this.displaySettlements();
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

    getSettlementStyle(population) {
        const pop = parseInt(population) || 0;

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

    displaySettlements() {
        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) {
            console.warn('No settlements data available');
            return;
        }

        this.dashboard.settlementsLayer.clearLayers();

        const settlementsToShow = this.getFilteredSettlements();

        settlementsToShow.forEach(settlement => {
            const coords = settlement.geometry.coordinates;
            const props = settlement.properties;
            const population = parseInt(props.population) || 0;
            const style = this.getSettlementStyle(population);

            const marker = L.circleMarker([coords[1], coords[0]], {
                radius: style.radius,
                fillColor: style.color,
                color: '#ffffff',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            });

            let popupContent = `
                <div class="settlement-popup">
                    <div class="settlement-name">${props.name || 'Unknown'}</div>
                    ${props['name:en'] ? `<div class="settlement-info">English: ${props['name:en']}</div>` : ''}
                    ${props.place ? `<div class="settlement-info">Type: ${props.place}</div>` : ''}
                    <div class="settlement-info">Category: ${style.label}</div>
                    ${props.population ? `<div class="settlement-info">Population: ${props.population.toLocaleString()}</div>` : ''}
                    <div class="settlement-info">Coordinates: ${coords[1].toFixed(6)}, ${coords[0].toFixed(6)}</div>
                    <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd;">
                        <button
                            onclick="window.markerAdjuster && window.markerAdjuster.pickSettlementLocation(${coords[1]}, ${coords[0]}, '${(props.name || '').replace(/'/g, "\\'")}', '${(props['name:en'] || '').replace(/'/g, "\\'")}')"
                            style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%;"
                        >
                            Pick Location
                        </button>
                    </div>
                </div>
            `;

            marker.bindPopup(popupContent);
            this.dashboard.settlementsLayer.addLayer(marker);
        });
    }

    filterSettlementsByRadius() {
        if (!this.dashboard.settlementsData || !this.dashboard.settlementsData.features) {
            return;
        }

        const clusterRadius = parseInt(this.dashboard.getEl('clusterRadius')?.value, 10) || 20;

        this.dashboard.filteredSettlements = this.dashboard.settlementsData.features.filter(settlement => {
            const population = parseInt(settlement.properties.population) || 0;
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

        if (this.dashboard.settlementBoundariesData && this.dashboard.settlementBoundariesData[cacheKey]) {
            const offlineData = this.dashboard.settlementBoundariesData[cacheKey];
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
                source = source.filter(s => (parseInt(s.properties.population) || 0) >= clusterRadius);
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
                                        <button
                                            onclick="window.markerAdjuster && window.markerAdjuster.pickSettlementLocation(${settlementLat}, ${settlementLng}, '${(props.name || '').replace(/'/g, "\\'")}', '${(props['name:en'] || '').replace(/'/g, "\\'")}')"
                                            style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%;"
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

    async loadSettlementHistory() {
        if (this.dashboard.settlementHistoryData) {
            return this.dashboard.settlementHistoryData;
        }

        try {
            const response = await fetch('data/settlement-status-timeline.json');
            const data = await response.json();
            this.dashboard.settlementHistoryData = data;
            console.log(`Loaded settlement history: ${data.settlements.length} settlements with events`);
            return data;
        } catch (error) {
            console.error('Failed to load settlement history:', error);
            return null;
        }
    }

    getStatusColor(status) {
        const colors = {
            controlled: '#4CAF50',    // Green
            contested: '#FFC107',     // Amber
            occupied: '#F44336',      // Red
            liberated: '#2196F3'      // Blue
        };
        return colors[status] || '#9E9E9E';
    }

    calculateBattleDuration(settlement) {
        if (!settlement.events || settlement.events.length === 0) return null;

        const events = settlement.events;

        // Find first contested/occupied event
        const firstBattleEvent = events.find(e =>
            e.status === 'contested' || e.status === 'occupied'
        );

        if (!firstBattleEvent) return null;

        // Find last liberated event or use current status
        const lastLiberatedEvent = [...events].reverse().find(e => e.status === 'liberated');

        let startDate = new Date(firstBattleEvent.date);
        let endDate;
        let isOngoing = false;

        if (lastLiberatedEvent) {
            endDate = new Date(lastLiberatedEvent.date);
        } else if (settlement.currentStatus === 'occupied' || settlement.currentStatus === 'contested') {
            endDate = new Date(); // Ongoing
            isOngoing = true;
        } else {
            // Find last occupied/contested event
            const lastBattleEvent = [...events].reverse().find(e =>
                e.status === 'contested' || e.status === 'occupied'
            );
            endDate = lastBattleEvent ? new Date(lastBattleEvent.date) : startDate;
        }

        const durationMs = endDate - startDate;
        const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24));

        return { durationDays, isOngoing, startDate, endDate };
    }

    formatDuration(durationDays) {
        if (durationDays === 0) return '< 1 day';
        if (durationDays === 1) return '1 day';
        if (durationDays < 30) return `${durationDays} days`;

        const months = Math.floor(durationDays / 30);
        const days = durationDays % 30;

        if (months === 1 && days === 0) return '1 month';
        if (months === 1) return `1 month ${days} days`;
        if (days === 0) return `${months} months`;
        return `${months} months ${days} days`;
    }

    async toggleSettlementHistory() {
        const dashboard = this.dashboard;

        if (dashboard.isChecked('settlement-history')) {
            const historyData = await this.loadSettlementHistory();

            if (!historyData) {
                alert('Failed to load settlement history data');
                const checkbox = dashboard.getEl('settlement-history');
                if (checkbox) checkbox.checked = false;
                return;
            }

            // Create layer if it doesn't exist
            if (!dashboard.settlementHistoryLayer) {
                dashboard.settlementHistoryLayer = L.layerGroup().addTo(dashboard.map);
            }

            dashboard.settlementHistoryLayer.clearLayers();

            // Check if radius filter is active
            const showBattleDuration = dashboard.isChecked('filter-settlements-radius');

            // Render each settlement with history
            historyData.settlements.forEach(settlement => {
                if (!settlement.coordinates) return;

                const [lng, lat] = settlement.coordinates;
                const currentStatus = settlement.currentStatus;

                // Create marker with color based on current status
                const marker = L.circleMarker([lat, lng], {
                    radius: 6,
                    fillColor: this.getStatusColor(currentStatus),
                    color: '#000',
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });

                // Build tooltip with timeline
                let tooltipContent = `<strong>${settlement.name}</strong><br/>`;
                tooltipContent += `<strong>Current:</strong> ${currentStatus}<br/>`;
                tooltipContent += `<strong>Events:</strong> ${settlement.events.length}<br/>`;

                // Add battle duration if radius filter is active
                if (showBattleDuration) {
                    const duration = this.calculateBattleDuration(settlement);
                    if (duration) {
                        tooltipContent += `<strong>Battle Duration:</strong> ${this.formatDuration(duration.durationDays)}`;
                        if (duration.isOngoing) {
                            tooltipContent += ` <span style="color: #F44336;">(ongoing)</span>`;
                        }
                        tooltipContent += `<br/>`;
                    }
                }

                tooltipContent += `<br/><strong>Timeline:</strong><br/>`;

                settlement.events.forEach((event) => {
                    const color = this.getStatusColor(event.status);
                    tooltipContent += `<div style="margin: 2px 0;">`;
                    tooltipContent += `<span style="color: ${color}; font-weight: bold;">●</span> `;
                    tooltipContent += `${event.date}: ${event.previousStatus} → ${event.status}`;
                    if (event.occupiedPercent !== undefined && event.occupiedPercent > 0) {
                        tooltipContent += ` (${event.occupiedPercent}%)`;
                    }
                    tooltipContent += `</div>`;
                });

                if (settlement.wasOccupied) {
                    tooltipContent += `<br/><em style="color: #F44336;">Was occupied</em>`;
                }

                marker.bindTooltip(tooltipContent, {
                    permanent: false,
                    direction: 'top',
                    offset: [0, -10]
                });

                marker.addTo(dashboard.settlementHistoryLayer);
            });

            console.log(`Displayed ${historyData.settlements.length} settlements with history`);

        } else {
            // Hide layer
            if (dashboard.settlementHistoryLayer) {
                dashboard.settlementHistoryLayer.clearLayers();
            }
        }
    }
    getBufferRadiusKm(population) {
        const pop = parseInt(population) || 0;
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
            source = source.filter(s => (parseInt(s.properties.population) || 0) >= clusterRadius);
        }

        // Collect settlements that qualify for a buffer and are in view
        const candidates = [];
        for (const settlement of source) {
            const coords = settlement.geometry.coordinates;
            const latLng = L.latLng(coords[1], coords[0]);
            if (!bounds.contains(latLng)) continue;

            const pop = parseInt(settlement.properties.population) || 0;
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

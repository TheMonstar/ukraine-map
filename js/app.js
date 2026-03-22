/**
 * Ukraine Frontline Map - Public Version
 * Based on Attack Map Dashboard
 */

// GCP API base URL - update this to your GCP endpoint
const API_BASE_URL = 'https://europe-west1-high-electron-312820.cloudfunctions.net/flask-app';
const APP_STATIC_URL = 'https://storage.googleapis.com/telegram-reader-static/static';

class AttackMapDashboard {
    constructor() {
        this.regionCoordinates = {
            'Kharkiv': [49.9, 36.25],
            'Kupiansk': [49.8, 37.9],
            'Lyman': [48.9, 37.4],
            'Siversk': [48.85, 37.9],
            'Kramatorsk': [48.7, 37.5],
            'Toretsk': [48.3, 38.0],
            'Pokrovsk': [48.1, 37.3],
            'Novopavlivka': [47.8, 36.8],
            'Gulyaipole': [47.5, 36.4],
            'Orikhiv': [47.8, 35.6],
            'Prydniprovske': [46.75, 33.3],
            'Kursk': [51.1, 35.2],
            "Восток": [48.1, 36.6],
            "Днепр": [46.75, 33.3],
            "Запад": [49.7, 37.45],
            "Юг": [48.3, 38.0],
            "Центр": [48.1, 37.3],
            "Север": [51.1, 35.2]
        };
        //[[[36.716309,47.739346],[36.303635,47.839905],[36.386719,48.173328],[37.043152,47.977058],[37.493196,47.936982],[36.716309,47.739346]]]
        //[[[36.997833,47.622827],[36.105194,47.89701],[36.386719,48.173328],[37.043152,47.977058],[37.493196,47.936982],[36.997833,47.622827]]]
        this.regionPolygons = {
            Orikhiv: '[[[35.337524,47.463529],[35.175476,47.629421],[35.970612,47.750391],[36.142273,47.506997],[35.792084,47.372482],[35.337524,47.463529]]]',
            Gulyaipole: '[[[36.997833,47.622827],[36.105194,47.89701],[35.970612,47.750391],[36.142273,47.506997],[36.557007,47.607042],[36.997833,47.622827]]]',
            Novopavlivka: '[[[36.997833,47.622827],[36.105194,47.89701],[36.386719,48.173328],[37.043152,47.977058],[37.493196,47.936982],[36.997833,47.622827]]]',
            Pokrovsk: '[[[37.493196,47.936982],[37.393341,48.203664],[37.738037,48.310618],[37.378235,48.595228],[36.702576,48.47379],[36.386719,48.173328],[37.043152,47.977058],[37.493196,47.936982]]]',
            Toretsk: '[[[38.004456,48.45834],[37.738037,48.310618],[37.378235,48.595228],[37.646027,48.563457],[38.004456,48.45834]]]',
            Kramatorsk: '[[[38.004456,48.45834],[38.060074,48.679554],[37.889786,48.794161],[37.433167,48.781515],[37.378235,48.595228],[37.646027,48.563457],[38.004456,48.45834]]]',
            Siversk: '[[[38.017502,48.916633],[38.255081,48.945029],[38.217316,48.771968],[38.060074,48.679554],[37.889786,48.794161],[37.895966,48.877298],[38.017502,48.916633]]]',
            Lyman: '[[[38.017502,48.916633],[38.255081,48.945029],[37.97081,49.158282],[38.063507,49.313906],[37.97081,49.464089],[37.437973,49.426572],[37.544403,49.203229],[37.599335,49.105281],[37.719498,48.910332],[37.895966,48.877298],[38.017502,48.916633]]]',
            Kupiansk: '[[[37.659073,49.810979],[37.918625,50.038476],[37.97081,49.464089],[37.437973,49.426572],[37.397461,49.795332],[37.659073,49.810979]]]',
            Kharkiv: '[[[37.659073,49.810979],[37.918625,50.038476],[37.328796,50.417215],[36.649017,50.334916],[35.457001,50.522089],[35.003815,50.398858],[36.503448,50.007723],[37.397461,49.795332],[37.659073,49.810979]]]',
            Kursk: '[[[34.391327,50.99561],[33.755493,51.22666],[34.119415,51.439401],[35.056,51.279033],[35.370483,51.160236],[35.457001,50.522089],[35.003815,50.398858],[34.707184,50.73718],[34.391327,50.99561]]]',
            Prydniprovske: '[[[35.137024,47.608135],[35.2771,47.404088],[34.274597,47.290592],[33.642883,46.775901],[32.332764,46.404142],[31.948242,46.481723],[31.978455,46.832291],[33.261108,47.132036],[33.887329,47.495079],[35.137024,47.608135]]]',
            Днепр: '[[[31.431885,46.695048],[31.654358,46.425047],[32.4646,46.398541],[33.728027,46.745877],[34.541016,47.234752],[36.070862,47.432023],[35.921173,47.778203],[35.235901,47.722814],[34.104309,47.649009],[31.431885,46.695048]]]',
            "Восток": '[[[36.929855,48.011523],[37.216187,47.999116],[36.694336,47.598319],[36.070862,47.432023],[35.921173,47.778203],[36.555634,48.134927],[36.929855,48.011523]]]',
            "Запад": '[[[38.279114,48.935976],[38.049774,49.950017],[37.791595,50.129297],[37.365875,49.796342],[37.633667,48.90248],[38.279114,48.935976]]]',
            "Юг": '[[[38.279114,48.935976],[38.041534,48.431842],[37.683105,48.282748],[37.661819,48.474279],[37.120056,48.592786],[37.633667,48.90248],[38.279114,48.935976]]]',
            "Центр": '[[[36.929855,48.011523],[37.216187,47.999116],[37.683105,48.282748],[37.661819,48.474279],[37.120056,48.592786],[36.555634,48.134927],[36.929855,48.011523]]]',
            "Север": '[[[34.911804,50.483678],[33.895569,51.122424],[33.788452,51.556507],[35.161743,51.28064],[36.013184,50.539567],[37.499084,50.572639],[37.791595,50.129297],[37.365875,49.796342],[36.01593,49.97926],[34.911804,50.483678]]]'
        }
        this.regionPolygonCache = new Map();

        this.map = null;
        this.markers = null;
        this.frontlineLayer = null;
        this.clusterLayer = null;
        this.deepLayer = null;
        this.featureLayer = null;

        this.startDate = null;
        this.endDate = null;
        this.minDate = null;
        this.maxDate = null;
        this.sliderLock = false;
        this.selectRegions = [];
        this.regionSelectionVersion = 0;
        this.directionData = [];
        this.locationData = [];
        this.cachedFrontline = null;
        this.copiedFrontline = [];
        this.modOverlay = null;
        this.russiaOverlay = null;
        this.ukraineOverlay = null;
        this.amkOverlay = null;
        this.owlOverlay = null;
        this.radovOverlay = null;
        this.iswOverlay = null;
        this.suriyakOverlay = null;
        this.russiaMergedPolygon = null; // Store merged Russia polygon for comparison
        this.ukraineMergedPolygon = null; // Store merged Ukraine polygon for comparison
        this.amkMergedPolygon = null; // Store the merged AMK polygon for comparison
        this.owlMergedPolygon = null; // Store the merged OWL polygon for comparison
        this.radovMergedPolygon = null; // Store the merged Radov polygon for comparison
        this.iswMergedPolygon = null; // Store the merged ISW polygon for comparison
        this.suriyakMergedPolygon = null; // Store the merged Suriyak polygon for comparison
        this.comparisonLayer = null;
        this.comparisonOverlapLayer = null; // Store overlap layer
        this.directionBorders = {};

        // Polygon selection functionality
        this.drawControl = null;
        this.drawnItems = null;
        this.selectedPolygons = [];
        this.polygonVersion = 0;
        this.polygonSelectionEnabled = false;
        this.currentDiffResult = null;
        this.diffSliceCount = 0;
        this.diffSliceDates = [];
        this.diffSliceSlider = null;
        this.positionsData = null;
        this.analyzeUnitsEnabled = false;

        // Ruler tool
        this.rulerEnabled = false;
        this.rulerPolyline = null;
        this.rulerPoints = [];
        this.rulerMarkers = [];
        this.rulerTooltip = null;

        // Image overlay
        this.customImageOverlay = null;
        this.imageResizeMode = false;
        this.imageCornerMarkers = [];
        this.currentImageBounds = null;
        this.customImageObjectUrl = null;

        // Region and settlement data
        this.regionsData = null;
        this.settlementsData = null;
        this.selectedRegions = [];
        this.occupiedTerritories = null;
        this.settlementsLayer = L.layerGroup();
        this.settlementBordersLayer = L.layerGroup();
        this.settlementBufferLayer = L.layerGroup();
        this.filteredSettlements = [];
        this.currentPredefinedRegion = null;
        this.settlementBoundariesCache = new Map(); // Cache for API responses
        this.settlementBoundariesData = null; // Offline boundaries data
        this.renderedBoundaries = new Set(); // Track which boundaries are already rendered

        // Data storage for different sources
        this.sourceData = {
            gsua: { direction: [], location: [] },
            mod: { direction: [], location: [] },
            air: { direction: [], location: [] }
        };

        this.animationInterval = null;
        this.isPlaying = false;
        this.playbackSpeed = 1000;

        // Add map style definitions
        this.mapStyles = {
            mapbox: {
                url: 'https://api.mapbox.com/styles/v1/mapbox/navigation-day-v1/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoibWFwYm94LWtpcmsiLCJhIjoiY205czZlMHo2MWd5ajJwczQ3bXM1MGl2cyJ9.SFkXvR-QU3S-FIlcBxSX7w&language=en',
                attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
            },
            carto: {
                url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
                attribution: '&copy; OpenStreetMap &copy; CartoDB'
            },
            osm: {
                url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            },
            esri: {
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
                attribution: '&copy; Esri'
            },
            'esri-elevation': {
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                attribution: '&copy; Esri'
            },
            'mapbox-kirk': {
                url: 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
                attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
            }
        };

        this.currentTileLayer = null;

        this.ui = {};
        this.updateMapDebounce = null;
        this.attackLegendEl = null;

        this.layers = new MapLayers(this);
        this.dataStore = new DataStore(this);
        this.settlements = new Settlements(this);
        this.uiBindings = new UiBindings(this);
    }

    /**
     * Initialize the map and all components
     */
    init() {
        this.layers.initMap();
        this.uiBindings.init();
        this.buildRegionPolygonCache();
        this.addLegend();
        this.initDates();
        this.initDiffSlices();
        this.initPredefinedRegions();
        this.loadGeographicData();
        this.initSidebar();
    }

    /**
     * Initialize sidebar toggle and accordion behavior
     */
    initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebar-toggle');
        if (toggle && sidebar) {
            toggle.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
            });
        }

        // Accordion behavior (independent toggle, no auto-close)
        document.querySelectorAll('.accordion-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.parentElement;
                const body = section.querySelector('.accordion-body');
                const arrow = header.querySelector('.accordion-arrow');
                const isOpen = body.style.display !== 'none';

                body.style.display = isOpen ? 'none' : 'block';
                arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
            });
        });
    }

    cacheUI() {
        const ids = [
            'map-style',
            'diff-area',
            'shadow-ua',
            'clusterRadius',
            'optimize-polygons',
            'diff-highlight',
            'losses-input-container',
            'losses-input',
            'regions-highlight',
            'diff-slices-count',
            'diff-slices-slider',
            'diff-slices-labels',
            'total-gains',
            'total-captured',
            'total-grayed',
            'settlements-in-diff',
            'slice-territory-stats',
            'date-slider',
            'date',
            'captured',
            'playback-speed',
            'play-btn',
            'copy-btn',
            'lock-sliders',
            'feature-ditches',
            'russia-overlay',
            'ukraine-overlay',
            'amk-overlay',
            'owl-overlay',
            'compare-deep-amk',
            'compare-layer-1',
            'compare-layer-2',
            'compare-mode',
            'clear-comparison',
            'feature-wire',
            'feature-dragon',
            'feature-positions-ua',
            'filter-usf-units',
            'usf-period-select',
            'usf-metric-select',
            'feature-positions-ru',
            'analyze-positions',
            'position-change',
            'position-change-controls',
            'filter-trace-distance',
            'trace-distance-limit',
            'filter-trace-distance-less',
            'trace-distance-limit-less',
            'units-analysis-panel',
            'polygon-select',
            'clear-polygons',
            'export-polygons',
            'ruler-tool',
            'load-image-overlay',
            'clear-image-overlay',
            'enable-image-resize',
            'image-opacity-slider',
            'image-overlay-url',
            'image-opacity-value',
            'predefined-regions',
            'search-in-predefined-region',
            'search-in-polygons',
            'load-selected-regions',
            'exclude-occupied',
            'calculate-unoccupied',
            'refresh-optimization',
            'show-settlements',
            'filter-settlements-radius',
            'settlements-border',
            'search-in-regions',
            'settlement-search',
            'settlement-search-results',
            'settlement-legend',
            'settlement-boundaries-loader',
            'boundaries-progress-bar',
            'boundaries-loader-text',
            'selected-area',
            'selected-population',
            'captured-in-selection',
            'captured-population',
            'highlighted-in-selection',
            'grayed-in-selection',
            'frontline-length',
            'capture-percentage',
            'shadow-population',
            'unoccupied-area',
            'unoccupied-population',
            'units-count',
            'units-list',
            'total-attacks',
            'region-stats',
            'clusterRadius',
            'hide-markers',
            'group-markers',
            'show-regions',
            'show-line',
            'snap-regions',
            'date-start',
            'date-end'
        ];
        ids.forEach(id => {
            this.ui[id] = document.getElementById(id);
        });
    }

    buildRegionPolygonCache() {
        Object.entries(this.regionPolygons).forEach(([name, coordsJson]) => {
            try {
                const polygonCoords = JSON.parse(coordsJson);
                const turfPolygon = turf.polygon(polygonCoords);
                this.regionPolygonCache.set(name, turfPolygon);
            } catch (error) {
                console.warn(`Failed to parse region polygon ${name}:`, error);
            }
        });
    }

    getEl(id) {
        return this.ui[id] || document.getElementById(id);
    }

    bindUI(id, event, handler, options) {
        const el = this.getEl(id);
        if (!el) {
            return null;
        }
        el.addEventListener(event, handler, options);
        return el;
    }

    setText(id, value) {
        const el = this.getEl(id);
        if (el) {
            el.textContent = value;
        }
    }

    setHTML(id, value) {
        const el = this.getEl(id);
        if (el) {
            el.innerHTML = value;
        }
    }

    isChecked(id) {
        const el = this.getEl(id);
        return !!el?.checked;
    }

    getDirectionColor(dir) {

        const directionColors = {
            Gulyaipole: '#1f77b4', // blue
            Novopavlivka: '#ff7f0e', // orange
            Pokrovsk: '#2ca02c', // green
            Toretsk: '#d62728', // red
            Kramatorsk: '#9467bd', // purple
            Siversk: '#8c564b', // brown
            Lyman: '#e377c2', // pink
            Kupiansk: '#7f7f7f', // gray
            Kharkiv: '#bcbd22', // olive
            Orikhiv: '#17becf', // cyan
            Prydniprovske: '#ffbb78',  // light orange
            Восток: '#1f77b4',
            Днепр: '#ffbb78',
            Запад: '#e377c2',
            Север: '#bcbd22',
            Центр: '#2ca02c',
            Юг: '#d62728'
        };
        return directionColors[dir] || 'white';
    }
    /**
     * Load geographic data (regions and settlements)
     */
    async loadGeographicData() {
        const fetchJSON = async (primary, fallback) => {
            try {
                const resp = await fetch(primary);
                if (resp.ok) return await resp.json();
            } catch (e) { /* fall through */ }
            if (fallback) {
                const resp = await fetch(fallback);
                if (resp.ok) return await resp.json();
            }
            return null;
        };

        try {
            // Load regions data - try API first, then local file
            this.regionsData = await fetchJSON(`${APP_STATIC_URL}/regions.json`, './regions.json');

            // Load settlements data - try API first, then local file
            this.settlementsData = await fetchJSON(`${APP_STATIC_URL}/settlements.json`, './settlements.json');

            // Settlement boundaries loaded on demand from Nominatim
            this.settlementBoundariesData = null;

            if (this.settlementsData) {
                console.log(`Loaded ${this.settlementsData.features?.length || 0} settlements`);
            }

            this.initRegionMultiSelect();
        } catch (error) {
            console.error('Error loading geographic data:', error);
        }
    }

    /**
     * Load local file (fallback method)
     */
    async loadLocalFile(filename) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = filename;
            script.onload = () => resolve(window.geojsonData);
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Initialize predefined regions dropdown
     */
    initPredefinedRegions() {
        const select = this.getEl('predefined-regions');
        if (!select) {
            return;
        }

        // Add options for each predefined region
        Object.keys(this.regionPolygons).forEach(regionName => {
            const option = document.createElement('option');
            option.value = regionName;
            option.textContent = regionName;
            select.appendChild(option);
        });
    }

    /**
     * Initialize region multiselect dropdown
     */
    initRegionMultiSelect() {
        const select = this.getEl('region-multiselect');
        if (!select) {
            return;
        }

        if (this.regionsData && this.regionsData.features) {
            this.regionsData.features.forEach(region => {
                const option = document.createElement('option');
                option.value = region.properties.name;
                option.textContent = region.properties.name;
                select.appendChild(option);
            });
        }
    }

    /**
     * Load selected regions from multiselect
     */
    loadSelectedRegions() {
        const select = this.getEl('region-multiselect');
        const btn = this.getEl('load-selected-regions');

        if (!select) {
            return;
        }
        const selectedOptions = Array.from(select.selectedOptions);

        if (selectedOptions.length === 0) {
            this.clearSelectedPolygons();
            return;
        }

        if (btn) {
            btn.classList.add('btn-loading');
        }

        // Use a short timeout to let the UI update and show the loading state
        setTimeout(() => {
            // Clear existing selections
            this.clearSelectedPolygons();

            selectedOptions.forEach(option => {
                const regionName = option.value;
                this.loadRegionPolygon(regionName);
            });
            this.polygonVersion += 1;

            // Calculate statistics after loading all regions
            this.calculateSelectedAreaStatistics();

            if (btn) {
                btn.classList.remove('btn-loading');
            }
        }, 50);
    }

    /**
     * Load a region polygon from regions.json
     */
    loadRegionPolygon(regionName) {
        if (!this.regionsData || !this.regionsData.features) {
            console.error('Regions data not loaded');
            return;
        }

        const region = this.regionsData.features.find(r => r.properties.name === regionName);
        if (!region) {
            console.error(`Region ${regionName} not found`);
            return;
        }

        try {
            // Convert GeoJSON to Leaflet polygon
            const geoJsonLayer = L.geoJSON(region, {
                style: {
                    color: '#3388ff',
                    weight: 2,
                    fillOpacity: 0.2
                }
            });

            geoJsonLayer.eachLayer(layer => {
                this.drawnItems.addLayer(layer);
                this.selectedPolygons.push(layer);
                this.selectedRegions.push(regionName);
            });

            // Fit map to show all selected regions
            if (this.selectedPolygons.length > 0) {
                const group = new L.featureGroup(this.selectedPolygons);
                this.map.fitBounds(group.getBounds(), { padding: [20, 20] });
            }

            console.log(`Loaded region: ${regionName}`);

        } catch (error) {
            console.error(`Error loading region ${regionName}:`, error);
        }
    }

    /**
     * Load a predefined region polygon
     */
    loadPredefinedRegion(regionName) {
        if (!this.regionPolygons[regionName]) {
            console.error(`Region ${regionName} not found in predefined regions`);
            return;
        }

        try {
            // Parse the coordinates string
            const coordinatesString = this.regionPolygons[regionName];
            const coordinates = JSON.parse(coordinatesString);

            // Convert from GeoJSON format [lng, lat] to Leaflet format [lat, lng]
            const leafletCoords = coordinates[0].map(coord => [coord[1], coord[0]]);

            // Create the polygon
            const polygon = L.polygon(leafletCoords, {
                color: '#3388ff',
                weight: 2,
                fillOpacity: 0.2
            });

            // Add to drawnItems and selectedPolygons
            this.drawnItems.addLayer(polygon);
            this.selectedPolygons.push(polygon);

            // Log coordinates
            this.printPolygonCoordinates(polygon, `LOADED (${regionName})`);

            // Calculate statistics
            this.calculateSelectedAreaStatistics();

            // Fit map to polygon bounds
            this.map.fitBounds(polygon.getBounds(), { padding: [20, 20] });

            console.log(`Loaded predefined region: ${regionName}`);

        } catch (error) {
            console.error(`Error loading predefined region ${regionName}:`, error);
        }
    }

    /**
     * Initialize polygon selection functionality
     */
    initPolygonSelection() {
        // Create feature group for drawn items
        this.drawnItems = new L.FeatureGroup();
        this.map.addLayer(this.drawnItems);

        // Initialize the draw control but don't add it to the map yet
        this.drawControl = new L.Control.Draw({
            position: 'topright',
            draw: {
                polyline: false,
                marker: false,
                circle: false,
                rectangle: true,
                polygon: true,
                circlemarker: false
            },
            edit: {
                featureGroup: this.drawnItems,
                remove: true
            }
        });

        // Handle drawing events
        this.map.on(L.Draw.Event.CREATED, (e) => {
            const layer = e.layer;
            this.drawnItems.addLayer(layer);
            this.selectedPolygons.push(layer);
            this.polygonVersion += 1;
            this.printPolygonCoordinates(layer, 'CREATED');
            this.calculateSelectedAreaStatistics();

            // Refresh settlement display and search if polygon filtering is enabled
            if (this.isChecked('search-in-polygons')) {
                if (this.isChecked('show-settlements')) {
                    this.displaySettlements();
                }
                const searchValue = this.getEl('settlement-search')?.value;
                if (searchValue?.trim()) {
                    this.handleSettlementSearch(searchValue);
                }
            }
        });

        this.map.on(L.Draw.Event.DELETED, (e) => {
            const layers = e.layers;
            layers.eachLayer((layer) => {
                const index = this.selectedPolygons.indexOf(layer);
                if (index > -1) {
                    this.selectedPolygons.splice(index, 1);
                }
            });
            this.polygonVersion += 1;
            this.calculateSelectedAreaStatistics();

            // Refresh settlement display and search if polygon filtering is enabled
            if (this.isChecked('search-in-polygons')) {
                if (this.isChecked('show-settlements')) {
                    this.displaySettlements();
                }
                const searchValue = this.getEl('settlement-search')?.value;
                if (searchValue?.trim()) {
                    this.handleSettlementSearch(searchValue);
                }
            }
        });

        this.map.on(L.Draw.Event.EDITED, (e) => {
            const layers = e.layers;
            layers.eachLayer((layer) => {
                this.printPolygonCoordinates(layer, 'EDITED');
            });
            this.polygonVersion += 1;
            this.calculateSelectedAreaStatistics();

            // Refresh settlement display and search if polygon filtering is enabled
            if (this.isChecked('search-in-polygons')) {
                if (this.isChecked('show-settlements')) {
                    this.displaySettlements();
                }
                const searchValue = this.getEl('settlement-search')?.value;
                if (searchValue?.trim()) {
                    this.handleSettlementSearch(searchValue);
                }
            }
        });
    }

    /**
     * Print polygon coordinates to console for future use as predefined areas
     */
    printPolygonCoordinates(layer, action) {
        try {
            const geoJSON = layer.toGeoJSON();
            const coordinates = geoJSON.geometry.coordinates;

            console.log(`\n=== POLYGON ${action} ===`);
            console.log('GeoJSON Coordinates:');
            console.log(JSON.stringify(coordinates, null, 2));

            // Also print in a more readable format for manual use
            if (geoJSON.geometry.type === 'Polygon') {
                const coords = coordinates[0]; // Get the outer ring
                console.log('\nReadable Format (lat, lng):');
                coords.forEach((coord, index) => {
                    console.log(`Point ${index + 1}: [${coord[1]}, ${coord[0]}]`);
                });

                // Print as array for easy copy-paste
                const latLngArray = coords.map(coord => [coord[1], coord[0]]);
                console.log('\nArray format for Leaflet:');
                console.log(JSON.stringify(latLngArray, null, 2));

                // Calculate area for reference
                const area = turf.area(geoJSON) / 1000000; // Convert to km²
                console.log(`\nArea: ${area.toFixed(2)} km²`);
            }

            console.log('=== END POLYGON ===\n');

        } catch (error) {
            console.error('Error printing polygon coordinates:', error);
        }
    }

    /**
     * Toggle polygon selection mode
     */
    togglePolygonSelection() {
        this.polygonSelectionEnabled = this.isChecked('polygon-select');

        if (this.polygonSelectionEnabled) {
            this.map.addControl(this.drawControl);
        } else {
            this.map.removeControl(this.drawControl);
        }
    }

    /**
     * Clear all selected polygons
     */
    clearSelectedPolygons() {
        this.drawnItems.clearLayers();
        this.selectedPolygons = [];
        this.polygonVersion += 1;
        this.resetAreaStatistics();
    }

    /**
     * Export all current polygons to console for future use
     */
    exportAllPolygonsToConsole() {
        if (this.selectedPolygons.length === 0) {
            console.log('No polygons to export');
            return;
        }

        console.log('\n=== EXPORTING ALL POLYGONS ===');
        console.log(`Total polygons: ${this.selectedPolygons.length}`);

        const allPolygonsData = [];

        this.selectedPolygons.forEach((polygon, index) => {
            try {
                const geoJSON = polygon.toGeoJSON();
                const coordinates = geoJSON.geometry.coordinates;
                const area = turf.area(geoJSON) / 1000000; // Convert to km²

                console.log(`\n--- Polygon ${index + 1} ---`);
                console.log('GeoJSON:', JSON.stringify(coordinates, null, 2));

                if (geoJSON.geometry.type === 'Polygon') {
                    const latLngArray = coordinates[0].map(coord => [coord[1], coord[0]]);
                    console.log('Leaflet format:', JSON.stringify(latLngArray, null, 2));
                    console.log(`Area: ${area.toFixed(2)} km²`);

                    allPolygonsData.push({
                        id: index + 1,
                        type: 'Polygon',
                        coordinates: coordinates,
                        leafletFormat: latLngArray,
                        area: parseFloat(area.toFixed(2))
                    });
                } else if (geoJSON.geometry.type === 'Rectangle') {
                    // Handle rectangles (which are also polygons in Leaflet)
                    const latLngArray = coordinates[0].map(coord => [coord[1], coord[0]]);
                    console.log('Rectangle Leaflet format:', JSON.stringify(latLngArray, null, 2));
                    console.log(`Area: ${area.toFixed(2)} km²`);

                    allPolygonsData.push({
                        id: index + 1,
                        type: 'Rectangle',
                        coordinates: coordinates,
                        leafletFormat: latLngArray,
                        area: parseFloat(area.toFixed(2))
                    });
                }
            } catch (error) {
                console.error(`Error processing polygon ${index + 1}:`, error);
            }
        });

        console.log('\n=== COMPLETE EXPORT DATA ===');
        console.log('Copy this for predefined areas:');
        console.log(JSON.stringify(allPolygonsData, null, 2));

        console.log('\n=== LEAFLET ARRAY FORMAT ===');
        console.log('For direct use in Leaflet:');
        const leafletPolygons = allPolygonsData.map(p => p.leafletFormat);
        console.log(JSON.stringify(leafletPolygons, null, 2));

        console.log('\n=== END EXPORT ===\n');
    }

    /**
     * Toggle ruler tool on/off
     */
    toggleRulerTool() {
        this.rulerEnabled = this.isChecked('ruler-tool');

        if (this.rulerEnabled) {
            // Enable ruler mode
            this.map.getContainer().style.cursor = 'crosshair';

            // Clear any existing ruler measurements
            this.clearRulerMeasurement();

            // Add click event listener for ruler
            this.map.on('click', this.rulerClickHandler.bind(this));
            this.map.on('mousemove', this.rulerMouseMoveHandler.bind(this));

            // Show instructions
            console.log('Ruler tool enabled:');
            console.log('- Click to add measurement points');
            console.log('- Double-click or press Escape to finish');
            console.log('- Total distance will be displayed');

            // Add keyboard listener for Escape key
            this.rulerKeyHandler = (e) => {
                if (e.key === 'Escape') {
                    this.finishRulerMeasurement();
                }
            };
            document.addEventListener('keydown', this.rulerKeyHandler);
        } else {
            // Disable ruler mode
            this.map.getContainer().style.cursor = '';
            this.map.off('click', this.rulerClickHandler);
            this.map.off('mousemove', this.rulerMouseMoveHandler);

            if (this.rulerKeyHandler) {
                document.removeEventListener('keydown', this.rulerKeyHandler);
                this.rulerKeyHandler = null;
            }

            // Clear measurement
            this.clearRulerMeasurement();
        }
    }

    /**
     * Handle click events for ruler tool
     */
    rulerClickHandler(e) {
        if (!this.rulerEnabled) return;

        const latlng = e.latlng;
        this.rulerPoints.push(latlng);

        // Add marker at click point
        const marker = L.circleMarker(latlng, {
            radius: 4,
            color: '#FF0000',
            fillColor: '#FF0000',
            fillOpacity: 1,
            weight: 2
        }).addTo(this.map);
        this.rulerMarkers.push(marker);

        // Update or create polyline
        if (this.rulerPoints.length === 1) {
            // First point - create polyline
            this.rulerPolyline = L.polyline([latlng], {
                color: '#FF0000',
                weight: 3,
                dashArray: '10, 5'
            }).addTo(this.map);
        } else {
            // Update polyline with new points
            this.rulerPolyline.setLatLngs(this.rulerPoints);
        }

        // Calculate and display total distance
        this.updateRulerDistance();
    }

    /**
     * Handle mouse move for ruler tool (show preview line)
     */
    rulerMouseMoveHandler(e) {
        if (!this.rulerEnabled || this.rulerPoints.length === 0) return;

        const latlng = e.latlng;

        // Update polyline to show preview to cursor
        const previewPoints = [...this.rulerPoints, latlng];
        if (this.rulerPolyline) {
            this.rulerPolyline.setLatLngs(previewPoints);
        }

        // Update distance display with preview
        this.updateRulerDistance(latlng);
    }

    /**
     * Calculate and display distance
     */
    updateRulerDistance(previewPoint = null) {
        if (this.rulerPoints.length === 0) return;

        let totalDistance = 0;
        const points = previewPoint ? [...this.rulerPoints, previewPoint] : this.rulerPoints;

        // Calculate total distance
        for (let i = 0; i < points.length - 1; i++) {
            totalDistance += points[i].distanceTo(points[i + 1]);
        }

        // Convert to km
        const distanceKm = (totalDistance / 1000).toFixed(2);

        // Show tooltip at last point
        const lastPoint = points[points.length - 1];

        if (!this.rulerTooltip) {
            this.rulerTooltip = L.tooltip({
                permanent: true,
                direction: 'top',
                className: 'ruler-tooltip'
            })
                .setLatLng(lastPoint)
                .setContent(`${distanceKm} km`)
                .addTo(this.map);
        } else {
            this.rulerTooltip
                .setLatLng(lastPoint)
                .setContent(`${distanceKm} km`);
        }

        // Also log to console
        if (!previewPoint) {
            console.log(`Distance: ${distanceKm} km (${points.length} points)`);
        }
    }

    /**
     * Finish ruler measurement
     */
    finishRulerMeasurement() {
        if (this.rulerPoints.length > 0) {
            this.updateRulerDistance(); // Final distance without preview
            console.log('Measurement complete');
        }

        // Keep the measurement visible but disable adding more points
        const rulerToggle = this.getEl('ruler-tool');
        if (rulerToggle) {
            rulerToggle.checked = false;
        }
        this.toggleRulerTool();
    }

    /**
     * Clear ruler measurement
     */
    clearRulerMeasurement() {
        // Remove polyline
        if (this.rulerPolyline) {
            this.map.removeLayer(this.rulerPolyline);
            this.rulerPolyline = null;
        }

        // Remove markers
        this.rulerMarkers.forEach(marker => {
            this.map.removeLayer(marker);
        });
        this.rulerMarkers = [];

        // Remove tooltip
        if (this.rulerTooltip) {
            this.map.removeLayer(this.rulerTooltip);
            this.rulerTooltip = null;
        }

        // Clear points
        this.rulerPoints = [];
    }

    /**
     * Load custom image overlay
     */
    loadImageOverlay() {
        const imageUrl = this.getEl('image-overlay-url')?.value?.trim();

        if (!imageUrl) {
            alert('Please enter an image URL');
            return;
        }

        // Clear existing overlay
        this.clearImageOverlay();

        console.log('═'.repeat(60));
        console.log('Loading image overlay...');
        console.log(`URL: ${imageUrl}`);

        // Get current map bounds as default placement
        const bounds = this.map.getBounds();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        // Calculate center and size for initial placement (50% of visible area)
        const centerLat = (south + north) / 2;
        const centerLng = (west + east) / 2;
        const latSpan = (north - south) * 0.5;
        const lngSpan = (east - west) * 0.5;

        // Set initial bounds
        this.currentImageBounds = [
            [centerLat - latSpan / 2, centerLng - lngSpan / 2], // Southwest corner
            [centerLat + latSpan / 2, centerLng + lngSpan / 2]  // Northeast corner
        ];

        // Create image overlay
        this.customImageOverlay = L.imageOverlay(imageUrl, this.currentImageBounds, {
            opacity: 0.7,
            interactive: false
        }).addTo(this.map);
        if (imageUrl.startsWith('blob:')) {
            this.customImageObjectUrl = imageUrl;
        }

        // Log initial coordinates
        this.logImageCoordinates();

        console.log('✓ Image overlay loaded');
        console.log('Enable "Resize Mode" to adjust position and size');
        console.log('═'.repeat(60));

        // Show corner markers if resize mode is already enabled
        if (this.imageResizeMode) {
            this.showImageCornerMarkers();
        }
    }

    /**
     * Clear image overlay
     */
    clearImageOverlay() {
        // Remove overlay
        if (this.customImageOverlay) {
            this.map.removeLayer(this.customImageOverlay);
            this.customImageOverlay = null;
        }
        if (this.customImageObjectUrl) {
            URL.revokeObjectURL(this.customImageObjectUrl);
            this.customImageObjectUrl = null;
        }

        // Remove corner markers
        this.hideImageCornerMarkers();

        this.currentImageBounds = null;

        console.log('Image overlay cleared');
    }

    /**
     * Toggle image resize mode
     */
    toggleImageResizeMode() {
        this.imageResizeMode = this.isChecked('enable-image-resize');

        if (this.imageResizeMode) {
            if (!this.customImageOverlay) {
                alert('Please load an image overlay first');
                const resizeToggle = this.getEl('enable-image-resize');
                if (resizeToggle) {
                    resizeToggle.checked = false;
                }
                this.imageResizeMode = false;
                return;
            }

            console.log('Image resize mode enabled');
            console.log('- Drag CORNERS to resize (scale)');
            console.log('- Drag CENTER marker to move entire image');
            console.log('- Map dragging is DISABLED in resize mode');

            // Disable map dragging
            this.map.dragging.disable();

            this.showImageCornerMarkers();
        } else {
            console.log('Image resize mode disabled');

            // Re-enable map dragging
            this.map.dragging.enable();

            this.hideImageCornerMarkers();
        }
    }

    /**
     * Show draggable corner markers for image overlay
     */
    showImageCornerMarkers() {
        if (!this.currentImageBounds) return;

        // Hide existing markers
        this.hideImageCornerMarkers();

        const [[south, west], [north, east]] = this.currentImageBounds;

        // Calculate center
        const centerLat = (south + north) / 2;
        const centerLng = (west + east) / 2;

        // Create CENTER marker for moving entire image
        const centerMarker = L.marker([centerLat, centerLng], {
            draggable: true,
            icon: L.divIcon({
                className: 'image-center-marker',
                html: `<div style="width: 24px; height: 24px; background: #0066FF; border: 3px solid white; border-radius: 50%; cursor: move; box-shadow: 0 2px 6px rgba(0,0,0,0.4);"></div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        }).addTo(this.map);

        centerMarker.isCenter = true;
        centerMarker.originalBounds = JSON.parse(JSON.stringify(this.currentImageBounds));

        centerMarker.on('drag', () => {
            this.moveImageOverlay(centerMarker);
        });

        centerMarker.on('dragend', () => {
            this.moveImageOverlay(centerMarker);
            // Update original bounds for next drag
            centerMarker.originalBounds = JSON.parse(JSON.stringify(this.currentImageBounds));
            this.logImageCoordinates();
        });

        this.imageCornerMarkers.push(centerMarker);

        // Create markers for all 4 corners
        const corners = [
            { lat: south, lng: west, name: 'SW', index: 0 },
            { lat: south, lng: east, name: 'SE', index: 1 },
            { lat: north, lng: east, name: 'NE', index: 2 },
            { lat: north, lng: west, name: 'NW', index: 3 }
        ];

        corners.forEach((corner) => {
            const marker = L.marker([corner.lat, corner.lng], {
                draggable: true,
                icon: L.divIcon({
                    className: 'image-corner-marker',
                    html: `<div style="width: 16px; height: 16px; background: #FF0000; border: 2px solid white; border-radius: 50%; cursor: nwse-resize; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                })
            }).addTo(this.map);

            marker.cornerIndex = corner.index;
            marker.cornerName = corner.name;

            // Add drag event listener for corners
            marker.on('drag', () => {
                this.resizeImageOverlay(marker);
            });

            marker.on('dragend', () => {
                this.resizeImageOverlay(marker);
                this.logImageCoordinates();
            });

            this.imageCornerMarkers.push(marker);
        });
    }

    /**
     * Hide corner markers
     */
    hideImageCornerMarkers() {
        this.imageCornerMarkers.forEach(marker => {
            this.map.removeLayer(marker);
        });
        this.imageCornerMarkers = [];
    }

    /**
     * Move entire image overlay by dragging center marker
     */
    moveImageOverlay(centerMarker) {
        const newCenter = centerMarker.getLatLng();
        const [[origSouth, origWest], [origNorth, origEast]] = centerMarker.originalBounds;

        // Calculate original center
        const origCenterLat = (origSouth + origNorth) / 2;
        const origCenterLng = (origWest + origEast) / 2;

        // Calculate offset
        const offsetLat = newCenter.lat - origCenterLat;
        const offsetLng = newCenter.lng - origCenterLng;

        // Apply offset to all corners
        const south = origSouth + offsetLat;
        const north = origNorth + offsetLat;
        const west = origWest + offsetLng;
        const east = origEast + offsetLng;

        // Update bounds
        this.currentImageBounds = [[south, west], [north, east]];

        // Update image overlay
        if (this.customImageOverlay) {
            this.customImageOverlay.setBounds(this.currentImageBounds);
        }

        // Update corner markers (skip center marker at index 0)
        if (this.imageCornerMarkers.length === 5) {
            this.imageCornerMarkers[1].setLatLng([south, west]); // SW
            this.imageCornerMarkers[2].setLatLng([south, east]); // SE
            this.imageCornerMarkers[3].setLatLng([north, east]); // NE
            this.imageCornerMarkers[4].setLatLng([north, west]); // NW
        }
    }

    /**
     * Resize image overlay by dragging corner markers
     */
    resizeImageOverlay(draggedMarker) {
        const newPos = draggedMarker.getLatLng();
        const [[south, west], [north, east]] = this.currentImageBounds;

        let newSouth = south;
        let newNorth = north;
        let newWest = west;
        let newEast = east;

        // Update bounds based on which corner is being dragged
        switch (draggedMarker.cornerIndex) {
            case 0: // SW corner
                newSouth = newPos.lat;
                newWest = newPos.lng;
                break;
            case 1: // SE corner
                newSouth = newPos.lat;
                newEast = newPos.lng;
                break;
            case 2: // NE corner
                newNorth = newPos.lat;
                newEast = newPos.lng;
                break;
            case 3: // NW corner
                newNorth = newPos.lat;
                newWest = newPos.lng;
                break;
        }

        // Ensure south < north and west < east (prevent flipping)
        if (newSouth >= newNorth) {
            return; // Don't allow flipping vertically
        }
        if (newWest >= newEast) {
            return; // Don't allow flipping horizontally
        }

        // Update bounds
        this.currentImageBounds = [[newSouth, newWest], [newNorth, newEast]];

        // Update image overlay
        if (this.customImageOverlay) {
            this.customImageOverlay.setBounds(this.currentImageBounds);
        }

        // Update all corner markers and center marker
        if (this.imageCornerMarkers.length === 5) {
            // Update center marker
            const centerLat = (newSouth + newNorth) / 2;
            const centerLng = (newWest + newEast) / 2;
            this.imageCornerMarkers[0].setLatLng([centerLat, centerLng]);
            this.imageCornerMarkers[0].originalBounds = JSON.parse(JSON.stringify(this.currentImageBounds));

            // Update corner markers
            this.imageCornerMarkers[1].setLatLng([newSouth, newWest]); // SW
            this.imageCornerMarkers[2].setLatLng([newSouth, newEast]); // SE
            this.imageCornerMarkers[3].setLatLng([newNorth, newEast]); // NE
            this.imageCornerMarkers[4].setLatLng([newNorth, newWest]); // NW
        }
    }

    /**
     * Update image overlay opacity
     */
    updateImageOpacity(opacityValue) {
        if (!this.customImageOverlay) return;

        // Convert 0-100 to 0-1
        const opacity = opacityValue / 100;

        // Update overlay opacity
        this.customImageOverlay.setOpacity(opacity);

        // Update display value
        this.setText('image-opacity-value', opacityValue);
    }

    /**
     * Log image overlay coordinates to console
     */
    logImageCoordinates() {
        if (!this.currentImageBounds) return;

        const [[south, west], [north, east]] = this.currentImageBounds;

        console.log('\n' + '─'.repeat(60));
        console.log('IMAGE OVERLAY COORDINATES:');
        console.log('─'.repeat(60));
        console.log('Southwest corner:', { lat: south.toFixed(6), lng: west.toFixed(6) });
        console.log('Northeast corner:', { lat: north.toFixed(6), lng: east.toFixed(6) });
        console.log('');
        console.log('Bounds array (for Leaflet):');
        console.log(JSON.stringify(this.currentImageBounds, null, 2));
        console.log('');
        console.log('Alternative format:');
        console.log(`South: ${south.toFixed(6)}, West: ${west.toFixed(6)}`);
        console.log(`North: ${north.toFixed(6)}, East: ${east.toFixed(6)}`);
        console.log('─'.repeat(60) + '\n');
    }

    /**
     * Reset area statistics display
     */
    resetAreaStatistics() {
        const ids = [
            'selected-area',
            'selected-population',
            'captured-in-selection',
            'captured-population',
            'highlighted-in-selection',
            'grayed-in-selection',
            'frontline-length',
            'capture-percentage',
            'shadow-population'
        ];
        ids.forEach(id => {
            this.setText(id, '0');
        });
    }

    /**
     * Calculate statistics for selected area
     */
    async calculateSelectedAreaStatistics() {
        if (this.selectedPolygons.length === 0) {
            this.resetAreaStatistics();
            return;
        }

        // Add loading state to UI
        const loaderHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-radius:50%;border-top-color:#fff;animation:btn-spin 0.8s linear infinite;"></span>';
        const ids = [
            'selected-area', 'selected-population', 'captured-in-selection',
            'captured-population', 'highlighted-in-selection', 'grayed-in-selection',
            'frontline-length', 'capture-percentage', 'shadow-population'
        ];
        ids.forEach(id => this.setHTML(id, loaderHTML));

        // Yield to allow the browser to paint loaders
        await new Promise(resolve => setTimeout(resolve, 50));

        // Calculate total selected area
        let totalSelectedArea = 0;
        let totalSelectedPopulation = 0;
        let capturedPopulation = 0;
        let shadowZonePopulation = 0;
        const selectedGeoJSONs = [];

        this.selectedPolygons.forEach(polygon => {
            const geoJSON = polygon.toGeoJSON();
            selectedGeoJSONs.push(geoJSON);

            // Calculate area using turf.js
            const area = turf.area(geoJSON) / 1000000; // Convert to km²
            totalSelectedArea += area;
        });

        // Calculate population in selected areas
        if (this.settlementsData && this.settlementsData.features) {
            const excludeOccupied = this.isChecked('exclude-occupied');

            selectedGeoJSONs.forEach(selectedPolygon => {
                this.settlementsData.features.forEach(settlement => {
                    try {
                        const point = turf.point(settlement.geometry.coordinates);
                        if (turf.booleanPointInPolygon(point, selectedPolygon)) {
                            const population = parseInt(settlement.properties.population) || 0;

                            // Check if settlement is in occupied territory
                            const isOccupied = this.isInOccupiedTerritory(point);

                            // Add to total population only if not excluding occupied territories, or if not occupied
                            if (!excludeOccupied || !isOccupied) {
                                totalSelectedPopulation += population;
                            }
                        }
                    } catch (error) {
                        console.warn('Error processing settlement:', error);
                    }
                });
            });
        }

        // Get current territory data if diff-area is enabled
        let capturedArea = 0;
        let grayedArea = 0;
        let highlightedArea = 0;
        let frontlineLength = 0;

        if (this.isChecked('diff-area') && this.deepLayer.toGeoJSON().features.length > 0) {
            const deepUtils = new DeepUtils(this.deepLayer);

            // Get current end date polygons
            const endDatePolygons = await deepUtils.addDeepMap(this.endDate);

            // Calculate intersection with selected polygons
            selectedGeoJSONs.forEach(selectedPolygon => {
                endDatePolygons.polygons.forEach(territoryPolygon => {
                    try {
                        const territoryGeoJSON = {
                            type: "Feature",
                            geometry: {
                                type: "Polygon",
                                coordinates: [territoryPolygon.coordinates.map(coord => [coord[1], coord[0]])]
                            },
                            properties: territoryPolygon.properties
                        };

                        const intersection = turf.intersect(selectedPolygon, territoryGeoJSON);
                        if (intersection) {
                            const intersectionArea = turf.area(intersection) / 1000000; // Convert to km²

                            // Check territory type by color
                            const stroke = territoryPolygon.properties.stroke;
                            const fill = territoryPolygon.properties.fill;

                            if (stroke === "#a52714" || fill === "#a52714") {
                                capturedArea += intersectionArea;
                            } else if (stroke === "#bcaaa4" || fill === "#bcaaa4") {
                                grayedArea += intersectionArea;
                            } else if (stroke === "#ff5252" || fill === "#ff5252") {
                                capturedArea += intersectionArea; // Controlled areas also count as captured
                            } else if (stroke === "#880e4f" || fill === "#880e4f") {
                                capturedArea += intersectionArea; // 2014 Occupied territories also count as captured
                            }
                        }
                    } catch (error) {
                        console.warn('Error calculating intersection:', error);
                    }
                });
            });

            // Calculate frontline length by converting captured polygons to lines
            selectedGeoJSONs.forEach(selectedPolygon => {
                endDatePolygons.polygons.forEach(territoryPolygon => {
                    try {
                        // Calculate frontline for all occupied territories
                        const stroke = territoryPolygon.properties.stroke;
                        const fill = territoryPolygon.properties.fill;
                        if (stroke === "#a52714" || stroke === "#bcaaa4" || stroke === "#ff5252" || stroke === "#880e4f" ||
                            fill === "#a52714" || fill === "#bcaaa4" || fill === "#ff5252" || fill === "#880e4f") {
                            // Convert captured polygon to line (polygon boundary)
                            const polygonCoords = territoryPolygon.coordinates.map(coord => [coord[1], coord[0]]);
                            const polygonLine = turf.polygonToLine(turf.polygon([polygonCoords]));

                            // Find line segments that intersect with the selected box
                            const lineSegments = this.getLineSegmentsInBox(polygonLine, selectedPolygon);

                            // Measure the total length of line segments within the box
                            lineSegments.forEach(segment => {
                                const segmentLength = turf.length(segment, { units: 'kilometers' });
                                frontlineLength += segmentLength;
                            });
                        }
                    } catch (error) {
                        console.warn('Error calculating frontline length:', error);
                    }
                });
            });

            // Also calculate territory from highlighted areas if highlight is enabled
            if (this.isChecked('diff-highlight') && this.currentDiffResult) {
                // Use the stored diffResult which contains the highlighted difference polygons
                selectedGeoJSONs.forEach(selectedPolygon => {
                    this.currentDiffResult.polygons.forEach(diffPolygon => {
                        try {
                            // Check if this is a difference polygon (highlighted in red)
                            if (diffPolygon.type === 'difference' && diffPolygon.geojson) {
                                const intersection = turf.intersect(selectedPolygon, diffPolygon.geojson);
                                if (intersection) {
                                    const intersectionArea = turf.area(intersection) / 1000000; // Convert to km²
                                    highlightedArea += intersectionArea;
                                    console.log('Found highlighted difference area intersection:', intersectionArea, 'km²');
                                }
                            }
                        } catch (error) {
                            console.warn('Error calculating intersection with highlighted difference area:', error);
                        }
                    });
                });
            }
        }

        // Yield again before the heaviest part of the calculation (app.js:1532) to keep loaders spinning smoothly
        await new Promise(resolve => setTimeout(resolve, 50));

        // Calculate population in captured territories and shadow zones
        if (this.settlementsData && this.settlementsData.features && this.deepLayer.toGeoJSON().features.length > 0) {
            let settlementsInSelection = 0;
            let settlementsInOccupiedTerritory = 0;

            // If no regions selected, calculate for all settlements (for debugging)
            const polygonsToCheck = selectedGeoJSONs.length > 0 ? selectedGeoJSONs : null;

            if (polygonsToCheck) {
                selectedGeoJSONs.forEach(selectedPolygon => {
                    this.settlementsData.features.forEach(settlement => {
                        try {
                            const point = turf.point(settlement.geometry.coordinates);
                            if (turf.booleanPointInPolygon(point, selectedPolygon)) {
                                settlementsInSelection++;
                                const population = parseInt(settlement.properties.population) || 0;

                                // Check if in occupied territory (any colored territory)
                                if (this.isInOccupiedTerritory(point)) {
                                    settlementsInOccupiedTerritory++;
                                    capturedPopulation += population;
                                }

                                // Check if in shadow zone (only if shadow-ua is enabled)
                                if (this.isChecked('shadow-ua') && this.isInShadowZone(point)) {
                                    shadowZonePopulation += population;
                                }
                            }
                        } catch (error) {
                            console.warn('Error processing settlement for captured/shadow zones:', error);
                        }
                    });
                });
            } else {
                console.log('No regions selected, skipping captured population calculation');
            }

            console.log(`Population calculation: ${settlementsInSelection} settlements in selection, ${settlementsInOccupiedTerritory} in occupied territory, total captured population: ${capturedPopulation}`);
        } else {
            console.log('Population calculation skipped:', {
                settlementsData: !!this.settlementsData,
                features: this.settlementsData?.features?.length || 0,
                deepLayerFeatures: this.deepLayer.toGeoJSON().features.length
            });
        }

        // Update UI
        this.setText('selected-area', totalSelectedArea.toFixed(2));
        this.setText('selected-population', totalSelectedPopulation.toLocaleString());
        this.setText('captured-in-selection', capturedArea.toFixed(2));
        this.setText('captured-population', capturedPopulation.toLocaleString());
        this.setText('highlighted-in-selection', highlightedArea.toFixed(2));
        this.setText('grayed-in-selection', grayedArea.toFixed(2));
        this.setText('frontline-length', frontlineLength.toFixed(2));
        this.setText('shadow-population', shadowZonePopulation.toLocaleString());

        // Automatically calculate Unoccupied stats based on area/population differences
        const totalUnoccupiedArea = Math.max(0, totalSelectedArea - capturedArea);
        const totalUnoccupiedPopulation = Math.max(0, totalSelectedPopulation - capturedPopulation);
        this.setText('unoccupied-area', totalUnoccupiedArea.toFixed(2));
        this.setText('unoccupied-population', totalUnoccupiedPopulation.toLocaleString());

        // Calculate total capture percentage including both captured and highlighted areas
        const totalCapturedArea = capturedArea + highlightedArea;
        const capturePercentage = totalSelectedArea > 0 ? (totalCapturedArea / totalSelectedArea * 100) : 0;
        this.setText('capture-percentage', capturePercentage.toFixed(1));

        // Analyze units in selected area if enabled
        if (this.analyzeUnitsEnabled) {
            this.analyzeUnitsInSelectedArea();
        }
    }

    /**
     * Calculate number of settlements in diff area (newly captured territory)
     */
    calculateSettlementsInDiffArea(startDatePolygons, endDatePolygons) {
        if (!this.settlementsData || !this.settlementsData.features) {
            console.log('No settlements data available');
            this.setText('settlements-in-diff', '0');
            return;
        }

        let settlementsCount = 0;

        try {
            // Get polygons that represent newly captured territory (in endDate but not in startDate)
            const deepMap = new DeepUtils(this.deepLayer);

            // Normalize polygons from both dates
            const startPolygons = deepMap.normalizePolygon(startDatePolygons.polygons);
            const endPolygons = deepMap.normalizePolygon(endDatePolygons.polygons);

            // Create union of start date territories
            const startUnion = startPolygons.length > 0 ? deepMap.unionList(startPolygons) : null;

            // Create union of end date territories
            const endUnion = endPolygons.length > 0 ? deepMap.unionList(endPolygons) : null;

            if (!endUnion) {
                console.log('No end date territories to analyze');
                this.setText('settlements-in-diff', '0');
                return;
            }

            // Calculate difference: territories in endDate but not in startDate
            let diffArea = endUnion;
            if (startUnion) {
                try {
                    diffArea = turf.difference(endUnion, startUnion);
                } catch (error) {
                    console.warn('Error calculating diff, using end union:', error);
                    diffArea = endUnion;
                }
            }

            if (!diffArea) {
                console.log('No territorial difference between dates');
                this.setText('settlements-in-diff', '0');
                return;
            }

            // Count settlements in diff area
            this.settlementsData.features.forEach(settlement => {
                try {
                    const point = turf.point(settlement.geometry.coordinates);
                    if (turf.booleanPointInPolygon(point, diffArea)) {
                        settlementsCount++;
                    }
                } catch (error) {
                    // Silently skip settlements with invalid geometry
                }
            });

            console.log(`Settlements in diff area: ${settlementsCount}`);
            this.setText('settlements-in-diff', settlementsCount.toString());

        } catch (error) {
            console.error('Error calculating settlements in diff area:', error);
            this.setText('settlements-in-diff', 'Error');
        }
    }

    /**
     * Check if a point is in occupied territory
     */
    isInOccupiedTerritory(point) {
        if (!this.deepLayer.toGeoJSON().features.length) {
            return false;
        }

        try {
            const deepFeatures = this.deepLayer.toGeoJSON().features;

            // Debug: Log available features on first call
            if (!this._debugLoggedFeatures) {
                console.log(`Deep layer has ${deepFeatures.length} features`);
                const featureColors = deepFeatures.map(f => ({
                    stroke: f.properties?.stroke,
                    fill: f.properties?.fill,
                    color: f.properties?.color
                })).filter(c => c.stroke || c.fill || c.color);
                console.log('Available feature colors:', featureColors.slice(0, 5));
                this._debugLoggedFeatures = true;
            }

            return deepFeatures.some(feature => {
                return turf.booleanPointInPolygon(point, feature);
            });
        } catch (error) {
            console.warn('Error checking occupied territory:', error);
            return false;
        }
    }

    /**
     * Check if a point is in captured territory (red zones from deep map)
     */
    isInCapturedTerritory(point) {
        if (!this.deepLayer.toGeoJSON().features.length) {
            return false;
        }

        try {
            const deepFeatures = this.deepLayer.toGeoJSON().features;
            return deepFeatures.some(feature => {
                // Check if feature is a captured territory (red color)
                if (feature.properties && (feature.properties.stroke === "#a52714" || feature.properties.fill === "#a52714")) {
                    return turf.booleanPointInPolygon(point, feature);
                }
                return false;
            });
        } catch (error) {
            console.warn('Error checking captured territory:', error);
            return false;
        }
    }

    /**
     * Check if a point is in shadow zone
     */
    isInShadowZone(point) {
        if (!this.isChecked('shadow-ua') || !this.deepLayer.toGeoJSON().features.length) {
            return false;
        }

        try {
            const deepFeatures = this.deepLayer.toGeoJSON().features;
            return deepFeatures.some(feature => {
                // Check if feature is a shadow zone (typically rendered with special properties)
                if (feature.properties &&
                    (feature.properties.type === 'shadow' ||
                        feature.properties.className === 'shadow' ||
                        (feature.properties.stroke && feature.properties.stroke.includes('shadow')))) {
                    return turf.booleanPointInPolygon(point, feature);
                }
                return false;
            });
        } catch (error) {
            console.warn('Error checking shadow zone:', error);
            return false;
        }
    }

    /**
     * Calculate unoccupied territory and population for a region
     */
    calculateUnoccupiedStats(regionPolygon) {
        let unoccupiedArea = 0;
        let unoccupiedPopulation = 0;

        try {
            const regionGeoJSON = regionPolygon.toGeoJSON();
            const regionArea = turf.area(regionGeoJSON) / 1000000; // Convert to km²

            // Calculate occupied area within the region (all colored territories)
            let occupiedArea = 0;
            if (this.isChecked('diff-area') && this.deepLayer.toGeoJSON().features.length) {
                const deepFeatures = this.deepLayer.toGeoJSON().features;
                deepFeatures.forEach(feature => {
                    try {
                        // Consider all colored territories as occupied
                        if (feature.properties &&
                            (feature.properties.stroke || feature.properties.fill)) {
                            const stroke = feature.properties.stroke;
                            const fill = feature.properties.fill;

                            // Check for any occupation territory colors
                            if (stroke === "#a52714" || stroke === "#bcaaa4" || stroke === "#ff5252" || stroke === "#880e4f" ||
                                fill === "#a52714" || fill === "#bcaaa4" || fill === "#ff5252" || fill === "#880e4f") {
                                const intersection = turf.intersect(regionGeoJSON, feature);
                                if (intersection) {
                                    occupiedArea += turf.area(intersection) / 1000000;
                                }
                            }
                        }
                    } catch (error) {
                        console.warn('Error calculating occupied area intersection:', error);
                    }
                });
            }

            unoccupiedArea = regionArea - occupiedArea;

            // Calculate population in unoccupied areas
            if (this.settlementsData && this.settlementsData.features) {
                this.settlementsData.features.forEach(settlement => {
                    try {
                        const point = turf.point(settlement.geometry.coordinates);
                        if (turf.booleanPointInPolygon(point, regionGeoJSON) &&
                            !this.isInOccupiedTerritory(point)) {
                            const population = parseInt(settlement.properties.population) || 0;
                            unoccupiedPopulation += population;
                        }
                    } catch (error) {
                        console.warn('Error calculating unoccupied population:', error);
                    }
                });
            }

        } catch (error) {
            console.error('Error calculating unoccupied stats:', error);
        }

        return {
            area: unoccupiedArea,
            population: unoccupiedPopulation
        };
    }

    /**
     * Optimize polygon rendering by unioning territories with the same color
     */
    optimizePolygonsByColor(polygonData) {
        if (!polygonData || !polygonData.polygons) {
            return polygonData;
        }

        try {
            // Group polygons by their stroke/fill color
            const colorGroups = {};

            polygonData.polygons.forEach(polygon => {
                let colorKey = 'default';

                // Determine color key from polygon properties
                if (polygon.properties) {
                    colorKey = polygon.properties.stroke || polygon.properties.fill || 'default';
                } else if (polygon.style) {
                    colorKey = polygon.style.color || polygon.style.fillColor || 'default';
                }

                if (!colorGroups[colorKey]) {
                    colorGroups[colorKey] = {
                        polygons: [],
                        style: polygon.style || this.getDefaultStyleForColor(colorKey),
                        properties: polygon.properties || {}
                    };
                }

                colorGroups[colorKey].polygons.push(polygon);
            });

            // Union polygons within each color group
            const optimizedPolygons = [];

            Object.entries(colorGroups).forEach(([colorKey, group]) => {
                if (group.polygons.length === 1) {
                    // No need to union single polygons
                    optimizedPolygons.push(group.polygons[0]);
                } else if (group.polygons.length > 1) {
                    // Convert polygons to GeoJSON for unioning
                    const geojsons = group.polygons.map(polygon => {
                        if (polygon.geojson) {
                            return polygon.geojson;
                        } else if (polygon.coordinates) {
                            return {
                                type: "Feature",
                                geometry: {
                                    type: "Polygon",
                                    coordinates: [polygon.coordinates.map(coord => [coord[1], coord[0]])]
                                },
                                properties: polygon.properties || {}
                            };
                        }
                        return null;
                    }).filter(Boolean);

                    if (geojsons.length > 0) {
                        try {
                            // Use DeepUtils unionList function
                            const deepUtils = new DeepUtils(this.deepLayer);
                            const unionedGeojson = deepUtils.unionList(geojsons);

                            if (unionedGeojson) {
                                optimizedPolygons.push({
                                    geojson: unionedGeojson,
                                    style: group.style,
                                    properties: {
                                        ...group.properties,
                                        stroke: colorKey !== 'default' ? colorKey : group.properties.stroke,
                                        fill: colorKey !== 'default' ? colorKey : group.properties.fill,
                                        optimized: true,
                                        originalCount: group.polygons.length
                                    },
                                    type: `unioned-${colorKey}`
                                });
                                console.log(`Unioned ${group.polygons.length} polygons of color ${colorKey}`);
                            } else {
                                console.warn(`Failed to union ${group.polygons.length} polygons of color ${colorKey}`);
                                // Fall back to original polygons if union fails
                                optimizedPolygons.push(...group.polygons);
                            }
                        } catch (unionError) {
                            console.warn(`Error unioning polygons of color ${colorKey}:`, unionError);
                            // Fall back to original polygons if union fails
                            optimizedPolygons.push(...group.polygons);
                        }
                    }
                }
            });

            // Log optimization results
            const originalCount = polygonData.polygons.length;
            const optimizedCount = optimizedPolygons.length;
            if (originalCount !== optimizedCount) {
                console.log(`Polygon optimization: ${originalCount} → ${optimizedCount} polygons (${Math.round((originalCount - optimizedCount) / originalCount * 100)}% reduction)`);
            }

            // Return optimized polygon data
            return {
                ...polygonData,
                polygons: optimizedPolygons
            };

        } catch (error) {
            console.warn('Error optimizing polygons by color:', error);
            return polygonData; // Return original data if optimization fails
        }
    }

    /**
     * Get default style for a color key
     */
    getDefaultStyleForColor(colorKey) {
        const colorStyles = {
            '#a52714': {
                color: "#a52714",
                fillColor: "#a52714",
                fillOpacity: 0.2,
                weight: 1
            },
            '#bcaaa4': {
                color: "#bcaaa4",
                fillColor: "#bcaaa4",
                fillOpacity: 0.2,
                weight: 1
            },
            '#ff5252': {
                color: "#ff5252",
                fillColor: "#ff5252",
                fillOpacity: 0.2,
                weight: 1
            },
            '#880e4f': {
                color: "#880e4f",
                fillColor: "#880e4f",
                fillOpacity: 0.2,
                weight: 1
            },
            'default': {
                color: "#3388ff",
                fillColor: "#3388ff",
                fillOpacity: 0.2,
                weight: 1
            }
        };

        return colorStyles[colorKey] || colorStyles['default'];
    }

    /**
     * Calculate unoccupied statistics for all selected regions
     */


    /**
     * Calculate the perimeter of a polygon in kilometers
     */
    calculatePolygonPerimeter(polygon) {
        try {
            // Use turf.js to calculate the perimeter/length of the polygon
            const length = turf.length(polygon, { units: 'kilometers' });
            return length;
        } catch (error) {
            console.warn('Error calculating polygon perimeter:', error);
            return 0;
        }
    }

    /**
     * Get line segments that fall within the selected box/polygon
     */
    getLineSegmentsInBox(line, selectedPolygon) {
        const segments = [];

        try {
            // Convert line to individual segments
            const coordinates = line.geometry.coordinates;

            for (let i = 0; i < coordinates.length - 1; i++) {
                const segmentStart = coordinates[i];
                const segmentEnd = coordinates[i + 1];

                // Create a line segment
                const segment = turf.lineString([segmentStart, segmentEnd]);

                // Check if segment intersects with the selected polygon
                const intersection = this.getLinePolygonIntersection(segment, selectedPolygon);

                if (intersection && intersection.length > 0) {
                    // Add intersected segments
                    intersection.forEach(intersectedSegment => {
                        segments.push(intersectedSegment);
                    });
                }
            }

        } catch (error) {
            console.warn('Error processing line segments:', error);
        }

        return segments;
    }

    /**
     * Get intersection between a line segment and a polygon
     */
    getLinePolygonIntersection(lineSegment, polygon) {
        try {
            // Simplified approach: check if line endpoints are within polygon
            const startPoint = turf.point(lineSegment.geometry.coordinates[0]);
            const endPoint = turf.point(lineSegment.geometry.coordinates[1]);

            const startInside = turf.booleanPointInPolygon(startPoint, polygon);
            const endInside = turf.booleanPointInPolygon(endPoint, polygon);

            if (startInside && endInside) {
                // Entire line segment is within polygon
                return [lineSegment];
            } else if (startInside || endInside) {
                // Partial intersection - use simplified clipping
                try {
                    const intersection = turf.lineIntersect(lineSegment, polygon);
                    if (intersection.features.length > 0) {
                        const intersectionCoord = intersection.features[0].geometry.coordinates;

                        if (startInside && !endInside) {
                            // Line starts inside, ends outside
                            const clippedSegment = turf.lineString([lineSegment.geometry.coordinates[0], intersectionCoord]);
                            return [clippedSegment];
                        } else if (!startInside && endInside) {
                            // Line starts outside, ends inside
                            const clippedSegment = turf.lineString([intersectionCoord, lineSegment.geometry.coordinates[1]]);
                            return [clippedSegment];
                        }
                    }

                    // Fallback: if intersection detection fails but we know one point is inside,
                    // just return a portion of the line
                    if (startInside) {
                        return [lineSegment]; // Return full segment as approximation
                    }
                } catch (intersectionError) {
                    console.warn('Line intersection calculation failed, using fallback');
                    // Fallback: return the segment if at least one endpoint is inside
                    if (startInside || endInside) {
                        return [lineSegment];
                    }
                }
            } else {
                // Check if line passes through polygon
                try {
                    const intersection = turf.lineIntersect(lineSegment, polygon);
                    if (intersection.features.length >= 2) {
                        // Line passes through - return approximate segment
                        return [lineSegment];
                    }
                } catch (intersectionError) {
                    // Ignore intersection errors for lines that don't touch polygon
                }
            }

            return [];

        } catch (error) {
            console.warn('Error calculating line-polygon intersection:', error);
            return [];
        }
    }

    /**
     * Get unit hierarchy level (higher number = larger unit)
     */
    getUnitLevel(unitName) {
        const unitHierarchy = {
            'Squad': 1,
            'Platoon': 2,
            'Company': 3,
            'Detachment': 4,
            'Battalion': 5,
            'Regiment': 6,
            'Brigade': 7,
            'Corps': 8
        };

        for (const [type, level] of Object.entries(unitHierarchy)) {
            if (unitName.match(new RegExp(`\\b${type}\\b`, 'i'))) {
                return level;
            }
        }

        // Default level for unknown units
        return 3;
    }

    /**
     * Analyze military units within selected polygons
     */
    analyzeUnitsInSelectedArea() {
        if (!this.positionsData || !this.positionsData.features || this.selectedPolygons.length === 0) {
            this.setText('units-count', '0');
            this.setHTML('units-list', '<p style="color: #666; font-style: italic;">No positions data or selected area</p>');
            return;
        }

        const unitsInArea = [];
        const selectedGeoJSONs = this.selectedPolygons.map(polygon => polygon.toGeoJSON());

        this.positionsData.features.forEach(feature => {
            if (feature.geometry && feature.geometry.type === 'Point') {
                const point = turf.point(feature.geometry.coordinates);

                // Check if point is within any selected polygon
                const isInSelectedArea = selectedGeoJSONs.some(selectedPolygon => {
                    try {
                        return turf.booleanPointInPolygon(point, selectedPolygon);
                    } catch (error) {
                        console.warn('Error checking point in polygon:', error);
                        return false;
                    }
                });

                if (isInSelectedArea && feature.properties) {
                    // Extract unit name (try different possible property names)
                    const unitName = feature.properties.Name ||
                        feature.properties.name ||
                        feature.properties.unit ||
                        feature.properties.designation ||
                        feature.properties.title ||
                        'Unknown Unit';

                    unitsInArea.push({
                        name: unitName,
                        properties: feature.properties,
                        coordinates: feature.geometry.coordinates
                    });
                }
            }
        });

        // Calculate unit types and estimated personnel
        const typeSizeMap = {
            'Corps': 15000,
            'Brigade': 3000,
            'Regiment': 1500,
            'Battalion': 500,
            'Detachment': 300,
            'Company': 120,
            'Center': 1000,
            'Group': 100,
            'Squad': 30,
            'Platoon': 40,
        };

        // Group units by name first
        const unitCounts = {};
        unitsInArea.forEach(unit => {
            unitCounts[unit.name] = (unitCounts[unit.name] || 0) + 1;
        });

        // Filter out subordinate units if parent exists and exclude Corps
        const filteredUnits = {};
        const allUnitNames = Object.keys(unitCounts);

        for (const unitName of allUnitNames) {
            // Skip Corps units entirely
            if (unitName.match(/\bCorps\b/i)) {
                continue;
            }

            let isSubordinate = false;

            // Check if this unit is subordinate to any other unit in the list
            // Look for patterns like "Battalion of the Brigade" or "Battalion Brigade"
            if (!unitName.match(/\bSeparate\b/i)) { // Separate units can't belong to anyone
                for (const otherUnitName of allUnitNames) {
                    if (otherUnitName !== unitName) {
                        // Method 1: Extract parent unit name from "of the" patterns like:
                        // "74th Battalion of 102nd TDF Brigade" -> "102nd TDF Brigade"
                        const parentMatch = unitName.match(/of (.+?)$/i);
                        if (parentMatch) {
                            const parentName = parentMatch[1];
                            // Check if the exact parent unit exists in our list
                            if (allUnitNames.some(name => name === parentName)) {
                                isSubordinate = true;
                                console.log(`Found subordinate: "${unitName}" is part of "${parentName}"`);
                                break;
                            }
                        }

                        // Method 2: Check for patterns where subordinate contains parent unit identifiers
                        // Like "2nd Mechanized Battalion of Presidential Brigade" and "Presidential Brigade"
                        const words = otherUnitName.split(' ');
                        const significantWords = words.filter(word =>
                            word.length > 2 &&
                            !word.match(/^\d/) &&
                            !['of', 'the', 'Battalion', 'Brigade', 'Regiment', 'Company', 'Detachment', 'TDF'].includes(word)
                        );

                        // Only check if we have significant identifying words
                        if (significantWords.length > 0) {
                            // Check if this unit name contains all significant words from a potential parent
                            const unitContainsAllWords = significantWords.every(word =>
                                unitName.toLowerCase().includes(word.toLowerCase())
                            );

                            // Additional check: make sure the current unit is actually smaller than the other
                            const currentUnitLevel = this.getUnitLevel(unitName);
                            const otherUnitLevel = this.getUnitLevel(otherUnitName);

                            if (unitContainsAllWords &&
                                unitName !== otherUnitName &&
                                currentUnitLevel < otherUnitLevel) {
                                isSubordinate = true;
                                console.log(`Found subordinate: "${unitName}" is part of "${otherUnitName}"`);
                                break;
                            }
                        }
                    }
                }
            }

            if (!isSubordinate) {
                filteredUnits[unitName] = unitCounts[unitName];
            }
        }

        let totalEstimatedPersonnel = 0;
        const unitTypeBreakdown = {};

        // Calculate personnel for filtered units only
        Object.keys(filteredUnits).forEach(unitName => {
            // Extract unit type from name
            const typeMatch = unitName.match(/\b(Brigade|Regiment|Battalion|Detachment|Company|Center|Group|Squad|Platoon)\b/i);
            if (typeMatch) {
                const unitType = typeMatch[1];
                const unitSize = typeSizeMap[unitType] || 100;
                totalEstimatedPersonnel += unitSize;

                unitTypeBreakdown[unitType] = (unitTypeBreakdown[unitType] || 0) + 1;
            } else {
                // If no type match, assume it's a smaller unit
                totalEstimatedPersonnel += 100;
                unitTypeBreakdown['Other'] = (unitTypeBreakdown['Other'] || 0) + 1;
            }
        });

        // Update UI
        this.setText('units-count', unitsInArea.length);
        const unitsList = this.getEl('units-list');
        if (!unitsList) {
            return;
        }
        if (unitsInArea.length === 0) {
            unitsList.innerHTML = '<p style="color: #666; font-style: italic;">No military units found in selected area</p>';
        } else {
            // Create summary section
            const typeBreakdownHTML = Object.entries(unitTypeBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => `<span style="margin-right: 10px; font-size: 12px; background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${type}: ${count}</span>`)
                .join('');

            const summaryHTML = `
                <div style="margin-bottom: 15px; padding: 10px; background: #f9f9f9; border-radius: 5px;">
                    <div style="font-weight: bold; margin-bottom: 5px;">Estimated Personnel: ${totalEstimatedPersonnel.toLocaleString()}</div>
                    <div style="margin-bottom: 5px;">Unit Types:</div>
                    <div>${typeBreakdownHTML}</div>
                </div>
            `;

            // Create detailed units list (filtered units only)
            const unitsHTML = Object.entries(filteredUnits)
                .sort((a, b) => b[1] - a[1]) // Sort by count descending
                .map(([name, count]) => {
                    const countText = count > 1 ? ` (${count})` : '';

                    // Extract type and estimated size for this unit
                    const typeMatch = name.match(/\b(Brigade|Regiment|Battalion|Detachment|Company|Center|Group|Squad|Platoon)\b/i);
                    const unitType = typeMatch ? typeMatch[1] : 'Other';
                    const estimatedSize = typeSizeMap[unitType] || 100;

                    return `<div style="padding: 3px 0; border-bottom: 1px solid #eee;">
                              <strong>${name}</strong>${countText}
                              <span style="float: right; font-size: 11px; color: #666;">~${estimatedSize.toLocaleString()}</span>
                            </div>`;
                })
                .join('');

            // Show filtered count info
            let filteredInfo = '';
            const totalUnits = Object.keys(unitCounts).length;
            const filteredCount = Object.keys(filteredUnits).length;
            if (totalUnits !== filteredCount) {
                filteredInfo = `<div style="font-size: 11px; color: #666; margin-bottom: 10px;">
                    Showing ${filteredCount} independent units (${totalUnits - filteredCount} subordinate units excluded)
                </div>`;
            }

            unitsList.innerHTML = summaryHTML + filteredInfo + unitsHTML;
        }
    }

    /**
     * Handle source change event for checkboxes
     */
    async handleSourceChange() {
        return this.dataStore.handleSourceChange();
    }

    /**
     * Load data for a specific source
     */
    async loadSourceData(source) {
        return this.dataStore.loadSourceData(source);
    }

    /**
     * Combine data from selected sources
     */
    combineSourceData() {
        return this.dataStore.combineSourceData();
    }

    /**
     * Get marker color based on source
     */
    getMarkerColor(source) {
        switch (source) {
            case 'gsua': return 'blue';
            case 'mod': return 'red';
            case 'air': return 'orange';
            default: return 'grey';
        }
    }

    /**
     * Create colored marker icon
     */
    createColoredMarkerIcon(color, count = 1) {
        if (count === 1) {
            // Standard marker for single incident
            return new L.Icon({
                iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-${color}.png`,
                shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            });
        } else {
            // Create a div icon with count badge for multiple incidents
            const colorMap = {
                'blue': '#3388ff',
                'red': '#d33c3c',
                'orange': '#ff8800',
                'grey': '#888888'
            };
            const bgColor = colorMap[color] || '#888888';

            return L.divIcon({
                className: 'custom-marker-icon',
                html: `
                    <div style="position: relative;">
                        <img src="https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-${color}.png"
                             style="width: 25px; height: 41px;" />
                        <div style="
                            position: absolute;
                            top: -8px;
                            right: -8px;
                            background: ${bgColor};
                            color: white;
                            border: 2px solid white;
                            border-radius: 50%;
                            width: 22px;
                            height: 22px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 11px;
                            font-weight: bold;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                        ">${count}</div>
                    </div>
                `,
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34]
            });
        }
    }

    /**
     * Get attack color based on count
     */
    getAttackColor(count) {
        if (count >= 50) return 'red';
        if (count >= 20) return 'orange';
        if (count >= 10) return 'blue';
        if (count > 0) return 'green';
        return 'gray';
    }

    /**
     * Get attack intensity class
     */
    getAttackClass(count) {
        if (count >= 50) return 'high-attacks';
        if (count >= 20) return 'medium-attacks';
        return 'low-attacks';
    }

    /**
     * Add legend to map
     */
    addLegend() {
        const legend = L.control({ position: 'bottomright' });

        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'legend');
            div.id = 'attack-legend';
            div.innerHTML = `
                <div class="legend-title">Attack Intensity</div>
                <div class="legend-item">
                    <div class="legend-color" style="background-color: #d9534f;"></div>
                    <span>High (50+)</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background-color: #f0ad4e;"></div>
                    <span>Medium (20-49)</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background-color: #5bc0de;"></div>
                    <span>Low-Medium (10-19)</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background-color: #5cb85c;"></div>
                    <span>Low (1-9)</span>
                </div>
            `;
            this.attackLegendEl = div;
            this.updateAttackLegendVisibility();
            return div;
        };

        legend.addTo(this.map);
    }

    updateAttackLegendVisibility() {
        if (!this.attackLegendEl) {
            return;
        }
        this.attackLegendEl.style.display = this.isChecked('show-regions') ? '' : 'none';
    }

    /**
     * Format date for display
     */
    formatDate(dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    /**
     * Initialize date slider
     */
    initSlider(minDate, maxDate, firstDate = 0, lastDate = 0) {
        const slider = this.getEl('date-slider');
        if (!slider) {
            return;
        }

        if (slider.noUiSlider) {
            slider.noUiSlider.destroy();
        }

        const startTimestamp = new Date(firstDate || minDate).getTime();
        const endTimestamp = new Date(lastDate || maxDate).getTime();

        const sliderConfig = {
            start: [startTimestamp, endTimestamp],
            connect: true,
            step: 86400000,
            range: {
                'min': new Date(minDate).getTime(),
                'max': new Date(maxDate).getTime()
            }
        };

        if (this.sliderLock) {
            Object.assign(sliderConfig, {
                behaviour: 'drag',
                margin: this.sliderLock,
                limit: this.sliderLock
            });
        }

        noUiSlider.create(slider, sliderConfig);

        slider.noUiSlider.on('update', (values) => {
            this.startDate = new Date(parseInt(values[0]));
            this.endDate = new Date(parseInt(values[1]));

            const dateLabel = this.getEl('date');
            if (dateLabel) {
                dateLabel.textContent = `${this.formatDate(this.startDate)} - ${this.formatDate(this.endDate)}`;
            }

            this.scheduleUpdateMap();
            this.syncDiffSliceRange();
            if (this.updateDailyPositions) {
                this.updateDailyPositions();
            }
            if (this.renderPositionChanges && this.isChecked('position-change')) {
                this.renderPositionChanges();
            }
        });
    }

    initDiffSlices() {
        const countEl = this.getEl('diff-slices-count');
        if (!countEl) {
            return;
        }
        const count = parseInt(countEl.value, 10) || 0;
        this.setDiffSliceCount(count);
    }

    setDiffSliceCount(count) {
        const clamped = Math.max(0, Math.min(5, count));
        const countEl = this.getEl('diff-slices-count');
        if (countEl) {
            countEl.value = clamped;
        }
        this.diffSliceCount = clamped;
        const sliderEl = this.getEl('diff-slices-slider');
        if (!sliderEl) {
            return;
        }
        if (sliderEl.noUiSlider) {
            sliderEl.noUiSlider.destroy();
        }
        this.diffSliceSlider = null;
        this.diffSliceDates = [];

        if (clamped === 0) {
            this.updateDiffSliceLabels();
            this.scheduleUpdateMap();
            return;
        }

        const startValues = this.getDiffSliceStartValues(clamped);
        noUiSlider.create(sliderEl, {
            start: startValues,
            connect: false,
            step: 86400000,
            range: {
                min: this.getDiffSliceRangeStart(),
                max: this.getDiffSliceRangeEnd()
            }
        });

        this.diffSliceSlider = sliderEl.noUiSlider;
        this.diffSliceSlider.on('update', (values) => {
            this.diffSliceDates = values.map(value => new Date(parseInt(value, 10)));
            this.updateDiffSliceLabels();
            this.scheduleUpdateMap();
        });
    }

    getDiffSliceRangeStart() {
        const start = this.startDate || this.minDate;
        return start ? start.getTime() : Date.now();
    }

    getDiffSliceRangeEnd() {
        const end = this.endDate || this.maxDate;
        return end ? end.getTime() : Date.now();
    }

    getDiffSliceStartValues(count) {
        const start = this.startDate || this.minDate;
        const end = this.endDate || this.maxDate;
        if (!start || !end) {
            return [];
        }
        const startMs = start.getTime();
        const endMs = end.getTime();
        const span = endMs - startMs;
        if (span <= 0) {
            return [];
        }
        const values = [];
        for (let i = 1; i <= count; i++) {
            values.push(startMs + (span * i) / (count + 1));
        }
        return values;
    }

    syncDiffSliceRange() {
        if (!this.diffSliceSlider || !this.diffSliceCount) {
            return;
        }
        const startMs = this.getDiffSliceRangeStart();
        const endMs = this.getDiffSliceRangeEnd();
        const span = endMs - startMs;
        if (span <= 0) {
            return;
        }
        let ratios = [];
        if (this.diffSliceDates.length === this.diffSliceCount) {
            ratios = this.diffSliceDates.map(date => (date.getTime() - startMs) / span);
        } else {
            for (let i = 1; i <= this.diffSliceCount; i++) {
                ratios.push(i / (this.diffSliceCount + 1));
            }
        }
        const values = ratios.map(ratio => {
            const clamped = Math.max(0.02, Math.min(0.98, ratio));
            return startMs + clamped * span;
        });

        this.diffSliceSlider.updateOptions({
            range: { min: startMs, max: endMs }
        }, false);
        this.diffSliceSlider.set(values);
    }

    updateDiffSliceLabels() {
        const labelsEl = this.getEl('diff-slices-labels');
        if (labelsEl) {
            labelsEl.textContent = this.diffSliceDates.length
                ? this.diffSliceDates.map(date => this.formatDate(date)).join(' | ')
                : '';
        }

        const dateEl = this.getEl('date');
        if (dateEl) {
            if (this.diffSliceDates.length) {
                const sorted = this.diffSliceDates
                    .slice().sort((a, b) => a - b)
                    .map(date => this.formatDate(date));
                dateEl.textContent = [this.formatDate(this.startDate), ...sorted, this.formatDate(this.endDate)].join(' - ');
            } else {
                dateEl.textContent = `${this.formatDate(this.startDate)} - ${this.formatDate(this.endDate)}`;
            }
        }
    }

    getDiffSliceDates() {
        return this.diffSliceDates.slice().sort((a, b) => a - b);
    }

    scheduleUpdateMap(delay = 150) {
        if (this.updateMapDebounce) {
            clearTimeout(this.updateMapDebounce);
        }
        this.updateMapDebounce = setTimeout(() => {
            this.updateMap();
        }, delay);
    }

    /**
     * Filter data by date range
     */
    filterDataByDateRange() {
        const capturedOnly = this.isChecked('captured');
        const filteredDirectionData = this.directionData.filter(item => {
            const itemDate = item._date || new Date(item.Date);
            if (capturedOnly && itemDate.getDay() !== 5) return false;
            return itemDate >= this.startDate && itemDate <= this.endDate;
        });

        const filteredLocationData = this.locationData.filter(item => {
            const itemDate = item._date || new Date(item.date);
            if (capturedOnly && itemDate.getDay() !== 5) return false;
            if (this.selectRegions.length && !this.selectRegions.includes(item.region)) return false;
            return itemDate >= this.startDate && itemDate <= this.endDate;
        });

        return {
            directionData: filteredDirectionData,
            locationData: filteredLocationData
        };
    }

    /**
     * Update slider values
     */
    updateSliderValues(start, end) {
        const slider = this.getEl('date-slider')?.noUiSlider;
        if (!slider) {
            return;
        }
        slider.set([start.getTime(), end.getTime()]);
    }

    /**
     * Play/pause animation
     */
    playAnimation() {
        if (this.isPlaying) {
            this.stopAnimation();
            return;
        }

        const playbackSpeed = parseInt(this.getEl('playback-speed')?.value, 10);
        this.playbackSpeed = Number.isFinite(playbackSpeed) ? playbackSpeed : this.playbackSpeed;
        this.isPlaying = true;

        const playBtn = this.getEl('play-btn');
        if (playBtn) {
            playBtn.querySelector('.icon-play').style.display = 'none';
            playBtn.querySelector('.icon-pause').style.display = '';
            playBtn.classList.add('playing');
        }

        const stepSizeMs = 86400000;
        this.animationInterval = setInterval(() => {
            this.startDate = new Date(this.startDate.getTime() + stepSizeMs);
            this.endDate = new Date(this.endDate.getTime() + stepSizeMs);

            if (this.endDate > this.maxDate) {
                this.stopAnimation();
                return;
            }

            this.updateSliderValues(this.startDate, this.endDate);
        }, this.playbackSpeed);
    }

    /**
     * Stop animation
     */
    stopAnimation() {
        if (this.animationInterval) {
            clearInterval(this.animationInterval);
            this.animationInterval = null;
        }

        this.isPlaying = false;
        const playBtn = this.getEl('play-btn');
        if (playBtn) {
            playBtn.querySelector('.icon-play').style.display = '';
            playBtn.querySelector('.icon-pause').style.display = 'none';
            playBtn.classList.remove('playing');
        }
    }

    /**
     * Copy frontline functionality
     */
    copyFront() {
        if (this.isChecked('copy-btn')) {
            this.copiedFrontline = this.cachedFrontline;
        } else {
            this.copiedFrontline = [];
        }
    }

    /**
     * Update map markers and display
     */
    updateMap() {
        // Clear both marker layers
        this.markers.clearLayers();
        this.ungroupedMarkers.clearLayers();

        const filteredData = this.filterDataByDateRange();
        const stats = this.calculateAttackStatistics(filteredData.directionData);
        this.updateStatistics(stats);

        // Add location markers with optional grouping by settlement and source
        if (!this.isChecked('hide-markers')) {
            const groupMarkers = this.getEl('group-markers')?.checked !== false;

            if (groupMarkers) {
                // GROUPED MODE: Use cluster group with our custom grouping
                this.map.removeLayer(this.ungroupedMarkers);
                if (!this.map.hasLayer(this.markers)) {
                    this.map.addLayer(this.markers);
                }

                // Group markers by location (coordinates), settlement name, and source
                const markerGroups = {};

                filteredData.locationData.forEach(item => {
                    if (!(parseFloat(item.Lat) && parseFloat(item.Lon))) {
                        return;
                    }

                    // Create a unique key based on coordinates, settlement name, and source
                    const locationKey = `${parseFloat(item.Lat).toFixed(4)}_${parseFloat(item.Lon).toFixed(4)}`;
                    const settlementName = item.location || item.settlement || 'Unknown';
                    const source = item.source || 'unknown';
                    const groupKey = source === 'gsua'
                        ? `${locationKey}_${source}`
                        : `${locationKey}_${settlementName}_${source}`;

                    if (!markerGroups[groupKey]) {
                        markerGroups[groupKey] = {
                            lat: parseFloat(item.Lat),
                            lon: parseFloat(item.Lon),
                            settlement: settlementName,
                            settlements: new Set(),
                            region: item.region,
                            source: source,
                            dates: [],
                            count: 0
                        };
                    }

                    markerGroups[groupKey].settlements.add(settlementName);
                    markerGroups[groupKey].dates.push(new Date(item.date));
                    markerGroups[groupKey].count++;
                });

                // Create a single marker for each grouped location-source combination
                Object.values(markerGroups).forEach(group => {
                    const regionAttacks = stats.regions[group.region] || 0;
                    const markerColor = this.getMarkerColor(group.source);
                    const coloredIcon = this.createColoredMarkerIcon(markerColor, group.count);

                    // Sort dates to get first and last
                    group.dates.sort((a, b) => a - b);
                    const firstDate = group.dates[0];
                    const lastDate = group.dates[group.dates.length - 1];

                    // Create popup content with aggregated information
                    let popupContent = `<div style="min-width: 200px;">`;
                    if (group.source === 'gsua' && group.settlements.size > 1) {
                        const names = Array.from(group.settlements);
                        const preview = names.slice(0, 5).join(', ');
                        const suffix = names.length > 5 ? ` +${names.length - 5} more` : '';
                        popupContent += `<strong>${preview}${suffix}</strong><br>`;
                    } else {
                        popupContent += `<strong>${group.settlement}</strong><br>`;
                    }
                    popupContent += `Region: ${group.region}<br>`;
                    popupContent += `Source: ${group.source.toUpperCase()}<br>`;
                    popupContent += `<strong>Incidents: ${group.count}</strong><br>`;

                    if (group.count === 1) {
                        popupContent += `Date: ${this.formatDate(firstDate)}<br>`;
                    } else {
                        popupContent += `First: ${this.formatDate(firstDate)}<br>`;
                        popupContent += `Last: ${this.formatDate(lastDate)}<br>`;

                        // Calculate days span
                        const daysDiff = Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24));
                        if (daysDiff > 0) {
                            popupContent += `Period: ${daysDiff} day${daysDiff !== 1 ? 's' : ''}<br>`;
                        }

                        // Add expandable list of all dates if there are multiple incidents
                        if (group.count <= 10) {
                            // Show all dates for small counts
                            popupContent += `<details style="margin-top: 5px;">`;
                            popupContent += `<summary style="cursor: pointer; color: #3388ff;">Show all dates (${group.count})</summary>`;
                            popupContent += `<div style="margin-top: 5px; margin-left: 10px;">`;
                            group.dates.forEach((date, idx) => {
                                popupContent += `${idx + 1}. ${this.formatDate(date)}<br>`;
                            });
                            popupContent += `</div></details>`;
                        } else {
                            // Show frequency summary for large counts
                            const dateCounts = {};
                            group.dates.forEach(date => {
                                const dateStr = this.formatDate(date);
                                dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
                            });
                            popupContent += `<details style="margin-top: 5px;">`;
                            popupContent += `<summary style="cursor: pointer; color: #3388ff;">Show date frequency (${group.count} total)</summary>`;
                            popupContent += `<div style="margin-top: 5px; margin-left: 10px; max-height: 150px; overflow-y: auto;">`;
                            Object.entries(dateCounts).sort().forEach(([dateStr, count]) => {
                                popupContent += `${dateStr}: ${count}×<br>`;
                            });
                            popupContent += `</div></details>`;
                        }
                    }

                    popupContent += `Region attacks: ${regionAttacks}<br>`;
                    popupContent += `<small style="color: #666;">Coords: ${group.lat.toFixed(4)}, ${group.lon.toFixed(4)}</small>`;

                    // Add Edit Location button
                    const markerId = `marker_${group.settlement}_${group.lat}_${group.lon}`.replace(/[^a-zA-Z0-9_]/g, '_');
                    popupContent += `
                        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd;">
                            <button
                                onclick="window.markerAdjuster && window.markerAdjuster.showSettlementPicker('${markerId}', ${group.lat}, ${group.lon})"
                                style="background-color: #5cb85c; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%;"
                            >
                                Edit Location
                            </button>
                        </div>
                    `;
                    popupContent += `</div>`;

                    const marker = L.marker([group.lat, group.lon], { icon: coloredIcon })
                        .bindPopup(popupContent);

                    this.markers.addLayer(marker);
                });
            } else {
                // UNGROUPED MODE: Create individual markers without any clustering
                this.map.removeLayer(this.markers);
                if (!this.map.hasLayer(this.ungroupedMarkers)) {
                    this.map.addLayer(this.ungroupedMarkers);
                }

                // Add each marker individually to the ungrouped layer
                filteredData.locationData.forEach(item => {
                    if (!(parseFloat(item.Lat) && parseFloat(item.Lon))) {
                        return;
                    }

                    const regionAttacks = stats.regions[item.region] || 0;
                    const markerColor = this.getMarkerColor(item.source);
                    const coloredIcon = this.createColoredMarkerIcon(markerColor);

                    const markerId = `marker_${item.location || item.settlement}_${item.Lat}_${item.Lon}`.replace(/[^a-zA-Z0-9_]/g, '_');
                    const popupContent = `
                        <div>
                            <strong>${item.location || item.settlement}</strong><br>
                            Region: ${item.region}<br>
                            Date: ${this.formatDate(item.date)}<br>
                            Source: ${item.source ? item.source.toUpperCase() : 'Unknown'}<br>
                            Region attacks: ${regionAttacks}
                            <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd;">
                                <button
                                    onclick="window.markerAdjuster && window.markerAdjuster.showSettlementPicker('${markerId}', ${item.Lat}, ${item.Lon})"
                                    style="background-color: #5cb85c; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; width: 100%;"
                                >
                                    Edit Location
                                </button>
                            </div>
                        </div>
                    `;

                    const marker = L.marker([item.Lat, item.Lon], { icon: coloredIcon })
                        .bindPopup(popupContent);

                    // Add to ungrouped layer (no clustering)
                    this.ungroupedMarkers.addLayer(marker);
                });
            }
        } else {
            // When markers are hidden, ensure both layers are removed
            this.map.removeLayer(this.markers);
            this.map.removeLayer(this.ungroupedMarkers);
        }

        // Handle GSUA heatmap layer
        if (this.heatmapLayer) {
            this.map.removeLayer(this.heatmapLayer);
        }

        if (this.isChecked('source-gsua-heatmap')) {
            // Build heatmap data from GSUA markers using group.count as intensity
            const heatmapData = [];
            const gsuaGroups = {};

            filteredData.locationData.forEach(item => {
                if (!(parseFloat(item.Lat) && parseFloat(item.Lon))) {
                    return;
                }
                if (item.source !== 'gsua') {
                    return;
                }

                const locationKey = `${parseFloat(item.Lat).toFixed(4)}_${parseFloat(item.Lon).toFixed(4)}`;
                const groupKey = `${locationKey}_gsua`;

                if (!gsuaGroups[groupKey]) {
                    gsuaGroups[groupKey] = {
                        lat: parseFloat(item.Lat),
                        lon: parseFloat(item.Lon),
                        count: 0
                    };
                }
                gsuaGroups[groupKey].count++;
            });

            // Convert to heatmap format [lat, lng, intensity]
            Object.values(gsuaGroups).forEach(group => {
                heatmapData.push([group.lat, group.lon, group.count]);
            });

            if (heatmapData.length > 0) {
                // Find max count for normalization
                const maxCount = Math.max(...heatmapData.map(d => d[2]));
                this.heatmapLayer = L.heatLayer(heatmapData, {
                    radius: 35,
                    blur: 25,
                    maxZoom: 10,
                    max: maxCount,
                    gradient: {
                        0.2: 'blue',
                        0.4: 'cyan',
                        0.6: 'lime',
                        0.8: 'yellow',
                        1.0: 'red'
                    }
                }).addTo(this.map);
            }
        }

        if (!Object.entries(this.directionBorders).length && filteredData.locationData.length && this.deepLayer.toGeoJSON().features.length) {
            const boundary = this.deepLayer.toGeoJSON().features.reduce((a, b) => turf.union(a, b));
            const allPoints = uniquePoints(turf.featureCollection(
                filteredData.locationData.filter(item => (parseFloat(item.Lat) && parseFloat(item.Lon))).map((item) =>
                    turf.point([parseFloat(item.Lon), parseFloat(item.Lat)], { direction: item.region })
                )
            ));

            function uniquePoints(points) {
                const seen = new Set();
                return turf.featureCollection(
                    points.features.filter(pt => {
                        const key = pt.geometry.coordinates.join(',');
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    })
                );
            }

            const voronoiPolygons = turf.voronoi(allPoints, { bbox: turf.bbox(boundary) });

            const cellsByDirection = {};
            voronoiPolygons.features.forEach(cell => {
                const dir = cell.properties?.direction;
                if (!dir) {
                    // Find which point is within the cell to get direction
                    const centroid = turf.centroid(cell);
                    const point = allPoints.features.find(pt =>
                        turf.booleanPointInPolygon(pt, cell)
                    );
                    if (point) cell.properties = point.properties;
                }
                const direction = cell.properties?.direction;
                if (direction) {
                    cellsByDirection[direction] = cellsByDirection[direction] || [];
                    cellsByDirection[direction].push(cell);
                }
            });
            for (const dir in cellsByDirection) {
                const unioned = cellsByDirection[dir].reduce((acc, cell) => {
                    try {
                        return turf.intersect(acc ? turf.union(acc, cell) : cell, boundary);
                    } catch (e) {
                        console.log(e);
                    }
                }, null);
                this.directionBorders[dir] = unioned;
            }

            // 9. Add results to the map
            // const that = this;
            // Object.entries(this.directionBorders).forEach(([dir, polygon]) => {
            // L.geoJSON(polygon, {
            //     style: {
            //         color: that.getDirectionColor(dir),
            //     weight: 2,
            //     fillOpacity: 0.2
            //     }
            // }).addTo(this.featureLayer).bindTooltip(dir);
            // });

        }


        // Add region attack labels
        if (this.isChecked('show-regions')) {
            this.addRegionLabels(stats, filteredData);
        }

        // Handle frontline display
        if (this.isChecked('show-line')) {
            this.calculateAndDisplayFrontline(filteredData.locationData, stats.regions);
        } else {
            this.clearFrontline();
        }

        // Adjust map view
        if (!this.isChecked('snap-regions') && filteredData.locationData.length > 0) {
            const bounds = this.markers.getBounds();
            bounds.isValid() && this.map.fitBounds(bounds, { padding: [50, 50] });
        }
    }

    /**
     * Add region attack labels to map
     */
    addRegionLabels(stats, filteredData) {
        Object.keys(this.regionCoordinates).forEach(region => {
            if (this.isChecked('snap-regions') && this.selectRegions.length && !this.selectRegions.includes(region)) return;
            if (stats.regions[region] !== undefined && stats.regions[region] > 0) {
                const attackCount = stats.regions[region];
                const coordinates = this.regionCoordinates[region];
                const dataSize = filteredData.directionData.length;

                const size = 30 + Math.min(attackCount / dataSize * 0.5, 30);
                const color = this.getAttackColor(attackCount / dataSize);

                const attackIcon = L.divIcon({
                    className: `attack-label border-${color}`,
                    html: `<div style="width:${size}px; height:${size}px; line-height:${size}px; font-size:${size / 2}px;">${attackCount}</div>`,
                    iconSize: [size, size],
                    iconAnchor: [size / 2, size / 2]
                });

                const marker = L.marker(coordinates, { icon: attackIcon });
                this.markers.addLayer(marker);
            }
        });
    }

    /**
     * Calculate attack statistics
     */
    calculateAttackStatistics(data) {
        let totalAttacks = 0;
        let totalLosses = 0;
        const regions = {};

        const regionNames = [
            'Kharkiv', 'Kupiansk', 'Lyman', 'Siversk', 'Kramatorsk',
            'Toretsk', 'Pokrovsk', 'Novopavlivka', 'Gulyaipole',
            'Orikhiv', 'Prydniprovske', 'Kursk',
            "Восток", "Днепр", "Запад", "Юг", "Центр", "Север"
        ];

        regionNames.forEach(region => {
            regions[region] = 0;
        });

        data.forEach(item => {
            totalAttacks += parseInt(item['Total Attacks'] || 0);
            totalLosses += parseInt(item['Losses'] || 0);

            regionNames.forEach(region => {
                if (item[region]) {
                    regions[region] += parseInt(item[region] || 0);
                }
            });
        });

        return {
            total: totalAttacks,
            losses: totalLosses,
            regions: regions
        };
    }

    /**
     * Update statistics display
     */
    updateStatistics(stats) {
        this.setText('total-attacks', stats.total);
        this.setText('total-losses', (stats.losses || 0).toLocaleString());

        const regionStatsList = this.getEl('region-stats');
        if (!regionStatsList) {
            return;
        }
        regionStatsList.innerHTML = '';

        const sortedRegions = Object.entries(stats.regions)
            .sort((a, b) => b[1] - a[1])
            .filter(region => region[1] > 0);

        sortedRegions.forEach(([region, count]) => {
            const listItem = document.createElement('li');
            listItem.innerHTML = `${region}: <span class="region-count">${count}</span>`;
            listItem.addEventListener('click', () => {
                if (this.selectRegions.includes(region)) {
                    this.selectRegions.splice(this.selectRegions.indexOf(region), 1);
                } else {
                    this.selectRegions.push(region);
                }
                this.regionSelectionVersion += 1;
                this.updateMap();
            });
            regionStatsList.appendChild(listItem);
        });

        if (sortedRegions.length === 0) {
            this.setHTML('region-stats', '<li>No attacks in selected period</li>');
        }
    }

    /**
     * Render casualties density visualization
     */
    renderCasualtiesDensity() {
        // Clear existing casualties layer
        if (this.casualtiesLayer) {
            this.casualtiesLayer.clearLayers();
        } else {
            this.casualtiesLayer = L.layerGroup().addTo(this.map);
        }

        // Check if we have highlighted area (diff-area polygons)
        if (!this.featureLayer) {
            console.warn('No feature layer found for casualties density');
            return;
        }

        // Check if diff-slices are enabled
        const sliceDates = this.getDiffSliceDates();
        const hasSlices = sliceDates.length > 0;

        if (hasSlices) {
            // Render casualties for each time slice
            this.renderCasualtiesDensityWithSlices(sliceDates);
        } else {
            // Render casualties for entire period (original behavior)
            this.renderCasualtiesDensitySimple();
        }
    }

    /**
     * Render casualties density for sliced time periods
     */
    renderCasualtiesDensityWithSlices(sliceDates) {
        // Define slice colors matching the diff-slices colors
        const sliceColors = ['#ff5252', '#ff9800', '#ffeb3b', '#8bc34a', '#03a9f4', '#9c27b0'];
        const allDates = [this.startDate, ...sliceDates, this.endDate];

        console.log(`Rendering casualties density for ${allDates.length - 1} time slices`);

        let totalPointsGenerated = 0;

        // Process each time slice
        for (let sliceIndex = 0; sliceIndex < allDates.length - 1; sliceIndex++) {
            const sliceStartDate = allDates[sliceIndex];
            const sliceEndDate = allDates[sliceIndex + 1];
            const sliceColor = sliceColors[sliceIndex % sliceColors.length];

            // Get polygons for this slice from featureLayer
            const slicePolygons = [];
            this.featureLayer._map.eachLayer(layer => {
                if (layer.options && layer.options.fillColor === sliceColor && layer.feature) {
                    slicePolygons.push(layer.feature);
                }
            });

            if (slicePolygons.length === 0) {
                console.log(`  Slice ${sliceIndex}: No polygons found for color ${sliceColor}`);
                continue;
            }

            // Merge polygons for this slice
            let mergedSlicePolygon = null;
            slicePolygons.forEach(feature => {
                const poly = turf.feature(feature.geometry);
                if (!mergedSlicePolygon) {
                    mergedSlicePolygon = poly;
                } else {
                    try {
                        mergedSlicePolygon = turf.union(mergedSlicePolygon, poly);
                    } catch (err) {
                        console.warn(`Could not merge slice ${sliceIndex} polygon`);
                    }
                }
            });

            if (!mergedSlicePolygon) {
                console.log(`  Slice ${sliceIndex}: Could not create merged polygon`);
                continue;
            }

            // Get losses and attacks for this time slice
            const sliceData = this.sourceData.gsua.direction.filter(item => {
                const itemDate = item._date || new Date(item.Date);
                return itemDate >= sliceStartDate && itemDate < sliceEndDate;
            });

            const sliceStats = this.calculateAttackStatistics(sliceData);
            const sliceLosses = sliceStats.losses || 0;
            const sliceAttacks = sliceStats.total || 0;

            if (sliceLosses === 0 || sliceAttacks === 0) {
                console.log(`  Slice ${sliceIndex}: No losses/attacks data`);
                continue;
            }

            const casualtiesPerAttack = sliceLosses / sliceAttacks;
            console.log(`  Slice ${sliceIndex} (${this.formatDate(sliceStartDate)} - ${this.formatDate(sliceEndDate)}): ${sliceLosses.toLocaleString()} losses / ${sliceAttacks} attacks`);

            // Render casualties for this slice
            const slicePoints = this.renderCasualtiesForPolygon(
                mergedSlicePolygon,
                sliceStats,
                casualtiesPerAttack,
                sliceColor
            );

            totalPointsGenerated += slicePoints;
        }

        console.log(`✓ Casualties density rendered: ${totalPointsGenerated} markers across ${allDates.length - 1} time slices`);
    }

    /**
     * Render casualties density for simple (non-sliced) mode
     */
    renderCasualtiesDensitySimple() {
        // Get all gains polygons (red color)
        const gainsPolygons = [];
        this.featureLayer._map.eachLayer(layer => {
            if (layer.options && layer.options.fillColor === 'red' && layer.feature) {
                gainsPolygons.push(layer.feature);
            }
        });

        if (gainsPolygons.length === 0) {
            console.log('No highlighted gains area found for casualties density');
            return;
        }

        // Merge all gains polygons into one
        let mergedGainsPolygon = null;
        gainsPolygons.forEach(feature => {
            const poly = turf.feature(feature.geometry);
            if (!mergedGainsPolygon) {
                mergedGainsPolygon = poly;
            } else {
                try {
                    mergedGainsPolygon = turf.union(mergedGainsPolygon, poly);
                } catch (err) {
                    console.warn('Could not merge gains polygon for casualties density');
                }
            }
        });

        if (!mergedGainsPolygon) {
            console.warn('Could not create merged gains polygon for casualties density');
            return;
        }

        // Get losses and attacks for the selected date range
        const filteredData = this.sourceData.gsua.direction.filter(item => {
            const itemDate = item._date || new Date(item.Date);
            return itemDate >= this.startDate && itemDate <= this.endDate;
        });

        const stats = this.calculateAttackStatistics(filteredData);
        const totalLosses = stats.losses || 0;
        const totalAttacks = stats.total || 0;

        if (totalLosses === 0 || totalAttacks === 0) {
            console.log('No losses/attacks data available for casualties density');
            return;
        }

        const casualtiesPerAttack = totalLosses / totalAttacks;
        console.log(`Casualties density: ${totalLosses.toLocaleString()} losses / ${totalAttacks} attacks = ${casualtiesPerAttack.toFixed(2)} per attack`);

        // Render casualties with default dark color
        const totalPoints = this.renderCasualtiesForPolygon(
            mergedGainsPolygon,
            stats,
            casualtiesPerAttack,
            null // Use default dark/gray colors
        );

        console.log(`✓ Casualties density rendered: ${totalPoints} markers`);
    }

    /**
     * Helper function to render casualties for a specific polygon area
     */
    renderCasualtiesForPolygon(mergedPolygon, stats, casualtiesPerAttack, sliceColor) {
        // Filter regions by selection
        const regionsToRender = Object.entries(stats.regions).filter(([region, attacks]) => {
            if (attacks === 0) return false;
            if (this.selectRegions.length === 0) return true; // Show all if none selected
            return this.selectRegions.includes(region);
        });

        if (regionsToRender.length === 0) {
            return 0;
        }

        let totalPointsGenerated = 0;
        const maxPointsPerRegion = 20000; // Limit per region for performance

        // Render casualties proportional to attacks in each region
        regionsToRender.forEach(([region, attackCount]) => {
            // Get region polygon from regionPolygons
            const coordinatesString = this.regionPolygons[region];
            if (!coordinatesString) {
                console.warn(`No polygon found for region: ${region}`);
                return;
            }

            // Parse coordinates and create Turf polygon
            const coordinates = JSON.parse(coordinatesString);
            const regionPolygon = turf.polygon(coordinates);

            // Intersect region polygon with merged polygon
            let intersectionPolygon = null;
            try {
                intersectionPolygon = turf.intersect(regionPolygon, mergedPolygon);
            } catch (err) {
                return;
            }

            if (!intersectionPolygon) {
                return;
            }

            // Calculate casualties for this region (proportional to attacks)
            const regionCasualties = Math.round(attackCount * casualtiesPerAttack);
            const pointsToGenerate = Math.min(regionCasualties, maxPointsPerRegion);

            if (pointsToGenerate === 0) return;

            // Get bounding box for efficient random point generation
            const bbox = turf.bbox(intersectionPolygon);

            // Generate random points within the intersection
            const points = [];
            let attempts = 0;
            const maxAttempts = pointsToGenerate * 20; // Prevent infinite loops

            while (points.length < pointsToGenerate && attempts < maxAttempts) {
                attempts++;

                // Generate random point within bounding box
                const randomLng = bbox[0] + Math.random() * (bbox[2] - bbox[0]);
                const randomLat = bbox[1] + Math.random() * (bbox[3] - bbox[1]);
                const point = turf.point([randomLng, randomLat]);

                // Check if point is within the intersection polygon
                try {
                    if (turf.booleanPointInPolygon(point, intersectionPolygon)) {
                        points.push([randomLat, randomLng]);
                    }
                } catch (err) {
                    // Skip invalid points
                }
            }

            // Render points
            points.forEach(([lat, lng]) => {
                let fillColor, color;

                const wia = (Math.random() > 0.4);
                fillColor = wia ? '#a8a8a8' : '#000000';
                color = wia ? '#a8a8a8' : '#000000';
                // if (sliceColor) {
                //     // Use slice color (with slight transparency)
                //     fillColor = sliceColor;
                //     color = sliceColor;
                // } else {
                //     // Use original dark/gray coloring based on casualty type
                //     const wia = (Math.random() > 0.4);
                //     fillColor = wia ? '#a8a8a8' : '#000000';
                //     color = wia ? '#a8a8a8' : '#000000';
                // }

                L.circleMarker([lat, lng], {
                    radius: 1.5,
                    fillColor: fillColor,
                    color: color,
                    weight: 1,
                    opacity: 0.7,
                    fillOpacity: 0.7
                }).addTo(this.casualtiesLayer);
            });

            totalPointsGenerated += points.length;
        });

        return totalPointsGenerated;
    }

    /**
     * Render losses (casualties) for the current diff-highlight area
     * @param {number} casualtiesPerKm2 - Number of casualties per square kilometer
     */
    renderLossesForDiffArea(casualtiesPerKm2) {
        console.log(`Rendering losses for diff area at ${casualtiesPerKm2} casualties/km²...`);

        // Initialize or clear losses layer
        if (this.lossesLayer) {
            this.lossesLayer.clearLayers();
        } else {
            this.lossesLayer = L.layerGroup().addTo(this.map);
        }

        // Get the highlighted difference polygons from featureLayer._map
        if (!this.featureLayer || !this.featureLayer._map) {
            console.warn('No feature layer or map found for losses rendering');
            return;
        }

        // Collect all diff-highlight polygons (red fill color)
        const diffPolygons = [];
        this.featureLayer._map.eachLayer(layer => {
            if (layer.options && layer.options.fillColor === 'red' && layer.feature) {
                diffPolygons.push(layer.feature);
            }
        });

        if (diffPolygons.length === 0) {
            console.warn('No diff-highlight features found (red polygons)');
            return;
        }

        console.log(`Found ${diffPolygons.length} diff-highlight polygon(s)`);

        let totalPoints = 0;

        // Process each feature in the diff-highlight area
        diffPolygons.forEach(feature => {
            try {
                // Calculate area of this feature in km²
                const areaM2 = turf.area(feature);
                const areaKm2 = areaM2 / 1_000_000;

                // Calculate number of casualties for this polygon
                const casualties = Math.round(areaKm2 * casualtiesPerKm2 / 10);

                if (casualties === 0) return;

                // Limit points per polygon for performance
                const pointsToGenerate = Math.min(casualties, 1000000);

                // Get bounding box
                const bbox = turf.bbox(feature);

                // Generate random points within the polygon
                const points = [];
                let attempts = 0;
                const maxAttempts = pointsToGenerate * 20;

                while (points.length < pointsToGenerate && attempts < maxAttempts) {
                    attempts++;

                    // Generate random point within bounding box
                    const randomLng = bbox[0] + Math.random() * (bbox[2] - bbox[0]);
                    const randomLat = bbox[1] + Math.random() * (bbox[3] - bbox[1]);
                    const point = turf.point([randomLng, randomLat]);

                    // Check if point is within the polygon
                    try {
                        if (turf.booleanPointInPolygon(point, feature)) {
                            points.push([randomLat, randomLng]);
                        }
                    } catch (err) {
                        // Skip invalid points
                    }
                }

                // Render points
                points.forEach(([lat, lng]) => {
                    // 60% wounded (gray), 40% killed (black)
                    // const wia = (Math.random() > 0.4);
                    // const fillColor = wia ? '#a8a8a8' : '#000000';
                    // const color = wia ? '#a8a8a8' : '#000000';

                    L.circleMarker([lat, lng], {
                        radius: 0.5,
                        fillColor: '#000000',
                        color: '#000000',
                        weight: 1,
                        opacity: 0.1,
                        fillOpacity: 0.7
                    }).addTo(this.lossesLayer);
                });

                totalPoints += points.length;

            } catch (err) {
                console.warn('Error processing feature for losses:', err);
            }
        });

        console.log(`✓ Losses rendered: ${totalPoints} markers (${casualtiesPerKm2}/km²)`);
    }

    /**
     * Calculate distance between two points in km
     */
    getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = this.deg2rad(lat2 - lat1);
        const dLon = this.deg2rad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Convert degrees to radians
     */
    deg2rad(deg) {
        return deg * (Math.PI / 180);
    }

    /**
     * Position cluster based on weighted average
     */
    positionCluster(cluster) {
        let totalWeight = 0;
        let weightedLat = 0;
        let weightedLng = 0;
        let regionNames = new Set();
        let locationNames = [];

        cluster.forEach(location => {
            const weight = location.weight;
            totalWeight += weight;
            weightedLat += location.latlng[0] * weight;
            weightedLng += location.latlng[1] * weight;
            regionNames.add(location.region);
            locationNames.push(location.name);
        });

        const avgLat = weightedLat / totalWeight;
        const avgLng = weightedLng / totalWeight;

        return {
            latlng: [avgLat, avgLng],
            weight: totalWeight,
            regions: Array.from(regionNames),
            locations: cluster,
            originalPoints: cluster.map(loc => loc.latlng)
        };
    }

    /**
     * Calculate edges using MST algorithm
     */
    calculateEdges(clusterCenters) {
        clusterCenters.sort((a, b) => a.latlng[1] - b.latlng[1]);

        const edges = [];
        for (let i = 0; i < clusterCenters.length; i++) {
            for (let j = i + 1; j < clusterCenters.length; j++) {
                const distance = this.getDistanceFromLatLonInKm(
                    clusterCenters[i].latlng[0], clusterCenters[i].latlng[1],
                    clusterCenters[j].latlng[0], clusterCenters[j].latlng[1]
                );

                edges.push({
                    from: i,
                    to: j,
                    distance: distance
                });
            }
        }

        edges.sort((a, b) => a.distance - b.distance);

        const mstEdges = [];
        const sets = clusterCenters.map((_, i) => new Set([i]));

        edges.forEach(edge => {
            const fromSet = sets.findIndex(set => set.has(edge.from));
            const toSet = sets.findIndex(set => set.has(edge.to));

            if (fromSet !== toSet) {
                mstEdges.push(edge);

                const mergedSet = new Set([...sets[fromSet], ...sets[toSet]]);
                sets.splice(Math.max(fromSet, toSet), 1);
                sets.splice(Math.min(fromSet, toSet), 1);
                sets.push(mergedSet);
            }
        });

        const mpt = [...mstEdges.map(el => [el.to, el.from]), ...mstEdges.map(el => [el.from, el.to])].reduce((acc, v) => {
            if (!acc.hasOwnProperty(v[0])) {
                acc[v[0]] = [v[1]];
            } else {
                acc[v[0]].push(v[1]);
            }
            return acc;
        }, {});

        const cmpt = Object.entries(mpt).filter(i => i[1].length > 2);
        if (cmpt.length) {
            let circutBreak = false;
            cmpt.forEach(el => {
                el[1].filter(i => mpt[i].length < 2).forEach(i => {
                    clusterCenters[el[0]].locations = [...clusterCenters[el[0]].locations, ...clusterCenters[i].locations];
                    clusterCenters[el[0]] = this.positionCluster(clusterCenters[el[0]].locations);
                    delete clusterCenters[i];
                    circutBreak = true;
                });
            });
            return circutBreak ? this.calculateEdges(clusterCenters.filter(Boolean)) : { mstEdges, clusterCenters };
        } else {
            return { mstEdges, clusterCenters };
        }
    }

    /**
     * Clear frontline display
     */
    clearFrontline() {
        this.frontlineLayer.clearLayers();
        this.clusterLayer.clearLayers();
    }

    /**
     * Calculate and display frontline
     */
    calculateAndDisplayFrontline(locationData, region) {
        this.clearFrontline();

        const activeLocations = locationData.filter(location => location.Lat && location.Lon).map(location => ({
            latlng: [parseFloat(location.Lat), parseFloat(location.Lon)],
            weight: 1,
            region: location.region,
            name: location.location
        }));

        if (activeLocations.length < 3) {
            alert('Not enough data points to calculate frontline (minimum 3 required)');
            return;
        }

        const clusterRadiusKm = parseFloat(this.getEl('clusterRadius')?.value);
        const clusters = [];
        const processedLocations = new Set();

        activeLocations.forEach((location, index) => {
            if (processedLocations.has(index)) return;

            const cluster = [location];
            processedLocations.add(index);

            activeLocations.forEach((otherLocation, otherIndex) => {
                if (processedLocations.has(otherIndex)) return;

                const distance = this.getDistanceFromLatLonInKm(
                    location.latlng[0], location.latlng[1],
                    otherLocation.latlng[0], otherLocation.latlng[1]
                );

                if (distance <= clusterRadiusKm) {
                    processedLocations.add(otherIndex);
                }
                if (distance <= clusterRadiusKm * 2) {
                    cluster.push(otherLocation);
                }
            });

            clusters.push(cluster);
        });

        const clusterCentersT = clusters.map(cluster => this.positionCluster(cluster));

        // Merge close clusters
        for (let i = 0; i < clusterCentersT.length; i++) {
            for (let j = i + 1; j < clusterCentersT.length; j++) {
                if (clusterCentersT[i] === undefined || clusterCentersT[j] === undefined) continue;
                const distance = this.getDistanceFromLatLonInKm(
                    clusterCentersT[i].latlng[0], clusterCentersT[i].latlng[1],
                    clusterCentersT[j].latlng[0], clusterCentersT[j].latlng[1]
                );
                if (distance <= clusterRadiusKm * 0.75) {
                    if (clusterCentersT[i].weight >= clusterCentersT[j].weight) {
                        clusterCentersT[i].locations = [...clusterCentersT[i].locations, ...clusterCentersT[j].locations];
                        clusterCentersT[i] = this.positionCluster(clusterCentersT[i].locations);
                        delete clusterCentersT[j];
                    } else {
                        clusterCentersT[j].locations = [...clusterCentersT[i].locations, ...clusterCentersT[j].locations];
                        clusterCentersT[j] = this.positionCluster(clusterCentersT[j].locations);
                        delete clusterCentersT[i];
                    }
                }
            }
        }

        const { mstEdges, clusterCenters } = this.calculateEdges(clusterCentersT.filter(Boolean));

        // Visualize clusters
        clusterCenters.forEach(center => {
            const clusterMarker = L.circleMarker(center.latlng, {
                radius: 8,
                fillColor: '#3388ff',
                color: '#000',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.8
            }).addTo(this.clusterLayer);

            clusterMarker.bindPopup(`
                <strong>Cluster Center</strong><br>
                Regions: ${center.regions.join(', ')}<br>
                Total Weight: ${center.weight}
            `);
        });

        this.cachedFrontline = [mstEdges, clusterCenters];

        // Draw frontline
        mstEdges.forEach(edge => {
            const from = clusterCenters[edge.from].latlng;
            const to = clusterCenters[edge.to].latlng;

            L.polyline([from, to], {
                color: 'red',
                weight: 4,
                opacity: 0.8
            }).addTo(this.frontlineLayer);
        });

        // Draw copied frontline if exists
        if (this.copiedFrontline.length) {
            this.copiedFrontline[0].forEach(edge => {
                const from = this.copiedFrontline[1][edge.from].latlng;
                const to = this.copiedFrontline[1][edge.to].latlng;

                L.polyline([from, to], {
                    color: 'red',
                    weight: 4,
                    opacity: 0.8,
                    dashArray: '10'
                }).addTo(this.frontlineLayer);
            });
        }
    }

    /**
     * Load and process data
     */
    loadData() {
        if (!this.directionData.length || !this.locationData.length) return;

        // const dates = this.directionData.map(item => new Date(item.Date));
        // this.minDate = new Date('2023-01-01');
        // this.maxDate = new Date();

        this.initSlider(this.minDate, this.maxDate);
        // this.startDate = this.minDate;
        // this.endDate = this.maxDate;
        this.updateMap();
    }

    initDates() {
        const now = new Date(new Date().toLocaleDateString('en-CA'));
        const threeMonthsAgo = new Date(now);
        threeMonthsAgo.setMonth(now.getMonth() - 3);

        this.minDate = threeMonthsAgo;
        this.maxDate = now;
        const dateStart = this.getEl('date-start');
        const dateEnd = this.getEl('date-end');
        if (dateStart) {
            dateStart.valueAsDate = this.minDate;
        }
        if (dateEnd) {
            dateEnd.valueAsDate = this.maxDate;
        }

        this.initSlider(this.minDate, this.maxDate);
        this.startDate = this.minDate;
        this.endDate = this.maxDate;
    }

    /**
     * Load all data from Flask endpoints
     */
    async loadAllData() {
        return this.dataStore.loadAllData();
    }

    /**
     * Toggle settlements display on/off
     */
    toggleSettlementsDisplay() {
        return this.settlements.toggleSettlementsDisplay();
    }

    /**
     * Get settlement color and size based on population
     */
    getSettlementStyle(population) {
        return this.settlements.getSettlementStyle(population);
    }

    /**
     * Display settlements on the map
     */
    displaySettlements() {
        return this.settlements.displaySettlements();
    }

    /**
     * Filter settlements based on cluster radius value
     */
    filterSettlementsByRadius() {
        return this.settlements.filterSettlementsByRadius();
    }

    /**
     * Toggle settlement history display
     */
    toggleSettlementHistory() {
        return this.settlements.toggleSettlementHistory();
    }

    /**
     * Fetch settlement boundary from offline data or Nominatim API
     */
    async fetchSettlementBoundary(osm_id, osm_type) {
        return this.settlements.fetchSettlementBoundary(osm_id, osm_type);
    }

    /**
     * Render settlement boundaries for visible settlements (incremental)
     */
    async renderSettlementBoundaries() {
        return this.settlements.renderSettlementBoundaries();
    }

    /**
     * Toggle settlement boundaries display
     */
    toggleSettlementBoundaries() {
        return this.settlements.toggleSettlementBoundaries();
    }

    toggleSettlementBuffers() {
        return this.settlements.toggleSettlementBuffers();
    }

    /**
     * Show settlement boundaries loader
     */
    showBoundariesLoader() {
        return this.settlements.showBoundariesLoader();
    }

    /**
     * Update settlement boundaries loader progress
     */
    updateBoundariesLoader(percentage, text) {
        return this.settlements.updateBoundariesLoader(percentage, text);
    }

    /**
     * Hide settlement boundaries loader
     */
    hideBoundariesLoader() {
        return this.settlements.hideBoundariesLoader();
    }

    /**
     * Check if a settlement point is within any selected user-drawn polygon
     */
    isSettlementInSelectedPolygons(coords) {
        if (!this.selectedPolygons || this.selectedPolygons.length === 0) {
            return false;
        }

        const point = turf.point([coords[0], coords[1]]); // turf expects [lng, lat]

        for (const polygon of this.selectedPolygons) {
            try {
                const geoJSON = polygon.toGeoJSON();
                if (turf.booleanPointInPolygon(point, geoJSON)) {
                    return true;
                }
            } catch (error) {
                console.warn('Error checking selected polygon:', error);
            }
        }

        return false;
    }

    /**
     * Check if a settlement point is within a specific predefined region
     */
    isSettlementInPredefinedRegion(coords, regionName) {
        if (!this.regionPolygons[regionName]) {
            return false;
        }

        const point = turf.point([coords[0], coords[1]]); // turf expects [lng, lat]

        try {
            const polygon = this.regionPolygonCache.get(regionName);
            if (!polygon) {
                return false;
            }
            return turf.booleanPointInPolygon(point, polygon);
        } catch (error) {
            console.warn(`Error checking predefined region ${regionName}:`, error);
            return false;
        }
    }

    /**
     * Check if a settlement point is within any selected region
     */
    isSettlementInSelectedRegions(coords) {
        if (!this.selectRegions.length) {
            return true; // If no regions selected, show all settlements
        }

        const point = turf.point([coords[0], coords[1]]); // turf expects [lng, lat]

        for (const regionName of this.selectRegions) {
            if (this.regionPolygons[regionName]) {
                try {
                    const polygon = this.regionPolygonCache.get(regionName);
                    if (!polygon) {
                        continue;
                    }
                    if (turf.booleanPointInPolygon(point, polygon)) {
                        return true;
                    }
                } catch (error) {
                    console.warn(`Error checking region ${regionName}:`, error);
                }
            }
        }

        return false;
    }

    /**
     * Handle settlement search
     */
    handleSettlementSearch(searchTerm) {
        return this.settlements.handleSettlementSearch(searchTerm);
    }
}

// Initialize the dashboard when the page loads
window.onload = () => {
    window.dashboard = new AttackMapDashboard();
    window.dashboard.init();
};

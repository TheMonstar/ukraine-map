class DeepUtils {
    constructor(deepLayer) {
        this.deepLayer = deepLayer;
    }
    static shadowOptions() {
        const value = id => document.getElementById(id)?.value;
        const depth = (id, fallback) => {
            const input = value(id);
            const number = input == null || input === '' ? fallback : Number(input);
            if (!Number.isFinite(number) || number < 0) throw new Error('Shadow depth must be a non-negative number');
            return number;
        };
        const defaultDepth = depth('clusterRadius', 20);
        return {
            enabled: !!document.getElementById('shadow-line')?.checked,
            occupiedDepth: depth('shadow-depth-occupied', defaultDepth),
            oppositeDepth: depth('shadow-depth-opposite', defaultDepth),
            gradient: !!document.getElementById('shadow-gradient')?.checked
        };
    }

    async addDeepMap(date = new Date(), options = DeepUtils.shadowOptions()) {
        try {
            const data = await TerritoryData.load(date);

            //"#bcaaa4", "#a52714", "#ff5252"
            const dbg = {};
            const polis = [];
            const filteredPolygons = [];

            data.features.filter(item =>
                ["Polygon", "MultiPolygon"].includes(item.geometry.type) &&
                ["#bcaaa4", "#a52714", "#880e4f"].indexOf(item.properties.stroke) >= 0
            ).forEach(item => {
                const squareMeters = turf.area(item);

                // Create polygon data object instead of rendering directly
                const polygonData = {
                    geojson: item,
                    style: {
                        color: item.properties.stroke,
                        fillColor: item.properties.fill,
                        fillOpacity: item.properties['fill-opacity'],
                        weight: 0
                    },
                    properties: item.properties,
                    area: { squareMeters, squareKilometers: squareMeters / 1e6 }
                };

                filteredPolygons.push(polygonData);

                if (options.enabled && item.properties.fill === "#bcaaa4") {
                    polis.push({ geojson: item, occupiedDepth: options.occupiedDepth, oppositeDepth: options.oppositeDepth });
                }

                if (dbg.hasOwnProperty(item.properties.fill)) {
                    dbg[item.properties.fill] += polygonData.area.squareKilometers;
                } else {
                    dbg[item.properties.fill] = polygonData.area.squareKilometers;
                }
            });

            // Handle shadow polygons if needed
            let shadowPolygon = null;
            if (options.enabled && polis.length > 0) {
                // Build merged occupied polygon from ALL filteredPolygons (all territories)
                let mergedOccupied = null;
                for (let polygon of filteredPolygons) {
                    const geojson = polygon.geojson;
                    if (!mergedOccupied) {
                        mergedOccupied = geojson;
                    } else {
                        mergedOccupied = turf.union(mergedOccupied, geojson);
                    }
                }

                // Create buffers for occupied side (extends outward from grey zone)
                let occupiedBuffers = polis.map(p => turf.buffer(p.geojson, p.occupiedDepth, { units: 'kilometers' }));
                let mergedOccupiedBuffer = occupiedBuffers[0];
                for (let i = 1; i < occupiedBuffers.length; i++) {
                    mergedOccupiedBuffer = turf.union(mergedOccupiedBuffer, occupiedBuffers[i]);
                }
                // Subtract the occupied area from the occupied-side buffer (outward shadow only)
                let occupiedShadow = turf.difference(mergedOccupiedBuffer, mergedOccupied);

                // Create buffers for opposite side (extends inward)
                let oppositeBuffers = polis.map(p => turf.buffer(p.geojson, p.oppositeDepth, { units: 'kilometers' }));
                let mergedOppositeBuffer = oppositeBuffers[0];
                for (let i = 1; i < oppositeBuffers.length; i++) {
                    mergedOppositeBuffer = turf.union(mergedOppositeBuffer, oppositeBuffers[i]);
                }
                // Intersect opposite-side buffer with the occupied area (inward shadow only)
                let oppositeShadow = turf.intersect(mergedOppositeBuffer, mergedOccupied);

                // Combine both shadow zones
                let combinedShadow = occupiedShadow;
                if (oppositeShadow) {
                    combinedShadow = TerritoryAnalysis.union([occupiedShadow, oppositeShadow]);
                }

                // Create gradient rings with exponential decay (only if gradient toggle is on)
                const gradientEnabled = options.gradient;
                const gradientRings = [];
                const numRings = 5;

                // Exponential depth percentages: 100%, 60%, 35%, 20%, 10%
                const depthPercentages = [1.0, 0.6, 0.35, 0.2, 0.1];

                // Opacity values (reduced for overlapping layers)
                const baseOpacities = [0.3, 0.3, 0.3, 0.3, 0.3]; // Innermost to outermost

                // Calculate average max depths
                const avgOccupiedDepth = polis.reduce((sum, p) => sum + p.occupiedDepth, 0) / polis.length;
                const avgOppositeDepth = polis.reduce((sum, p) => sum + p.oppositeDepth, 0) / polis.length;

                // Generate rings from outermost to innermost
                for (let i = 0; gradientEnabled && i < numRings; i++) {
                    const depthPercent = depthPercentages[i];
                    const ringOccupiedDepth = avgOccupiedDepth * depthPercent;
                    const ringOppositeDepth = avgOppositeDepth * depthPercent;

                    // Create buffer for this ring on occupied side
                    let ringOccupiedBuffers = polis.map(p => turf.buffer(p.geojson, ringOccupiedDepth, { units: 'kilometers' }));
                    let ringOccupiedBuffer = ringOccupiedBuffers[0];
                    for (let j = 1; j < ringOccupiedBuffers.length; j++) {
                        ringOccupiedBuffer = turf.union(ringOccupiedBuffer, ringOccupiedBuffers[j]);
                    }
                    let ringOccupiedShadow = turf.difference(ringOccupiedBuffer, mergedOccupied);

                    // Create buffer for this ring on opposite side
                    let ringOppositeBuffers = polis.map(p => turf.buffer(p.geojson, ringOppositeDepth, { units: 'kilometers' }));
                    let ringOppositeBuffer = ringOppositeBuffers[0];
                    for (let j = 1; j < ringOppositeBuffers.length; j++) {
                        ringOppositeBuffer = turf.union(ringOppositeBuffer, ringOppositeBuffers[j]);
                    }
                    let ringOppositeShadow = turf.intersect(ringOppositeBuffer, mergedOccupied);

                    // Combine ring shadows
                    let ringCombinedShadow = ringOccupiedShadow;
                    if (ringOppositeShadow) {
                        ringCombinedShadow = TerritoryAnalysis.union([ringOccupiedShadow, ringOppositeShadow]);
                    }

                    // Use reduced opacity for overlapping layers (opacity compounds visually)
                    const opacity = baseOpacities[i];

                    gradientRings.push({
                        geojson: ringCombinedShadow,
                        style: {
                            color: 'gray',
                            fillColor: 'gray',
                            fillOpacity: opacity,
                            weight: 0
                        }
                    });
                }

                shadowPolygon = {
                    geojson: combinedShadow,
                    style: {
                        color: 'gray',
                        fillColor: 'gray',
                        fillOpacity: 0.4
                    },
                    gradientRings: gradientRings
                };
            }

            console.log(dbg);

            return {
                polygons: filteredPolygons,
                shadowPolygon: shadowPolygon,
                statistics: dbg
            };

        } catch (error) {
            throw new Error(`Territory data unavailable: ${error.message}`, { cause: error });
        }
    }

    /**
     * Render polygons on the map
     * @param {Object} polygonData - Object containing polygons and shadow polygon
     */
    renderMap(polygonData) {
        // Build off-map first; malformed rendering data cannot clear the last successful map.
        const nextLayer = L.layerGroup();

        console.log('🎨 Rendering polygons:', polygonData.polygons.length);

        // Render regular polygons
        polygonData.polygons.forEach((polygon, index) => {
            console.log(`  [${index}] type: ${polygon.type}, color: ${polygon.style?.fillColor}, hasGeojson: ${!!polygon.geojson}, hasCoords: ${!!polygon.coordinates}`);

            if (polygon.geojson) {
                // Handle GeoJSON polygons (for merged/difference polygons)
                const layer = L.geoJSON(polygon.geojson, {
                    style: polygon.style
                }).addTo(nextLayer);

                // For diff slices, show the slice size in km² when clicked
                if (polygon.showArea) {
                    try {
                        const km2 = turf.area(polygon.geojson) / 1e6;
                        const label = polygon.sliceLabel || (polygon.isLoss ? 'Lost' : 'Captured');
                        layer.bindPopup(
                            `<b>${label}</b><br>${km2.toLocaleString(undefined, { maximumFractionDigits: 1 })} km²`
                        );
                    } catch (e) { /* skip popup if area can't be computed */ }
                }
            } else if (polygon.coordinates) {
                // Handle coordinate-based polygons (original format)
                L.polygon(polygon.coordinates, polygon.style).addTo(nextLayer);
            }
        });

        // Render shadow polygon if it exists with gradient effect
        if (polygonData.shadowPolygon) {
            // Create gradient by rendering multiple buffer rings with decreasing opacity
            if (polygonData.shadowPolygon.gradientRings && polygonData.shadowPolygon.gradientRings.length) {
                // Render gradient rings from outermost to innermost for proper layering
                polygonData.shadowPolygon.gradientRings.forEach(ring => {
                    L.geoJSON(ring.geojson, {
                        style: ring.style
                    }).addTo(nextLayer);
                });
            } else {
                // Fallback to simple rendering if no gradient rings
                L.geoJSON(polygonData.shadowPolygon.geojson, {
                    style: polygonData.shadowPolygon.style
                }).addTo(nextLayer);
            }
        }
        this.deepLayer.clearLayers();
        nextLayer.eachLayer(layer => layer.addTo(this.deepLayer));
    }

    /**
     * Render a single polygon
     * @param {Object} polygon - Polygon data object
     */
    renderSinglePolygon(polygon) {
        return L.geoJSON(TerritoryAnalysis.feature(polygon), { style: polygon.style }).addTo(this.deepLayer);
    }

    /**
     * Calculate polygon difference between start and end dates for highlighting
     * @param {Object} startDatePolygons - Polygons from start date
     * @param {Object} endDatePolygons - Polygons from end date
     * @returns {Object} Processed polygon data with diff highlighting
     */
    calculatePolygonDifference(startDatePolygons, endDatePolygons) {
        return TerritoryAnalysis.difference(startDatePolygons, endDatePolygons);
    }

    unionList(geojsons) {
        return TerritoryAnalysis.union(geojsons);
    }

    normalizePolygon(geojsons) {
        return geojsons.map(p => TerritoryAnalysis.feature(p));
    }

    prepareRender(geojsons) {
        return {
            polygons: geojsons.map(geojson => {
                return {
                    geojson: geojson,
                    style: {
                        color: "#a52714",
                        fillColor: "#a52714",
                        fillOpacity: 0.2,
                        weight: 1
                    },
                    type: 'merged-start'
                };
            })
        };
    }

    addShadow(geojson, depth = 20) {
        return turf.buffer(geojson, depth, { units: 'kilometers' })
    }

    async loadTheBorder(code = 'ua') {
        try {
            const response = await fetch(`https://summary-map.storage.googleapis.com/${code}.json`);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();
            return data.features[0];
        } catch (e) {
            throw new Error(`Border ${code} unavailable: ${e.message}`, { cause: e });
        }
    }

    async loadFeatures(feature = 'ditches', user = 0) {
        try {
            const response = await fetch(`https://playframap.github.io/${feature}.geojson`);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            return await response.json();
        } catch (e) {
            console.error(`Failed to load ${feature} from PlayFra:`, e);
        }

    }
}
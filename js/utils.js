class DeepUtils {
    constructor(deepLayer) {
        this.deepLayer = deepLayer;
    }
    /**
     * Calculate the area of a polygon given its vertices in [longitude, latitude] format
     * Uses geodesic polygon area calculation for high accuracy
     * @param {Array<Array<number>>} vertices - Array of [longitude, latitude] coordinate pairs
     * @returns {object} The area of the polygon in square meters and square kilometers
     */
    calculateGeoPolygonArea(vertices) {
        if (vertices.length < 3) {
            return { squareMeters: 0, squareKilometers: 0 };
        }

        const earthRadius = 6378137.0; // WGS84 semi-major axis in meters

        // Calculate spherical excess
        let area = 0;
        const n = vertices.length;

        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const [lat1, lon1] = vertices[i].map(this.toRadians);
            const [lat2, lon2] = vertices[j].map(this.toRadians);

            area += (lon2 - lon1) * Math.sin((lat1 + lat2) / 2);
        }

        area = Math.abs(area) * earthRadius * earthRadius;

        return {
            squareMeters: area,
            squareKilometers: area / 1000000
        };
    }

    /**
     * Convert degrees to radians
     * @param {number} degrees - Angle in degrees
     * @returns {number} Angle in radians
     */
    toRadians(degrees) {
        return degrees * Math.PI / 180;
    }

    async addDeepMap(date = new Date()) {
        try {
            const dateStr = date.toLocaleDateString('en-CA');
            if (!this.constructor.cache) {
                this.constructor.cache = new Map();
            }

            const MAX_CACHE_SIZE = 30; // Limit to ~18MB to prevent memory leaks

            let data;
            if (this.constructor.cache.has(dateStr)) {
                // Return cached data and move to the end to mark as recently used
                data = this.constructor.cache.get(dateStr);
                this.constructor.cache.delete(dateStr);
                this.constructor.cache.set(dateStr, data);
            } else {
                const response = await fetch(`https://flask-app-kibakefmpq-ew.a.run.app/geojson-by-date?date=${dateStr}`);

                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }

                data = await response.json();
                this.constructor.cache.set(dateStr, data);

                // Enforce maximum cache size by removing the oldest entry
                if (this.constructor.cache.size > MAX_CACHE_SIZE) {
                    const oldestKey = this.constructor.cache.keys().next().value;
                    this.constructor.cache.delete(oldestKey);
                }
            }

            //"#bcaaa4", "#a52714", "#ff5252"
            const dbg = {};
            const polis = [];
            const filteredPolygons = [];

            data.features.filter(item =>
                item.geometry.type === "Polygon" &&
                ["#bcaaa4", "#a52714", "#880e4f"].indexOf(item.properties.stroke) >= 0
            ).forEach(item => {
                const coordinates = item.geometry.coordinates[0].map(coord => [coord[1], coord[0]]);

                // Create polygon data object instead of rendering directly
                const polygonData = {
                    coordinates: coordinates,
                    style: {
                        color: item.properties.stroke,
                        fillColor: item.properties.fill,
                        fillOpacity: item.properties['fill-opacity'],
                        weight: 0
                    },
                    properties: item.properties,
                    area: this.calculateGeoPolygonArea(coordinates)
                };

                filteredPolygons.push(polygonData);

                if (document.getElementById('shadow-line')?.checked && item.properties.fill === "#bcaaa4") {
                    const tempPolygon = L.polygon(coordinates);
                    const geojson = tempPolygon.toGeoJSON();

                    // Get depth values, default to clusterRadius if not set
                    const defaultDepth = document.getElementById('clusterRadius')?.value || 20;
                    const occupiedDepth = parseFloat(document.getElementById('shadow-depth-occupied')?.value || defaultDepth);
                    const oppositeDepth = parseFloat(document.getElementById('shadow-depth-opposite')?.value || defaultDepth);

                    // Store both buffer zones with their depths
                    polis.push({
                        geojson: geojson,
                        occupiedDepth: occupiedDepth,
                        oppositeDepth: oppositeDepth
                    });
                }

                if (dbg.hasOwnProperty(item.properties.fill)) {
                    dbg[item.properties.fill] += parseFloat(polygonData.area.squareKilometers.toFixed(2));
                } else {
                    dbg[item.properties.fill] = parseFloat(polygonData.area.squareKilometers.toFixed(2));
                }
            });

            // Handle shadow polygons if needed
            let shadowPolygon = null;
            if (document.getElementById('shadow-line')?.checked && polis.length > 0) {
                // Build merged occupied polygon from ALL filteredPolygons (all territories)
                let mergedOccupied = null;
                for (let polygon of filteredPolygons) {
                    const tempPolygon = L.polygon(polygon.coordinates);
                    const geojson = tempPolygon.toGeoJSON();
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
                    combinedShadow = turf.union(occupiedShadow, oppositeShadow);
                }

                // Create gradient rings with exponential decay
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
                for (let i = 0; i < numRings; i++) {
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
                        ringCombinedShadow = turf.union(ringOccupiedShadow, ringOppositeShadow);
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
                        fillOpacity: 0.3
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
            console.error('Fetch error:', error);
            if (document.getElementById('output')) {
                document.getElementById('output').textContent = 'Error fetching data: ' + error;
            }
            return {
                polygons: [],
                shadowPolygon: null,
                statistics: {}
            };
        }
    }

    /**
     * Render polygons on the map
     * @param {Object} polygonData - Object containing polygons and shadow polygon
     */
    renderMap(polygonData) {
        // Clear existing layers first
        this.deepLayer.clearLayers();

        console.log('🎨 Rendering polygons:', polygonData.polygons.length);

        // Render regular polygons
        polygonData.polygons.forEach((polygon, index) => {
            console.log(`  [${index}] type: ${polygon.type}, color: ${polygon.style?.fillColor}, hasGeojson: ${!!polygon.geojson}, hasCoords: ${!!polygon.coordinates}`);

            if (polygon.geojson) {
                // Handle GeoJSON polygons (for merged/difference polygons)
                L.geoJSON(polygon.geojson, {
                    style: polygon.style
                }).addTo(this.deepLayer);
            } else if (polygon.coordinates) {
                // Handle coordinate-based polygons (original format)
                L.polygon(polygon.coordinates, polygon.style).addTo(this.deepLayer);
            }
        });

        // Render shadow polygon if it exists with gradient effect
        if (polygonData.shadowPolygon) {
            // Create gradient by rendering multiple buffer rings with decreasing opacity
            if (polygonData.shadowPolygon.gradientRings) {
                // Render gradient rings from outermost to innermost for proper layering
                polygonData.shadowPolygon.gradientRings.forEach(ring => {
                    L.geoJSON(ring.geojson, {
                        style: ring.style
                    }).addTo(this.deepLayer);
                });
            } else {
                // Fallback to simple rendering if no gradient rings
                L.geoJSON(polygonData.shadowPolygon.geojson, {
                    style: polygonData.shadowPolygon.style
                }).addTo(this.deepLayer);
            }
        }
    }

    /**
     * Render a single polygon
     * @param {Object} polygon - Polygon data object
     */
    renderSinglePolygon(polygon) {
        return L.polygon(polygon.coordinates, polygon.style).addTo(this.deepLayer);
    }

    /**
     * Calculate polygon difference between start and end dates for highlighting
     * @param {Object} startDatePolygons - Polygons from start date
     * @param {Object} endDatePolygons - Polygons from end date
     * @returns {Object} Processed polygon data with diff highlighting
     */
    calculatePolygonDifference(startDatePolygons, endDatePolygons) {
        // Filter polygons with "#a52714" color from both datasets
        const startRedPolygons = startDatePolygons.polygons;
        const endRedPolygons = endDatePolygons.polygons;

        // Convert polygons to GeoJSON for Turf.js operations
        const startGeojsons = startRedPolygons.map(p => ({
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [p.coordinates.map(coord => [coord[1], coord[0]])] // Convert back to [lng, lat]
            },
            properties: p.properties
        }));

        const endGeojsons = endRedPolygons.map(p => ({
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [p.coordinates.map(coord => [coord[1], coord[0]])] // Convert back to [lng, lat]
            },
            properties: p.properties
        }));

        let mergedStart = null;
        let mergedEnd = null;
        let difference = null;
        let reverseDifference = null; // Areas in start but not in end (losses)

        try {
            // Merge all start date polygons
            if (startGeojsons.length > 0) {
                mergedStart = startGeojsons[0];
                for (let i = 1; i < startGeojsons.length; i++) {
                    if (mergedStart) {
                        mergedStart = turf.union(mergedStart, startGeojsons[i]);
                    }
                }
            }

            // Merge all end date polygons
            if (endGeojsons.length > 0) {
                mergedEnd = endGeojsons[0];
                for (let i = 1; i < endGeojsons.length; i++) {
                    if (mergedEnd) {
                        mergedEnd = turf.union(mergedEnd, endGeojsons[i]);
                    }
                }
            }

            // Calculate differences in both directions

            // Calculate difference: areas in end date but not in start date (gains)
            if (mergedEnd && mergedStart) {
                try {
                    difference = turf.difference(mergedEnd, mergedStart);
                    console.log('✓ Calculated gains difference:', difference ? 'exists' : 'null');
                } catch (error) {
                    console.warn('Could not calculate difference between polygons:', error);
                    difference = mergedEnd; // Fallback to showing end polygons
                }

                // Calculate reverse difference: areas in start but not in end (losses)
                try {
                    reverseDifference = turf.difference(mergedStart, mergedEnd);
                    console.log('✓ Calculated losses difference:', reverseDifference ? 'exists' : 'null');
                } catch (error) {
                    console.warn('Could not calculate reverse difference between polygons:', error);
                }
            } else if (mergedEnd) {
                difference = mergedEnd; // No start polygons, show all end polygons as new
                console.log('⚠️ No start polygons, using end as difference');
            } else if (mergedStart) {
                reverseDifference = mergedStart; // No end polygons, show all start polygons as lost
                console.log('⚠️ No end polygons, using start as reverse difference');
            }
        } catch (error) {
            console.error('Error processing polygon difference:', error);
        }

        // Prepare result
        const result = {
            polygons: [],
            shadowPolygon: endDatePolygons.shadowPolygon || startDatePolygons.shadowPolygon,
            statistics: {
                ...startDatePolygons.statistics,
                ...endDatePolygons.statistics
            }
        };

        if (mergedStart) {
            result.polygons.push({
                geojson: mergedStart,
                style: {
                    color: "#a52714",
                    fillColor: "#a52714",
                    fillOpacity: 0.3,
                    weight: 1
                },
                type: 'merged-start'
            });
        }

        // Add difference polygons highlighted in red (gains: start -> end)
        if (difference) {
            const diffArea = this.calculateGeoPolygonArea(difference.geometry?.coordinates || difference.coordinates);
            console.log(`Gains (start → end): ${diffArea.squareKilometers.toFixed(2)} km²`);

            result.polygons.push({
                geojson: difference,
                style: {
                    color: "red",
                    fillColor: "red",
                    fillOpacity: 0.5,
                    weight: 2
                },
                type: 'difference'
            });
        }

        // Add reverse difference polygons highlighted in blue (losses: end -> start)
        if (reverseDifference) {
            const reverseDiffArea = this.calculateGeoPolygonArea(reverseDifference.geometry?.coordinates || reverseDifference.coordinates);
            console.log(`📉 Losses (end → start): ${reverseDiffArea.squareKilometers.toFixed(2)} km²`);
            console.log('Blue polygon added to result:', {
                type: 'reverse-difference',
                hasGeojson: !!reverseDifference,
                style: { color: "blue", fillColor: "blue", fillOpacity: 0.5, weight: 2 }
            });

            result.polygons.push({
                geojson: reverseDifference,
                style: {
                    color: "blue",
                    fillColor: "blue",
                    fillOpacity: 0.5,
                    weight: 2
                },
                type: 'reverse-difference'
            });
        } else {
            console.log('⚠️ No reverse difference calculated (no territorial losses)');
        }

        console.log(`Total polygons in result: ${result.polygons.length}`, result.polygons.map(p => p.type));

        return result;
    }

    unionList(geojsons) {
        let mergedStart;
        if (geojsons.length > 0) {
            mergedStart = geojsons[0];
            for (let i = 1; i < geojsons.length; i++) {
                if (mergedStart) {
                    mergedStart = turf.union(mergedStart, geojsons[i]);
                }
            }
        }
        return mergedStart;
    }

    normalizePolygon(geojsons) {
        return geojsons.map(p => ({
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [p.coordinates.map(coord => [coord[1], coord[0]])] // Convert back to [lng, lat]
            },
            properties: p.properties
        }));
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

        }
    }

    async loadFeatures(feature = 'ditches', user = 0) {
        try {
            const response = await fetch(`https://playframap.github.io/data/${feature}.geojson`);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            return await response.json();
        } catch (e) {
            console.error(`Failed to load ${feature} from PlayFra:`, e);
        }

    }
}
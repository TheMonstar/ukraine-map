const HEX_FRONTLINE_REGIONS = [
    'Avtonomna Respublika Krym',
    'Dnipropetrovska',
    'Donetska',
    'Zaporizka',
    'Luhanska',
    'Mykolaivska',
    'Sumska',
    'Kharkivska',
    'Khersonska'
];

const HEX_REGION_AREA_KM2 = 450000;

class HexTiles {
    constructor() {
        this.layer = null;
        this._borderCache = null;      // merged region shape
        this._hexGridCache = null;     // { cellSizeKm, grid }
    }

    async getBorderShape(regionsData) {
        if (this._borderCache) return this._borderCache;

        let shape = null;

        if (regionsData && regionsData.features) {
            const matched = regionsData.features.filter(f =>
                HEX_FRONTLINE_REGIONS.includes(f.properties?.name)
            );
            if (matched.length > 0) {
                shape = matched[0];
                for (let i = 1; i < matched.length; i++) {
                    try { shape = turf.union(shape, matched[i]); } catch (e) { }
                }
            }
        }

        if (!shape) {
            const deepUtils = new DeepUtils(null);
            shape = await deepUtils.loadTheBorder();
        }

        // Simplified shape for fast point-in-polygon tests (full shape kept in _borderFull)
        this._borderFull = shape;
        this._borderCache = turf.simplify(shape, { tolerance: 0.05, highQuality: false });
        return this._borderCache;
    }

    _getHexGrid(borderShape, cellSizeKm) {
        if (this._hexGridCache && this._hexGridCache.cellSizeKm === cellSizeKm) {
            return this._hexGridCache.grid;
        }
        // No mask — generate full bbox grid, filter by centroid PIP (much faster than masked hexGrid)
        const bbox = turf.bbox(this._borderFull || borderShape);
        const grid = turf.hexGrid(bbox, cellSizeKm, { units: 'kilometers' });
        // Pre-filter to region centroid-inside only
        grid.features = grid.features.filter(hex =>
            turf.booleanPointInPolygon(turf.centroid(hex), borderShape)
        );
        this._hexGridCache = { cellSizeKm, grid };
        return grid;
    }

    _polygonDataToGeojson(poly) {
        if (poly.geojson) return poly.geojson;
        if (poly.coordinates) {
            const ring = poly.coordinates.map(c => [c[1], c[0]]);
            if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
                ring.push(ring[0]);
            }
            return turf.polygon([ring]);
        }
        return null;
    }

    async render(mapInstance, regionsData, cellSizeKm, occupiedPolygons, viewBbox) {
        if (this.layer) {
            mapInstance.removeLayer(this.layer);
            this.layer = null;
        }

        const borderShape = await this.getBorderShape(regionsData);
        if (!borderShape) return;

        const hexGrid = this._getHexGrid(borderShape, cellSizeKm);

        // Clip to viewport when viewbox mode is active — reduces tile count before any heavy work
        const features = viewBbox
            ? hexGrid.features.filter(hex => {
                const [minX, minY, maxX, maxY] = turf.bbox(hex);
                return minX <= viewBbox[2] && maxX >= viewBbox[0] && minY <= viewBbox[3] && maxY >= viewBbox[1];
            })
            : hexGrid.features;

        // Build merged unions once per color — occupation zone is contiguous so this is cheap
        let occupiedUnion = null;
        const colorUnions = {};

        if (occupiedPolygons && occupiedPolygons.length > 0) {
            for (const poly of occupiedPolygons) {
                const geojson = this._polygonDataToGeojson(poly);
                if (!geojson) continue;
                const color = poly.style?.fillColor || '#a52714';
                try {
                    occupiedUnion = occupiedUnion ? turf.union(occupiedUnion, geojson) : geojson;
                    colorUnions[color] = colorUnions[color] ? turf.union(colorUnions[color], geojson) : geojson;
                } catch (e) { }
            }
        }

        // Simplify occupied union for faster PIP and intersect tests
        if (occupiedUnion) {
            try { occupiedUnion = turf.simplify(occupiedUnion, { tolerance: 0.01, highQuality: false }); } catch (e) { }
            for (const color of Object.keys(colorUnions)) {
                try { colorUnions[color] = turf.simplify(colorUnions[color], { tolerance: 0.01, highQuality: false }); } catch (e) { }
            }
        }

        // Pre-compute bbox of occupied union for fast rejection
        const occBbox = occupiedUnion ? turf.bbox(occupiedUnion) : null;

        const styledFeatures = features.map(hex => {
            let fillColor = 'transparent';
            let fillOpacity = 0;

            if (!occupiedUnion) {
                fillColor = '#0057B7';
                fillOpacity = 0.25;
                return { ...hex, properties: { ...hex.properties, _hfill: fillColor, _hopacity: fillOpacity } };
            }

            try {
                const hexBbox = turf.bbox(hex);

                // Fast bbox rejection — no overlap with occupied zone at all
                if (hexBbox[0] > occBbox[2] || hexBbox[2] < occBbox[0] ||
                    hexBbox[1] > occBbox[3] || hexBbox[3] < occBbox[1]) {
                    return { ...hex, properties: { ...hex.properties, _hfill: fillColor, _hopacity: fillOpacity } };
                }

                const centroid = turf.centroid(hex);
                const centroidInside = turf.booleanPointInPolygon(centroid, occupiedUnion);

                if (centroidInside) {
                    // Centroid inside → treat as fully occupied; skip expensive intersect
                    for (const [color, union] of Object.entries(colorUnions)) {
                        if (turf.booleanPointInPolygon(centroid, union)) {
                            fillColor = color;
                            fillOpacity = 0.55;
                            break;
                        }
                    }
                    if (fillOpacity === 0) { fillColor = '#a52714'; fillOpacity = 0.55; }
                } else {
                    // Centroid outside but bbox overlaps → boundary tile, do precise intersect
                    const intersection = turf.intersect(hex, occupiedUnion);
                    if (intersection) {
                        const ratio = turf.area(intersection) / turf.area(hex);
                        if (ratio >= 0.85) {
                            for (const [color, union] of Object.entries(colorUnions)) {
                                if (turf.booleanPointInPolygon(centroid, union)) {
                                    fillColor = color;
                                    fillOpacity = 0.55;
                                    break;
                                }
                            }
                            if (fillOpacity === 0) { fillColor = '#a52714'; fillOpacity = 0.55; }
                        } else if (ratio >= 0.05) {
                            fillColor = '#888888';
                            fillOpacity = 0.35;
                        }
                    }
                }
            } catch (e) { }

            return { ...hex, properties: { ...hex.properties, _hfill: fillColor, _hopacity: fillOpacity } };
        });

        this.layer = L.geoJSON({ type: 'FeatureCollection', features: styledFeatures }, {
            style: f => ({
                color: '#55555566',
                weight: 0.6,
                fillColor: f.properties._hfill,
                fillOpacity: f.properties._hopacity
            })
        }).addTo(mapInstance);
    }

    remove(mapInstance) {
        if (this.layer) {
            mapInstance.removeLayer(this.layer);
            this.layer = null;
        }
    }

    invalidateBorderCache() {
        this._borderCache = null;
        this._borderFull = null;
        this._hexGridCache = null;
    }

    static approxTileCount(cellSizeKm) {
        const hexArea = 2.598 * cellSizeKm * cellSizeKm;
        return Math.round(HEX_REGION_AREA_KM2 / hexArea);
    }
}

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

    static boxesOverlap(a, b) {
        return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    }

    // A small bounding-box tree over exact boundary segments. It is conservative:
    // a negative query proves there is no boundary (including holes) in the cell.
    static boundaryTree(boxes) {
        if (!boxes.length) return null;
        const bounds = [Infinity, Infinity, -Infinity, -Infinity];
        for (const box of boxes) {
            bounds[0] = Math.min(bounds[0], box[0]); bounds[1] = Math.min(bounds[1], box[1]);
            bounds[2] = Math.max(bounds[2], box[2]); bounds[3] = Math.max(bounds[3], box[3]);
        }
        if (boxes.length <= 16) return { bounds, boxes };
        const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
        boxes.sort((a, b) => (a[axis] + a[axis + 2]) - (b[axis] + b[axis + 2]));
        const mid = Math.floor(boxes.length / 2);
        return { bounds, left: HexTiles.boundaryTree(boxes.slice(0, mid)), right: HexTiles.boundaryTree(boxes.slice(mid)) };
    }

    static touchesBoundary(tree, bbox) {
        if (!tree || !HexTiles.boxesOverlap(tree.bounds, bbox)) return false;
        return tree.boxes ? tree.boxes.some(box => HexTiles.boxesOverlap(box, bbox))
            : HexTiles.touchesBoundary(tree.left, bbox) || HexTiles.touchesBoundary(tree.right, bbox);
    }

    static prepareCoverage(geometry) {
        const boxes = [];
        turf.segmentEach(geometry, segment => boxes.push(turf.bbox(segment)));
        return { geometry, bbox: turf.bbox(geometry), boundary: HexTiles.boundaryTree(boxes),
            parts: turf.flatten(geometry).features.map(feature => ({ feature, bbox: turf.bbox(feature) })) };
    }

    static coverage(hex, bbox, area, prepared) {
        if (!HexTiles.boxesOverlap(bbox, prepared.bbox)) return 0;
        if (!HexTiles.touchesBoundary(prepared.boundary, bbox)) {
            return turf.booleanPointInPolygon(turf.centroid(hex), prepared.geometry) ? 1 : 0;
        }
        // Only boundary cells need clipping. Disjoint MultiPolygon components
        // outside the cell are excluded before Turf sees the geometry.
        let covered = 0;
        for (const part of prepared.parts) {
            if (!HexTiles.boxesOverlap(bbox, part.bbox)) continue;
            const intersection = turf.intersect(hex, part.feature);
            if (intersection) covered += turf.area(intersection);
        }
        return Math.min(1, covered / area);
    }

    _prepareOccupation(polygons = []) {
        const inputs = polygons.map(poly => ({ geometry: poly.geojson || poly.coordinates, color: poly.style?.fillColor || '#a52714' }));
        const cached = this._occupation;
        if (cached && inputs.length === cached.inputs.length && inputs.every((input, i) =>
            input.geometry === cached.inputs[i].geometry && input.color === cached.inputs[i].color)) return cached;
        const colors = new Map();
        polygons.forEach((poly, i) => {
            const geometry = this._polygonDataToGeojson(poly);
            if (!geometry) return;
            const color = inputs[i].color;
            colors.set(color, colors.has(color) ? turf.union(colors.get(color), geometry) : geometry);
        });
        const occupied = [...colors.values()].reduce((union, geometry) => union ? turf.union(union, geometry) : geometry, null);
        const coverage = occupied ? HexTiles.prepareCoverage(occupied) : null;
        this._occupation = { inputs, styles: new WeakMap(), occupied: coverage,
            colors: [...colors].map(([color, geometry]) => ({ color,
                coverage: colors.size === 1 ? coverage : HexTiles.prepareCoverage(geometry) })) };
        return this._occupation;
    }

    async render(mapInstance, regionsData, cellSizeKm, occupiedPolygons, viewBbox) {
        const generation = this._generation = (this._generation || 0) + 1;
        this._cellSizeKm = cellSizeKm;

        const borderShape = await this.getBorderShape(regionsData);
        if (!borderShape || generation !== this._generation) return;

        const hexGrid = this._getHexGrid(borderShape, cellSizeKm);

        // Clip to viewport when viewbox mode is active — reduces tile count before any heavy work
        const features = viewBbox
            ? hexGrid.features.filter(hex => {
                const [minX, minY, maxX, maxY] = turf.bbox(hex);
                return minX <= viewBbox[2] && maxX >= viewBbox[0] && minY <= viewBbox[3] && maxY >= viewBbox[1];
            })
            : hexGrid.features;

        const prepared = this._prepareOccupation(occupiedPolygons || []);
        const styledFeatures = features.map(hex => {
            const cached = prepared.styles.get(hex);
            if (cached) return cached;
            let fillColor = 'transparent', fillOpacity = 0;
            if (!prepared.occupied) {
                fillColor = '#0057B7'; fillOpacity = 0.25;
            } else {
                const bbox = turf.bbox(hex), area = turf.area(hex);
                const ratio = HexTiles.coverage(hex, bbox, area, prepared.occupied);
                if (ratio >= 0.85) {
                    if (prepared.colors.length === 1) fillColor = prepared.colors[0].color;
                    else {
                        let largest = 0;
                        for (const entry of prepared.colors) {
                            const colorRatio = HexTiles.coverage(hex, bbox, area, entry.coverage);
                            if (colorRatio > largest) { largest = colorRatio; fillColor = entry.color; }
                            if (colorRatio === 1) break;
                        }
                    }
                    fillOpacity = 0.55;
                } else if (ratio >= 0.05) {
                    fillColor = '#888888'; fillOpacity = 0.35;
                }
            }
            const styled = { ...hex, properties: { ...hex.properties, _hfill: fillColor, _hopacity: fillOpacity } };
            prepared.styles.set(hex, styled);
            return styled;
        });

        if (this.layer) mapInstance.removeLayer(this.layer);
        this.layer = L.geoJSON({ type: 'FeatureCollection', features: styledFeatures }, {
            style: f => ({
                color: '#55555566',
                weight: 0.6,
                fillColor: f.properties._hfill,
                fillOpacity: f.properties._hopacity
            }),
            onEachFeature: (feature, lyr) => lyr.on('click', () => {
                if (this._cellSizeKm > 15) return;
                const c = turf.centroid(feature).geometry.coordinates; // [lng, lat]
                const date = document.getElementById('date-end')?.value || new Date().toISOString().slice(0, 10);
                window.open(`3d-view.html?lat=${c[1].toFixed(5)}&lng=${c[0].toFixed(5)}&size=${this._cellSizeKm}&date=${date}`, '_blank');
            })
        }).addTo(mapInstance);
    }

    remove(mapInstance) {
        this._generation = (this._generation || 0) + 1;
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

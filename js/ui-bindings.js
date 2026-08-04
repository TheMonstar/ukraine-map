class UiBindings {
    constructor(dashboard) {
        this.dashboard = dashboard;
    }

    init() {
        this.dashboard.cacheUI();
        this.register();
    }

    register() {
        const dashboard = this.dashboard;
        let selectedIcons = new Set();

        const updateDiffStats = (startDatePolygons, endDatePolygons) => {
            const totalGains = Object.values(endDatePolygons.statistics).reduce((acc, curr) => acc + curr, 0) -
                Object.values(startDatePolygons.statistics).reduce((acc, curr) => acc + curr, 0);
            const totalGrey = endDatePolygons.statistics['#bcaaa4'] - startDatePolygons.statistics['#bcaaa4'];
            const totalCaptured = endDatePolygons.statistics['#a52714'] - startDatePolygons.statistics['#a52714'];

            dashboard.setText('total-gains', Math.round(totalGains));
            dashboard.setText('total-captured', Math.round(totalCaptured));
            dashboard.setText('total-grayed', Math.round(totalGrey));
            dashboard.calculateSettlementsInDiffArea(startDatePolygons, endDatePolygons);
            const sliceStatsEl = dashboard.getEl('slice-territory-stats');
            if (sliceStatsEl) sliceStatsEl.innerHTML = '';
        };

        const polyCache = new Map();
        const borderCache = new Map();

        const getPolygons = async (date) => {
            const shadowLine = document.getElementById('shadow-line')?.checked ? 1 : 0;
            const occDepth = document.getElementById('shadow-depth-occupied')?.value || '';
            const oppDepth = document.getElementById('shadow-depth-opposite')?.value || '';
            const gradient = document.getElementById('shadow-gradient')?.checked ? 1 : 0;
            const key = `${date.toLocaleDateString('en-CA')}:${shadowLine}:${occDepth}:${oppDepth}:${gradient}`;
            if (!polyCache.has(key)) {
                const utils = new DeepUtils(null);
                polyCache.set(key, await utils.addDeepMap(date));
            }
            return polyCache.get(key);
        };

        const getBorder = async (code = 'ua') => {
            if (!borderCache.has(code)) {
                const utils = new DeepUtils(null);
                borderCache.set(code, await utils.loadTheBorder(code));
            }
            return borderCache.get(code);
        };

        const safeUnion = (left, right) => {
            if (!left) return right;
            try {
                return turf.union(left, right);
            } catch (error) {
                try {
                    return turf.union(turf.cleanCoords(left), turf.cleanCoords(right));
                } catch (cleanError) {
                    console.warn('Union failed for diff slice polygon, skipping merge:', cleanError);
                    return left;
                }
            }
        };

        const renderDeepLayer = async () => {
            dashboard.deepLayer.clearLayers();
            if (!dashboard.isChecked('diff-area')) {
                dashboard.setText('settlements-in-diff', '0');
                if (dashboard.casualtiesLayer) dashboard.casualtiesLayer.clearLayers();
                if (dashboard.selectedPolygons.length > 0) dashboard.calculateSelectedAreaStatistics();
                return;
            }

            const deepMap = new DeepUtils(dashboard.deepLayer);
            const endDatePolygons = await getPolygons(dashboard.endDate);

            if (dashboard.isChecked('shadow-ua')) {
                const uaborder = await getBorder('ua');
                const ruborder = await getBorder('ru');
                const frame = turf.polygon([[[52.426188, 31.433755], [52.426188, 40.678473], [46.977225, 40.678473], [46.977225, 31.433755], [52.426188, 31.433755]].map(el => [el[1], el[0]])]);
                const area = deepMap.unionList([...deepMap.normalizePolygon(endDatePolygons.polygons), turf.intersect(ruborder, frame)]);
                const chunk = turf.difference(uaborder, area);
                const shadow = deepMap.addShadow(area, dashboard.getEl('shadow-ua-size')?.value || 20);
                const shadowOnly = turf.difference(shadow, area);
                const shadowExclRu = turf.intersect(turf.difference(shadowOnly, ruborder), uaborder);
                dashboard.shadowUaPolygon = shadowExclRu;
                const zone = turf.difference(chunk, shadow);
                const contested = turf.difference(uaborder, zone);
                const areaExclRu = turf.difference(area, ruborder);
                const contestedExclRu = turf.difference(contested, ruborder);
                const shadowPolygonData = {
                    polygons: [
                        { geojson: areaExclRu, style: { color: '#a52714', fillColor: '#a52714', fillOpacity: 0.2, weight: 1 }, type: 'merged-start' },
                        { geojson: shadowExclRu, style: { color: '#1b1a1a', fillColor: '#1b1a1a', fillOpacity: 0.3, weight: 1 }, type: 'shadow' },
                        { geojson: contestedExclRu, style: { color: '#a52714', fillColor: '#a52714', fillOpacity: 0.2, weight: 1 }, type: 'merged-start' }
                    ].filter(p => p.geojson)
                };
                const optimizedShadowData = dashboard.isChecked('optimize-polygons') ?
                    dashboard.optimizePolygonsByColor(shadowPolygonData) : shadowPolygonData;
                deepMap.renderMap(optimizedShadowData);

            } else if (dashboard.isChecked('diff-highlight')) {
                const startDatePolygons = await getPolygons(dashboard.startDate);
                updateDiffStats(startDatePolygons, endDatePolygons);

                const noGray = (data) => dashboard.isChecked('diff-no-base')
                    ? { ...data, polygons: data.polygons.filter(p => p.properties?.fill !== '#bcaaa4') }
                    : data;

                const sliceDates = dashboard.getDiffSliceDates();
                if (sliceDates.length) {
                    const sliceColors = ['#ff5252', '#ff9800', '#ffeb3b', '#8bc34a', '#03a9f4', '#9c27b0'];
                    const allDates = [dashboard.startDate, ...sliceDates, dashboard.endDate];
                    const diffPolygons = [];
                    let combinedDifference = null;

                    const baseResult = deepMap.calculatePolygonDifference(noGray(startDatePolygons), noGray(endDatePolygons));
                    baseResult.polygons
                        .filter(polygon => polygon.type === 'merged-start')
                        .forEach(polygon => diffPolygons.push(polygon));

                    const sliceTerritoryStats = [];
                    for (let i = 0; i < allDates.length - 1; i++) {
                        const sliceStart = await getPolygons(allDates[i]);
                        const sliceEnd = await getPolygons(allDates[i + 1]);
                        const sliceDiff = deepMap.calculatePolygonDifference(noGray(sliceStart), noGray(sliceEnd));
                        const color = sliceColors[i % sliceColors.length];
                        let sliceGains = 0, sliceLosses = 0;

                        sliceDiff.polygons
                            .filter(polygon => polygon.type === 'difference')
                            .forEach(polygon => {
                                polygon.style = { ...polygon.style, color, fillColor: color };
                                polygon.sliceIndex = i;
                                polygon.showArea = true;
                                polygon.sliceLabel = `${dashboard.formatDate(allDates[i])} → ${dashboard.formatDate(allDates[i + 1])} captured`;
                                diffPolygons.push(polygon);
                                combinedDifference = safeUnion(combinedDifference, polygon.geojson);
                                try { sliceGains += turf.area(polygon.geojson) / 1e6; } catch (e) { }
                            });

                        sliceDiff.polygons
                            .filter(polygon => polygon.type === 'reverse-difference')
                            .forEach(polygon => {
                                polygon.style = { ...polygon.style, color: 'blue', fillColor: 'blue', fillOpacity: 0.5 };
                                polygon.sliceIndex = i;
                                polygon.isLoss = true;
                                polygon.showArea = true;
                                polygon.sliceLabel = `${dashboard.formatDate(allDates[i])} → ${dashboard.formatDate(allDates[i + 1])} lost`;
                                diffPolygons.push(polygon);
                                try { sliceLosses += turf.area(polygon.geojson) / 1e6; } catch (e) { }
                            });

                        sliceTerritoryStats.push({
                            from: dashboard.formatDate(allDates[i]),
                            to: dashboard.formatDate(allDates[i + 1]),
                            color, gains: sliceGains, losses: sliceLosses, net: sliceGains - sliceLosses
                        });
                    }

                    const minAreaSqM = 1e6;
                    const filteredDiffPolygons = diffPolygons.map(polygon => {
                        if (!polygon.geojson) return polygon;
                        try {
                            const geom = polygon.geojson.geometry || polygon.geojson;
                            if (geom.type === 'MultiPolygon') {
                                const kept = geom.coordinates.filter(coords =>
                                    turf.area(turf.polygon(coords)) >= minAreaSqM
                                );
                                if (kept.length === 0) return null;
                                return {
                                    ...polygon, geojson: kept.length === 1
                                        ? turf.polygon(kept[0]) : turf.multiPolygon(kept)
                                };
                            }
                            if (geom.type === 'Polygon') {
                                return turf.area(polygon.geojson) >= minAreaSqM ? polygon : null;
                            }
                            return polygon;
                        } catch (e) {
                            return polygon;
                        }
                    }).filter(Boolean);

                    const combinedResult = {
                        polygons: filteredDiffPolygons,
                        shadowPolygon: endDatePolygons.shadowPolygon || startDatePolygons.shadowPolygon,
                        statistics: { ...startDatePolygons.statistics, ...endDatePolygons.statistics }
                    };
                    dashboard.currentDiffResult = combinedResult;

                    const optimizedDiffResult = dashboard.isChecked('optimize-polygons') ?
                        dashboard.optimizePolygonsByColor(combinedResult) : combinedResult;
                    deepMap.renderMap(optimizedDiffResult);

                    const statsEl = dashboard.getEl('slice-territory-stats');
                    if (statsEl && sliceTerritoryStats.length) {
                        const totalGains = sliceTerritoryStats.reduce((s, t) => s + t.gains, 0);
                        const totalLosses = sliceTerritoryStats.reduce((s, t) => s + t.losses, 0);
                        const totalNet = totalGains - totalLosses;
                        let html = '<h3 style="margin:10px 0 5px">Slice Territory</h3>';
                        sliceTerritoryStats.forEach(s => {
                            html += `<p style="margin:2px 0;font-size:12px">` +
                                `<span style="color:${s.color}">■</span> ${s.from} → ${s.to}: ` +
                                `<b>${s.net >= 0 ? '+' : ''}${s.net.toFixed(1)}</b> km² ` +
                                `(↑${s.gains.toFixed(1)} ↓${s.losses.toFixed(1)})</p>`;
                        });
                        html += `<p style="margin:4px 0 0;font-size:12px;border-top:1px solid #ddd;padding-top:4px">` +
                            `<b>Total: ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(1)} km²</b> ` +
                            `(↑${totalGains.toFixed(1)} ↓${totalLosses.toFixed(1)})</p>`;
                        statsEl.innerHTML = html;
                    } else if (statsEl) {
                        statsEl.innerHTML = '';
                    }

                    if (dashboard.isChecked('regions-highlight') && combinedDifference) {
                        const dirs = [];
                        Object.entries(dashboard.directionBorders).forEach(([key, value]) => {
                            const res = turf.intersect(value, combinedDifference);
                            if (!res) return;
                            L.geoJSON(res, {
                                style: { color: dashboard.getDirectionColor(key), weight: 2, fillOpacity: 0.7 }
                            }).addTo(dashboard.featureLayer).bindTooltip(key);
                            dirs.push({
                                region: key, totalAttacks: res.geometry.coordinates.flatMap(item => item)
                                    .reduce((a, b) => a + deepMap.calculateGeoPolygonArea(b).squareKilometers || 0, 0)
                            });
                        });
                        dashboard.updateStatistics(dashboard.calculateAttackStatistics(dirs));
                    }

                } else {
                    const diffResult = deepMap.calculatePolygonDifference(noGray(startDatePolygons), noGray(endDatePolygons));
                    dashboard.currentDiffResult = diffResult;

                    const optimizedDiffResult = dashboard.isChecked('optimize-polygons') ?
                        dashboard.optimizePolygonsByColor(diffResult) : diffResult;
                    deepMap.renderMap(optimizedDiffResult);

                    if (dashboard.isChecked('regions-highlight')) {
                        const dirs = [];
                        const gainsPolygon = diffResult.polygons.find(p => p.type === 'difference');
                        const lossesPolygon = diffResult.polygons.find(p => p.type === 'reverse-difference');

                        if (gainsPolygon?.geojson) {
                            Object.entries(dashboard.directionBorders).forEach(([key, value]) => {
                                const res = turf.intersect(value, gainsPolygon.geojson);
                                if (!res) return;
                                L.geoJSON(res, {
                                    style: { color: dashboard.getDirectionColor(key), weight: 2, fillOpacity: 0.7 }
                                }).addTo(dashboard.featureLayer).bindTooltip(`${key} (gains)`);
                                const area = res.geometry.coordinates.flatMap(item => item)
                                    .reduce((a, b) => a + deepMap.calculateGeoPolygonArea(b).squareKilometers || 0, 0);
                                const existingDir = dirs.find(d => d.region === key);
                                if (existingDir) existingDir.gains = area;
                                else dirs.push({ region: key, totalAttacks: area, gains: area, losses: 0 });
                            });
                        }

                        if (lossesPolygon?.geojson) {
                            Object.entries(dashboard.directionBorders).forEach(([key, value]) => {
                                const res = turf.intersect(value, lossesPolygon.geojson);
                                if (!res) return;
                                L.geoJSON(res, {
                                    style: { color: 'blue', weight: 2, fillOpacity: 0.5 }
                                }).addTo(dashboard.featureLayer).bindTooltip(`${key} (losses)`);
                                const area = res.geometry.coordinates.flatMap(item => item)
                                    .reduce((a, b) => a + deepMap.calculateGeoPolygonArea(b).squareKilometers || 0, 0);
                                const existingDir = dirs.find(d => d.region === key);
                                if (existingDir) existingDir.losses = area;
                                else dirs.push({ region: key, totalAttacks: 0, gains: 0, losses: area });
                            });
                        }

                        if (dirs.length > 0) {
                            dashboard.updateStatistics(dashboard.calculateAttackStatistics(dirs));
                        }
                    }
                }

            } else {
                // Base case: render only endDate polygons
                dashboard.currentDiffResult = null;
                dashboard.currentDeepResult = endDatePolygons;
                const sliceStatsEl = dashboard.getEl('slice-territory-stats');
                if (sliceStatsEl) sliceStatsEl.innerHTML = '';
                const optimized = dashboard.isChecked('optimize-polygons') ?
                    dashboard.optimizePolygonsByColor(endDatePolygons) : endDatePolygons;
                deepMap.renderMap(optimized);
            }

            if (dashboard.isChecked('casualties-density')) {
                dashboard.renderCasualtiesDensity();
            }
            if (dashboard.selectedPolygons.length > 0) {
                dashboard.calculateSelectedAreaStatistics();
            }
        };

        dashboard.renderDeepLayer = renderDeepLayer;

        dashboard.bindUI('map-style', 'change', (e) => {
            dashboard.layers.setBaseLayer(e.target.value);
        });

        // ── Map rotation (leaflet-rotate) ─────────────────────────────────────
        const bearingSlider = dashboard.getEl('rotate-bearing');
        const setBearingUI = (deg) => {
            const norm = ((deg % 360) + 360) % 360;
            if (bearingSlider) bearingSlider.value = norm;
            dashboard.setText('rotate-bearing-value', Math.round(norm));
        };

        dashboard.bindUI('rotate-left', 'click', () => {
            dashboard.map.setBearing(dashboard.map.getBearing() - 15);
        });
        dashboard.bindUI('rotate-right', 'click', () => {
            dashboard.map.setBearing(dashboard.map.getBearing() + 15);
        });
        dashboard.bindUI('rotate-reset', 'click', () => {
            dashboard.map.setBearing(0);
        });
        dashboard.bindUI('rotate-bearing', 'input', (e) => {
            dashboard.map.setBearing(parseInt(e.target.value, 10));
        });
        // keep the slider/label in sync with gesture-driven rotation too
        // (touch two-finger rotate, shift+drag) — not just the UI controls
        dashboard.map.on('rotate', () => setBearingUI(dashboard.map.getBearing()));

        dashboard.bindUI('shadow-line', 'change', () => {
            const shadowDepthControls = document.getElementById('shadow-depth-controls');
            if (shadowDepthControls) {
                shadowDepthControls.style.display = dashboard.isChecked('shadow-line') ? 'block' : 'none';
            }
            renderDeepLayer();
        });

        dashboard.bindUI('shadow-ua', 'change', () => renderDeepLayer());

        dashboard.bindUI('shadow-ua-size', 'input', () => {
            if (dashboard.isChecked('shadow-ua')) renderDeepLayer();
        });

        const MAJOR_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary']);

        dashboard.bindUI('motorlines-by-shadow-btn', 'click', async () => {
            try {
            if (!dashboard.isChecked('shadow-ua') || !dashboard.shadowUaPolygon) {
                console.warn('Enable UA Shadow first');
                return;
            }
            const roadFeatures = await dashboard.lineFeatures.loadAllRoads();
            const totals = {};
            for (const feature of roadFeatures) {
                const highway = feature?.properties?.highway;
                if (!MAJOR_HIGHWAYS.has(highway)) continue;
                try {
                    const clipped = turf.lineSplit(feature, dashboard.shadowUaPolygon);
                    const inside = (clipped.features.length ? clipped.features : [feature]).filter(seg => {
                        const mid = turf.midpoint(turf.getCoords(seg)[0], turf.getCoords(seg)[turf.getCoords(seg).length - 1]);
                        return turf.booleanPointInPolygon(mid, dashboard.shadowUaPolygon);
                    });
                    const km = inside.reduce((sum, seg) => sum + turf.length(seg, { units: 'kilometers' }), 0);
                    totals[highway] = (totals[highway] || 0) + km;
                } catch {
                    // skip malformed features
                }
            }
            console.log('Road km within UA shadow zone:');
            Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([type, km]) => {
                console.log(`  ${type}: ${km.toFixed(1)} km`);
            });
            } catch (e) { console.error('motorlines-by-shadow error:', e); }
        });

        // --- Hex Tiles ---
        const hexTiles = new HexTiles();
        let hexDebounce = null;

        const scheduleHexUpdate = () => {
            clearTimeout(hexDebounce);
            hexDebounce = setTimeout(async () => {
                if (!dashboard.isChecked('hex-tiles')) {
                    hexTiles.remove(dashboard.map);
                    return;
                }
                const cellSize = parseFloat(dashboard.getEl('hex-tile-size')?.value || 30);
                let occupiedPolygons = null;
                if (dashboard.isChecked('match-the-front')) {
                    const deepUtils = new DeepUtils(null);
                    const data = await deepUtils.addDeepMap(dashboard.endDate);
                    occupiedPolygons = data.polygons;
                }
                let viewBbox = null;
                if (dashboard.isChecked('hex-viewbox')) {
                    const b = dashboard.map.getBounds();
                    viewBbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
                }
                await hexTiles.render(dashboard.map, dashboard.regionsData, cellSize, occupiedPolygons, viewBbox);
            }, 500);
        };

        dashboard.hexTilesUpdate = scheduleHexUpdate;

        dashboard.bindUI('hex-tiles', 'change', () => {
            const controls = dashboard.getEl('hex-tiles-controls');
            if (controls) controls.style.display = dashboard.isChecked('hex-tiles') ? 'block' : 'none';
            scheduleHexUpdate();
        });

        dashboard.bindUI('hex-tile-size', 'input', () => {
            const cellSize = parseFloat(dashboard.getEl('hex-tile-size')?.value || 30);
            const label = dashboard.getEl('hex-tile-count-label');
            if (label) label.textContent = `${cellSize}km (~${HexTiles.approxTileCount(cellSize)} tiles)`;
            scheduleHexUpdate();
        });

        dashboard.bindUI('match-the-front', 'change', scheduleHexUpdate);
        dashboard.bindUI('hex-viewbox', 'change', scheduleHexUpdate);

        dashboard.map.on('moveend zoomend rotate', () => {
            if (dashboard.isChecked('hex-tiles') && dashboard.isChecked('hex-viewbox')) {
                scheduleHexUpdate();
            }
        });
        // --- End Hex Tiles ---

        dashboard.bindUI('diff-area', 'change', () => renderDeepLayer());

        dashboard.bindUI('motorlines-by-diff-btn', 'click', async () => {
            try {
            const visibleTypes = new Set([
                ...(dashboard.isChecked('motorlines-type-highway')  ? ['motorway', 'trunk']      : []),
                ...(dashboard.isChecked('motorlines-type-primary')   ? ['primary', 'secondary']   : []),
                ...(dashboard.isChecked('motorlines-type-tertiary')  ? ['tertiary']               : []),
            ]);
            if (!visibleTypes.size) { console.warn('No motorline types selected'); return; }
            const roadFeatures = await dashboard.lineFeatures.loadAllRoads();
            const features = roadFeatures.filter(f => visibleTypes.has(f?.properties?.highway));

            const unionAll = (polys) => {
                if (polys.length === 0) return null;
                if (polys.length === 1) return polys[0].geojson;
                const mid = Math.floor(polys.length / 2);
                const left = unionAll(polys.slice(0, mid));
                const right = unionAll(polys.slice(mid));
                return left && right ? turf.union(left, right) : (left || right);
            };

            const calcByType = (polygon) => {
                if (!polygon) return {};
                const totals = {};
                for (const feature of features) {
                    const highway = feature.properties.highway;
                    try {
                        const clipped = turf.lineSplit(feature, polygon);
                        const segs = clipped.features.length ? clipped.features : [feature];
                        const inside = segs.filter(seg => {
                            const coords = turf.getCoords(seg);
                            const mid = turf.midpoint(coords[0], coords[coords.length - 1]);
                            return turf.booleanPointInPolygon(mid, polygon);
                        });
                        const km = inside.reduce((sum, seg) => sum + turf.length(seg, { units: 'kilometers' }), 0);
                        if (km > 0) totals[highway] = (totals[highway] || 0) + km;
                    } catch { }
                }
                return totals;
            };

            if (dashboard.selectedPolygons.length > 0) {
                const geoJsons = dashboard.selectedPolygons.map(p => p.toGeoJSON());
                const polygon = geoJsons.reduce((acc, g) => acc ? turf.union(acc, g) : g, null);
                const totals = calcByType(polygon);
                console.log('Road km in selected polygon:');
                Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([t, km]) => console.log(`  ${t}: ${km.toFixed(1)} km`));
            } else if (dashboard.currentDiffResult) {
                const gainPolygons = dashboard.currentDiffResult.polygons.filter(p => p.type === 'difference' && p.geojson);
                const lossPolygons = dashboard.currentDiffResult.polygons.filter(p => p.type === 'reverse-difference' && p.geojson);
                const [gains, losses] = await Promise.all([calcByType(unionAll(gainPolygons)), calcByType(unionAll(lossPolygons))]);
                console.log('Road km in GAINS (diff area):');
                Object.entries(gains).sort((a, b) => b[1] - a[1]).forEach(([t, km]) => console.log(`  ${t}: ${km.toFixed(1)} km`));
                console.log('Road km in LOSSES (diff area):');
                Object.entries(losses).sort((a, b) => b[1] - a[1]).forEach(([t, km]) => console.log(`  ${t}: ${km.toFixed(1)} km`));
            } else if (dashboard.currentDeepResult) {
                const basePolygons = dashboard.currentDeepResult.polygons
                    .filter(p => p.geojson || p.coordinates)
                    .map(p => {
                        if (p.geojson) return { geojson: p.geojson };
                        const ring = p.coordinates.map(([lat, lng]) => [lng, lat]);
                        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
                        return { geojson: turf.polygon([ring]) };
                    });
                const totals = await calcByType(unionAll(basePolygons));
                console.log('Road km in DeepState painted area:');
                Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([t, km]) => console.log(`  ${t}: ${km.toFixed(1)} km`));
            } else {
                console.warn('Enable DeepState first');
            }
            } catch (e) { console.error('motorlines-by-diff error:', e); }
        });

        dashboard.bindUI('show-date-overlay', 'change', () => {
            const el = dashboard.getEl('date');
            if (el) el.style.display = dashboard.isChecked('show-date-overlay') ? '' : 'none';
        });

        dashboard.bindUI('diff-no-base', 'change', () => renderDeepLayer());

        dashboard.bindUI('diff-highlight', 'change', async () => {
            await renderDeepLayer();
            if (dashboard.isChecked('diff-highlight')) {
                const overlaySources = [
                    { id: 'amk-overlay', key: 'AMK' },
                    { id: 'radov-overlay', key: 'RADOV' },
                    { id: 'isw-overlay', key: 'ISW' },
                    { id: 'suriyak-overlay', key: 'suriyak' }
                ];
                let totalGains = 0;
                let totalLosses = 0;
                for (const source of overlaySources) {
                    if (dashboard.isChecked(source.id)) {
                        const result = await dashboard.layers.getManifestDiffAreaKm2(
                            source.key,
                            dashboard.startDate,
                            dashboard.endDate
                        );
                        // Handle both old (number) and new (object) return formats
                        if (typeof result === 'object') {
                            totalGains += result.gains || 0;
                            totalLosses += result.losses || 0;
                        } else {
                            totalGains += result || 0;
                        }
                    }
                }
                if (dashboard.isChecked('ria-overlay')) {
                    const riaResult = await dashboard.layers.getRiaDiffAreaKm2(dashboard.startDate, dashboard.endDate);
                    totalGains += riaResult.gains || 0;
                    totalLosses += riaResult.losses || 0;
                }
                const netChange = totalGains - totalLosses;
                dashboard.setText('total-gains', `${Math.round(netChange)} (↑${Math.round(totalGains)} ↓${Math.round(totalLosses)})`);
                console.log(`📊 Total: Gains ${totalGains.toFixed(2)} km², Losses ${totalLosses.toFixed(2)} km², Net ${netChange.toFixed(2)} km²`);
                dashboard.setText('total-captured', '0');
                dashboard.setText('total-grayed', '0');
                dashboard.setText('settlements-in-diff', '0');
            }
            if (dashboard.isChecked('radov-overlay')) {
                await dashboard.layers.toggleRadovOverlay(true);
            }
            if (dashboard.isChecked('amk-overlay')) {
                await dashboard.layers.toggleAmkOverlay(true);
            }
            if (dashboard.isChecked('isw-overlay')) {
                await dashboard.layers.toggleIswOverlay(true);
            }
            if (dashboard.isChecked('suriyak-overlay')) {
                await dashboard.layers.toggleSuriyakOverlay(true);
            }
            if (dashboard.isChecked('ria-overlay')) {
                await dashboard.layers.toggleRiaOverlay(true);
            }

            // Update casualties density if enabled
            if (dashboard.isChecked('casualties-density')) {
                dashboard.renderCasualtiesDensity();
            }

            // Show/hide losses input container
            const lossesContainer = dashboard.getEl('losses-input-container');
            if (lossesContainer) {
                lossesContainer.style.display = dashboard.isChecked('diff-highlight') ? 'block' : 'none';
            }

            if (dashboard.isChecked('creamy-overlay')) {
                await dashboard.layers.toggleCreamyOverlay(true);
            }
        });

        // Handle losses input changes
        dashboard.bindUI('losses-input', 'input', (e) => {
            const value = parseInt(e.target.value, 10) || 0;

            // Render losses if diff-highlight is checked and value > 0
            if (dashboard.isChecked('diff-highlight') && value > 0) {
                dashboard.renderLossesForDiffArea(value);
            } else if (dashboard.lossesLayer) {
                // Clear losses markers if value is 0
                dashboard.lossesLayer.clearLayers();
            }
        });

        dashboard.bindUI('casualties-density', 'change', async () => {
            if (dashboard.isChecked('casualties-density')) {
                dashboard.renderCasualtiesDensity();
            } else {
                // Clear casualties markers
                if (dashboard.casualtiesLayer) {
                    dashboard.casualtiesLayer.clearLayers();
                }
            }
        });

        dashboard.bindUI('diff-slices-count', 'change', (e) => {
            const value = parseInt(e.target.value, 10);
            dashboard.setDiffSliceCount(Number.isNaN(value) ? 0 : value);
        });

        dashboard.bindUI('play-btn', 'click', () => dashboard.playAnimation());
        dashboard.bindUI('copy-btn', 'click', () => dashboard.copyFront());

        dashboard.bindUI('lock-sliders', 'change', () => {
            if (dashboard.isChecked('lock-sliders')) {
                dashboard.sliderLock = dashboard.endDate - dashboard.startDate;
            } else {
                dashboard.sliderLock = 0;
            }
            dashboard.initSlider(dashboard.minDate, dashboard.maxDate, dashboard.startDate, dashboard.endDate);
        });

        dashboard.bindUI('source-gsua', 'change', async () => await dashboard.handleSourceChange());
        dashboard.bindUI('source-gsua-direction', 'change', async () => await dashboard.handleSourceChange());
        dashboard.bindUI('source-gsua-heatmap', 'change', () => dashboard.updateMap());
        dashboard.bindUI('source-mod', 'change', async () => await dashboard.handleSourceChange());
        dashboard.bindUI('source-air', 'change', async () => await dashboard.handleSourceChange());
        dashboard.bindUI('feature-mod', 'change', () => {
            dashboard.layers.setModOverlayEnabled(dashboard.isChecked('feature-mod'));
        });

        dashboard.bindUI('topo-mode', 'change', () => {
            const mode = dashboard.getEl('topo-mode')?.value;
            if (!mode || mode === 'off') {
                dashboard.layers.clearTopographicOverlay();
            } else if (dashboard.topoTileLayer) {
                dashboard.layers._recolorTopo();
            } else {
                dashboard.layers.scheduleTopographicOverlayLoad();
            }
        });

        dashboard.map.on('moveend zoomend', () => {
            const mode = dashboard.getEl('topo-mode')?.value;
            if (mode && mode !== 'off') {
                dashboard.layers.scheduleTopographicOverlayLoad();
            }
        });

        dashboard.bindUI('date-start', 'change', () => {
            dashboard.minDate = dashboard.getEl('date-start')?.valueAsDate;
            dashboard.initSlider(dashboard.minDate, dashboard.maxDate, dashboard.startDate, dashboard.endDate);
        });
        dashboard.bindUI('date-end', 'change', () => {
            dashboard.maxDate = dashboard.getEl('date-end')?.valueAsDate;
            dashboard.initSlider(dashboard.minDate, dashboard.maxDate, dashboard.startDate, dashboard.endDate);
        });

        const updateFeaturesAttribution = () => {
            const el = document.getElementById('features-attribution');
            if (el) {
                const any = dashboard.isChecked('feature-ditches') || dashboard.isChecked('feature-wire') || dashboard.isChecked('feature-dragon') || dashboard.isChecked('feature-motorlines') || dashboard.isChecked('feature-railways');
                el.style.display = any ? '' : 'none';
            }
        };

        dashboard.bindUI('feature-ditches', 'change', async () => {
            if (dashboard.isChecked('feature-ditches')) {
                await dashboard.refreshDitches();
            } else {
                dashboard.featureDitchesLayer.clearLayers();
                dashboard.featureDitchesStartLayer.clearLayers();
            }
            if (window._map3DView) window._map3DView.updateDitches3D();
            updateFeaturesAttribution();
        });

        dashboard.bindUI('features-diff', 'change', async () => {
            if (dashboard.isChecked('feature-ditches')) {
                await dashboard.refreshDitches();
                if (window._map3DView) window._map3DView.updateDitches3D();
            }
        });

        dashboard.bindUI('russia-overlay', 'change', async () => {
            await dashboard.layers.toggleRussiaOverlay(dashboard.isChecked('russia-overlay'));
        });

        dashboard.bindUI('ukraine-overlay', 'change', async () => {
            await dashboard.layers.toggleUkraineOverlay(dashboard.isChecked('ukraine-overlay'));
        });

        dashboard.bindUI('amk-overlay', 'change', async () => {
            await dashboard.layers.toggleAmkOverlay(dashboard.isChecked('amk-overlay'));
        });

        dashboard.bindUI('owl-overlay', 'change', async () => {
            await dashboard.layers.toggleOwlOverlay(dashboard.isChecked('owl-overlay'));
        });

        dashboard.bindUI('radov-overlay', 'change', async () => {
            await dashboard.layers.toggleRadovOverlay(dashboard.isChecked('radov-overlay'));
        });

        dashboard.bindUI('isw-overlay', 'change', async () => {
            await dashboard.layers.toggleIswOverlay(dashboard.isChecked('isw-overlay'));
        });

        dashboard.bindUI('suriyak-overlay', 'change', async () => {
            await dashboard.layers.toggleSuriyakOverlay(dashboard.isChecked('suriyak-overlay'));
        });

        dashboard.bindUI('ria-overlay', 'change', async () => {
            await dashboard.layers.toggleRiaOverlay(dashboard.isChecked('ria-overlay'));
        });

        dashboard.bindUI('creamy-overlay', 'change', async () => {
            await dashboard.layers.toggleCreamyOverlay(dashboard.isChecked('creamy-overlay'));
        });

        // FIRMS fire-detection bindings
        dashboard.bindUI('firms-overlay', 'change', async () => {
            await dashboard.layers.toggleFirmsOverlay(dashboard.isChecked('firms-overlay'));
        });
        const reloadFirms = async () => {
            if (dashboard.isChecked('firms-overlay')) await dashboard.layers.toggleFirmsOverlay(true);
        };
        dashboard.bindUI('firms-source', 'change', reloadFirms);
        dashboard.bindUI('firms-days', 'change', reloadFirms); // 'change' not 'input' — fire once on release
        dashboard.bindUI('firms-days', 'input', (e) => dashboard.setText('firms-days-value', e.target.value));
        const firmsKeyInput = dashboard.getEl('firms-key');
        if (firmsKeyInput) {
            firmsKeyInput.value = localStorage.getItem('firmsMapKey') || '';
            firmsKeyInput.addEventListener('change', () => {
                localStorage.setItem('firmsMapKey', firmsKeyInput.value.trim());
            });
        }

        // Custom KML bindings
        dashboard.bindUI('load-custom-kml', 'click', async () => {
            const url = dashboard.getEl('custom-kml-url')?.value?.trim();
            if (!url) {
                alert('Please enter a KML URL');
                return;
            }
            await dashboard.layers.loadCustomKml(url);
        });

        // Load custom layer from a local file
        dashboard.bindUI('load-custom-kml-file', 'click', () => {
            dashboard.getEl('custom-kml-file')?.click();
        });

        dashboard.bindUI('custom-kml-file', 'change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            await dashboard.layers.loadCustomKmlFile(file);
            e.target.value = ''; // allow re-loading the same file
        });

        dashboard.bindUI('custom-kml-overlay', 'change', async () => {
            await dashboard.layers.toggleCustomKmlOverlay(dashboard.isChecked('custom-kml-overlay'));
        });

        // Update custom KML colors when changed
        const updateCustomKmlColors = async () => {
            if (dashboard.isChecked('custom-kml-overlay')) {
                await dashboard.layers.toggleCustomKmlOverlay(true);
            }
        };

        dashboard.bindUI('color-captured', 'change', updateCustomKmlColors);
        dashboard.bindUI('color-grey', 'change', updateCustomKmlColors);
        dashboard.bindUI('color-controlled', 'change', updateCustomKmlColors);

        dashboard.bindUI('compare-deep-amk', 'click', async () => {
            try {
                const layer1Name = dashboard.getEl('compare-layer-1')?.value;
                const layer2Name = dashboard.getEl('compare-layer-2')?.value;
                const compareMode = dashboard.getEl('compare-mode')?.value;

                console.log('═'.repeat(60));
                console.log(`Comparing ${layer1Name} vs ${layer2Name}`);
                console.log(`Mode: ${compareMode}`);
                console.log('═'.repeat(60));

                const getLayerPolygon = async (layerName) => {
                    const normalizedLayer = {
                        amkOverlay: 'amkLayer',
                        owlOverlay: 'owlLayer',
                        radovOverlay: 'radovLayer',
                        iswOverlay: 'iswLayer',
                        suriyakOverlay: 'suriyakLayer',
                        riaOverlay: 'riaLayer',
                        russianOverlay: 'russiaLayer',
                        ukraineOverlay: 'ukraineLayer',
                        customKmlOverlay: 'customKmlLayer'
                    }[layerName] || layerName;

                    switch (normalizedLayer) {
                        case 'deepLayer':
                            if (!dashboard.deepLayer) {
                                throw new Error('DeepStateMap frontline data not loaded');
                            }
                            const excludeGreyZone = dashboard.isChecked('diff-no-base');
                            const deepPolygons = [];
                            const collectDeepLayer = (layer) => {
                                if (typeof layer.eachLayer === 'function') {
                                    layer.eachLayer(collectDeepLayer);
                                    return;
                                }
                                // grey zone (contested/undetermined) excluded when diff-no-base is enabled
                                if (excludeGreyZone && layer.options?.fillColor === '#bcaaa4') return;
                                const geometry = layer.toGeoJSON?.()?.geometry;
                                if (geometry) deepPolygons.push(...GeometryUtils.toTurfPolygons(geometry));
                            };
                            dashboard.deepLayer.eachLayer(collectDeepLayer);
                            if (deepPolygons.length === 0) {
                                throw new Error('No polygons in DeepStateMap layer');
                            }
                            let deepUnion = deepPolygons[0];
                            for (let i = 1; i < deepPolygons.length; i++) {
                                try {
                                    deepUnion = turf.union(deepUnion, deepPolygons[i]);
                                } catch (err) {
                                    console.warn(`Warning: Could not merge polygon ${i}`);
                                }
                            }
                            return deepUnion;
                        case 'amkLayer':
                            if (!dashboard.amkMergedPolygon) {
                                throw new Error('AMK data not loaded. Please enable AMK overlay first.');
                            }
                            return dashboard.amkMergedPolygon;
                        case 'owlLayer':
                            if (!dashboard.owlMergedPolygon) {
                                throw new Error('OWL data not loaded. Please enable OWL overlay first.');
                            }
                            return dashboard.owlMergedPolygon;
                        case 'radovLayer':
                            if (!dashboard.radovMergedPolygon) {
                                throw new Error('Radov data not loaded. Please enable Radov overlay first.');
                            }
                            return dashboard.radovMergedPolygon;
                        case 'iswLayer':
                            if (!dashboard.iswMergedPolygon) {
                                throw new Error('ISW data not loaded. Please enable ISW overlay first.');
                            }
                            return dashboard.iswMergedPolygon;
                        case 'suriyakLayer':
                            if (!dashboard.suriyakMergedPolygon) {
                                throw new Error('Suriyak data not loaded. Please enable Suriyak overlay first.');
                            }
                            return dashboard.suriyakMergedPolygon;
                        case 'riaLayer':
                            if (!dashboard.riaMergedPolygon) {
                                throw new Error('RIA data not loaded. Please enable RIA overlay first.');
                            }
                            return dashboard.riaMergedPolygon;
                        case 'russiaLayer':
                            if (!dashboard.russiaMergedPolygon) {
                                throw new Error('Russia data not loaded. Please enable Russia overlay first.');
                            }
                            return dashboard.russiaMergedPolygon;
                        case 'ukraineLayer':
                            if (!dashboard.ukraineMergedPolygon) {
                                throw new Error('Ukraine data not loaded. Please enable Ukraine overlay first.');
                            }
                            return dashboard.ukraineMergedPolygon;
                        case 'customKmlLayer':
                            if (!dashboard.customKmlMergedPolygon) {
                                throw new Error('Custom KML not loaded. Please load a custom KML first.');
                            }
                            return dashboard.customKmlMergedPolygon;
                        case 'extractedOverlay':
                            if (!dashboard.extractedMergedPolygon) {
                                throw new Error('No extracted zones. Run "Detect Red Zones" on an image overlay first.');
                            }
                            return dashboard.extractedMergedPolygon;
                        default:
                            throw new Error(`Unknown layer: ${layerName}`);
                    }
                };

                const polygon1 = await getLayerPolygon(layer1Name);
                const polygon2 = await getLayerPolygon(layer2Name);

                let difference = null;
                let overlap = null;

                if (compareMode === 'difference' || compareMode === 'both') {
                    try {
                        difference = turf.difference(polygon2, polygon1);
                    } catch (error) {
                        console.error('Error calculating difference:', error);
                        alert('Failed to calculate difference. Polygons may be too complex.');
                    }
                }

                if (compareMode === 'overlap' || compareMode === 'both') {
                    try {
                        overlap = turf.intersect(polygon1, polygon2);
                    } catch (error) {
                        console.error('Error calculating overlap:', error);
                        alert('Failed to calculate overlap. Polygons may be too complex.');
                    }
                }

                let selectedPolygonsMask = null;
                if (dashboard.selectedPolygons.length > 0) {
                    const selectedGeoJSONs = dashboard.selectedPolygons.map(polygon => polygon.toGeoJSON());
                    selectedPolygonsMask = selectedGeoJSONs.reduce((acc, curr) => {
                        try {
                            return acc ? turf.union(acc, curr) : curr;
                        } catch (error) {
                            console.warn('Error merging selected polygons, using first one only');
                            return acc || curr;
                        }
                    }, null);
                }

                if (selectedPolygonsMask) {
                    if (difference) {
                        try {
                            difference = turf.intersect(difference, selectedPolygonsMask);
                        } catch (error) {
                            console.warn('Error clipping difference to selected polygons');
                        }
                    }
                    if (overlap) {
                        try {
                            overlap = turf.intersect(overlap, selectedPolygonsMask);
                        } catch (error) {
                            console.warn('Error clipping overlap to selected polygons');
                        }
                    }
                }

                if (dashboard.comparisonLayer) {
                    dashboard.map.removeLayer(dashboard.comparisonLayer);
                }
                if (dashboard.comparisonOverlapLayer) {
                    dashboard.map.removeLayer(dashboard.comparisonOverlapLayer);
                }

                if (difference) {
                    dashboard.comparisonLayer = L.geoJSON(difference, {
                        style: {
                            color: '#ffeb3b',
                            weight: 2,
                            fillColor: '#ffeb3b',
                            fillOpacity: 0.5
                        }
                    }).addTo(dashboard.map);
                }

                if (overlap) {
                    dashboard.comparisonOverlapLayer = L.geoJSON(overlap, {
                        style: {
                            color: '#4caf50',
                            weight: 2,
                            fillColor: '#4caf50',
                            fillOpacity: 0.5
                        }
                    }).addTo(dashboard.map);
                }

                let area1 = turf.area(polygon1) / 1000000;
                let area2 = turf.area(polygon2) / 1000000;
                let differenceArea = difference ? turf.area(difference) / 1000000 : 0;
                let overlapArea = overlap ? turf.area(overlap) / 1000000 : 0;

                if (selectedPolygonsMask) {
                    try {
                        const maskedPolygon1 = turf.intersect(polygon1, selectedPolygonsMask);
                        const maskedPolygon2 = turf.intersect(polygon2, selectedPolygonsMask);
                        area1 = maskedPolygon1 ? turf.area(maskedPolygon1) / 1000000 : 0;
                        area2 = maskedPolygon2 ? turf.area(maskedPolygon2) / 1000000 : 0;
                    } catch (error) {
                        console.warn('Error calculating masked areas:', error);
                        area1 = 0;
                        area2 = 0;
                    }
                }

                console.log('═'.repeat(60));
                console.log('Summary:');
                console.log(`  ${layer1Name}: ${area1.toFixed(2)} km²`);
                console.log(`  ${layer2Name}: ${area2.toFixed(2)} km²`);
                if (difference) {
                    const differencePercent = area2 ? ((differenceArea / area2) * 100).toFixed(2) : '0.00';
                    console.log(`  Difference (yellow): ${differenceArea.toFixed(2)} km² (${differencePercent}%)`);
                }
                if (overlap) {
                    console.log(`  Overlap (green): ${overlapArea.toFixed(2)} km²`);
                }
                if (selectedPolygonsMask) {
                    console.log(`  Mode: Selected polygon area only`);
                }
                console.log('═'.repeat(60));

                let alertMessage = `Comparison Complete!${selectedPolygonsMask ? '\n(Within selected polygon area)' : ''}\n\n`;
                alertMessage += `${layer1Name}: ${area1.toFixed(2)} km²\n`;
                alertMessage += `${layer2Name}: ${area2.toFixed(2)} km²\n\n`;

                if (difference) {
                    alertMessage += `Difference (yellow): ${differenceArea.toFixed(2)} km²\n`;
                    const differencePercent = area2 ? ((differenceArea / area2) * 100).toFixed(2) : '0.00';
                    alertMessage += `(${differencePercent}% of ${layer2Name})\n`;
                    alertMessage += `Shows area in ${layer2Name} but not in ${layer1Name}\n\n`;
                }

                if (overlap) {
                    alertMessage += `Overlap (green): ${overlapArea.toFixed(2)} km²\n`;
                    const overlapPercent1 = area1 ? ((overlapArea / area1) * 100).toFixed(2) : '0.00';
                    const overlapPercent2 = area2 ? ((overlapArea / area2) * 100).toFixed(2) : '0.00';
                    alertMessage += `${overlapPercent1}% of ${layer1Name}\n`;
                    alertMessage += `${overlapPercent2}% of ${layer2Name}\n`;
                }

                if (!difference && !overlap) {
                    alertMessage = 'No comparison results. Layers may not intersect or topology issues occurred.';
                }

                alert(alertMessage);

            } catch (error) {
                console.error('Error during comparison:', error);
                alert(`Error during comparison: ${error.message}`);
            }
        });

        dashboard.bindUI('clear-comparison', 'click', () => {
            try {
                let layersCleared = 0;

                if (dashboard.comparisonLayer) {
                    dashboard.map.removeLayer(dashboard.comparisonLayer);
                    dashboard.comparisonLayer = null;
                    layersCleared++;
                }

                if (dashboard.comparisonOverlapLayer) {
                    dashboard.map.removeLayer(dashboard.comparisonOverlapLayer);
                    dashboard.comparisonOverlapLayer = null;
                    layersCleared++;
                }

                if (layersCleared > 0) {
                    console.log(`✓ Cleared ${layersCleared} comparison layer(s)`);
                    alert(`Cleared ${layersCleared} comparison layer(s)`);
                } else {
                    console.log('No comparison layers to clear');
                    alert('No comparison layers to clear');
                }
            } catch (error) {
                console.error('Error clearing comparison layers:', error);
                alert(`Error: ${error.message}`);
            }
        });

        dashboard.bindUI('sentinel-1-overlay', 'change', async () => {
            await dashboard.layers.toggleSentinelOverlay(dashboard.isChecked('sentinel-1-overlay'));
        });

        dashboard.bindUI('feature-wire', 'change', async () => {
            if (dashboard.isChecked('feature-wire')) {
                const deepMap = new DeepUtils(dashboard.featureWireLayer);
                const wire = await deepMap.loadFeatures('wire');
                L.geoJSON(wire, {
                    style: function () {
                        return { color: 'cyan' };
                    }
                }).addTo(dashboard.featureWireLayer);
            } else {
                dashboard.featureWireLayer.clearLayers();
            }
            updateFeaturesAttribution();
        });

        dashboard.bindUI('feature-dragon', 'change', async () => {
            if (dashboard.isChecked('feature-dragon')) {
                const deepMap = new DeepUtils(dashboard.featureDragonLayer);
                const dragon = await deepMap.loadFeatures('teeth');
                L.geoJSON(dragon, {
                    style: function () {
                        return { color: 'blue' };
                    }
                }).addTo(dashboard.featureDragonLayer);
            } else {
                dashboard.featureDragonLayer.clearLayers();
            }
            updateFeaturesAttribution();
        });

        dashboard.bindUI('feature-events', 'change', async () => {
            if (dashboard.isChecked('feature-events')) {
                dashboard._eventsSetReloadBtn('idle');
                await dashboard.refreshEvents();
            } else {
                if (dashboard.eventsLayer) dashboard.eventsLayer.clearLayers();
                const filterList = document.getElementById('events-filter-list');
                if (filterList) filterList.style.display = 'none';
                const attr = document.getElementById('events-attribution');
                if (attr) attr.style.display = 'none';
                dashboard._eventsSetReloadBtn('hidden');
            }
        });

        const eventsReloadBtn = document.getElementById('events-reload-btn');
        if (eventsReloadBtn) {
            eventsReloadBtn.addEventListener('click', () => dashboard.refreshEvents());
        }

        dashboard.bindUI('feature-modr', 'change', async () => {
            if (dashboard.isChecked('feature-modr')) {
                await dashboard.refreshModr();
            } else {
                if (dashboard.modrLayer) dashboard.modrLayer.clearLayers();
            }
        });

        // Roads, waterways and railways are owned by LineFeatures
        // (js/line-features.js); only the event wiring belongs here.
        dashboard.bindUI('feature-waterways', 'change', async () => {
            const typesEl = document.getElementById('waterways-types');
            if (typesEl) typesEl.style.display = dashboard.isChecked('feature-waterways') ? '' : 'none';
            await dashboard.lineFeatures.renderWaterways();
        });

        ['waterways-type-river', 'waterways-type-stream'].forEach(id => {
            dashboard.bindUI(id, 'change', () => dashboard.lineFeatures.renderWaterways());
        });

        dashboard.bindUI('feature-motorlines', 'change', async () => {
            const typesEl = document.getElementById('motorlines-types');
            if (typesEl) typesEl.style.display = dashboard.isChecked('feature-motorlines') ? '' : 'none';
            await dashboard.lineFeatures.renderRoads();
            updateFeaturesAttribution();
        });

        ['motorlines-type-highway', 'motorlines-type-primary', 'motorlines-type-tertiary', 'motorlines-type-bridge'].forEach(id => {
            dashboard.bindUI(id, 'change', () => dashboard.lineFeatures.renderRoads());
        });

        dashboard.bindUI('motorlines-clear-selection-btn', 'click', () => {
            dashboard.lineFeatures.clearRoadSelection();
        });

        dashboard.bindUI('feature-railways', 'change', async () => {
            const typesEl = document.getElementById('railways-types');
            if (typesEl) typesEl.style.display = dashboard.isChecked('feature-railways') ? '' : 'none';
            await dashboard.lineFeatures.renderRailways();
            updateFeaturesAttribution();
        });

        ['railways-type-rail', 'railways-type-station', 'railways-type-bridge'].forEach(id => {
            dashboard.bindUI(id, 'change', () => dashboard.lineFeatures.renderRailways());
        });

        const kmlCache = {}; // { 'ua:20240419': '<kml>...</kml>', ... }

        const updateDailyPositions = async (forceLoad = false, addToMapOverride = false) => {
            dashboard._dailyIconIds = new Set();

            // Helper to load and render a layer
            const loadLayer = async (side) => { // side: 'ua' or 'ru'
                const checkboxId = side === 'ua' ? 'feature-positions-ua' : 'feature-positions-ru';
                const layerProp = side === 'ua' ? 'dailyLayerUA' : 'dailyLayerRU';

                // Clear existing layer if it exists
                if (dashboard[layerProp]) {
                    dashboard.featureLayer.removeLayer(dashboard[layerProp]);
                    dashboard[layerProp] = null;
                }

                let shouldLoad = forceLoad || dashboard.isChecked(checkboxId);
                if (side === 'ua' && dashboard.isChecked('filter-usf-units')) {
                    shouldLoad = true;
                }
                if (side === 'ru' && dashboard.isChecked('show-linked-units')) {
                    shouldLoad = true;
                }

                if (shouldLoad) {
                    if (!dashboard.endDate) return;

                    const date = dashboard.endDate;
                    const yyyy = date.getFullYear();
                    const mm = String(date.getMonth() + 1).padStart(2, '0');
                    const dd = String(date.getDate()).padStart(2, '0');
                    const dateStr = `${yyyy}${mm}${dd}`;

                    const filename = side === 'ua'
                        ? `ukrainian_positions_${dateStr}.kml`
                        : `russian_positions_${dateStr}.kml`;

                    const url = `${API_BASE_URL}/daily/${dateStr}/${filename}`;
                    const cacheKey = `${side}:${dateStr}`;

                    let text;
                    if (!forceLoad && kmlCache[cacheKey]) {
                        text = kmlCache[cacheKey];
                    } else {
                        try {
                            const response = await fetch(url);
                            if (!response.ok) {
                                if (response.status !== 404) {
                                    console.warn(`Failed to fetch ${url}: ${response.status}`);
                                }
                                return;
                            }
                            text = await response.text();
                            kmlCache[cacheKey] = text;
                        } catch (err) {
                            console.warn(`Failed to fetch ${url}:`, err);
                            return;
                        }
                    }

                    try {
                        const parser = new DOMParser();
                        const kml = parser.parseFromString(text, 'text/xml');
                        const geojson = toGeoJSON.kml(kml);

                        const color = side === 'ua' ? '#0057B7' : '#D0021B'; // Blue for UA, Red for RU
                        const isUSFFilterEnabled = dashboard.isChecked('filter-usf-units');

                        // Parse icon from styleUrl: #icon-ci-57 -> 57 -> images/ua/icon-57.png
                        const getUnitIcon = (feature, color) => {
                            const styleUrl = feature.properties?.styleUrl || '';
                            const match = styleUrl.match(/[\d]+/);
                            if (!match) return null;
                            const iconId = parseInt(match[0]);
                            const iconUrl = `./images/${side}/icon-${iconId}.png`;
                            return L.divIcon({
                                className: 'unit-icon-marker',
                                html: `<img src="${iconUrl}" style="width:100%;height:100%;border:2px solid ${color};border-radius:5px;background:rgba(255,255,255,0.7);box-sizing:border-box;">`,
                                iconSize: [24, 24],
                                iconAnchor: [12, 12],
                                popupAnchor: [0, -12]
                            });
                        };

                        // Also try extracting styleUrl from raw KML since toGeoJSON may strip it
                        const styleMap = {};
                        const placemarks = kml.querySelectorAll('Placemark');
                        placemarks.forEach(pm => {
                            const name = pm.querySelector('name')?.textContent?.trim();
                            const styleUrl = pm.querySelector('styleUrl')?.textContent?.trim();
                            if (name && styleUrl) styleMap[name] = styleUrl;
                        });

                        dashboard[layerProp] = L.geoJSON(geojson, {
                            filter: (feature) => {
                                const name = feature.properties.name?.trim() || '';

                                // Collect icon IDs from original data before any filtering
                                const rawStyleUrl = feature.properties?.styleUrl || styleMap[name] || '';
                                const iconMatch = rawStyleUrl.match(/[\d]+/);
                                if (iconMatch) {
                                    dashboard._dailyIconIds.add(`${side}:${parseInt(iconMatch[0])}`);
                                }

                                // Prevent UA OOB units from appearing on the RU layer (same name in both KMLs)
                                if (side === 'ru' && dashboard.linkedUnitNames?.has(name)) return false;

                                const terms = dashboard.unitsNameFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                                if (terms.length && !terms.some(t => name.toLowerCase().includes(t))) return false;
                                if (side === 'ua' && isUSFFilterEnabled) {
                                    if (!dashboard.usfStats) return false;
                                    return dashboard.usfStats.hasOwnProperty(name);
                                }
                                if (dashboard.isChecked('show-linked-units')) {
                                    const oob = side === 'ru' ? dashboard.ruLinkedUnitNames : dashboard.linkedUnitNames;
                                    if (!oob || !oob.has(name)) return false;
                                }
                                if (dashboard.isChecked('show-only-highlighted') && window.highlightedUnits && window.highlightedUnits.size > 0) {
                                    if (!window.highlightedUnits.has(name)) return false;
                                }
                                if (dashboard.isChecked('filter-by-icon') && selectedIcons.size > 0) {
                                    if (!iconMatch) return false;
                                    if (!selectedIcons.has(`${side}:${parseInt(iconMatch[0])}`)) return false;
                                }
                                return true;
                            },
                            pointToLayer: (feature, latlng) => {
                                // Inject styleUrl from KML parse if not in properties
                                if (!feature.properties.styleUrl && feature.properties.name) {
                                    feature.properties.styleUrl = styleMap[feature.properties.name.trim()] || '';
                                }
                                const name = feature.properties.name?.trim() || '';
                                const isHighlighted = window.highlightedUnits && window.highlightedUnits.has(name);
                                const markerColor = isHighlighted ? 'yellow' : color;
                                const icon = getUnitIcon(feature, markerColor);
                                if (icon) {
                                    const styleUrl = feature.properties.styleUrl || '';
                                    const m = styleUrl.match(/[\d]+/);
                                    if (m) {
                                        dashboard._dailyIconIds.add(`${side}:${parseInt(m[0])}`);
                                    }
                                    const dragEnabled = dashboard.isChecked('drag-units');
                                    if (!window.draggedCorpsPositions) window.draggedCorpsPositions = {};
                                    const savedPos = window.draggedCorpsPositions[name];
                                    const markerLatlng = savedPos ? L.latLng(savedPos[0], savedPos[1]) : latlng;
                                    const marker = L.marker(markerLatlng, { icon, draggable: dragEnabled });
                                    if (dragEnabled) {
                                        marker.on('dragend', (e) => {
                                            const ll = e.target.getLatLng();
                                            window.draggedCorpsPositions[name] = [ll.lat, ll.lng];
                                        });
                                    }
                                    return marker;
                                }
                                return L.circleMarker(latlng, {
                                    radius: isHighlighted ? 6 : 4,
                                    fillColor: isHighlighted ? 'yellow' : color,
                                    color: isHighlighted ? 'yellow' : '#fff',
                                    weight: isHighlighted ? 2 : 1,
                                    opacity: 1,
                                    fillOpacity: 0.8
                                });
                            },
                            style: () => {
                                return {
                                    color: color,
                                    weight: 2,
                                    opacity: 0.8
                                };
                            },
                            onEachFeature: (feature, layer) => {
                                if (feature.properties) {
                                    // Basic popup with properties
                                    let popupContent = Object.entries(feature.properties)
                                        .filter(([key, value]) => value && value !== 'null' && typeof value === 'string' && value.trim() !== '' && key !== 'description')
                                        .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
                                        .join('<br>');

                                    // Placeholder for stats
                                    popupContent += `<div id="stats-${feature.properties.name?.replace(/\s+/g, '-')}" class="usf-stats-container"></div>`;

                                    let lat = 0, lon = 0;
                                    if (feature.geometry && feature.geometry.type === 'Point') {
                                        lon = feature.geometry.coordinates[0];
                                        lat = feature.geometry.coordinates[1];
                                    } else if (layer.getBounds) {
                                        const center = layer.getBounds().getCenter();
                                        lat = center.lat;
                                        lon = center.lng;
                                    }

                                    popupContent += `
                                        <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                            ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                            <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${lat}, ${lon}, '${(feature.properties.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                        </div>
                                    `;

                                    if (popupContent) {
                                        layer.bindPopup(popupContent);
                                    }

                                    const unitName = feature.properties.name?.trim() || '';

                                    if (unitName && dashboard.isChecked('show-unit-titles')) {
                                        const ordinal = unitName.match(/\d+(?:st|nd|rd|th)/i)?.[0] || unitName;
                                        layer.bindTooltip(ordinal, {
                                            permanent: true,
                                            direction: 'top',
                                            className: 'unit-title-tooltip',
                                            offset: [0, -5]
                                        });
                                    }

                                    layer.on('contextmenu', (e) => {
                                        L.DomEvent.stopPropagation(e);
                                        L.DomEvent.preventDefault(e);
                                        const highlight = new Set([unitName]);
                                        const subordinates = dashboard.linkedUnitsByParent?.get(unitName)
                                            || dashboard.ruLinkedUnitsByParent?.get(unitName);
                                        if (subordinates) {
                                            // Clicked a corps — add all its subordinates
                                            subordinates.forEach(s => highlight.add(s));
                                        } else {
                                            // Clicked a subordinate — find parent and full family
                                            const maps = [dashboard.linkedUnitsByParent, dashboard.ruLinkedUnitsByParent];
                                            maps.forEach(map => {
                                                if (!map) return;
                                                map.forEach((brigades, corpsName) => {
                                                    if (brigades.has(unitName)) {
                                                        highlight.add(corpsName);
                                                        brigades.forEach(s => highlight.add(s));
                                                    }
                                                });
                                            });
                                        }
                                        window.highlightedUnits = highlight;
                                        updateDailyPositions();
                                    });
                                }
                            }
                        });

                        const isChecked = dashboard.isChecked(checkboxId);
                        const isUSFActive = side === 'ua' && dashboard.isChecked('filter-usf-units');
                        if (addToMapOverride || isChecked || isUSFActive) {
                            dashboard[layerProp].addTo(dashboard.featureLayer);
                        }

                        // If stats are already selected, trigger update (optional, might be heavy)
                        // For now we rely on user interaction or period select change

                    } catch (err) {
                        console.error(`Error loading KML for ${side}:`, err);
                    }
                }
            };

            await loadLayer('ua');
            await loadLayer('ru');

            if (dashboard.isChecked('filter-by-icon')) {
                const iconFilterList = dashboard.getEl('icon-filter-list');
                if (iconFilterList && dashboard._dailyIconIds.size > 0) {
                    const sortedIcons = Array.from(dashboard._dailyIconIds).sort((a, b) => {
                        const [sa, ia] = a.split(':'); const [sb, ib] = b.split(':');
                        return sa.localeCompare(sb) || parseInt(ia) - parseInt(ib);
                    });
                    iconFilterList.innerHTML = sortedIcons.map(key => {
                        const [iconSide, iconId] = key.split(':');
                        const isChecked = selectedIcons.has(key);
                        const borderStyle = isChecked ? 'border: 3px solid red;' : 'border: 3px solid transparent;';
                        return `<label style="display:inline-block;margin:4px;cursor:pointer;">
                            <input type="checkbox" class="icon-filter-checkbox" data-icon-id="${key}" ${isChecked ? 'checked' : ''} style="display:none;">
                            <img src="./images/${iconSide}/icon-${iconId}.png" alt="${iconSide} Icon ${iconId}" title="${iconSide.toUpperCase()} ${iconId}" style="width:40px;height:40px;${borderStyle}border-radius:4px;display:block;">
                        </label>`;
                    }).join('');

                    iconFilterList.querySelectorAll('label').forEach(label => {
                        label.addEventListener('click', (e) => {
                            e.preventDefault();
                            const checkbox = label.querySelector('.icon-filter-checkbox');
                            const iconId = checkbox.dataset.iconId;
                            const img = label.querySelector('img');
                            if (selectedIcons.has(iconId)) {
                                selectedIcons.delete(iconId);
                                checkbox.checked = false;
                                img.style.border = '3px solid transparent';
                            } else {
                                selectedIcons.add(iconId);
                                checkbox.checked = true;
                                img.style.border = '3px solid red';
                            }
                            updateDailyPositions();
                        });
                    });
                }
            }
        };

        dashboard.updateDailyPositions = updateDailyPositions;

        const loadUSFStats = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/usf-unit-stats`);
                const data = await response.json();
                dashboard.usfStats = data;

                // Populate period select
                const periods = new Set();
                Object.keys(data["USF Grouping"].periods).forEach(p => periods.add({ key: p, ...data["USF Grouping"].periods[p] })); // Ensure grouping periods are included

                const select = dashboard.getEl('usf-period-select');
                // clear existing options except first
                while (select.options.length > 1) {
                    select.remove(1);
                }


                Array.from(periods).forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.key;
                    opt.textContent = p["period.name_en"];
                    select.appendChild(opt);
                });

            } catch (e) {
                console.error('Failed to load USF stats', e);
            }
        };

        // Load USF stats on init
        loadUSFStats();

        const usfReloadBtn = document.getElementById('usf-reload-btn');
        if (usfReloadBtn) {
            usfReloadBtn.addEventListener('click', async () => {
                usfReloadBtn.disabled = true;
                usfReloadBtn.style.animation = 'btn-spin 1s linear infinite';
                const period = dashboard.getEl('usf-period-select')?.value;
                if (period && dashboard.usfDataCache) {
                    delete dashboard.usfDataCache[period];
                }
                await updateUSFStatsDisplay();
                usfReloadBtn.disabled = false;
                usfReloadBtn.style.animation = 'none';
            });
        }

        const updateUSFStatsDisplay = async () => {
            const period = dashboard.getEl('usf-period-select').value;
            const metric = dashboard.getEl('usf-metric-select')?.value || 'personnel';

            if (!period || !dashboard.usfStats) return;

            // Init cache
            if (!dashboard.usfDataCache) dashboard.usfDataCache = {};
            if (!dashboard.usfDataCache[period]) dashboard.usfDataCache[period] = {};

            // Iterate through layer features using dashboard.dailyLayerUA
            if (dashboard.dailyLayerUA) {
                // 1. Identification Phase
                const unitsToFetch = [];
                const featuresToUpdate = [];

                dashboard.dailyLayerUA.eachLayer((layer) => {
                    const name = layer.feature.properties.name?.trim();
                    if (name && dashboard.usfStats[name]) {
                        const unitData = dashboard.usfStats[name];
                        const unitPeriods = unitData.periods || unitData; // Fallback

                        if (unitPeriods[period]) {
                            // Check cache
                            if (dashboard.usfDataCache[period][name]) {
                                featuresToUpdate.push({
                                    layer,
                                    unitName: name,
                                    data: dashboard.usfDataCache[period][name],
                                    iconUrl: unitData.icon
                                });
                            } else {
                                unitsToFetch.push({
                                    layer,
                                    unitName: name,
                                    statsInfo: unitPeriods[period],
                                    iconUrl: unitData.icon
                                });
                            }
                        }
                    }
                });

                // 2. Data Fetching Phase (Parallel) - Only if needed
                if (unitsToFetch.length > 0) {
                    const results = await Promise.all(unitsToFetch.map(async (unit) => {
                        try {
                            const proxyUrl = `${API_BASE_URL}/proxy?url=${encodeURIComponent(unit.statsInfo.url)}`;
                            const response = await fetch(proxyUrl);
                            if (response.ok) {
                                const json = await response.json();
                                if (json.success && json.data) {
                                    // Cache data
                                    dashboard.usfDataCache[period][unit.unitName] = json.data;
                                    return {
                                        layer: unit.layer,
                                        unitName: unit.unitName,
                                        data: json.data,
                                        iconUrl: unit.iconUrl
                                    };
                                }
                            }
                        } catch (e) {
                            console.error(`Failed to fetch stats for ${unit.layer.feature.properties.name}`, e);
                        }
                        return null;
                    }));

                    const validNew = results.filter(r => r !== null);
                    featuresToUpdate.push(...validNew);
                }

                if (featuresToUpdate.length === 0) return;

                // 3. Metric Calculation & Normalization
                let maxVal = 0;
                const processed = featuresToUpdate.map(item => {
                    const { data } = item;
                    const d = data;
                    const targets = d.targetsByType || [];

                    const getHit = (cls) => {
                        const t = targets.find(i => i.targetClass && i.targetClass.includes(cls));
                        return t ? (t.hit || 0) : 0;
                    };

                    let val = 0;
                    let metricLabel = 'Value';

                    switch (metric) {
                        case 'sorties':
                            val = d.flights?.strike || 0;
                            metricLabel = 'Sorties';
                            break;
                        case 'drones':
                            val = getHit('Шахеди') + getHit('Гербери');
                            metricLabel = 'Drones';
                            break;
                        case 'armored':
                            val = 0;
                            targets.forEach(t => {
                                if (t.targetClass === 'Танки' || t.targetClass === 'ББМ, БМП, БТР') {
                                    val += (t.hit || 0);
                                }
                            });
                            metricLabel = 'Armored';
                            break;
                        case 'unarmored':
                            val = 0;
                            targets.forEach(t => {
                                if (t.targetClass.includes('ЛАТ') || t.targetClass === 'Мотоцикли') {
                                    val += (t.hit || 0);
                                }
                            });
                            metricLabel = 'Unarmored';
                            break;
                        case 'artillery':
                            val = 0;
                            targets.forEach(t => {
                                const c = t.targetClass;
                                if (c === 'Гармати, гаубиці' || c === 'САУ' || c === 'PCЗВ, ЗРК, ЗУ' || c.includes('РСЗВ') || c === 'Міномети') {
                                    val += (t.hit || 0);
                                }
                            });
                            metricLabel = 'Artillery';
                            break;
                        case 'hideouts':
                            val = 0;
                            targets.forEach(t => {
                                if (t.targetClass === 'Укриття' || t.targetClass === 'Бліндажі') {
                                    val += (t.hit || 0);
                                }
                            });
                            metricLabel = 'Hideouts';
                            break;
                        case 'personnel':
                        default:
                            val = d.totalPersonnelCasualties || 0;
                            metricLabel = 'Casualties';
                            break;
                        case 'targets':
                            val = d.totalTargetsHit || 0;
                            metricLabel = 'Targets';
                            break;
                        case 'launchers':
                            val = getHit("Точки вильоту дронів");
                            metricLabel = 'Launchers';
                            break;
                        case 'wings':
                            val = getHit("Ворожі крила");
                            metricLabel = 'Wings';
                            break;
                        case 'efficiency':
                            val = Math.round((d.totalTargetsHit || 0) / (d.flights?.strike || 1) * 100);
                            metricLabel = 'Efficiency';
                            break;
                    }

                    if (val > maxVal) maxVal = val;

                    return { ...item, val, metricLabel };
                });

                // 4. Threshold Calculation based on MaxVal
                // If maxVal is small (e.g. < 20), use linear micro-scale.
                // If maxVal is large, use percentage-based quintiles (20%, 40%, 60%, 80%).
                // But generally, we want "100+" to be XL if maxVal is huge.
                // If maxVal is 5, then 5 should be XL.

                let getThresholds;
                if (maxVal <= 10) {
                    // Micro scale
                    // XS: 0, SM: 1-2, MD: 3-5, LG: 6-8, XL: 9+ (adjusted relative to max)
                    getThresholds = (v) => {
                        if (v >= maxVal * 0.8 && v > 0) return 'usf-marker-xl';
                        if (v >= maxVal * 0.6 && v > 0) return 'usf-marker-lg';
                        if (v >= maxVal * 0.4 && v > 0) return 'usf-marker-md';
                        if (v >= maxVal * 0.2 && v > 0) return 'usf-marker-sm';
                        return 'usf-marker-xs';
                    };
                } else if (maxVal <= 50) {
                    // Mid scale
                    getThresholds = (v) => {
                        if (v >= 40) return 'usf-marker-xl';
                        if (v >= 25) return 'usf-marker-lg';
                        if (v >= 15) return 'usf-marker-md';
                        if (v >= 5) return 'usf-marker-sm';
                        return 'usf-marker-xs';
                    };
                } else {
                    // Large scale (>50) - closer to original user request but scaled if maxVal is HUUUGE
                    // Original: 10, 25, 50, 100
                    // If maxVal is 2000, maybe 100 is too low for XL?
                    // Let's stick to original "100+" as XL unless maxVal demands log scale.
                    // But "scale accordingly" implies data fit.
                    // Let's use the Quintile approach relative to MaxVal for best visualization.
                    getThresholds = (v) => {
                        if (v >= maxVal * 0.8) return 'usf-marker-xl';
                        if (v >= maxVal * 0.6) return 'usf-marker-lg';
                        if (v >= maxVal * 0.4) return 'usf-marker-md';
                        if (v >= maxVal * 0.2) return 'usf-marker-sm';
                        return 'usf-marker-xs';
                    };
                }

                // 5. Rendering Phase
                processed.forEach(item => {
                    const { layer, val, metricLabel, iconUrl } = item;

                    let sizeClass = getThresholds(val);

                    // Determine pixel size for icon anchor - PRESERVING USER CHANGES
                    let iconSize = [30, 30];
                    if (sizeClass === 'usf-marker-xl') iconSize = [60, 60];
                    else if (sizeClass === 'usf-marker-lg') iconSize = [52, 52];
                    else if (sizeClass === 'usf-marker-md') iconSize = [46, 46];
                    else if (sizeClass === 'usf-marker-sm') iconSize = [38, 38];

                    // Icon/Image logic
                    let htmlContent = val > 0 ? val : '';
                    let className = `usf-marker ${sizeClass}`;

                    if (iconUrl) {
                        // If icon exists, display it.
                        // Overlay value or make it visible?
                        // Simple approach: Use image as background, white text with shadow.
                        // We need to override the background-color of the marker class if we use an image?
                        // Or just put img inside.
                        // Let's use a container div inside.
                        // We also need to keep the background color ring? Or replace it?
                        // User "add unit icons" likely implies seeing the logo.
                        // Logos are usually square/round.
                        // Let's try to fit the logo.

                        htmlContent = `
                            <div style="
                                width: 100%;
                                height: 100%;
                                background-image: url('${iconUrl}');
                                background-size: cover;
                                background-position: center;
                                border-radius: 50%;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                position: relative;
                            ">
                                <span style="
                                    font-weight: bold;
                                    color: white;
                                    text-shadow: 0 0 2px black, 0 0 2px black;
                                    z-index: 1;
                                ">${val > 0 ? val : ''}</span>
                            </div>`;

                        // We might want to remove the default background color if icon is present
                        // But the background color denotes SIZE/INTENSITY (Blue/Red).
                        // Maybe keep the border color?
                        // Or utilize 'border' property of the container.
                        // Let's keep the marker class for the size, but styling might mask the bg color
                        // if we use width 100%.
                        // Actually the marker class sets background-color on the leaflet-div-icon itself (the container).
                        // Our inner html is inside that.
                        // If our inner div covers 100%, it covers the bg color.
                        // We can set the inner div to be slightly smaller or transparent?
                        // Or borders.
                        // Let's set a border on the inner div matching the intensity color? No, we don't have that color in JS easily (it's in CSS).
                        // Let's just create the icon. If the user provides transparent PNGs, the background color will show through!
                        // That is the best approach.

                        // Refined HTML for Icon:
                        htmlContent = `<div class="usf-icon-container" style="background-image: url('${iconUrl}');">${val > 0 ? val : ''}</div>`;
                    }

                    const icon = L.divIcon({
                        className: className,
                        html: htmlContent,
                        iconSize: iconSize,
                        iconAnchor: [iconSize[0] / 2, iconSize[1] / 2]
                    });

                    const latlng = layer.getLatLng();
                    const newMarker = L.marker(latlng, { icon: icon });

                    newMarker.feature = layer.feature;
                    newMarker.feature.properties.activeMetric = val;
                    newMarker.feature.properties.activeMetricLabel = metricLabel;

                    let popupContent = Object.entries(layer.feature.properties)
                        .filter(([key, value]) => value && value !== 'null' && typeof value === 'string' && value.trim() !== '' && key !== 'description' && key !== 'activeMetric' && key !== 'activeMetricLabel' && key !== 'casualties')
                        .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
                        .join('<br>');
                    popupContent += `<br><strong>${metricLabel}:</strong> ${val}`;
                    newMarker.bindPopup(popupContent);

                    dashboard.dailyLayerUA.removeLayer(layer);
                    dashboard.dailyLayerUA.addLayer(newMarker);
                });

                // Update Metric Overlay
                const overlay = dashboard.getEl('usf-metric-overlay');
                if (overlay) {
                    const labels = {
                        'personnel': 'Personnel Casualties',
                        'sorties': 'Sorties (Strikes)',
                        'drones': 'Drones (Shaheds/Gerbers)',
                        'armored': 'Armored Vehicles',
                        'unarmored': 'Unarmored Vehicles',
                        'artillery': 'Artillery Systems',
                        'hideouts': 'Hideouts/Shelters',
                        'targets': 'Targets',
                        'launchers': 'Launchers',
                        'wings': 'Wings',
                        'efficiency': 'Efficiency'
                    };

                    const label = labels[metric] || metric.charAt(0).toUpperCase() + metric.slice(1);
                    overlay.innerHTML = `Selected Statistic: <span style="color: #d32f2f;">${label}</span>`;
                    overlay.style.display = 'block';
                }
            } else {
                const overlay = dashboard.getEl('usf-metric-overlay');
                if (overlay) overlay.style.display = 'none';
            }
        };

        let refreshInterval = null;

        const handleAutoRefreshVisibility = () => {
            const periodSelect = dashboard.getEl('usf-period-select');
            const container = dashboard.getEl('usf-refresh-container');
            const refreshCheckbox = dashboard.getEl('usf-auto-refresh');

            // "За поточну добу" usually corresponds to a specific value or text. 
            // The value in the dropdown matches the keys in JSON (e.g. "08.02.2025" or special strings).
            // User said "За поточну добу". Let's assume the text content matches that or the value.
            // But usually the dropdown values are dates or keys from the JSON.
            // If the key is dynamic dates, we need to check if it represents 'today'.
            // OR if the user literally named a key "За поточну добу" in the JSON.
            // Given I don't see the JSON content for keys, I'll check if the selected VALUE implies current day.
            // However, often "current day" is just the latest date.
            // Wait, looking at previous context, keys are dates like "05.02.2026".
            // The user might be referring to a specific label they see or added.
            // I will check against the selected value being "За поточну добу" OR if the text is that.
            // BUT, strictly following request: 'when #usf-period-select "За поточну добу" selected'.

            const selectedOption = periodSelect.options[periodSelect.selectedIndex];
            if ((selectedOption && selectedOption.text.includes('За поточну добу')) || periodSelect.value === 'За поточну добу') {
                container.style.display = 'inline';
            } else {
                container.style.display = 'none';
                if (refreshCheckbox.checked) {
                    refreshCheckbox.checked = false;
                    handleAutoRefreshToggle(); // Stop interval
                }
            }
        };

        const handleAutoRefreshToggle = () => {
            const checkbox = dashboard.getEl('usf-auto-refresh');
            if (checkbox && checkbox.checked) {
                if (refreshInterval) clearInterval(refreshInterval);
                refreshInterval = setInterval(() => {
                    // Clear cache for current period to force fetch
                    const period = dashboard.getEl('usf-period-select').value;
                    if (dashboard.usfDataCache && dashboard.usfDataCache[period]) {
                        delete dashboard.usfDataCache[period];
                    }
                    updateUSFStatsDisplay();
                }, 10 * 60 * 1000); // 10 minutes
            } else {
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
            }
        };

        dashboard.updateUnitsAttribution = () => {
            const el = document.getElementById('units-attribution');
            if (el) {
                const any = dashboard.isChecked('feature-positions-ua') || dashboard.isChecked('feature-positions-ru') || dashboard.isChecked('position-change') || dashboard.isChecked('filter-usf-units');
                el.style.display = any ? '' : 'none';
            }
        };
        const updateUnitsAttribution = dashboard.updateUnitsAttribution;

        dashboard.bindUI('feature-positions-ua', 'change', () => { updateDailyPositions(); updateUnitsAttribution(); });
        dashboard.bindUI('feature-positions-ru', 'change', () => { updateDailyPositions(); updateUnitsAttribution(); });
        dashboard.bindUI('filter-usf-units', 'change', () => {
            if (!dashboard.isChecked('filter-usf-units')) {
                const overlay = dashboard.getEl('usf-metric-overlay');
                if (overlay) overlay.style.display = 'none';
            }
            updateDailyPositions();
            updateUnitsAttribution();
        });
        dashboard.bindUI('show-unit-icons', 'change', () => { updateDailyPositions(); });
        dashboard.bindUI('show-unit-titles', 'change', () => {
            if (dashboard.isChecked('position-change')) {
                renderPositionChanges();
            } else {
                updateDailyPositions();
            }
        });

        let unitsNameFilterDebounce = null;
        const unitsNameFilterEl = document.getElementById('units-name-filter');
        if (unitsNameFilterEl) {
            unitsNameFilterEl.addEventListener('input', () => {
                dashboard.unitsNameFilter = unitsNameFilterEl.value;
                clearTimeout(unitsNameFilterDebounce);
                unitsNameFilterDebounce = setTimeout(() => updateDailyPositions(), 400);
            });
        }
        dashboard.bindUI('usf-period-select', 'change', () => {
            updateUSFStatsDisplay();
            handleAutoRefreshVisibility();
        });
        dashboard.bindUI('usf-metric-select', 'change', updateUSFStatsDisplay);
        dashboard.bindUI('usf-auto-refresh', 'change', handleAutoRefreshToggle);


        // Initial load if checkboxes are checked (and date is set)
        // We might need to hook this into slider update
        // We can expose this function to be called from slider update
        dashboard.updateDailyPositions = updateDailyPositions;

        const positionChangesCache = {}; // { 'ua:20240410:20240419': {...data} }

        const renderPositionChanges = async () => {
            if (dashboard.isChecked('position-change')) {
                const controls = dashboard.getEl('position-change-controls');
                if (controls) controls.style.display = 'block';

                try {
                    // Format dates as YYYYMMDD for the API
                    const formatDate = (date) => {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        return `${year}${month}${day}`;
                    };

                    const startDate = formatDate(dashboard.startDate);
                    const endDate = formatDate(dashboard.endDate);

                    // Determine which side(s) to fetch based on checkboxes
                    const showUA = dashboard.isChecked('feature-positions-ua');
                    const showRU = dashboard.isChecked('feature-positions-ru');

                    let side = 'ua'; // Default to UA
                    if (showUA && showRU) {
                        side = 'both';
                    } else if (showRU && !showUA) {
                        side = 'ru';
                    }

                    const url = `${API_BASE_URL}/position-changes?startDate=${startDate}&endDate=${endDate}&side=${side}`;
                    const pcCacheKey = `${side}:${startDate}:${endDate}`;

                    let rawData;
                    if (positionChangesCache[pcCacheKey]) {
                        rawData = positionChangesCache[pcCacheKey];
                    } else {
                        console.log(`Fetching position changes (${side}): ${startDate} -> ${endDate}`);
                        const response = await fetch(url);
                        if (!response.ok) {
                            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                            throw new Error(errorData.error || `HTTP ${response.status}`);
                        }
                        rawData = await response.json();
                        positionChangesCache[pcCacheKey] = rawData;
                    }

                    // Clear existing layers first to avoid duplicates when re-rendering
                    dashboard.featureLayer.clearLayers();

                    // Handle both sides if returned - merge the data with side labels
                    let data;
                    if (side === 'both' && rawData.ua && rawData.ru) {
                        // Merge both datasets, adding side info to each item
                        const addSideLabel = (items, sideLabel) => {
                            if (!items || !Array.isArray(items)) return [];
                            return items.map(item => ({ ...item, side: sideLabel }));
                        };

                        data = {
                            moved: [
                                ...addSideLabel(rawData.ua.moved, 'UA'),
                                ...addSideLabel(rawData.ru.moved, 'RU')
                            ],
                            new: [
                                ...addSideLabel(rawData.ua.new, 'UA'),
                                ...addSideLabel(rawData.ru.new, 'RU')
                            ],
                            missing: [
                                ...addSideLabel(rawData.ua.missing, 'UA'),
                                ...addSideLabel(rawData.ru.missing, 'RU')
                            ],
                            unchanged: [
                                ...addSideLabel(rawData.ua.unchanged, 'UA'),
                                ...addSideLabel(rawData.ru.unchanged, 'RU')
                            ],
                            statistics: {
                                // Merge statistics if needed
                                subordinateUnits: {
                                    moved: [
                                        ...addSideLabel(rawData.ua.statistics?.subordinateUnits?.moved || [], 'UA'),
                                        ...addSideLabel(rawData.ru.statistics?.subordinateUnits?.moved || [], 'RU')
                                    ],
                                    new: [
                                        ...addSideLabel(rawData.ua.statistics?.subordinateUnits?.new || [], 'UA'),
                                        ...addSideLabel(rawData.ru.statistics?.subordinateUnits?.new || [], 'RU')
                                    ],
                                    missing: [
                                        ...addSideLabel(rawData.ua.statistics?.subordinateUnits?.missing || [], 'UA'),
                                        ...addSideLabel(rawData.ru.statistics?.subordinateUnits?.missing || [], 'RU')
                                    ],
                                    unchanged: [
                                        ...addSideLabel(rawData.ua.statistics?.subordinateUnits?.unchanged || [], 'UA'),
                                        ...addSideLabel(rawData.ru.statistics?.subordinateUnits?.unchanged || [], 'RU')
                                    ]
                                }
                            }
                        };
                    } else if (side === 'both' && rawData.ua) {
                        // Only UA data available
                        data = rawData.ua;
                        // Add side label to all items
                        const addSideLabel = (items) => items?.map(item => ({ ...item, side: 'UA' })) || [];
                        data.moved = addSideLabel(data.moved);
                        data.new = addSideLabel(data.new);
                        data.missing = addSideLabel(data.missing);
                        data.unchanged = addSideLabel(data.unchanged);
                    } else if (side === 'both' && rawData.ru) {
                        // Only RU data available
                        data = rawData.ru;
                        // Add side label to all items
                        const addSideLabel = (items) => items?.map(item => ({ ...item, side: 'RU' })) || [];
                        data.moved = addSideLabel(data.moved);
                        data.new = addSideLabel(data.new);
                        data.missing = addSideLabel(data.missing);
                        data.unchanged = addSideLabel(data.unchanged);
                    } else {
                        // Single side data - add side label
                        data = rawData;
                        const sideLabel = side === 'ua' ? 'UA' : 'RU';
                        const addSideLabel = (items) => items?.map(item => ({ ...item, side: sideLabel })) || [];
                        data.moved = addSideLabel(data.moved);
                        data.new = addSideLabel(data.new);
                        data.missing = addSideLabel(data.missing);
                        data.unchanged = addSideLabel(data.unchanged);
                    }

                    let highlightedLayer = null;
                    let countMoved = 0;
                    let countNew = 0;
                    let countMissing = 0;
                    let countUnchanged = 0;

                    // Polygon Filtering Helper
                    const isInSelectedPolygons = (lat, lon) => {
                        if (!dashboard.isChecked('polygon-select') || dashboard.selectedPolygons.length === 0) {
                            return true; // Pass if filter is off or no polygons
                        }

                        const point = turf.point([lon, lat]); // Turf uses [lon, lat]
                        for (const polygonLayer of dashboard.selectedPolygons) {
                            try {
                                // Handle different layer types (Polygon, Rectangle)
                                const geoJSON = polygonLayer.toGeoJSON();
                                if (turf.booleanPointInPolygon(point, geoJSON)) {
                                    return true;
                                }
                            } catch (e) {
                                console.warn('Error checking point in polygon', e);
                            }
                        }
                        return false;
                    };


                    const showIcons = true; // Icons always on
                    const showTitles = dashboard.isChecked('show-unit-titles');
                    const showLinkedUnits = dashboard.isChecked('show-linked-units');
                    const dragCorpsEnabled = dashboard.isChecked('drag-units');
                    const filterByIcon = dashboard.isChecked('filter-by-icon');
                    const showOnlyHighlighted = dashboard.isChecked('show-only-highlighted');

                    // Store for dragged positions
                    if (!window.draggedCorpsPositions) {
                        window.draggedCorpsPositions = {};
                    }

                    // Store for selected icons

                    // Helper to extract icon ID from styleUrl
                    const getIconId = (item) => {
                        if (!item.styleUrl) return null;
                        const match = item.styleUrl.match(/[\d]+/);
                        return match ? match[0] : null;
                    };

                    // Build set of connected unit names when show-linked-units is enabled
                    const connectedUnits = new Set();
                    if (showLinkedUnits && data.statistics && data.statistics.subordinateUnits) {
                        // Add all units that have subordinate relationships
                        const addConnectedUnits = (list) => {
                            if (!list || !Array.isArray(list)) return;
                            list.forEach(({ unit, parent }) => {
                                connectedUnits.add(unit);
                                connectedUnits.add(parent);
                            });
                        };

                        addConnectedUnits(data.statistics.subordinateUnits.moved);
                        addConnectedUnits(data.statistics.subordinateUnits.new);
                        addConnectedUnits(data.statistics.subordinateUnits.missing);
                        addConnectedUnits(data.statistics.subordinateUnits.unchanged);
                    }

                    // Helper to check if unit should be shown based on linked units filter
                    const shouldShowLinked = (unitName) => {
                        if (!showLinkedUnits) return true; // Show all if filter is off
                        return connectedUnits.has(unitName); // Only show connected units
                    };

                    const addTitleTooltip = (marker, name) => {
                        if (!showTitles) return;
                        const ordinal = name.match(/\d+(?:st|nd|rd|th)/i)?.[0] || name;
                        marker.bindTooltip(ordinal, { permanent: true, direction: 'top', className: 'unit-title-tooltip', offset: [0, -5] });
                    };

                    // Helper to check if unit should be shown based on highlighted filter
                    const shouldShowHighlighted = (unitName) => {
                        if (!showOnlyHighlighted) return true; // Show all if filter is off
                        if (!window.highlightedUnits || window.highlightedUnits.size === 0) return true; // Show all if no highlights
                        return window.highlightedUnits.has(unitName); // Only show highlighted units
                    };

                    // Unit Level Scaling
                    const getMarkerRadius = (level) => {
                        const baseRadius = 4;
                        const factor = 1;
                        const lvl = parseInt(level) || 1; // Default level 1
                        return baseRadius + (lvl * factor);
                    };

                    const getIcon = (item, color, radius) => {
                        if (!item.styleUrl) return null;
                        // Parse #icon-ci-57 -> 57 -> images/{side}/icon-57.png
                        const match = item.styleUrl.match(/[\d]+/);
                        if (!match) return null;

                        const iconId = parseInt(match[0]);
                        const iconSide = item.side === 'RU' ? 'ru' : 'ua';
                        const iconUrl = `./images/${iconSide}/icon-${iconId}.png`;
                        const size = radius * 3; // Icon size proportional to marker radius

                        return L.divIcon({
                            className: 'unit-icon-marker',
                            html: `<img src="${iconUrl}" style="width: 100%; height: 100%; border: 2px solid ${color}; border-radius: 5px; background: rgba(255,255,255,0.7); box-sizing: border-box;">`,
                            iconSize: [size, size],
                            iconAnchor: [size / 2, size / 2],
                            popupAnchor: [0, -size / 2]
                        });
                    };

                    // Collect unique icons for filter UI
                    const uniqueIcons = new Set();
                    const collectIcons = (items) => {
                        if (!items || !Array.isArray(items)) return;
                        items.forEach(item => {
                            const iconId = getIconId(item);
                            if (iconId) uniqueIcons.add(iconId);
                        });
                    };
                    collectIcons(data.moved);
                    collectIcons(data.new);
                    collectIcons(data.missing);
                    collectIcons(data.unchanged);

                    // Build icon filter UI if enabled
                    if (filterByIcon) {
                        const iconFilterList = dashboard.getEl('icon-filter-list');
                        if (iconFilterList && uniqueIcons.size > 0) {
                            const sortedIcons = Array.from(uniqueIcons).sort((a, b) => parseInt(a) - parseInt(b));
                            iconFilterList.innerHTML = sortedIcons.map(iconId => {
                                const isChecked = selectedIcons.has(iconId);
                                const borderStyle = isChecked ? 'border: 3px solid red;' : 'border: 3px solid transparent;';
                                return `
                                    <label style="display: inline-block; margin: 4px; cursor: pointer;">
                                        <input type="checkbox" class="icon-filter-checkbox" data-icon-id="${iconId}" ${isChecked ? 'checked' : ''} style="display: none;">
                                        <img src="./images/ua/icon-${iconId}.png" alt="Icon ${iconId}" title="Icon ${iconId}" style="width: 40px; height: 40px; ${borderStyle} border-radius: 4px; display: block;">
                                    </label>
                                `;
                            }).join('');

                            // Add event listeners to labels (clicking image toggles checkbox)
                            iconFilterList.querySelectorAll('label').forEach(label => {
                                label.addEventListener('click', (e) => {
                                    e.preventDefault();
                                    const checkbox = label.querySelector('.icon-filter-checkbox');
                                    const iconId = checkbox.dataset.iconId;
                                    const img = label.querySelector('img');

                                    // Toggle selection
                                    if (selectedIcons.has(iconId)) {
                                        selectedIcons.delete(iconId);
                                        checkbox.checked = false;
                                        img.style.border = '3px solid transparent';
                                    } else {
                                        selectedIcons.add(iconId);
                                        checkbox.checked = true;
                                        img.style.border = '3px solid red';
                                    }

                                    renderPositionChanges(); // Re-render with new filter
                                });
                            });
                        }
                    }

                    // Icon filter helper
                    const shouldShowIcon = (item) => {
                        if (!filterByIcon || selectedIcons.size === 0) return true;
                        const iconId = getIconId(item);
                        return iconId && selectedIcons.has(iconId);
                    };

                    // Helper to add right-click handler to unit markers
                    // Corps (level 6): highlights corps + all subordinates
                    // Subordinates: highlights unit + its parent corps
                    const addCorpsRightClickHandler = (marker, unitName, unitLevel) => {
                        marker.on('contextmenu', function (e) {
                            L.DomEvent.stopPropagation(e);
                            L.DomEvent.preventDefault(e);

                            const connectedToHighlight = new Set([unitName]);

                            if (unitLevel === 6) {
                                // Corps: add all direct subordinates from the pre-built map
                                const subordinates = dashboard.linkedUnitsByParent?.get(unitName)
                                    || dashboard.ruLinkedUnitsByParent?.get(unitName);
                                if (subordinates) subordinates.forEach(s => connectedToHighlight.add(s));
                            } else {
                                // Subordinate: find parent corps and highlight the full family
                                const maps = [dashboard.linkedUnitsByParent, dashboard.ruLinkedUnitsByParent];
                                maps.forEach(map => {
                                    if (!map) return;
                                    map.forEach((brigades, corpsName) => {
                                        if (brigades.has(unitName)) {
                                            connectedToHighlight.add(corpsName);
                                            brigades.forEach(s => connectedToHighlight.add(s));
                                        }
                                    });
                                });
                            }

                            window.highlightedUnits = connectedToHighlight;
                            renderPositionChanges();
                        });
                    };

                    if (data.moved && Array.isArray(data.moved)) {
                        const isInBox = (lat, lon) => {
                            return lat >= 42.7 && lat <= 44.0 && lon >= 28.4 && lon <= 39.2;
                        };

                        const filterDistance = dashboard.isChecked('filter-trace-distance');
                        const distanceLimit = parseFloat(dashboard.getEl('trace-distance-limit')?.value || 50);

                        const filterDistanceLess = dashboard.isChecked('filter-trace-distance-less');
                        const distanceLimitLess = parseFloat(dashboard.getEl('trace-distance-limit-less')?.value || 10);


                        data.moved.forEach(item => {
                            // Apply filters
                            if (!shouldShowIcon(item)) return;
                            if (!shouldShowLinked(item.name)) return;
                            if (!shouldShowHighlighted(item.name)) return;
                            const oldPos = item.oldPos;
                            const newPos = item.newPos;
                            let itemDistance = parseFloat(item.distance || 0);

                            let oldInBox = false;
                            let newInBox = false;

                            if (oldPos) oldInBox = isInBox(oldPos.lat, oldPos.lon);
                            if (newPos) newInBox = isInBox(newPos.lat, newPos.lon);

                            // Filter: Don't show positions from the box (Internal movements)
                            if (oldInBox && newInBox) return;

                            // Default settings with side-based colors
                            let showLine = true;
                            const isRussian = item.side === 'RU';
                            let newMarkerColor = isRussian ? '#8B0000' : 'blue'; // Dark red for RU, blue for UA
                            let oldMarkerColor = 'gray';
                            let oldMarkerRadius = 5;
                            let lineColor = isRussian ? '#8B0000' : '#ff9d96'; // Dark red for RU, pink for UA

                            if (newInBox) {
                                // Moved TO the box
                                showLine = false; // No traces
                                oldMarkerColor = 'black'; // "old ... smaller black markers"
                                oldMarkerRadius = 3;
                                newMarkerColor = 'black';
                            } else if (oldInBox) {
                                // Moved FROM the box
                                showLine = false; // No traces
                                newMarkerColor = isRussian ? '#006400' : 'green'; // Dark green for RU, green for UA
                            }

                            // Distance Filter Logic
                            // Hide if > limit
                            if (filterDistance && itemDistance > distanceLimit) {
                                return;
                            }
                            // Hide if < limit
                            if (filterDistanceLess && itemDistance < distanceLimitLess) {
                                return;
                            }

                            // Hide if < limit
                            if (filterDistanceLess && itemDistance < distanceLimitLess) {
                                return;
                            }

                            // Polygon Filter Logic Check (Filter out if NEITHER old nor new pos is in polygon)
                            let oldInPoly = oldPos ? isInSelectedPolygons(oldPos.lat, oldPos.lon) : false;
                            let newInPoly = newPos ? isInSelectedPolygons(newPos.lat, newPos.lon) : false;

                            // If polygon filter is active (checked & has polys), and neither point is inside, skip.
                            if (dashboard.isChecked('polygon-select') && dashboard.selectedPolygons.length > 0) {
                                if (!oldInPoly && !newInPoly) return;
                            }

                            countMoved++;


                            let oldMarker, newMarker, line;

                            const highlightLine = () => {
                                if (showLine && line) {
                                    if (highlightedLayer && highlightedLayer !== line) {
                                        highlightedLayer.setStyle({ weight: 1, color: highlightedLayer.options.originalColor });
                                    }

                                    if (highlightedLayer === line) {
                                        // Toggle off
                                        line.setStyle({ weight: 1, color: lineColor });
                                        highlightedLayer = null;
                                    } else {
                                        // Highlight
                                        highlightedLayer = line;
                                        line.setStyle({ weight: 4, color: 'red' });
                                        line.bringToFront();
                                    }
                                }
                            };

                            // Create markers for old position
                            if (item.oldPos) {
                                oldMarker = L.circleMarker([item.oldPos.lat, item.oldPos.lon], {
                                    radius: oldMarkerRadius,
                                    color: oldMarkerColor,
                                    fillColor: oldMarkerColor,
                                    fillOpacity: 0.8
                                }).addTo(dashboard.featureLayer);

                                oldMarker.bindPopup(`
                                     <strong>${item.name}</strong> (Old Pos)<br>
                                     ${item.properties.description || ''}
                                     <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                        ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                        <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${item.oldPos.lat}, ${item.oldPos.lon}, '${(item.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                     </div>
                                 `);
                                oldMarker.on('click', highlightLine);
                            }

                            // Create markers for new position
                            if (item.newPos) {
                                // Calculate scaled radius based on unitLevel (for new position mainly)
                                const scaledRadius = getMarkerRadius(item.unitLevel);

                                // Check if this unit is highlighted
                                const isHighlighted = window.highlightedUnits && window.highlightedUnits.has(item.name);
                                const displayColor = isHighlighted ? 'yellow' : newMarkerColor;

                                let markerLayer;
                                const icon = showIcons ? getIcon(item, displayColor, scaledRadius) : null;

                                // Check if this position was previously dragged
                                const draggedPos = window.draggedCorpsPositions[item.name];
                                const markerPos = draggedPos || [item.newPos.lat, item.newPos.lon];

                                if (icon) {
                                    markerLayer = L.marker(markerPos, { icon: icon });
                                } else {
                                    markerLayer = L.circleMarker(markerPos, {
                                        radius: isHighlighted ? scaledRadius * 1.5 : scaledRadius, // Larger if highlighted
                                        color: displayColor,
                                        fillColor: displayColor,
                                        fillOpacity: isHighlighted ? 1.0 : 0.8,
                                        weight: isHighlighted ? 3 : 1
                                    });
                                }

                                // Make draggable if it's a Corps (level 6) and drag is enabled
                                if (dragCorpsEnabled && item.unitLevel === 6) {
                                    markerLayer.dragging?.enable();

                                    // For L.marker, we need to initialize dragging
                                    if (markerLayer instanceof L.Marker) {
                                        markerLayer.options.draggable = true;
                                    }

                                    // Handle drag end event
                                    markerLayer.on('dragend', function (e) {
                                        const newLatLng = e.target.getLatLng();
                                        window.draggedCorpsPositions[item.name] = [newLatLng.lat, newLatLng.lng];

                                        console.log(`Corps "${item.name}" moved to: ${newLatLng.lat}, ${newLatLng.lng}`);

                                        // Show notification
                                        const popup = L.popup()
                                            .setLatLng(newLatLng)
                                            .setContent(`<b>${item.name}</b><br>Position updated!<br>Lat: ${newLatLng.lat.toFixed(6)}<br>Lng: ${newLatLng.lng.toFixed(6)}`)
                                            .openOn(dashboard.map);

                                        setTimeout(() => dashboard.map.closePopup(popup), 3000);
                                    });
                                }

                                newMarker = markerLayer.addTo(dashboard.featureLayer);

                                // Add right-click handler for Corps units
                                addCorpsRightClickHandler(newMarker, item.name, item.unitLevel);

                                const currentLatLng = markerLayer.getLatLng ? markerLayer.getLatLng() : { lat: markerPos[0], lng: markerPos[1] };
                                const isDragged = window.draggedCorpsPositions[item.name] ? ' (MOVED)' : '';

                                newMarker.bindPopup(`
                                     <strong>${item.name}</strong> (New Pos)${isDragged}<br>
                                     Level: ${item.unitLevel || 'N/A'}<br>
                                     Distance: ${item.distance} km<br>
                                     Current: ${currentLatLng.lat.toFixed(6)}, ${currentLatLng.lng.toFixed(6)}<br>
                                     ${item.properties.description || ''}<br>
                                     <a href="${item.properties.Last_Known_Location}" target="_blank">Source</a>
                                     <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                        ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                        <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${currentLatLng.lat}, ${currentLatLng.lng}, '${(item.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                     </div>
                                 `);
                                newMarker.on('click', highlightLine);
                                addTitleTooltip(newMarker, item.name);
                            }

                            // Draw line between positions
                            if (showLine && item.oldPos && item.newPos) {
                                line = L.polyline([
                                    [item.oldPos.lat, item.oldPos.lon],
                                    [item.newPos.lat, item.newPos.lon]
                                ], {
                                    color: lineColor,
                                    weight: 1,
                                    dashArray: '5, 10'
                                }).addTo(dashboard.featureLayer);
                                line.options.originalColor = lineColor;
                            }
                        });
                    }

                    // Process "New" items (Green, treated as brought from box)
                    if (data.new && Array.isArray(data.new)) {
                        data.new.forEach(item => {
                            if (!isInSelectedPolygons(item.lat, item.lon)) return; // Polygon Filter
                            if (!shouldShowIcon(item)) return; // Icon Filter
                            if (!shouldShowLinked(item.name)) return; // Linked Units Filter
                            if (!shouldShowHighlighted(item.name)) return; // Highlighted Filter

                            countNew++;
                            const scaledRadius = getMarkerRadius(item.unitLevel);

                            // Check if this unit is highlighted
                            const isHighlighted = window.highlightedUnits && window.highlightedUnits.has(item.name);
                            const isRussian = item.side === 'RU';
                            const baseColor = isRussian ? '#006400' : 'green'; // Dark green for RU, green for UA
                            const displayColor = isHighlighted ? 'yellow' : baseColor;

                            let markerLayer;
                            const icon = showIcons ? getIcon(item, displayColor, scaledRadius) : null;

                            // Check if this position was previously dragged
                            const draggedPos = window.draggedCorpsPositions[item.name];
                            const markerPos = draggedPos || [item.lat, item.lon];

                            if (icon) {
                                markerLayer = L.marker(markerPos, { icon: icon });
                            } else {
                                markerLayer = L.circleMarker(markerPos, {
                                    radius: isHighlighted ? scaledRadius * 1.5 : scaledRadius,
                                    color: displayColor,
                                    fillColor: displayColor,
                                    fillOpacity: isHighlighted ? 1.0 : 0.8,
                                    weight: isHighlighted ? 3 : 1
                                });
                            }

                            // Make draggable if it's a Corps (level 6) and drag is enabled
                            if (dragCorpsEnabled && item.unitLevel === 6) {
                                if (markerLayer instanceof L.Marker) {
                                    markerLayer.options.draggable = true;
                                }

                                markerLayer.on('dragend', function (e) {
                                    const newLatLng = e.target.getLatLng();
                                    window.draggedCorpsPositions[item.name] = [newLatLng.lat, newLatLng.lng];
                                    console.log(`Corps "${item.name}" moved to: ${newLatLng.lat}, ${newLatLng.lng}`);

                                    const popup = L.popup()
                                        .setLatLng(newLatLng)
                                        .setContent(`<b>${item.name}</b><br>Position updated!`)
                                        .openOn(dashboard.map);
                                    setTimeout(() => dashboard.map.closePopup(popup), 3000);
                                });
                            }

                            const marker = markerLayer.addTo(dashboard.featureLayer);

                            // Add right-click handler for Corps units
                            addCorpsRightClickHandler(marker, item.name, item.unitLevel);

                            const currentLatLng = markerLayer.getLatLng ? markerLayer.getLatLng() : { lat: markerPos[0], lng: markerPos[1] };
                            const isDragged = window.draggedCorpsPositions[item.name] ? ' (MOVED)' : '';

                            marker.bindPopup(`
                                <strong>${item.name}</strong> (New)${isDragged}<br>
                                Level: ${item.unitLevel || 'N/A'}<br>
                                Current: ${currentLatLng.lat.toFixed(6)}, ${currentLatLng.lng.toFixed(6)}<br>
                                ${item.properties?.description || ''}
                                <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                    ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                    <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${currentLatLng.lat}, ${currentLatLng.lng}, '${(item.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                </div>
                            `);
                            addTitleTooltip(marker, item.name);
                        });
                    }

                    // Process "Missing" items (Black, treated as moved to box)
                    if (data.missing && Array.isArray(data.missing)) {
                        data.missing.forEach(item => {
                            if (!isInSelectedPolygons(item.lat, item.lon)) return; // Polygon Filter
                            if (!shouldShowIcon(item)) return; // Icon Filter
                            if (!shouldShowLinked(item.name)) return; // Linked Units Filter
                            if (!shouldShowHighlighted(item.name)) return; // Highlighted Filter

                            countMissing++;
                            const scaledRadius = getMarkerRadius(item.unitLevel);

                            // Check if this unit is highlighted
                            const isHighlighted = window.highlightedUnits && window.highlightedUnits.has(item.name);
                            const isRussian = item.side === 'RU';
                            const baseColor = isRussian ? '#4B0000' : 'black'; // Dark maroon for RU, black for UA
                            const displayColor = isHighlighted ? 'yellow' : baseColor;

                            let markerLayer;
                            const icon = showIcons ? getIcon(item, displayColor, scaledRadius) : null;

                            if (icon) {
                                markerLayer = L.marker([item.lat, item.lon], { icon: icon });
                            } else {
                                markerLayer = L.circleMarker([item.lat, item.lon], {
                                    radius: isHighlighted ? scaledRadius * 1.5 : 3,
                                    color: displayColor,
                                    fillColor: displayColor,
                                    fillOpacity: isHighlighted ? 1.0 : 0.8,
                                    weight: isHighlighted ? 3 : 1
                                });
                            }

                            const marker = markerLayer.addTo(dashboard.featureLayer);

                            // Add right-click handler for Corps units
                            addCorpsRightClickHandler(marker, item.name, item.unitLevel);

                            marker.bindPopup(`
                                <strong>${item.name}</strong> (Missing)<br>
                                Level: ${item.unitLevel || 'N/A'}<br>
                                ${item.properties?.description || ''}
                                <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                    ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                    <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${item.lat}, ${item.lon}, '${(item.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                </div>
                            `);
                            addTitleTooltip(marker, item.name);
                        });
                    }

                    // Process "Unchanged" items (Blue, treated as moved by 0)
                    if (data.unchanged && Array.isArray(data.unchanged)) {
                        const filterDistanceLess = dashboard.isChecked('filter-trace-distance-less');
                        const distanceLimitLess = parseFloat(dashboard.getEl('trace-distance-limit-less')?.value || 10);

                        // If filtering small moves, and limit > 0, hide unchanged (dist 0)
                        if (filterDistanceLess && distanceLimitLess > 0) {
                            // Skip rendering
                        } else {
                            data.unchanged.forEach(item => {
                                if (!isInSelectedPolygons(item.lat, item.lon)) return; // Polygon Filter
                                if (!shouldShowIcon(item)) return; // Icon Filter
                                if (!shouldShowLinked(item.name)) return; // Linked Units Filter
                                if (!shouldShowHighlighted(item.name)) return; // Highlighted Filter

                                countUnchanged++;
                                const scaledRadius = getMarkerRadius(item.unitLevel);
                                // Check if this unit is highlighted
                                const isHighlighted = window.highlightedUnits && window.highlightedUnits.has(item.name);
                                const isRussian = item.side === 'RU';
                                const baseColor = isRussian ? '#B22222' : 'blue'; // Firebrick red for RU, blue for UA
                                const displayColor = isHighlighted ? 'yellow' : baseColor;

                                let markerLayer;
                                const icon = showIcons ? getIcon(item, displayColor, scaledRadius) : null;

                                // Check if this position was previously dragged
                                const draggedPos = window.draggedCorpsPositions[item.name];
                                const markerPos = draggedPos || [item.lat, item.lon];

                                if (icon) {
                                    markerLayer = L.marker(markerPos, { icon: icon });
                                } else {
                                    markerLayer = L.circleMarker(markerPos, {
                                        radius: isHighlighted ? scaledRadius * 1.5 : scaledRadius,
                                        color: displayColor,
                                        fillColor: displayColor,
                                        fillOpacity: isHighlighted ? 1.0 : 0.8,
                                        weight: isHighlighted ? 3 : 1
                                    });
                                }

                                // Make draggable if it's a Corps (level 6) and drag is enabled
                                if (dragCorpsEnabled && item.unitLevel === 6) {
                                    if (markerLayer instanceof L.Marker) {
                                        markerLayer.options.draggable = true;
                                    }

                                    markerLayer.on('dragend', function (e) {
                                        const newLatLng = e.target.getLatLng();
                                        window.draggedCorpsPositions[item.name] = [newLatLng.lat, newLatLng.lng];
                                        console.log(`Corps "${item.name}" moved to: ${newLatLng.lat}, ${newLatLng.lng}`);

                                        const popup = L.popup()
                                            .setLatLng(newLatLng)
                                            .setContent(`<b>${item.name}</b><br>Position updated!`)
                                            .openOn(dashboard.map);
                                        setTimeout(() => dashboard.map.closePopup(popup), 3000);
                                    });
                                }

                                const marker = markerLayer.addTo(dashboard.featureLayer);

                                // Add right-click handler for Corps units
                                addCorpsRightClickHandler(marker, item.name, item.unitLevel);

                                const currentLatLng = markerLayer.getLatLng ? markerLayer.getLatLng() : { lat: markerPos[0], lng: markerPos[1] };
                                const isDragged = window.draggedCorpsPositions[item.name] ? ' (MOVED)' : '';

                                marker.bindPopup(`
                                    <strong>${item.name}</strong> (Unchanged)${isDragged}<br>
                                    Level: ${item.unitLevel || 'N/A'}<br>
                                    Current: ${currentLatLng.lat.toFixed(6)}, ${currentLatLng.lng.toFixed(6)}<br>
                                    ${item.properties?.description || ''}
                                    <div style="margin-top:10px; border-top: 1px solid #ccc; padding-top: 5px;">
                                        ${window.markerAdjuster ? window.markerAdjuster.getMissingEntitiesHTML() : ''}
                                        <button onclick="window.markerAdjuster && window.markerAdjuster.pickUnitLocation(${currentLatLng.lat}, ${currentLatLng.lng}, '${(item.name || '').replace(/'/g, "\\'")}')" style="background-color: #3388ff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 5px;">Pick Location</button>
                                    </div>
                                `);
                                addTitleTooltip(marker, item.name);
                            });
                        }
                    }

                    // Draw lines between subordinate units and their parents
                    if (showLinkedUnits && data.statistics && data.statistics.subordinateUnits) {
                        const unitPositions = new Map();

                        // Build a map of unit names to their positions
                        const collectPositions = (items, type) => {
                            if (!items || !Array.isArray(items)) return;
                            items.forEach(item => {
                                // Check if this unit has been dragged
                                const draggedPos = window.draggedCorpsPositions[item.name];

                                if (draggedPos) {
                                    // Use dragged position
                                    unitPositions.set(item.name, { lat: draggedPos[0], lon: draggedPos[1], type });
                                } else if (type === 'moved') {
                                    // For moved units, use the new position
                                    if (item.newPos) {
                                        unitPositions.set(item.name, { lat: item.newPos.lat, lon: item.newPos.lon, type });
                                    }
                                } else if (item.lat && item.lon) {
                                    unitPositions.set(item.name, { lat: item.lat, lon: item.lon, type });
                                }
                            });
                        };

                        collectPositions(data.moved, 'moved');
                        collectPositions(data.new, 'new');
                        collectPositions(data.missing, 'missing');
                        collectPositions(data.unchanged, 'unchanged');

                        // Draw lines for each subordinate relationship
                        const drawSubordinateLines = (subordinateList, color) => {
                            if (!subordinateList || !Array.isArray(subordinateList)) return;

                            subordinateList.forEach(({ unit, parent }) => {
                                const unitPos = unitPositions.get(unit);
                                const parentPos = unitPositions.get(parent);

                                if (unitPos && parentPos) {
                                    // Check polygon filter for both positions
                                    if (!isInSelectedPolygons(unitPos.lat, unitPos.lon)) return;
                                    if (!isInSelectedPolygons(parentPos.lat, parentPos.lon)) return;

                                    const line = L.polyline(
                                        [[unitPos.lat, unitPos.lon], [parentPos.lat, parentPos.lon]],
                                        {
                                            color: color,
                                            weight: 2,
                                            opacity: 1,
                                            dashArray: '5, 5'
                                        }
                                    ).addTo(dashboard.featureLayer);

                                    line.bindPopup(`
                                        <strong>Subordinate Link</strong><br>
                                        ${unit}<br>
                                        ↓<br>
                                        ${parent}
                                    `);
                                }
                            });
                        };

                        // Draw lines for moved units (blue dashed lines)
                        drawSubordinateLines(data.statistics.subordinateUnits.moved, '#0066cc');
                        drawSubordinateLines(data.statistics.subordinateUnits.unchanged, '#0066cc');

                        // Draw lines for new units (green dashed lines)
                        drawSubordinateLines(data.statistics.subordinateUnits.new, '#00aa00');

                        // Draw lines for missing units (black dashed lines)
                        drawSubordinateLines(data.statistics.subordinateUnits.missing, '#333333');
                    }

                    const statsEl = dashboard.getEl('position-change-stats');
                    if (statsEl) {
                        let subordinateCounts = '';
                        if (data.statistics && data.statistics.subordinateUnits) {
                            const movedSub = data.statistics.subordinateUnits.moved?.length || 0;
                            const newSub = data.statistics.subordinateUnits.new?.length || 0;
                            const missingSub = data.statistics.subordinateUnits.missing?.length || 0;
                            if (movedSub + newSub + missingSub > 0) {
                                subordinateCounts = `<br><small>Linked: ${movedSub + newSub + missingSub} units</small>`;
                            }
                        }

                        const draggedCount = Object.keys(window.draggedCorpsPositions).length;
                        const draggedInfo = draggedCount > 0 ? `<br><small style="color: orange;">Dragged: ${draggedCount} units</small>` : '';

                        statsEl.innerHTML = `
                            Moved: ${countMoved}<br>
                            New: ${countNew}<br>
                            Missing: ${countMissing}<br>
                            Unchanged: ${countUnchanged}${subordinateCounts}${draggedInfo}
                        `;
                    }
                } catch (error) {
                    console.error('Error loading position changes:', error);
                    alert('Failed to load position changes data.');
                }
            } else {
                const controls = dashboard.getEl('position-change-controls');
                if (controls) controls.style.display = 'none';
                dashboard.featureLayer.clearLayers();
            }
        };

        // Expose renderPositionChanges to dashboard for slider updates
        dashboard.renderPositionChanges = renderPositionChanges;

        dashboard.bindUI('position-change', 'change', () => { renderPositionChanges(); if (dashboard.updateUnitsAttribution) dashboard.updateUnitsAttribution(); });
        dashboard.bindUI('feature-positions-ua', 'change', renderPositionChanges);
        dashboard.bindUI('feature-positions-ru', 'change', renderPositionChanges);
        dashboard.bindUI('show-unit-icons', 'change', renderPositionChanges);
        dashboard.bindUI('show-linked-units', 'change', () => { updateDailyPositions(); if (dashboard.isChecked('position-change')) renderPositionChanges(); });
        dashboard.bindUI('show-only-highlighted', 'change', () => { updateDailyPositions(); if (dashboard.isChecked('position-change')) renderPositionChanges(); });
        dashboard.bindUI('drag-units', 'change', () => { updateDailyPositions(); if (dashboard.isChecked('position-change')) renderPositionChanges(); });
        dashboard.bindUI('filter-trace-distance', 'change', renderPositionChanges);
        dashboard.bindUI('trace-distance-limit', 'change', renderPositionChanges);
        dashboard.bindUI('filter-trace-distance-less', 'change', renderPositionChanges);
        dashboard.bindUI('trace-distance-limit-less', 'change', renderPositionChanges);

        // Export dragged positions button
        // Handle filter-by-icon checkbox
        dashboard.bindUI('filter-by-icon', 'change', () => {
            const filterControls = dashboard.getEl('icon-filter-controls');
            if (filterControls) {
                filterControls.style.display = dashboard.isChecked('filter-by-icon') ? 'block' : 'none';
            }
            updateDailyPositions();
            if (dashboard.isChecked('position-change')) renderPositionChanges();
        });

        dashboard.bindUI('reposition-units', 'click', () => {
            if (!dashboard.linkedUnitsByParent && !dashboard.ruLinkedUnitsByParent) return;

            // Build name → {latlng, layer} from current daily layers
            const unitPositions = new Map();
            const unitLayers = new Map();
            [dashboard.dailyLayerUA, dashboard.dailyLayerRU].forEach(layer => {
                if (!layer) return;
                layer.getLayers().forEach(sub => {
                    const name = sub.feature?.properties?.name?.trim();
                    if (!name) return;
                    const latlng = sub.getLatLng ? sub.getLatLng()
                        : sub.getBounds ? sub.getBounds().getCenter() : null;
                    if (latlng) {
                        unitPositions.set(name, latlng);
                        unitLayers.set(name, sub);
                    }
                });
            });

            if (!window.draggedCorpsPositions) window.draggedCorpsPositions = {};

            const repoBounds = L.latLngBounds(
                L.latLng(46.09034063760397, 31.928531085733255),
                L.latLng(52.324983525342205, 40.38061609411399)
            );

            const repositionCorps = (parentMap) => {
                parentMap?.forEach((brigades, corpsName) => {
                    const positions = [];
                    brigades.forEach(brigade => {
                        if (brigade.includes('Artillery Brigade')) return;
                        const pos = unitPositions.get(brigade);
                        if (pos && repoBounds.contains(pos)) positions.push(pos);
                    });
                    if (positions.length === 0) return;
                    const lat = positions.reduce((s, p) => s + p.lat, 0) / positions.length;
                    const lng = positions.reduce((s, p) => s + p.lng, 0) / positions.length;
                    const centroid = L.latLng(lat, lng);
                    window.draggedCorpsPositions[corpsName] = [lat, lng];
                    const corpsMarker = unitLayers.get(corpsName);
                    if (corpsMarker?.setLatLng) corpsMarker.setLatLng(centroid);
                });
            };
            repositionCorps(dashboard.linkedUnitsByParent);
            repositionCorps(dashboard.ruLinkedUnitsByParent);
        });

        dashboard.bindUI('export-dragged-positions', 'click', () => {
            if (Object.keys(window.draggedCorpsPositions).length === 0) {
                alert('No dragged positions to export!');
                return;
            }

            const exportData = {
                timestamp: new Date().toISOString(),
                draggedPositions: window.draggedCorpsPositions
            };

            const dataStr = JSON.stringify(exportData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `dragged-corps-positions-${new Date().toISOString().split('T')[0]}.json`;
            link.click();

            URL.revokeObjectURL(url);

            console.log('Exported dragged positions:', exportData);
            alert(`Exported ${Object.keys(window.draggedCorpsPositions).length} dragged positions!`);
        });

        // Register map draw events to trigger updates
        dashboard.map.on(L.Draw.Event.CREATED, () => {
            // Small delay to allow polygon to be fully registered in selectedPolygons array
            setTimeout(renderPositionChanges, 100);
        });
        dashboard.map.on(L.Draw.Event.DELETED, () => {
            setTimeout(renderPositionChanges, 100);
        });
        dashboard.map.on(L.Draw.Event.EDITED, () => {
            setTimeout(renderPositionChanges, 100);
        });

        // Route Tracker — shows historical movement trails from unit-movements.json
        let routeTrackerLayer = L.layerGroup().addTo(dashboard.map);
        let routeTrackerData = null;
        // Stores { line, startMarker, endMarker, visible } per unit name
        let routeTrackerUnits = {};

        const renderRouteTracker = async () => {
            routeTrackerLayer.clearLayers();
            routeTrackerUnits = {};
            const panel = document.getElementById('route-tracker-panel');

            if (!dashboard.isChecked('route-tracker')) {
                if (panel) panel.style.display = 'none';
                return;
            }

            // Load data once
            if (!routeTrackerData) {
                try {
                    const resp = await fetch(`${API_BASE_URL}/unit-movements`);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    routeTrackerData = await resp.json();
                } catch (err) {
                    console.error('Route tracker: failed to load data', err);
                    return;
                }
            }

            // Use position-change distance filters when #position-change is enabled
            const useDistFilters = dashboard.isChecked('position-change');
            const filterMax = useDistFilters && dashboard.isChecked('filter-trace-distance');
            const maxDist = parseFloat(dashboard.getEl('trace-distance-limit')?.value || 50);
            const filterMin = useDistFilters && dashboard.isChecked('filter-trace-distance-less');
            const minDist = parseFloat(dashboard.getEl('trace-distance-limit-less')?.value || 10);

            // Reuse UA position marker style: blue #0057B7
            const uaBlue = '#0057B7';
            const traceColors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
                '#42d4f4', '#f032e6', '#469990', '#9A6324', '#800000',
                '#808000', '#000075', '#e6beff', '#aaffc3', '#ff4500'];

            // Sort all units by totalDistanceKm descending, filter
            const sorted = Object.entries(routeTrackerData)
                .filter(([, u]) => u.totalMoves > 0 && u.positions.length >= 2)
                .filter(([, u]) => {
                    if (filterMax && u.totalDistanceKm > maxDist) return false;
                    if (filterMin && u.totalDistanceKm < minDist) return false;
                    return true;
                })
                .sort((a, b) => b[1].totalDistanceKm - a[1].totalDistanceKm);

            const toggledOnly = dashboard.isChecked('route-tracker-toggled-only');

            // Toggle trace visibility for a unit
            const toggleTrace = (name) => {
                const entry = routeTrackerUnits[name];
                if (!entry) return;
                entry.visible = !entry.visible;
                if (entry.visible) {
                    routeTrackerLayer.addLayer(entry.line);
                    routeTrackerLayer.addLayer(entry.startMarker);
                } else {
                    routeTrackerLayer.removeLayer(entry.line);
                    routeTrackerLayer.removeLayer(entry.startMarker);
                    // If toggled-only mode, also hide end marker
                    if (dashboard.isChecked('route-tracker-toggled-only')) {
                        routeTrackerLayer.removeLayer(entry.endMarker);
                    }
                }
                // Update panel row highlight
                const row = document.getElementById(`rt-row-${entry.idx}`);
                if (row) row.style.background = entry.visible ? entry.color + '22' : 'transparent';
            };

            // Preserve toggle state from previous render
            const prevVisible = new Set();
            for (const [name, entry] of Object.entries(routeTrackerUnits)) {
                if (entry.visible) prevVisible.add(name);
            }

            // Create layers for each unit
            sorted.forEach(([name, unit], idx) => {
                const positions = unit.positions;
                const latlngs = positions.map(p => [p.lat, p.lon]);
                const wasVisible = prevVisible.has(name);

                const unitColor = traceColors[idx % traceColors.length];

                // Polyline
                const line = L.polyline(latlngs, {
                    color: unitColor, weight: 3.5, opacity: 0.85, dashArray: '6, 4'
                });
                line.bindTooltip(name, { sticky: true });

                // Start marker
                const startMarker = L.circleMarker(latlngs[0], {
                    radius: 4, fillColor: unitColor, color: '#fff', weight: 1, opacity: 1, fillOpacity: 0.8
                }).bindPopup(`<strong>${name}</strong><br>Start: ${positions[0].date}`);

                // End marker
                const last = positions[positions.length - 1];
                const endMarker = L.circleMarker(latlngs[latlngs.length - 1], {
                    radius: 4, fillColor: uaBlue, color: '#fff', weight: 1, opacity: 1, fillOpacity: 0.8
                });
                endMarker.bindPopup(
                    `<strong>${name}</strong><br>` +
                    `${positions[0].date} → ${last.date}<br>` +
                    `Moves: ${unit.totalMoves} | ${unit.totalDistanceKm} km`
                );
                endMarker.on('click', () => toggleTrace(name));

                const visible = wasVisible;

                // Show end marker unless toggled-only mode hides non-active
                if (!toggledOnly || visible) {
                    routeTrackerLayer.addLayer(endMarker);
                }
                // Restore trace if was visible
                if (visible) {
                    routeTrackerLayer.addLayer(line);
                    routeTrackerLayer.addLayer(startMarker);
                }

                routeTrackerUnits[name] = { line, startMarker, endMarker, visible, idx, color: unitColor };
            });

            // Build stats panel — units with 4+ moves, sorted by distance
            if (panel) {
                panel.style.display = 'block';
                const qualified = sorted.filter(([, u]) => u.totalMoves >= 4).slice(0, 15);
                panel.innerHTML = `<strong>Top movers (4+ moves, click to toggle):</strong><br>` +
                    qualified.map(([name, unit]) => {
                        const entry = routeTrackerUnits[name];
                        const c = entry ? entry.color : uaBlue;
                        const bg = entry && entry.visible ? c + '22' : 'transparent';
                        const i = entry ? entry.idx : 0;
                        return `<div id="rt-row-${i}" style="cursor:pointer; padding: 1px 4px; border-left: 3px solid ${c}; margin: 1px 0; background: ${bg};" data-unit="${name.replace(/"/g, '&quot;')}">` +
                            `<span style="color:${c}; font-weight:bold;">●</span> ${name} ` +
                            `<span style="color:#888;">${unit.totalDistanceKm}km, ${unit.totalMoves} moves</span>` +
                            `</div>`;
                    }).join('');

                // Click handlers for panel rows
                panel.querySelectorAll('[data-unit]').forEach(row => {
                    row.addEventListener('click', () => {
                        const unitName = row.getAttribute('data-unit');
                        toggleTrace(unitName);
                        const entry = routeTrackerUnits[unitName];
                        if (entry && entry.visible) {
                            dashboard.map.panTo(entry.endMarker.getLatLng());
                        }
                    });
                });
            }

            console.log(`Route tracker: ${sorted.length} units`);
        };

        dashboard.bindUI('route-tracker', 'change', renderRouteTracker);
        // Re-render when position-change filters change (if route-tracker is active)
        const routeFilterHandler = () => {
            if (dashboard.isChecked('route-tracker')) renderRouteTracker();
        };
        dashboard.bindUI('filter-trace-distance', 'change', routeFilterHandler);
        dashboard.bindUI('trace-distance-limit', 'change', routeFilterHandler);
        dashboard.bindUI('filter-trace-distance-less', 'change', routeFilterHandler);
        dashboard.bindUI('trace-distance-limit-less', 'change', routeFilterHandler);
        dashboard.bindUI('route-tracker-toggled-only', 'change', routeFilterHandler);

        dashboard.bindUI('analyze-positions', 'change', () => {
            dashboard.analyzeUnitsEnabled = dashboard.isChecked('analyze-positions');
            const panel = dashboard.getEl('units-analysis-panel');
            if (dashboard.analyzeUnitsEnabled) {
                if (panel) {
                    panel.style.display = 'block';
                }
                if (dashboard.selectedPolygons.length > 0) {
                    dashboard.analyzeUnitsInSelectedArea();
                }
            } else if (panel) {
                panel.style.display = 'none';
            }
        });

        dashboard.bindUI('polygon-select', 'change', () => {
            dashboard.togglePolygonSelection();
        });

        dashboard.bindUI('clear-polygons', 'click', () => {
            dashboard.clearSelectedPolygons();
        });

        dashboard.bindUI('export-polygons', 'click', () => {
            dashboard.exportAllPolygonsToConsole();
        });

        dashboard.bindUI('ruler-tool', 'change', () => {
            dashboard.toggleRulerTool();
        });

        dashboard.bindUI('game-tool', 'change', () => {
            dashboard.toggleGameTool();
        });

        dashboard.bindUI('save-session', 'click', () => {
            const state = dashboard.serializeSession();
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `ukraine-map-session-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
        });

        dashboard.bindUI('load-session', 'click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                    const state = JSON.parse(await file.text());
                    await dashboard.restoreSession(state);
                } catch (err) {
                    console.error('Session load failed:', err);
                    alert(`Could not load session: ${err.message}`);
                }
            });
            input.click();
        });

        dashboard.bindUI('share-session-link', 'click', () => {
            const btn = dashboard.getEl('share-session-link');
            try {
                const state = dashboard.serializeSession();
                // data: URLs can be megabytes — links carry only fetchable image URLs
                state.imageOverlays = (state.imageOverlays || []).filter(
                    o => o.url && !o.url.startsWith('data:'));
                const packed = LZString.compressToEncodedURIComponent(JSON.stringify(state));
                const link = `${location.origin}${location.pathname}#session=${packed}`;
                dashboard.lastShareLink = link; // used by automated verification
                navigator.clipboard.writeText(link).catch(() => {});
                if (link.length > 30000) {
                    alert('Link copied, but it is very long (heavy drawings) — some messengers may truncate it. Consider Save Session to a file instead.');
                } else if (btn) {
                    const orig = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                }
            } catch (err) {
                console.error('Share link failed:', err);
                alert(`Could not create share link: ${err.message}`);
            }
        });

        dashboard.bindUI('load-image-overlay', 'click', () => {
            dashboard.loadImageOverlay();
        });

        dashboard.bindUI('clear-image-overlay', 'click', () => {
            dashboard.clearImageOverlay();
        });

        dashboard.bindUI('save-image-overlay', 'click', () => {
            dashboard.saveImageOverlay();
        });

        dashboard.bindUI('enable-image-resize', 'change', () => {
            dashboard.toggleImageResizeMode();
        });

        dashboard.bindUI('image-warp-points', 'change', (e) => {
            dashboard.setImageWarpPoints(parseInt(e.target.value, 10));
            // while align mode is armed, edit markers must stay hidden
            // (they intercept alignment clicks) and panning stays enabled
            if (dashboard.imageAligner?.active) {
                dashboard.hideImageCornerMarkers();
                dashboard.hideMeshMarkers();
                dashboard.map.dragging.enable();
            }
        });

        dashboard.bindUI('image-opacity-slider', 'input', (e) => {
            dashboard.updateImageOpacity(e.target.value);
        });

        dashboard.bindUI('predefined-regions', 'change', (e) => {
            if (e.target.value) {
                dashboard.currentPredefinedRegion = e.target.value;
                dashboard.loadPredefinedRegion(e.target.value);
            } else {
                dashboard.currentPredefinedRegion = null;
            }

            if (dashboard.isChecked('show-settlements')) {
                dashboard.displaySettlements();
            }
            const searchValue = dashboard.getEl('settlement-search')?.value || '';
            if (searchValue.trim()) {
                dashboard.handleSettlementSearch(searchValue);
            }
        });

        dashboard.bindUI('search-in-predefined-region', 'change', () => {
            if (dashboard.isChecked('show-settlements')) {
                dashboard.displaySettlements();
            }

            const searchValue = dashboard.getEl('settlement-search')?.value || '';
            if (searchValue.trim()) {
                dashboard.handleSettlementSearch(searchValue);
            }
        });

        dashboard.bindUI('search-in-polygons', 'change', () => {
            if (dashboard.isChecked('show-settlements')) {
                dashboard.displaySettlements();
            }

            const searchValue = dashboard.getEl('settlement-search')?.value || '';
            if (searchValue.trim()) {
                dashboard.handleSettlementSearch(searchValue);
            }
        });

        dashboard.bindUI('load-selected-regions', 'click', () => {
            dashboard.loadSelectedRegions();
        });

        dashboard.bindUI('exclude-occupied', 'change', () => {
            dashboard.calculateSelectedAreaStatistics();
        });

        dashboard.bindUI('calculate-unoccupied', 'click', () => {
            dashboard.calculateUnoccupiedForAllRegions();
        });

        dashboard.bindUI('refresh-optimization', 'click', () => {
            if (dashboard.isChecked('diff-area')) {
                dashboard.getEl('diff-area')?.dispatchEvent(new Event('change'));
            }
        });

        dashboard.bindUI('refresh-data-sources', 'click', async () => {
            console.log('Refreshing data sources...');
            await dashboard.loadAllData();
            console.log('Data sources refreshed');
        });

        const mapboxInput = dashboard.getEl('mapbox-token-input');
        if (mapboxInput) {
            mapboxInput.value = localStorage.getItem('mapboxToken') || '';
        }
        dashboard.bindUI('mapbox-token-save', 'click', () => {
            const token = dashboard.getEl('mapbox-token-input')?.value.trim() || '';
            localStorage.setItem('mapboxToken', token);
            dashboard.mapboxToken = token;
            dashboard.mapStyles.mapbox.url = `https://api.mapbox.com/styles/v1/mapbox/navigation-day-v1/tiles/{z}/{x}/{y}?access_token=${token}&language=en`;
            if (dashboard.getEl('map-style')?.value === 'mapbox') {
                dashboard.changeMapStyle('mapbox');
            }
        });

        dashboard.bindUI('group-markers', 'change', () => {
            dashboard.updateMap();
        });

        dashboard.bindUI('show-regions', 'change', () => {
            dashboard.updateAttackLegendVisibility();
            dashboard.updateMap();
        });

        dashboard.bindUI('show-settlements', 'change', () => {
            dashboard.toggleSettlementsDisplay();
        });

        dashboard.bindUI('filter-settlements-radius', 'change', () => {
            dashboard.filterSettlementsByRadius();
            if (dashboard.isChecked('settlements-border')) {
                dashboard.settlementBordersLayer.clearLayers();
                dashboard.renderedBoundaries.clear();
                dashboard.toggleSettlementBoundaries();
            }
        });

        dashboard.bindUI('clusterRadius', 'input', () => {
            if (dashboard.isChecked('filter-settlements-radius') && dashboard.isChecked('settlements-border')) {
                dashboard.settlementBordersLayer.clearLayers();
                dashboard.renderedBoundaries.clear();
                dashboard.toggleSettlementBoundaries();
            }
        });

        dashboard.bindUI('settlements-border', 'change', () => {
            dashboard.toggleSettlementBoundaries();
        });

        dashboard.bindUI('show-settlement-boundaries', 'change', () => {
            dashboard.toggleLocalBoundaries();
        });

        dashboard.bindUI('show-settlement-names', 'change', () => {
            dashboard.toggleSettlementNames();
        });

        dashboard.bindUI('settlement-label-pop-slider', 'input', () => {
            const val = parseInt(dashboard.getEl('settlement-label-pop-slider')?.value) || 20000;
            const display = dashboard.getEl('settlement-label-pop-value');
            if (display) display.textContent = val.toLocaleString();
            if (dashboard.isChecked('show-settlement-boundaries')) dashboard.renderLocalBoundaries();
            if (dashboard.isChecked('show-settlement-names')) dashboard.renderSettlementNames();
        });

        dashboard.bindUI('settlement-boundary-color', 'input', () => {
            if (dashboard.isChecked('show-settlement-boundaries')) dashboard.renderLocalBoundaries();
        });

        dashboard.bindUI('clear-manual-layers', 'click', () => {
            dashboard.settlements.clearManualLayers();
        });

        dashboard.bindUI('settlement-buffers', 'change', () => {
            dashboard.toggleSettlementBuffers();
        });

        dashboard.bindUI('settlement-history', 'change', () => {
            dashboard.toggleSettlementHistory();
        });

        dashboard.bindUI('search-in-regions', 'change', () => {
            const searchValue = dashboard.getEl('settlement-search')?.value || '';
            if (searchValue.trim()) {
                dashboard.handleSettlementSearch(searchValue);
            }

            if (dashboard.isChecked('show-settlements')) {
                dashboard.displaySettlements();
            }
        });

        dashboard.bindUI('settlement-search', 'input', (e) => {
            dashboard.handleSettlementSearch(e.target.value);
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#settlement-search') && !e.target.closest('#settlement-search-results')) {
                const resultsContainer = dashboard.getEl('settlement-search-results');
                if (resultsContainer) {
                    resultsContainer.style.display = 'none';
                }
            }
        });

        // ── Image Alignment (control-point registration) ─────────────────────
        dashboard.imageAligner = new ImageAligner(dashboard);

        dashboard.bindUI('align-points', 'change', () => {
            if (dashboard.isChecked('align-points')) {
                if (!dashboard.customImageOverlay) {
                    alert('Load an image overlay first');
                    const cb = dashboard.getEl('align-points');
                    if (cb) cb.checked = false;
                    return;
                }
                // one armed capture-mode at a time
                const pick = dashboard.getEl('extract-pick-color');
                if (pick?.checked) {
                    pick.checked = false;
                    pick.dispatchEvent(new Event('change'));
                }
                const editSel = dashboard.getEl('extract-edit-mode');
                if (editSel && editSel.value !== 'none') {
                    editSel.value = 'none';
                    editSel.dispatchEvent(new Event('change'));
                }
                dashboard.imageAligner.start();
            } else {
                dashboard.imageAligner.stop();
            }
        });

        dashboard.bindUI('align-reset', 'click', () => {
            dashboard.imageAligner.resetPairs();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dashboard.imageAligner.active) {
                const cb = dashboard.getEl('align-points');
                if (cb) {
                    cb.checked = false;
                    cb.dispatchEvent(new Event('change'));
                }
            }
        });

        // ── Image Zone Extraction ─────────────────────────────────────────────
        dashboard.imageExtractor = new ImageExtractor(dashboard);

        // ── Streaming / Presenter Mode ────────────────────────────────────────
        dashboard.streamer = new MapStreamer(dashboard);

        dashboard.bindUI('stream-start', 'click', () => dashboard.streamer.startPresenting());
        dashboard.bindUI('stream-stop', 'click', () => dashboard.streamer.stop());
        dashboard.bindUI('stream-leave', 'click', () => dashboard.streamer.stop());
        dashboard.bindUI('stream-copy-link', 'click', () => {
            const link = dashboard.getEl('stream-link')?.value;
            if (link) navigator.clipboard.writeText(link).catch(() => {});
        });
        dashboard.bindUI('stream-request-draw', 'click', () => dashboard.streamer.requestDraw());

        // Auto-join when opened via a share link
        const followMatch = location.hash.match(/#follow=([\w-]+)/);
        if (followMatch) {
            dashboard.streamer.join(followMatch[1]);
        }

        // Auto-restore when opened via a share link
        const sessionMatch = location.hash.match(/#session=(.+)/);
        if (!followMatch && sessionMatch) {
            setTimeout(async () => {
                try {
                    const json = LZString.decompressFromEncodedURIComponent(sessionMatch[1]);
                    if (!json) throw new Error('corrupted link data');
                    await dashboard.restoreSession(JSON.parse(json));
                    console.log('✓ Session restored from share link');
                } catch (err) {
                    console.error('Session link restore failed:', err);
                    alert(`Could not restore session from link: ${err.message}`);
                }
            }, 0);
        }

        const extractStatus = (msg) => {
            const el = dashboard.getEl('extract-status');
            if (!el) return;
            el.style.display = msg ? 'block' : 'none';
            el.textContent = msg || '';
        };

        dashboard.bindUI('extract-tolerance', 'input', (e) => {
            dashboard.setText('extract-tolerance-value', e.target.value);
        });

        /** Replace the extracted-zones layer with the given features and refresh merged polygon + status. */
        const setExtractedZones = (features) => {
            if (dashboard.extractedZoneLayer) {
                dashboard.map.removeLayer(dashboard.extractedZoneLayer);
            }
            if (!features.length) {
                dashboard.extractedZoneLayer = null;
                dashboard.extractedMergedPolygon = null;
                extractStatus('All zones erased');
                return;
            }
            dashboard.extractedZoneLayer = L.geoJSON(turf.featureCollection(features), {
                style: { color: '#c62828', weight: 2, fillColor: '#e53935', fillOpacity: 0.35 },
                interactive: false
            }).addTo(dashboard.map);
            let merged = features[0];
            for (let i = 1; i < features.length; i++) {
                try { merged = turf.union(merged, features[i]); }
                catch (e) { console.warn('Union failed for polygon', i); }
            }
            dashboard.extractedMergedPolygon = merged;
            const km2 = Math.round(turf.area(merged) / 1e6);
            extractStatus(`${features.length} zone${features.length > 1 ? 's' : ''}, ${km2.toLocaleString()} km²`);
        };
        dashboard.setExtractedZones = setExtractedZones;

        // ── Edit undo stack (extracted zones + custom layer) ─────────────────
        const editUndoStack = [];   // entries: { target: 'extracted'|'custom', payload }
        const MAX_UNDO = 10;

        const updateUndoBtn = () => {
            const btn = dashboard.getEl('extract-undo');
            if (btn) btn.disabled = editUndoStack.length === 0;
        };

        /** Snapshot the given target BEFORE mutating it. */
        const pushEditUndo = (target) => {
            let payload;
            if (target === 'custom') {
                payload = dashboard.customKmlData
                    ? JSON.parse(JSON.stringify(dashboard.customKmlData))
                    : null;
            } else {
                payload = dashboard.extractedZoneLayer
                    ? dashboard.extractedZoneLayer.toGeoJSON().features
                    : [];
            }
            editUndoStack.push({ target, payload });
            if (editUndoStack.length > MAX_UNDO) editUndoStack.shift();
            updateUndoBtn();
        };

        /** Recompute merged polygon + re-render the custom overlay from customKmlData. */
        const refreshCustomLayer = () => {
            const polys = [];
            (dashboard.customKmlData?.features || []).forEach(f => {
                if (f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
                    polys.push(...GeometryUtils.toTurfPolygons(f.geometry));
                }
            });
            let merged = polys[0] || null;
            for (let i = 1; i < polys.length; i++) {
                try { merged = turf.union(merged, polys[i]); }
                catch (e) { /* keep partial union */ }
            }
            dashboard.customKmlMergedPolygon = merged;
            dashboard.layers.toggleCustomKmlOverlay(!!dashboard.getEl('custom-kml-overlay')?.checked);
            return merged;
        };

        dashboard.bindUI('extract-undo', 'click', () => {
            const entry = editUndoStack.pop();
            updateUndoBtn();
            if (!entry) return;
            if (entry.target === 'custom') {
                dashboard.customKmlData = entry.payload;
                const merged = refreshCustomLayer();
                const km2 = merged ? Math.round(turf.area(merged) / 1e6) : 0;
                extractStatus(entry.payload
                    ? `Undo: custom layer restored (${entry.payload.features.length} features, ${km2.toLocaleString()} km²)`
                    : 'Undo: custom layer cleared');
            } else {
                setExtractedZones(entry.payload);
                if (!entry.payload.length) extractStatus('Undo: no zones');
            }
        });

        dashboard.bindUI('extract-zones', 'click', async () => {
            const btn = dashboard.getEl('extract-zones');
            const tolerance = parseInt(dashboard.getEl('extract-tolerance')?.value ?? '50', 10);
            if (btn) { btn.disabled = true; btn.textContent = 'Detecting…'; }
            extractStatus('⏳ Processing image…');
            // let the browser paint the status before the heavy synchronous work
            await new Promise(r => setTimeout(r, 50));
            try {
                const result = await dashboard.imageExtractor.extract(tolerance);
                pushEditUndo('extracted');
                setExtractedZones(result.featureCollection.features);
            } catch (err) {
                console.error('Zone extraction failed:', err);
                extractStatus(null);
                alert(err.message);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Detect Red Zones'; }
            }
        });

        dashboard.bindUI('clear-extracted-zones', 'click', () => {
            const editSel = dashboard.getEl('extract-edit-mode');
            if (editSel && editSel.value !== 'none') {
                editSel.value = 'none';
                editSel.dispatchEvent(new Event('change'));
            }
            if (dashboard.extractedZoneLayer) {
                pushEditUndo('extracted');
                dashboard.map.removeLayer(dashboard.extractedZoneLayer);
                dashboard.extractedZoneLayer = null;
            }
            dashboard.extractedMergedPolygon = null;
            dashboard.imageExtractor.pickedColor = null;
            extractStatus(null);
        });

        dashboard.bindUI('export-extracted-zones', 'click', () => {
            if (!dashboard.extractedZoneLayer) {
                alert('Extract zones first');
                return;
            }
            const gj = dashboard.extractedZoneLayer.toGeoJSON();
            const blob = new Blob([JSON.stringify(gj)], { type: 'application/geo+json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `extracted-zones-${new Date().toISOString().slice(0, 10)}.geojson`;
            a.click();
            URL.revokeObjectURL(a.href);
        });

        // Capture-phase DOM listener: clicks must reach us even when interactive
        // layers (DeepState polygons, extracted zones, markers) sit above the map.
        const pickColorHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const latlng = dashboard.map.mouseEventToLatLng(e);
            extractStatus('⏳ Sampling color…');
            try {
                const ok = await dashboard.imageExtractor.pickColorAt(latlng);
                if (ok) {
                    const c = dashboard.imageExtractor.pickedColor;
                    extractStatus(`Color picked: rgb(${c.r},${c.g},${c.b}) — run extraction`);
                } else {
                    extractStatus('That click was outside the image — try again');
                    return; // keep pick mode active
                }
            } catch (err) {
                extractStatus(err.message);
                return; // keep pick mode active so the user can retry
            }
            const cb = dashboard.getEl('extract-pick-color');
            if (cb) cb.checked = false;
            dashboard.map.getContainer().removeEventListener('click', pickColorHandler, true);
        };

        dashboard.bindUI('extract-pick-color', 'change', () => {
            if (dashboard.isChecked('extract-pick-color')) {
                extractStatus('Click the zone color on the image…');
                dashboard.map.getContainer().addEventListener('click', pickColorHandler, true);
            } else {
                dashboard.map.getContainer().removeEventListener('click', pickColorHandler, true);
                dashboard.imageExtractor.pickedColor = null;
                extractStatus(null);
            }
        });

        dashboard.bindUI('load-image-file', 'click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (!file) return;
                const url = URL.createObjectURL(file);
                const urlInput = dashboard.getEl('image-overlay-url');
                if (urlInput) urlInput.value = url;
                dashboard.loadImageOverlay();
            });
            input.click();
        });

        // ── Extracted-zone editing (brush adds, eraser removes) ─────────────
        dashboard.bindUI('erase-size', 'input', (e) => {
            dashboard.setText('erase-size-value', e.target.value);
        });

        let editPoints = null;
        let editStrokePreview = null;

        const editBrushPx = () => parseInt(dashboard.getEl('erase-size')?.value ?? '30', 10);
        const editMode = () => dashboard.getEl('extract-edit-mode')?.value ?? 'none';
        const editTarget = () => dashboard.getEl('extract-edit-target')?.value ?? 'extracted';

        const isPolygonal = (f) =>
            f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');

        /** Apply a brush/eraser stroke to a feature list; returns the edited list. */
        const editFeatures = (features, stroke, mode) => {
            const result = [];
            if (mode === 'eraser') {
                for (const f of features) {
                    if (!isPolygonal(f)) {
                        result.push(f);
                        continue;
                    }
                    try {
                        const diff = turf.difference(f, stroke);
                        if (diff && turf.area(diff) / 1e6 >= 0.5) {
                            diff.properties = f.properties;
                            result.push(diff);
                        }
                    } catch (e) {
                        result.push(f); // keep untouched on geometry errors
                    }
                }
            } else { // brush: merge the stroke with every zone it touches
                let merged = stroke;
                let mergedProps = null;
                for (const f of features) {
                    if (!isPolygonal(f)) {
                        result.push(f);
                        continue;
                    }
                    try {
                        if (turf.booleanDisjoint(f, merged)) {
                            result.push(f);
                        } else {
                            merged = turf.union(merged, f);
                            if (!mergedProps) mergedProps = f.properties;
                        }
                    } catch (e) {
                        result.push(f);
                    }
                }
                if (mergedProps) merged.properties = mergedProps;
                result.push(merged);
            }
            return result;
        };

        const applyEdit = (latlngs) => {
            const mode = editMode();
            // brush radius: pixels → km at current zoom/latitude
            const center = dashboard.map.getCenter();
            const mpp = 40075016.686 * Math.abs(Math.cos(center.lat * Math.PI / 180)) /
                (256 * Math.pow(2, dashboard.map.getZoom()));
            const radiusKm = (editBrushPx() * mpp) / 1000;

            let stroke;
            try {
                stroke = latlngs.length === 1
                    ? turf.circle([latlngs[0].lng, latlngs[0].lat], radiusKm, { units: 'kilometers' })
                    : turf.buffer(turf.lineString(latlngs.map(p => [p.lng, p.lat])), radiusKm, { units: 'kilometers' });
            } catch (e) {
                return;
            }

            if (editTarget() === 'custom') {
                if (!dashboard.customKmlData) return;
                pushEditUndo('custom');
                dashboard.customKmlData.features =
                    editFeatures(dashboard.customKmlData.features, stroke, mode);

                // Enable the overlay if hidden so the edit is visible
                const cb = dashboard.getEl('custom-kml-overlay');
                if (cb && !cb.checked) cb.checked = true;
                const merged = refreshCustomLayer();

                const km2 = merged ? Math.round(turf.area(merged) / 1e6) : 0;
                extractStatus(`Custom layer: ${dashboard.customKmlData.features.length} features, ${km2.toLocaleString()} km²`);
                return;
            }

            pushEditUndo('extracted');
            const features = dashboard.extractedZoneLayer
                ? dashboard.extractedZoneLayer.toGeoJSON().features
                : [];
            setExtractedZones(editFeatures(features, stroke, mode));
        };

        const editStart = (e) => {
            e.preventDefault();
            e.stopPropagation();
            editPoints = [dashboard.map.mouseEventToLatLng(e)];
            editStrokePreview = L.polyline(editPoints, {
                color: editMode() === 'brush' ? '#c62828' : '#333',
                weight: editBrushPx() * 2, opacity: 0.35,
                lineCap: 'round', lineJoin: 'round', interactive: false
            }).addTo(dashboard.map);
        };
        const editMoveHandler = (e) => {
            if (!editPoints) return;
            e.preventDefault();
            e.stopPropagation();
            editPoints.push(dashboard.map.mouseEventToLatLng(e));
            editStrokePreview.setLatLngs(editPoints);
        };
        const editEnd = (e) => {
            if (!editPoints) return;
            e.preventDefault();
            e.stopPropagation();
            const pts = editPoints;
            editPoints = null;
            if (editStrokePreview) {
                dashboard.map.removeLayer(editStrokePreview);
                editStrokePreview = null;
            }
            applyEdit(pts);
        };

        const disableZoneEditing = () => {
            const container = dashboard.map.getContainer();
            dashboard.map.dragging.enable();
            container.style.cursor = '';
            container.removeEventListener('mousedown', editStart, true);
            container.removeEventListener('mousemove', editMoveHandler, true);
            container.removeEventListener('mouseup', editEnd, true);
            // non-capture: mouseleave must only fire when leaving the map itself,
            // not when the cursor crosses overlay polygons/tooltips inside it
            container.removeEventListener('mouseleave', editEnd, false);
            editPoints = null;
            if (editStrokePreview) {
                dashboard.map.removeLayer(editStrokePreview);
                editStrokePreview = null;
            }
        };

        dashboard.bindUI('extract-edit-mode', 'change', () => {
            const mode = editMode();
            disableZoneEditing(); // idempotent reset before (re)arming
            if (mode === 'none') return;
            if (editTarget() === 'custom') {
                if (!dashboard.customKmlData) {
                    alert('Load a custom layer first');
                    const sel = dashboard.getEl('extract-edit-mode');
                    if (sel) sel.value = 'none';
                    return;
                }
            } else if (mode === 'eraser' && !dashboard.extractedZoneLayer) {
                alert('Extract zones first');
                const sel = dashboard.getEl('extract-edit-mode');
                if (sel) sel.value = 'none';
                return;
            }
            const container = dashboard.map.getContainer();
            dashboard.map.dragging.disable();
            container.style.cursor = 'crosshair';
            container.addEventListener('mousedown', editStart, true);
            container.addEventListener('mousemove', editMoveHandler, true);
            container.addEventListener('mouseup', editEnd, true);
            container.addEventListener('mouseleave', editEnd, false);
            extractStatus(mode === 'brush'
                ? 'Brush: drag to add area'
                : 'Erase: drag over areas to remove');
        });

        dashboard.bindUI('extract-edit-target', 'change', () => {
            const sel = dashboard.getEl('extract-edit-mode');
            if (sel && sel.value !== 'none') sel.dispatchEvent(new Event('change'));
        });

        // ── Drawing Tool ──────────────────────────────────────────────────────
        const drawTool = new DrawingTool(dashboard.map);
        dashboard.drawTool = drawTool;

        const drawHints = {
            freedraw: 'Click and drag to draw freely.',
            line: 'Click and drag to draw a line.',
            arrow: 'Click and drag to draw an arrow.',
            ellipse: 'Drag 1: set axis. Drag 2: stretch width.',
            rect: 'Drag 1: set axis. Drag 2: stretch width.',
            arc: 'Draw a curved path — the deepest point sets the arc.',
            text: 'Drag to set position and angle, then type. Enter to confirm.',
            eraser: 'Click or drag over shapes to erase them.',
        };

        const thicknessSlider = dashboard.getEl('draw-thickness');
        const thicknessLabel = dashboard.getEl('draw-thickness-value');
        const thicknessRow = thicknessSlider && thicknessSlider.closest('.draw-options');
        const thicknessTitle = thicknessRow && thicknessRow.querySelector('.small-label');

        const applyThicknessMode = (mode) => {
            if (!thicknessSlider) return;
            if (mode === 'text') {
                thicknessSlider.min = '8';
                thicknessSlider.max = '96';
                thicknessSlider.step = '2';
                if (thicknessTitle) thicknessTitle.childNodes[0].textContent = 'Size ';
            } else {
                thicknessSlider.min = '1';
                thicknessSlider.max = '20';
                thicknessSlider.step = '1';
                if (thicknessTitle) thicknessTitle.childNodes[0].textContent = 'Width ';
            }
            if (thicknessLabel) thicknessLabel.textContent = thicknessSlider.value;
            drawTool.setThickness(thicknessSlider.value);
        };

        const setDrawHint = (mode) => {
            const el = dashboard.getEl('draw-hint');
            if (el) el.textContent = drawHints[mode] || '';
        };

        dashboard.bindUI('draw-enable', 'change', () => {
            const controls = dashboard.getEl('draw-controls');
            if (dashboard.isChecked('draw-enable')) {
                controls.style.display = 'block';
                drawTool.enable();
                setDrawHint(drawTool.mode);
            } else {
                controls.style.display = 'none';
                drawTool.disable();
            }
        });

        document.querySelectorAll('.draw-tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const mode = btn.dataset.mode;
                drawTool.setMode(mode);
                applyThicknessMode(mode);
                setDrawHint(mode);
            });
        });

        // Color presets
        const colorInput = dashboard.getEl('draw-color');
        const setActivePreset = (color) => {
            document.querySelectorAll('.draw-preset').forEach(b => {
                b.classList.toggle('active', b.dataset.color === color);
            });
        };
        document.querySelectorAll('.draw-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                drawTool.setColor(color);
                if (colorInput) colorInput.value = color;
                setActivePreset(color);
            });
        });
        // Mark first preset active by default
        setActivePreset('#ff0000');

        dashboard.bindUI('draw-color', 'input', (e) => {
            drawTool.setColor(e.target.value);
            setActivePreset(e.target.value);
        });

        // Dashed line toggle
        const dashBtn = dashboard.getEl('draw-dash-btn');
        if (dashBtn) {
            dashBtn.addEventListener('click', () => {
                const on = !dashBtn.classList.contains('active');
                dashBtn.classList.toggle('active', on);
                drawTool.setDash(on);
            });
        }

        dashboard.bindUI('draw-thickness', 'input', (e) => {
            drawTool.setThickness(e.target.value);
            const label = dashboard.getEl('draw-thickness-value');
            if (label) label.textContent = e.target.value;
        });

        dashboard.bindUI('draw-undo', 'click', () => drawTool.undo());
        dashboard.bindUI('draw-clear', 'click', () => drawTool.clear());

        // MapUML bindings
        dashboard.bindUI('btn-render-mapuml', 'click', async () => {
            const el = dashboard.getEl('map-uml-input');
            const btn = dashboard.getEl('btn-render-mapuml');
            if (el && dashboard.mapUmlEngine) {
                const oldText = btn.textContent;
                btn.textContent = 'Rendering...';
                btn.disabled = true;
                try {
                    await dashboard.mapUmlEngine.renderScript(el.value);
                } catch(e) { 
                    console.error(e); 
                    alert('Error parsing or rendering MapUML. See console.'); 
                } finally {
                    btn.textContent = oldText;
                    btn.disabled = false;
                }
            }
        });
        
        dashboard.bindUI('map-uml-edit-mode', 'change', () => {
            const btn = dashboard.getEl('btn-render-mapuml');
            if (btn) btn.click();
        });

        dashboard.bindUI('map-uml-hide-markers', 'change', () => {
            const btn = dashboard.getEl('btn-render-mapuml');
            if (btn) btn.click();
        });

        dashboard.bindUI('btn-clear-mapuml', 'click', () => {
            if (dashboard.mapUmlEngine) {
                dashboard.mapUmlEngine.clear();
            }
        });

        dashboard.bindUI('btn-help-mapuml', 'click', () => {
            const modal = document.getElementById('map-uml-help-modal');
            if (modal) modal.style.display = 'flex';
        });

        dashboard.bindUI('btn-close-mapuml-help', 'click', () => {
            const modal = document.getElementById('map-uml-help-modal');
            if (modal) modal.style.display = 'none';
        });

        document.getElementById('map-uml-help-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
        });

        // Terrain Analysis
        if (dashboard.terrainAnalysis) {
            const ta = dashboard.terrainAnalysis;

            dashboard.bindUI('forest-overlay', 'change', () => {
                const on = dashboard.isChecked('forest-overlay');
                ta.toggleForestLayer(on);
                if (window._map3DView) window._map3DView.updateForest3D(on);
            });

            dashboard.bindUI('los-p2p-mode', 'change', () => {
                if (dashboard.isChecked('los-p2p-mode')) {
                    const vsEl = dashboard.getEl('los-viewshed-mode');
                    if (vsEl) vsEl.checked = false;
                    ta.enableMode('p2p');
                } else {
                    ta.disableMode();
                }
            });

            dashboard.bindUI('los-viewshed-mode', 'change', () => {
                if (dashboard.isChecked('los-viewshed-mode')) {
                    const p2pEl = dashboard.getEl('los-p2p-mode');
                    if (p2pEl) p2pEl.checked = false;
                    ta.enableMode('viewshed');
                } else {
                    ta.disableMode();
                }
            });

            dashboard.bindUI('los-clear', 'click', () => {
                ta.clearLos();
                const hint = dashboard.getEl('los-hint');
                if (hint) hint.textContent = '';
            });
        }

        // ---- Air Defense Range ----
        {
            const adLayer = L.layerGroup().addTo(dashboard.map);
            let adWeapons = [];
            let adSelected = null;
            let adPlacedCount = 0;
            let adClickHandler = null;

            const adHint = () => dashboard.getEl('air-defense-hint');
            const adRoundGroup = () => dashboard.getEl('air-defense-round-group');
            const adRoundSelect = () => dashboard.getEl('air-defense-round');
            const adGrid = () => dashboard.getEl('air-defense-grid');
            const isMultiple = () => dashboard.isChecked('air-defense-multiple');

            const setHint = (msg) => {
                const el = adHint();
                if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
            };

            const detachMapClick = () => {
                if (adClickHandler) {
                    dashboard.map.off('click', adClickHandler);
                    adClickHandler = null;
                }
                dashboard.map.getContainer().style.cursor = '';
            };

            const attachMapClick = () => {
                detachMapClick();
                adClickHandler = (e) => {
                    if (!adSelected) return;
                    const roundEl = adRoundSelect();
                    const roundId = roundEl ? roundEl.value : null;
                    const round = adSelected.rounds.find(r => r.id === roundId) || adSelected.rounds[0];
                    if (!round) return;

                    const maxAllowed = isMultiple() ? 100 : 1;
                    if (adPlacedCount >= maxAllowed) {
                        if (!isMultiple()) {
                            adLayer.clearLayers();
                            adPlacedCount = 0;
                        } else {
                            setHint(`Max ${maxAllowed} placements reached`);
                            return;
                        }
                    }

                    const radiusM = round.range.max;
                    const circle = L.circle(e.latlng, {
                        radius: radiusM,
                        color: '#4fc3f7',
                        fillColor: '#4fc3f7',
                        fillOpacity: 0.08,
                        weight: 1.5,
                        dashArray: '6 4'
                    });
                    const label = adSelected.meta.title.en + (adSelected.rounds.length > 1 ? ` / ${round.name}` : '');
                    circle.bindTooltip(`${label}<br>${(radiusM / 1000).toFixed(0)} km`, { sticky: false });
                    circle.addTo(adLayer);
                    adPlacedCount++;

                    if (!isMultiple()) {
                        detachMapClick();
                        setHint(`${label}: ${(radiusM / 1000).toFixed(0)} km range`);
                    } else {
                        setHint(`Placed ${adPlacedCount}/100 — click to add more`);
                    }
                };
                dashboard.map.on('click', adClickHandler);
                dashboard.map.getContainer().style.cursor = 'crosshair';
            };

            const selectWeapon = (weapon) => {
                adSelected = weapon;

                document.querySelectorAll('.air-defense-item').forEach(el => {
                    el.classList.toggle('selected', el.dataset.id === weapon.id);
                });

                const roundGroup = adRoundGroup();
                const roundSel = adRoundSelect();
                if (weapon.rounds.length > 1) {
                    roundSel.innerHTML = weapon.rounds.map(r =>
                        `<option value="${r.id}">${r.name} — ${(r.range.max / 1000).toFixed(0)} km</option>`
                    ).join('');
                    roundGroup.style.display = '';
                } else {
                    roundGroup.style.display = 'none';
                }

                if (!isMultiple()) {
                    adLayer.clearLayers();
                    adPlacedCount = 0;
                }
                attachMapClick();
                setHint('Click on map to place range circle');
            };

            const buildGrid = (weapons) => {
                const grid = adGrid();
                if (!grid) return;
                grid.innerHTML = '';
                weapons.forEach(w => {
                    const item = document.createElement('div');
                    item.className = 'air-defense-item';
                    item.dataset.id = w.id;
                    item.title = `${w.meta.title.en}\nMax: ${(Math.max(...w.rounds.map(r => r.range.max)) / 1000).toFixed(0)} km`;

                    const imgUrl = `https://deepstatemap.live/images/arty/${w.image}`;
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.alt = w.meta.title.en;
                    img.onerror = () => {
                        const ph = document.createElement('div');
                        ph.className = 'ad-icon-placeholder';
                        ph.textContent = '🛡';
                        img.replaceWith(ph);
                    };

                    const label = document.createElement('span');
                    label.textContent = w.meta.title.en;

                    item.appendChild(img);
                    item.appendChild(label);
                    item.addEventListener('click', () => selectWeapon(w));
                    grid.appendChild(item);
                });
            };

            // ---- Event ranges overlay ----
            const adEventLayer = L.layerGroup().addTo(dashboard.map);

            // Order matters: more-specific patterns before less-specific ones
            const AD_EVENT_MATCH = [
                { keywords: ['s-300v4', 's300v4'],          weaponId: 'S-300V4' },
                { keywords: ['s-300vm', 's300vm'],          weaponId: 'S-300V' },
                { keywords: ['s-300v', 's300v'],            weaponId: 'S-300V' },
                { keywords: ['s-400', 's400'],              weaponId: 'S-400' },
                { keywords: ['s-300', 's300'],              weaponId: 'S-300' },
                { keywords: ['buk-m3', 'buk m3'],          weaponId: 'Buk-M3' },
                { keywords: ['buk-m2', 'buk m2', '9a316'], weaponId: 'Buk-M2' },
                { keywords: ['buk-m1', 'buk m1'],          weaponId: 'Buk-M1' },
                { keywords: ['tor-m2u', 'tor m2u'],        weaponId: 'Tor-M2' },
                { keywords: ['tor-m2', 'tor m2'],          weaponId: 'Tor-M2' },
                { keywords: ['tor-m1', 'tor m1'],          weaponId: 'Tor-M1' },
                { keywords: ['pantsir'],                   weaponId: 'Pantsir-S1' },
                { keywords: ['zu-23-2', 'zu-23', 'zu 23'], weaponId: 'ZU-23-2' },
                { keywords: ['tunguska'],                  weaponId: '2K22 Tunguska' },
                { keywords: ['strela-10', 'strela 10'],    weaponId: 'Strela-10' },
            ];

            const resolveEventWeapon = (name) => {
                const lower = name.toLowerCase();
                for (const entry of AD_EVENT_MATCH) {
                    if (entry.keywords.some(k => lower.includes(k))) {
                        return adWeapons.find(w => w.id === entry.weaponId) || null;
                    }
                }
                return null;
            };

            const renderAdEventRanges = () => {
                adEventLayer.clearLayers();
                if (!dashboard.isChecked('air-defense-event-ranges')) return;
                if (!dashboard.eventsData || !dashboard.eventsData.length) return;

                dashboard.eventsData.forEach(e => {
                    if (!dashboard.eventsFilterEnabled[e.category]) return;
                    const weapon = resolveEventWeapon(e.name);
                    if (!weapon) return;
                    const round = weapon.rounds[0];
                    const radiusM = round.range.max;
                    L.circle([e.lat, e.lon], {
                        radius: radiusM,
                        color: '#ff7043',
                        fillColor: '#ff7043',
                        fillOpacity: 0.05,
                        weight: 1,
                        dashArray: '4 3',
                        interactive: false
                    })
                    .bindTooltip(`${e.name}<br>${weapon.meta.title.en}: ${(radiusM / 1000).toFixed(0)} km`, { sticky: false })
                    .addTo(adEventLayer);
                });
            };

            // Patch renderEventsMarkers so event range circles stay in sync
            const _origRenderEvents = dashboard.renderEventsMarkers.bind(dashboard);
            dashboard.renderEventsMarkers = function () {
                _origRenderEvents();
                renderAdEventRanges();
            };

            dashboard.bindUI('air-defense-event-ranges', 'change', renderAdEventRanges);

            fetch('./data/arty.json')
                .then(r => r.json())
                .then(data => {
                    adWeapons = data;
                    buildGrid(data);
                })
                .catch(err => console.warn('Failed to load arty.json', err));

            dashboard.bindUI('air-defense-multiple', 'change', () => {
                if (!isMultiple() && adPlacedCount > 1) {
                    adLayer.clearLayers();
                    adPlacedCount = 0;
                    setHint('Single mode — click map to place');
                }
            });

            dashboard.bindUI('air-defense-round', 'change', () => {
                if (!isMultiple()) {
                    adLayer.clearLayers();
                    adPlacedCount = 0;
                    attachMapClick();
                    setHint('Click on map to place range circle');
                }
            });

            dashboard.bindUI('air-defense-clear', 'click', () => {
                adLayer.clearLayers();
                adPlacedCount = 0;
                detachMapClick();
                if (adSelected) {
                    attachMapClick();
                    setHint('Click on map to place range circle');
                } else {
                    setHint('');
                }
            });

            // ---- Full AD (known positions from KML survey) ----
            const fullAdMarkerLayer = L.layerGroup().addTo(dashboard.map);
            const fullAdRangeLayer = L.layerGroup().addTo(dashboard.map);
            let fullAdData = [];

            const FULL_AD_COLORS = {
                'Pantsir': '#ff9800',
                'S-300/400': '#e53935',
                'Radio Technical positions': '#ffd54f',
                'Shahed launch sites': '#ab47bc',
                'Alabuga towers A (tent)': '#9e9e9e',
                'Alabuga towers B (cabins)': '#9e9e9e',
                'others': '#bdbdbd'
            };

            // Radar detection radius (not an intercept range) — approximate, since most
            // placemarks are just labeled "RT" with no specific radar model.
            const radar = (title, radiusM) => ({ meta: { title: { en: title } }, rounds: [{ range: { max: radiusM } }] });

            // Only categories with a known range/detection envelope get a range circle.
            const resolveFullAdWeapon = (folder, name) => {
                const lower = (name || '').toLowerCase();
                if (folder === 'Pantsir') {
                    const pantsir = adWeapons.find(w => w.id === 'Pantsir-S1');
                    if (!pantsir) return null;
                    const roundId = dashboard.getEl('full-ad-pantsir-round')?.value || '57E6 missile';
                    const round = pantsir.rounds.find(r => r.id === roundId) || pantsir.rounds[0];
                    return { meta: pantsir.meta, rounds: [round] };
                }
                if (folder === 'S-300/400') {
                    let weaponId = 'S-400'; // ambiguous/blank name in this folder — assume the longer-ranged S-400
                    if (lower.includes('400')) weaponId = 'S-400';
                    else if (lower.includes('300')) weaponId = 'S-300';
                    const weapon = adWeapons.find(w => w.id === weaponId);
                    if (!weapon) return null;

                    const mode = dashboard.getEl('full-ad-s300-mode')?.value || 'short';
                    // "short" = the smaller, more maneuverable missile plausible for engaging
                    // drones/cruise missiles; "long" = the big aircraft/ballistic interceptor.
                    const shortRoundId = weaponId === 'S-400' ? '9M96E2' : '5В55Р';
                    const round = mode === 'short'
                        ? (weapon.rounds.find(r => r.id === shortRoundId) || weapon.rounds[0])
                        : weapon.rounds.reduce((a, b) => (b.range.max > a.range.max ? b : a));
                    return { meta: weapon.meta, rounds: [round] };
                }
                if (folder === 'Radio Technical positions') {
                    const mode = dashboard.getEl('full-ad-rt-mode')?.value || 'drone';
                    // "aircraft" = rated/advertised detection range against large, high-altitude
                    // targets; "drone" = a much shorter realistic range against small, low-flying
                    // low-RCS targets, limited by radar horizon and return signal strength.
                    const RT_PROFILES = {
                        nebo:    { label: 'Nebo radar',     aircraft: 400000, drone: 150000 },
                        kasta:   { label: 'Kasta-2E2 radar', aircraft: 180000, drone: 60000 },
                        podlet:  { label: 'Podlet radar',   aircraft: 200000, drone: 120000 },
                        generic: { label: 'RT radar',       aircraft: 250000, drone: 80000 }
                    };
                    let key = 'generic';
                    if (lower.includes('nebo')) key = 'nebo';
                    else if (lower.includes('kasta')) key = 'kasta';
                    else if (lower.includes('68u') || lower.includes('podlet')) key = 'podlet';
                    const p = RT_PROFILES[key];
                    return radar(`${p.label} (${mode === 'drone' ? 'vs drone' : 'vs aircraft'}, approx.)`, p[mode]);
                }
                return null;
            };

            // Which folders/categories are currently enabled in the type filter. Populated
            // (all-on) once a KML is loaded; absence of a key is treated as enabled.
            let fullAdCategoryEnabled = {};
            const isFullAdCategoryOn = (folder) => fullAdCategoryEnabled[folder] !== false;

            // Matches "ex RT", "(ex) S-400", "(ex?) RT", "ex-P", etc. — placemarks marked
            // as a former/no-longer-active position.
            const isExPosition = (name) => /^\(?ex\b/i.test((name || '').trim());
            const passesFullAdFilters = (p) => {
                if (!isFullAdCategoryOn(p.f)) return false;
                if (dashboard.isChecked('full-ad-hide-ex') && isExPosition(p.n)) return false;
                return true;
            };

            const buildFullAdCategoryFilter = () => {
                const container = dashboard.getEl('full-ad-categories');
                if (!container) return;
                container.innerHTML = '';
                const folders = [...new Set(fullAdData.map(p => p.f))].sort();
                folders.forEach(folder => {
                    if (!(folder in fullAdCategoryEnabled)) fullAdCategoryEnabled[folder] = true;
                    const count = fullAdData.filter(p => p.f === folder).length;
                    const color = FULL_AD_COLORS[folder] || '#bdbdbd';

                    const row = document.createElement('label');
                    row.className = 'full-ad-category-row';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = fullAdCategoryEnabled[folder];
                    checkbox.addEventListener('change', () => {
                        fullAdCategoryEnabled[folder] = checkbox.checked;
                        renderFullAdPositions();
                        renderFullAdRanges();
                    });

                    const swatch = document.createElement('span');
                    swatch.className = 'full-ad-category-swatch';
                    swatch.style.background = color;

                    row.appendChild(checkbox);
                    row.appendChild(swatch);
                    row.appendChild(document.createTextNode(`${folder} (${count})`));
                    container.appendChild(row);
                });
            };

            const renderFullAdPositions = () => {
                fullAdMarkerLayer.clearLayers();
                if (!dashboard.isChecked('full-ad-positions')) return;
                fullAdData.filter(passesFullAdFilters).forEach(p => {
                    const color = FULL_AD_COLORS[p.f] || '#bdbdbd';
                    L.circleMarker([p.lat, p.lon], {
                        radius: 4,
                        color,
                        fillColor: color,
                        fillOpacity: 0.8,
                        weight: 1
                    })
                    .bindTooltip(`${p.n || p.f}<br>${p.f}`, { sticky: false })
                    .addTo(fullAdMarkerLayer);
                });
            };

            const renderFullAdRanges = () => {
                fullAdRangeLayer.clearLayers();
                if (!dashboard.isChecked('full-ad-ranges')) return;
                fullAdData.filter(passesFullAdFilters).forEach(p => {
                    const weapon = resolveFullAdWeapon(p.f, p.n);
                    if (!weapon) return;
                    const radiusM = Math.max(...weapon.rounds.map(r => r.range.max));
                    const color = FULL_AD_COLORS[p.f] || '#bdbdbd';
                    L.circle([p.lat, p.lon], {
                        radius: radiusM,
                        color,
                        fillColor: color,
                        fillOpacity: 0.03,
                        weight: 1,
                        dashArray: '4 3',
                        interactive: false
                    })
                    .bindTooltip(`${p.n || p.f}<br>${weapon.meta.title.en}: ${(radiusM / 1000).toFixed(0)} km`, { sticky: false })
                    .addTo(fullAdRangeLayer);
                });
            };

            // Parses a KML into {n: name, f: folder, lat, lon} points. Runs entirely
            // client-side — the file is never uploaded or written to disk, since this
            // is expected to be a private/local dataset (e.g. a survey of real positions).
            const directChild = (el, tag) => Array.from(el.children).find(c => c.tagName === tag);

            const parseFullAdKml = (text) => {
                const doc = new DOMParser().parseFromString(text, 'text/xml');
                if (doc.querySelector('parsererror')) return [];
                const out = [];
                const walk = (el, folder) => {
                    Array.from(el.children).forEach(child => {
                        const tag = child.tagName;
                        if (tag === 'Folder') {
                            const nm = directChild(child, 'name')?.textContent?.trim() || folder;
                            walk(child, nm);
                        } else if (tag === 'Placemark') {
                            if (!folder) return; // skip ungrouped/legend placemarks outside any folder
                            const pointEl = child.getElementsByTagName('Point')[0];
                            const coordsEl = pointEl && pointEl.getElementsByTagName('coordinates')[0];
                            if (!coordsEl || !coordsEl.textContent) return;
                            const [lonStr, latStr] = coordsEl.textContent.trim().split(',');
                            const lon = parseFloat(lonStr), lat = parseFloat(latStr);
                            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
                            const nm = directChild(child, 'name')?.textContent?.trim() || '';
                            out.push({ n: nm, f: folder, lat, lon });
                        } else if (tag === 'Document' || tag === 'kml') {
                            walk(child, folder);
                        }
                    });
                };
                walk(doc.documentElement, '');
                return out;
            };

            const fullAdHint = () => dashboard.getEl('full-ad-hint');

            dashboard.bindUI('full-ad-load-file', 'click', () => {
                dashboard.getEl('full-ad-file')?.click();
            });

            dashboard.bindUI('full-ad-file', 'change', (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                file.text().then(text => {
                    fullAdData = parseFullAdKml(text);
                    fullAdCategoryEnabled = {};
                    buildFullAdCategoryFilter();
                    renderFullAdPositions();
                    renderFullAdRanges();
                    const hint = fullAdHint();
                    if (hint) hint.textContent = `Loaded ${fullAdData.length} positions from ${file.name}`;
                }).catch(err => {
                    console.warn('Failed to parse Full AD KML', err);
                    const hint = fullAdHint();
                    if (hint) hint.textContent = 'Failed to parse KML file';
                });
                e.target.value = '';
            });

            dashboard.bindUI('full-ad-positions', 'change', renderFullAdPositions);
            dashboard.bindUI('full-ad-ranges', 'change', renderFullAdRanges);
            dashboard.bindUI('full-ad-pantsir-round', 'change', renderFullAdRanges);
            dashboard.bindUI('full-ad-s300-mode', 'change', renderFullAdRanges);
            dashboard.bindUI('full-ad-rt-mode', 'change', renderFullAdRanges);
            dashboard.bindUI('full-ad-hide-ex', 'change', () => {
                renderFullAdPositions();
                renderFullAdRanges();
            });
        }
    }
}

window.UiBindings = UiBindings;

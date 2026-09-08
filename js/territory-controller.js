/** Each feature owns its message; one successful update cannot erase another error. */
class TerritoryStatus {
    static messages = new WeakMap();

    static set(dashboard, source, message) {
        let messages = this.messages.get(dashboard);
        if (!messages) { messages = new Map(); this.messages.set(dashboard, messages); }
        if (message) messages.set(source, message);
        else messages.delete(source);
        dashboard.setText('territory-status', [...messages.values()].join('\n'));
    }
}

/** Territory rendering and regional statistics, separate from DOM event registration. */
class TerritoryController {
    constructor(dashboard) { this.dashboard = dashboard; }

    init() {
        const dashboard = this.dashboard;
        const updateDiffStats = (startDatePolygons, endDatePolygons, hasSlices = false) => {
            const totalGains = Object.values(endDatePolygons.statistics).reduce((acc, curr) => acc + curr, 0) -
                Object.values(startDatePolygons.statistics).reduce((acc, curr) => acc + curr, 0);
            const totalGrey = (endDatePolygons.statistics['#bcaaa4'] || 0) - (startDatePolygons.statistics['#bcaaa4'] || 0);
            const totalCaptured = (endDatePolygons.statistics['#a52714'] || 0) - (startDatePolygons.statistics['#a52714'] || 0);

            dashboard.setText('total-gains', Math.round(totalGains));
            dashboard.setText('total-captured', Math.round(totalCaptured));
            dashboard.setText('total-grayed', Math.round(totalGrey));
            dashboard.calculateSettlementsInDiffArea(startDatePolygons, endDatePolygons);
            if (!hasSlices) {
                const sliceStatsEl = dashboard.getEl('slice-territory-stats');
                if (sliceStatsEl) sliceStatsEl.innerHTML = '';
                dashboard.charts?.onTerritoryStats(null);
            }
        };

        const borderCache = new AsyncLruCache(3);
        const getPolygons = date => TerritoryData.polygons(date, DeepUtils.shadowOptions());
        const getBorder = (code = 'ua') => borderCache.get(code, () => new DeepUtils(null).loadTheBorder(code));

        const safeUnion = (left, right) => {
            if (!left) return right;
            try {
                return turf.union(left, right);
            } catch (error) {
                try {
                    return turf.union(turf.cleanCoords(left), turf.cleanCoords(right));
                } catch (cleanError) {
                    throw new Error(`Unable to merge territory: ${cleanError.message}`, { cause: cleanError });
                }
            }
        };

        const TACTICAL_REGIONS = AttackMapDashboard.TACTICAL_REGIONS;

        const RU_DIRECTIONS = ['Север', 'Запад', 'Восток', 'Центр', 'Юг', 'Днепр'];

        /** Clip gains/losses geometry against a named region set. */
        const regionDiffRows = (gainsGeom, lossesGeom, regionNames) => {
            const clippedKm2 = (regionPolygon, geom) => {
                if (!geom) return 0;
                try {
                    const clipped = turf.intersect(regionPolygon, geom);
                    return clipped ? turf.area(clipped) / 1e6 : 0;
                } catch (e) {
                    throw new Error(`Unable to measure region: ${e.message}`, { cause: e });
                }
            };

            const rows = [];
            regionNames.forEach(name => {
                const regionPolygon = dashboard.regionPolygonCache.get(name);
                if (!regionPolygon) return;

                const gains = clippedKm2(regionPolygon, gainsGeom);
                const losses = clippedKm2(regionPolygon, lossesGeom);
                if (gains < 0.01 && losses < 0.01) return;

                rows.push({
                    name, gains, losses,
                    net: gains - losses,
                    coordinates: dashboard.regionCoordinates[name]
                });
            });
            return rows;
        };

        const logRegionDiffRows = (header, rows) => {
            console.log(header);
            if (!rows.length) {
                console.log('  (no overlap with predefined regions)');
                return;
            }
            rows.forEach(({ name, gains, losses, net }) => {
                console.log(`  ${name}: ${net >= 0 ? '+' : ''}${net.toFixed(1)} km² (↑${gains.toFixed(1)} ↓${losses.toFixed(1)})`);
            });
        };

        const drawRegionDiffLabels = (rows) => {
            if (!dashboard.diffRegionLabels) dashboard.diffRegionLabels = L.layerGroup().addTo(dashboard.map);
            // Concurrent renders can interleave past the clear at the top of
            // renderDeepLayer, so clear again here where the writes happen.
            dashboard.diffRegionLabels.clearLayers();
            rows.forEach(({ net, coordinates }) => {
                if (!coordinates) return;
                const text = `${net >= 0 ? '+' : ''}${net.toFixed(1)}`;
                const w = Math.max(40, text.length * 10 + 16);
                const h = 26;
                const icon = L.divIcon({
                    className: `attack-label border-${net >= 0 ? 'red' : 'green'}`,
                    html: `<div style="font-size:14px; line-height:1;">${text}</div>`,
                    iconSize: [w, h],
                    iconAnchor: [w / 2, h / 2]
                });
                L.marker(coordinates, { icon }).addTo(dashboard.diffRegionLabels);
            });
        };

        const reportDiffByPredefinedRegions = (polygons) => {
            let gains = null, losses = null;
            polygons.forEach(p => {
                if (!p.geojson) return;
                if (p.type === 'difference') gains = safeUnion(gains, p.geojson);
                else if (p.type === 'reverse-difference') losses = safeUnion(losses, p.geojson);
            });

            const rows = regionDiffRows(gains, losses, TACTICAL_REGIONS);
            logRegionDiffRows(
                `Diff by predefined region ${dashboard.formatDate(dashboard.startDate)} → ${dashboard.formatDate(dashboard.endDate)}:`,
                rows
            );
            drawRegionDiffLabels(rows);
        };

        const runRegionTask = task => {
            try { task(); }
            catch (error) {
                console.warn('Region breakdown unavailable:', error);
                dashboard.diffRegionLabels?.clearLayers();
                TerritoryStatus.set(dashboard, 'regions', `Region breakdown unavailable: ${error.message}`);
            }
        };

        const renderPrepared = (getPolygons, getBorder) => {
            TerritoryStatus.set(dashboard, 'regions', '');
            if (!dashboard.diffRegionLabels) dashboard.diffRegionLabels = L.layerGroup().addTo(dashboard.map);
            dashboard.diffRegionLabels.clearLayers();
            if (!dashboard.isChecked('diff-area')) {
                dashboard.deepLayer.clearLayers();
                dashboard.setText('settlements-in-diff', '0');
                if (dashboard.casualtiesLayer) dashboard.casualtiesLayer.clearLayers();
                dashboard.charts?.onTerritoryStats(null);
                if (dashboard.selectedPolygons.length > 0) dashboard.calculateSelectedAreaStatistics();
                return;
            }

            const deepMap = new DeepUtils(dashboard.deepLayer);
            const endDatePolygons = getPolygons(dashboard.endDate);

            if (dashboard.isChecked('shadow-ua')) {
                const uaborder = getBorder('ua');
                const ruborder = getBorder('ru');
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
                const startDatePolygons = getPolygons(dashboard.startDate);

                const noGray = (data) => dashboard.isChecked('diff-no-base')
                    ? { ...data, polygons: data.polygons.filter(p => p.properties?.fill !== '#bcaaa4') }
                    : data;

                const sliceDates = dashboard.getDiffSliceDates();
                if (sliceDates.length) {
                    const sliceColors = ['#ff5252', '#ff9800', '#ffeb3b', '#8bc34a', '#03a9f4', '#9c27b0'];
                    const allDates = [dashboard.startDate, ...sliceDates, dashboard.endDate];
                    const diffPolygons = [];

                    const baseResult = deepMap.calculatePolygonDifference(noGray(startDatePolygons), noGray(endDatePolygons));
                    baseResult.polygons
                        .filter(polygon => polygon.type === 'merged-start')
                        .forEach(polygon => diffPolygons.push(polygon));

                    const sliceTerritoryStats = [];
                    for (let i = 0; i < allDates.length - 1; i++) {
                        const sliceStart = getPolygons(allDates[i]);
                        const sliceEnd = getPolygons(allDates[i + 1]);
                        const sliceDiff = deepMap.calculatePolygonDifference(noGray(sliceStart), noGray(sliceEnd));
                        const color = sliceColors[i % sliceColors.length];
                        let sliceGains = 0, sliceLosses = 0;
                        // Kept so the charts ledger can re-clip a slice against a selected
                        // polygon without re-running the diff. Captured before the
                        // small-fragment filter below, which builds new objects and leaves
                        // these untouched, so clipped and whole-front totals share geometry.
                        const sliceGainGeoms = [], sliceLossGeoms = [];

                        sliceDiff.polygons
                            .filter(polygon => polygon.type === 'difference')
                            .forEach(polygon => {
                                polygon.style = { ...polygon.style, color, fillColor: color };
                                polygon.sliceIndex = i;
                                polygon.showArea = true;
                                polygon.sliceLabel = `${dashboard.formatDate(allDates[i])} → ${dashboard.formatDate(allDates[i + 1])} captured`;
                                diffPolygons.push(polygon);
                                if (polygon.geojson) sliceGainGeoms.push(polygon.geojson);
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
                                if (polygon.geojson) sliceLossGeoms.push(polygon.geojson);
                                try { sliceLosses += turf.area(polygon.geojson) / 1e6; } catch (e) { }
                            });

                        sliceTerritoryStats.push({
                            from: dashboard.formatDate(allDates[i]),
                            to: dashboard.formatDate(allDates[i + 1]),
                            color, gains: sliceGains, losses: sliceLosses, net: sliceGains - sliceLosses,
                            gainGeoms: sliceGainGeoms, lossGeoms: sliceLossGeoms
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

                    dashboard.charts?.onTerritoryStats(sliceTerritoryStats);
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

                    if (dashboard.isChecked('regions-highlight')) runRegionTask(() => {
                        const combinedDifference = TerritoryAnalysis.union(diffPolygons.filter(p => p.type === 'difference').map(p => p.geojson));
                        if (!combinedDifference) return;
                        const dirs = [];
                        Object.entries(dashboard.directionBorders).forEach(([key, value]) => {
                            const res = turf.intersect(value, combinedDifference);
                            if (!res) return;
                            L.geoJSON(res, {
                                style: { color: dashboard.getDirectionColor(key), weight: 2, fillOpacity: 0.7 }
                            }).addTo(dashboard.featureLayer).bindTooltip(key);
                            dirs.push({
                                region: key, totalAttacks: turf.area(res) / 1e6
                            });
                        });
                        dashboard.updateStatistics(dashboard.calculateAttackStatistics(dirs));
                    });

                } else {
                    const diffResult = deepMap.calculatePolygonDifference(noGray(startDatePolygons), noGray(endDatePolygons));
                    dashboard.currentDiffResult = diffResult;

                    const optimizedDiffResult = dashboard.isChecked('optimize-polygons') ?
                        dashboard.optimizePolygonsByColor(diffResult) : diffResult;
                    deepMap.renderMap(optimizedDiffResult);

                    if (dashboard.isChecked('regions-highlight')) runRegionTask(() => {
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
                                const area = turf.area(res) / 1e6;
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
                                const area = turf.area(res) / 1e6;
                                const existingDir = dirs.find(d => d.region === key);
                                if (existingDir) existingDir.losses = area;
                                else dirs.push({ region: key, totalAttacks: 0, gains: 0, losses: area });
                            });
                        }

                        if (dirs.length > 0) {
                            dashboard.updateStatistics(dashboard.calculateAttackStatistics(dirs));
                        }
                    });
                }

                updateDiffStats(startDatePolygons, endDatePolygons, sliceDates.length > 0);

                if (dashboard.isChecked('search-in-regions') && dashboard.currentDiffResult) {
                    runRegionTask(() => reportDiffByPredefinedRegions(dashboard.currentDiffResult.polygons));
                }

            } else {
                // Base case: render only endDate polygons
                dashboard.currentDiffResult = null;
                dashboard.currentDeepResult = endDatePolygons;
                const sliceStatsEl = dashboard.getEl('slice-territory-stats');
                if (sliceStatsEl) sliceStatsEl.innerHTML = '';
                dashboard.charts?.onTerritoryStats(null);
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

        let generation = 0;
        const renderDeepLayer = async () => {
            const request = ++generation;
            if (!dashboard.isChecked('diff-area')) {
                renderPrepared();
                TerritoryStatus.set(dashboard, 'deep', '');
                return;
            }
            TerritoryStatus.set(dashboard, 'deep', 'Loading territory…');
            const stateKey = () => JSON.stringify([dashboard.startDate, dashboard.endDate, dashboard.getDiffSliceDates(),
                ...['diff-area', 'diff-highlight', 'diff-no-base', 'shadow-ua',
                    'optimize-polygons', 'regions-highlight', 'search-in-regions'].map(id => dashboard.isChecked(id)),
                ...['shadow-ua-size', 'shadow-depth-occupied', 'shadow-depth-opposite', 'clusterRadius'].map(id => dashboard.getEl(id)?.value),
                dashboard.isChecked('shadow-line'), dashboard.isChecked('shadow-gradient')]);
            const state = stateKey();
            const isCurrent = () => request === generation && state === stateKey();
            try {
                const options = DeepUtils.shadowOptions();
                const dates = [dashboard.endDate];
                if (dashboard.isChecked('diff-highlight')) dates.push(dashboard.startDate, ...dashboard.getDiffSliceDates());
                const uniqueDates = [...new Map(dates.map(date => [TerritoryData.dateKey(date), new Date(date)])).values()];
                const polygons = new Map();
                const borders = new Map();
                await Promise.all([
                    ...uniqueDates.map(async date => polygons.set(TerritoryData.dateKey(date), await TerritoryData.polygons(date, options))),
                    ...(dashboard.isChecked('shadow-ua') ? ['ua', 'ru'].map(async code => borders.set(code, await getBorder(code))) : [])
                ]);
                if (!isCurrent()) return;
                // All input is ready: the commit contains no awaits, so another request cannot interleave writes.
                renderPrepared(date => polygons.get(TerritoryData.dateKey(date)), code => borders.get(code));
                TerritoryStatus.set(dashboard, 'deep', '');
            } catch (error) {
                if (!isCurrent()) return;
                console.error('Territory update failed:', error);
                TerritoryStatus.set(dashboard, 'deep', `Territory unavailable. Previous map retained. ${error.message}`);
                ['total-gains', 'total-captured', 'total-grayed', 'settlements-in-diff'].forEach(id => dashboard.setText(id, '—'));
                dashboard.charts?.onTerritoryStats(null);
            }
        };
        dashboard.renderDeepLayer = renderDeepLayer;
        return { getPolygons, safeUnion, regionDiffRows, logRegionDiffRows, drawRegionDiffLabels, RU_DIRECTIONS, renderDeepLayer };

    }
}

/** Aggregate successful sources without describing a partial sum as a complete total. */
function createOverlayDiffUpdater(dashboard, sources, regions) {
    let generation = 0;
    return async () => {
        const request = ++generation;
        const stateKey = () => JSON.stringify([dashboard.startDate, dashboard.endDate,
            dashboard.isChecked('diff-highlight'), dashboard.isChecked('search-in-regions'),
            ...sources.map(source => dashboard.isChecked(source.id))]);
        const state = stateKey();
        const isCurrent = () => request === generation && state === stateKey();
        const enabled = sources.filter(source => dashboard.isChecked(source.id));
        if (!dashboard.isChecked('diff-highlight') || !enabled.length) {
            TerritoryStatus.set(dashboard, 'overlays', '');
            return;
        }
        const start = new Date(dashboard.startDate), end = new Date(dashboard.endDate);
        const results = await Promise.allSettled(enabled.map(source => source.key
            ? dashboard.layers.getManifestDiffAreaKm2(source.key, start, end)
            : dashboard.layers.getRiaDiffAreaKm2(start, end)));
        if (!isCurrent()) return;
        let gains = 0, losses = 0, labelRows = null;
        const loaded = [], unavailable = [], regionErrors = [];
        results.forEach((result, i) => {
            const source = enabled[i];
            if (result.status === 'rejected') {
                unavailable.push(source.label);
                console.warn(`${source.label} comparison unavailable:`, result.reason);
                return;
            }
            loaded.push(source.label);
            const value = result.value;
            gains += typeof value === 'number' ? value : value.gains || 0;
            losses += typeof value === 'number' ? 0 : value.losses || 0;
            if (dashboard.isChecked('search-in-regions') && typeof value === 'object') {
                try {
                    const rows = regions.regionDiffRows(value.gainsGeom, value.lossesGeom, regions.directions);
                    regions.logRegionDiffRows(`${source.label} diff by direction:`, rows);
                    labelRows ||= rows;
                } catch (error) {
                    regionErrors.push(source.label);
                }
            }
        });
        if (!dashboard.isChecked('diff-area')) {
            if (labelRows) regions.drawRegionDiffLabels(labelRows);
            else dashboard.diffRegionLabels?.clearLayers();
        }
        const partial = unavailable.length && loaded.length ? ` · partial (${loaded.join(', ')})` : '';
        dashboard.setText('total-gains', loaded.length
            ? `${Math.round(gains - losses)} (↑${Math.round(gains)} ↓${Math.round(losses)})${partial}` : '—');
        ['total-captured', 'total-grayed', 'settlements-in-diff'].forEach(id => dashboard.setText(id, loaded.length ? '0' : '—'));
        const messages = [];
        if (unavailable.length) messages.push(`Comparison unavailable: ${unavailable.join(', ')}.${loaded.length ? ` Total includes only ${loaded.join(', ')}.` : ''}`);
        if (regionErrors.length) messages.push(`Region breakdown unavailable: ${regionErrors.join(', ')}.`);
        TerritoryStatus.set(dashboard, 'overlays', messages.join('\n'));
    };
}

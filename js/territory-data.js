/** Successful results only, with LRU eviction and shared in-flight requests. */
class AsyncLruCache {
    constructor(limit = 30) {
        this.limit = limit;
        this.values = new Map();
        this.pending = new Map();
    }

    async get(key, load) {
        if (this.values.has(key)) {
            const value = this.values.get(key);
            this.values.delete(key);
            this.values.set(key, value);
            return value;
        }
        if (this.pending.has(key)) return this.pending.get(key);
        const request = Promise.resolve().then(load).then(value => {
            this.values.set(key, value);
            while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
            return value;
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, request);
        return request;
    }
}

/** Territory I/O is independent of the map and DOM. */
class TerritoryData {
    static raw = new AsyncLruCache(30);
    static processed = new AsyncLruCache(12);

    static dateKey(date) {
        if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid territory date');
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    static load(date) {
        const key = this.dateKey(date);
        return this.raw.get(key, async () => {
            const response = await fetch(`https://flask-app-kibakefmpq-ew.a.run.app/geojson-by-date?date=${key}`, {
                signal: AbortSignal.timeout(30000)
            });
            if (!response.ok) throw new Error(`Territory data for ${key}: HTTP ${response.status}`);
            const data = await response.json();
            if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
                throw new Error(`Invalid territory data for ${key}`);
            }
            // Reject malformed polygon data rather than publishing partial territory.
            for (const feature of data.features) {
                const geometry = feature?.geometry;
                if (!geometry || !feature.properties) throw new Error(`Invalid territory feature for ${key}`);
                if (['Polygon', 'MultiPolygon'].includes(geometry.type)) {
                    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
                    if (!Array.isArray(polygons) || !polygons.length) throw new Error('Invalid territory polygons');
                    for (const rings of polygons) {
                        if (!Array.isArray(rings) || !rings.length) throw new Error('Invalid territory rings');
                        for (const ring of rings) {
                            if (!Array.isArray(ring) || ring.length < 4 || ring.some(p =>
                                !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
                                Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) ||
                                ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
                                throw new Error('Invalid territory ring');
                            }
                        }
                    }
                }
            }
            return data;
        });
    }

    static polygons(date, options) {
        const snapshot = new Date(date);
        options = { ...options };
        const key = `${this.dateKey(snapshot)}:${JSON.stringify(options)}`;
        return this.processed.get(key, () => new DeepUtils(null).addDeepMap(snapshot, options));
    }
}

/** Geometry-only operations; failures propagate instead of fabricating changes. */
class TerritoryAnalysis {
    static feature(polygon) {
        if (polygon.geojson) return polygon.geojson;
        return turf.polygon([polygon.coordinates.map(([lat, lng]) => [lng, lat])], polygon.properties || {});
    }

    static union(features) {
        return features.filter(Boolean).reduce((merged, feature) => merged ? turf.union(merged, feature) : feature, null);
    }

    static summary(before, after) {
        const data = geojson => ({ polygons: geojson ? [{ geojson }] : [], statistics: {} });
        const comparison = this.difference(data(before), data(after));
        const gainsGeom = comparison.polygons.find(p => p.type === 'difference')?.geojson || null;
        const lossesGeom = comparison.polygons.find(p => p.type === 'reverse-difference')?.geojson || null;
        const gains = gainsGeom ? turf.area(gainsGeom) / 1e6 : 0;
        const losses = lossesGeom ? turf.area(lossesGeom) / 1e6 : 0;
        return { gains, losses, net: gains - losses, gainsGeom, lossesGeom };
    }

    static difference(start, end) {
        if (!Array.isArray(start?.polygons) || !Array.isArray(end?.polygons)) throw new Error('Both territory datasets are required');
        const before = this.union(start.polygons.map(p => this.feature(p)));
        const after = this.union(end.polygons.map(p => this.feature(p)));
        const gains = before && after ? turf.difference(after, before) : after;
        const losses = before && after ? turf.difference(before, after) : before;
        const polygons = [];
        if (before) polygons.push({ geojson: before, type: 'merged-start', style: {
            color: '#a52714', fillColor: '#a52714', fillOpacity: 0.3, weight: 1
        } });
        if (gains) polygons.push({ geojson: gains, type: 'difference', style: {
            color: 'red', fillColor: 'red', fillOpacity: 0.5, weight: 2
        } });
        if (losses) polygons.push({ geojson: losses, type: 'reverse-difference', style: {
            color: 'blue', fillColor: 'blue', fillOpacity: 0.5, weight: 2
        } });
        return { polygons, shadowPolygon: end.shadowPolygon || start.shadowPolygon,
            statistics: { ...start.statistics, ...end.statistics } };
    }
}

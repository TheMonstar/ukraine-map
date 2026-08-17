/**
 * Overpass (OSM) query layer.
 *
 * Takes an Overpass QL query as free text — pasted straight from overpass-turbo
 * or picked from a preset — runs it against the public Overpass API and renders
 * the result as its own toggleable overlay. Independent of the Custom KML
 * loader in MapLayers: own layer, own data, own state.
 */
class Overpass {

    static ENDPOINT = 'https://overpass-api.de/api/interpreter';

    /** Ready-made infrastructure queries. All use overpass-turbo's {{bbox}}
     *  token, which expandQuery() swaps for the current viewport.
     *
     *  Site features (substations, plants, tank farms) end in `out tags center;`
     *  so ways and relations come back as a single centroid and render as
     *  markers — a fenced substation compound is a point of interest, not an
     *  area, and the centroid form is a fraction of the download. Features
     *  whose shape carries the meaning (lines, runways) keep full geometry via
     *  `out body; >; out skel qt;`. */
    static PRESETS = [
        {
            id: 'hv-substations',
            label: 'High-voltage substations (≥40 kV)',
            query: `[out:json][timeout:180];
nwr
  ["power"="substation"]
  ["substation"!="minor_distribution"]
  ["voltage"~"(^|;)([4-9][0-9]{4}|[1-9][0-9]{5,})(;|$)"]
  ({{bbox}});
out tags center;`
        },
        {
            id: 'power-plants',
            label: 'Power plants',
            query: `[out:json][timeout:180];
nwr["power"="plant"]({{bbox}});
out tags center;`
        },
        {
            id: 'power-lines',
            label: 'Power lines (≥110 kV)',
            query: `[out:json][timeout:180];
way
  ["power"="line"]
  ["voltage"~"(^|;)([1-9][0-9]{5,})(;|$)"]
  ({{bbox}});
out body; >; out skel qt;`
        },
        {
            id: 'bridges',
            label: 'Road and rail bridges',
            query: `[out:json][timeout:180];
way["bridge"]["bridge"!="no"]["highway"~"^(motorway|trunk|primary|secondary)$"]({{bbox}});
way["bridge"]["bridge"!="no"]["railway"]({{bbox}});
out body; >; out skel qt;`
        },
        {
            id: 'airfields',
            label: 'Airfields and runways',
            query: `[out:json][timeout:180];
nwr["aeroway"~"^(aerodrome|runway|helipad)$"]({{bbox}});
out body; >; out skel qt;`
        },
        {
            id: 'fuel-depots',
            label: 'Fuel and oil storage',
            query: `[out:json][timeout:180];
nwr["man_made"="storage_tank"]["content"~"^(fuel|oil|diesel|gas|petroleum)"]({{bbox}});
nwr["landuse"="industrial"]["industrial"~"^(oil|fuel|petroleum)"]({{bbox}});
out tags center;`
        }
    ];

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.layer = null;
        this.data = null;
        this.elapsed = null;
        this.controller = null;
        this.territoryFilter = { ukraine: true, occupied: true, russia: true };
    }

    /** Same buckets, labels and colors the OWL event filter uses, so a
     *  substation and a strike on it read the same way. */
    static TERRITORY = {
        ukraine: { label: 'Ukraine', color: '#2b7cff', title: 'Ukrainian-held territory' },
        occupied: { label: 'Occupied', color: '#e53935', title: 'Ukrainian territory inside a DeepState control polygon' },
        russia: { label: 'Russia', color: '#b71c1c', title: 'Outside the Ukrainian border' }
    };

    /**
     * Substitute overpass-turbo's {{bbox}} for the current viewport. Any other
     * turbo token is rejected here rather than by the API, which would only
     * report a parse error at the offending character.
     */
    expandQuery(text) {
        const bounds = this.dashboard.map.getBounds();
        const bbox = [
            bounds.getSouth(), bounds.getWest(),
            bounds.getNorth(), bounds.getEast()
        ].map(v => v.toFixed(5)).join(',');

        const expanded = text.replace(/\{\{bbox\}\}/g, bbox);

        const leftover = expanded.match(/\{\{\s*([^}]*?)\s*\}\}/);
        if (leftover) {
            throw new Error(`overpass-turbo token {{${leftover[1]}}} is not supported — only {{bbox}} is`);
        }
        return expanded;
    }

    /** Run a query and render the result. Reports through the status line, not
     *  alert() — these calls take seconds and the counts matter on success too. */
    async run(text) {
        const query = (text || '').trim();
        if (!query) {
            this.setStatus('Enter an Overpass query first.', true);
            return;
        }

        let expanded;
        try {
            expanded = this.expandQuery(query);
        } catch (error) {
            this.setStatus(error.message, true);
            return;
        }

        // A second run supersedes the first rather than racing it
        if (this.controller) this.controller.abort();
        this.controller = new AbortController();
        const controller = this.controller;

        this.setStatus('Running query…');
        const started = performance.now();

        try {
            const response = await fetch(Overpass.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: 'data=' + encodeURIComponent(expanded),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(await Overpass.describeError(response));
            }

            const osm = await response.json();
            const geojson = osmtogeojson(osm);

            if (controller.signal.aborted) return;

            this.data = geojson;
            this.elapsed = ((performance.now() - started) / 1000).toFixed(1);

            if (!geojson.features.length) {
                this.setStatus(`No features in this area · ${this.elapsed} s`, true);
                this.render(false);
                return;
            }

            await this.classifyTerritory();
            if (controller.signal.aborted) return;
            this.renderTerritoryFilter();

            const toggle = this.dashboard.getEl('overpass-overlay');
            if (toggle) toggle.checked = true;
            this.render(true); // reports the counts, which depend on the filters

        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('Overpass query failed:', error);
            this.setStatus(error.message, true);
        } finally {
            if (this.controller === controller) this.controller = null;
        }
    }

    /**
     * Overpass reports failures as an HTML page with the parser's own remark
     * inside it, which is far more useful than the bare status code.
     */
    static async describeError(response) {
        if (response.status === 429 || response.status === 504) {
            return `Overpass is rate-limiting or busy (HTTP ${response.status}) — retry in a few seconds.`;
        }

        let remark = '';
        try {
            const body = await response.text();
            const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            const match = text.match(/Error[^]*/i);
            remark = (match ? match[0] : text).slice(0, 300);
        } catch (e) {
            // fall through to the bare status
        }
        return remark ? `HTTP ${response.status}: ${remark}` : `HTTP ${response.status} from Overpass`;
    }

    render(enabled) {
        const dashboard = this.dashboard;

        if (!enabled) {
            if (this.layer) this.layer.clearLayers();
            return;
        }

        if (!this.data) {
            // Silent no-op rather than an alert: the toggle is also flipped by
            // session restore and by stream.js on viewers with no data loaded
            const toggle = dashboard.getEl('overpass-overlay');
            if (toggle) toggle.checked = false;
            this.setStatus('Run a query first.', true);
            return;
        }

        if (!this.layer) {
            this.layer = L.layerGroup().addTo(dashboard.map);
        }
        this.layer.clearLayers();

        const color = dashboard.getEl('overpass-color')?.value || '#ffb300';

        // Shares the Custom Layer section's event-proximity controls rather
        // than duplicating them: one "near/far from events" setting for every
        // user-supplied layer
        const mode = dashboard.getEl('custom-kml-event-filter')?.value || 'all';
        const radiusM = Number(dashboard.getEl('custom-kml-event-radius')?.value) || 50;
        const nearFar = mode === 'all'
            ? this.data.features
            : dashboard.layers.filterFeaturesByEventProximity(this.data.features, mode, radiusM);

        // Unclassified features always show — an unavailable territory context
        // must not silently empty the layer
        const features = nearFar.filter(f => {
            const territory = f.properties?._territory;
            return !territory || this.territoryFilter[territory] !== false;
        });

        const colorFor = (feature) => Overpass.TERRITORY[feature.properties?._territory]?.color || color;

        L.geoJSON({ ...this.data, features }, {
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                radius: 5,
                color: colorFor(feature),
                weight: 2,
                fillColor: colorFor(feature),
                fillOpacity: 0.7
            }),
            style: (feature) => ({
                color: colorFor(feature),
                weight: 2,
                fillColor: colorFor(feature),
                fillOpacity: 0.3
            }),
            onEachFeature: (feature, layer) => {
                layer.bindPopup(Overpass.popupHtml(feature));
            }
        }).addTo(this.layer);

        const total = this.data.features.length;
        const proximity = mode === 'near'
            ? ` near events ≤ ${radiusM} m`
            : mode === 'far' ? ` away from events > ${radiusM} m` : '';
        const shown = features.length === total
            ? `${total} features`
            : `${features.length} / ${total} features${proximity}`;
        this.setStatus(this.elapsed ? `${shown} · ${this.elapsed} s` : shown, features.length === 0);
    }

    /** Lat/lng to classify a result by — its own coordinates for a point,
     *  the centroid for ways and relations returned with full geometry. */
    static featureLatLng(feature) {
        if (!feature.geometry) return null;
        try {
            const [lng, lat] = feature.geometry.type === 'Point'
                ? feature.geometry.coordinates
                : turf.centroid(feature).geometry.coordinates;
            return { lat, lng };
        } catch (error) {
            return null;
        }
    }

    /**
     * Bucket every result into Ukraine / Occupied / Russia with the context the
     * OWL event filter builds for the selected end date, so both layers agree
     * on where the line is. Runs once per query — re-run after changing the
     * date to reclassify against that day's control polygons.
     */
    async classifyTerritory() {
        const dashboard = this.dashboard;
        const context = await dashboard.loadOwlTerritoryContext();

        this.data.features.forEach(feature => {
            const point = context ? Overpass.featureLatLng(feature) : null;
            if (!feature.properties) feature.properties = {};
            feature.properties._territory = point ? dashboard.owlEventTerritory(point) : null;
        });
    }

    /** Territory checkboxes with live counts, mirroring the OWL event filter's
     *  territory row. Hidden when nothing could be classified. */
    renderTerritoryFilter() {
        const container = this.dashboard.getEl('overpass-territory-filter');
        if (!container) return;

        const counts = {};
        (this.data?.features || []).forEach(f => {
            const territory = f.properties?._territory;
            if (territory) counts[territory] = (counts[territory] || 0) + 1;
        });

        container.innerHTML = '';
        container.style.display = Object.keys(counts).length ? 'flex' : 'none';

        Object.entries(Overpass.TERRITORY).forEach(([territory, { label, color, title }]) => {
            const wrap = document.createElement('label');
            wrap.title = title;
            wrap.style.cssText = 'display:flex; align-items:center; gap:3px; font-size:10px; cursor:pointer; white-space:nowrap;';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.territoryFilter[territory] !== false;
            cb.addEventListener('change', () => {
                this.territoryFilter[territory] = cb.checked;
                if (this.dashboard.isChecked('overpass-overlay')) this.render(true);
            });

            const swatch = document.createElement('span');
            swatch.style.cssText = `width:8px; height:8px; border-radius:50%; background:${color}; flex-shrink:0;`;

            wrap.appendChild(cb);
            wrap.appendChild(swatch);
            wrap.appendChild(document.createTextNode(`${label} (${counts[territory] || 0})`));
            container.appendChild(wrap);
        });
    }

    /** Tag table plus a link back to the object on openstreetmap.org. */
    static popupHtml(feature) {
        const props = feature.properties || {};
        const id = props.id || feature.id || '';
        const rows = Object.entries(props)
            .filter(([key]) => key !== 'id' && key !== '_territory')
            .map(([key, value]) => `<tr><td><strong>${key}</strong></td><td>${value}</td></tr>`)
            .join('');

        const territory = Overpass.TERRITORY[props._territory];

        return `<div style="max-height:220px; overflow:auto;">
            ${territory ? `<div style="color:${territory.color}; font-weight:600; margin-bottom:2px;">${territory.label}</div>` : ''}
            <table style="font-size:11px; border-spacing:4px 1px;">${rows}</table>
            ${id ? `<a href="https://www.openstreetmap.org/${id}" target="_blank">${id} on OSM</a>` : ''}
        </div>`;
    }

    clear() {
        if (this.controller) this.controller.abort();
        this.data = null;
        this.elapsed = null;
        if (this.layer) this.layer.clearLayers();
        const toggle = this.dashboard.getEl('overpass-overlay');
        if (toggle) toggle.checked = false;
        this.renderTerritoryFilter();
        this.setStatus('');
    }

    setStatus(message, isError = false) {
        const el = this.dashboard.getEl('overpass-status');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? '#f87171' : '';
    }
}

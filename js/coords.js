/**
 * Coordinate tooling: the sidebar cursor readout, a right-click popup to copy
 * a point, the top-bar go-to box and an MGRS grid overlay.
 *
 * proj4 (CDN) does the geodesy — UTM projection for the grid, MGRS through
 * proj4.Point — so nothing here re-implements it.
 */
class Coords {
    /** Above this many grid lines only the UTM zone boundaries are drawn. */
    static MAX_GRID_LINES = 400;

    /** Grid spacing in metres for a zoom level: 100 km, then 10 km, then 1 km. */
    static gridSpacing(zoom) {
        return zoom < 8 ? 100000 : zoom < 12 ? 10000 : 1000;
    }

    /**
     * Read typed text as a point: "48.6, 37.8" or "48.6 37.8" (latitude first),
     * degrees/minutes/seconds with N/S/E/W, or MGRS with or without spaces.
     * An MGRS input also returns `mgrs`, the reference as typed (spaced).
     * Anything else — a place name — returns null.
     */
    static parse(text) {
        const s = String(text ?? '').trim();
        if (!s) return null;

        const decimal = s.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
        if (decimal) return Coords._point(parseFloat(decimal[1]), parseFloat(decimal[2]));

        const part = String.raw`(\d+(?:\.\d+)?)°\s*(?:(\d+(?:\.\d+)?)['′]\s*)?(?:(\d+(?:\.\d+)?)(?:"|″|'')\s*)?([NSEW])`;
        const dms = s.match(new RegExp(`^${part}[\\s,;]*${part}$`, 'i'));
        if (dms) {
            const value = (deg, min, sec, hemi) =>
                (parseFloat(deg) + (parseFloat(min) || 0) / 60 + (parseFloat(sec) || 0) / 3600) * (/[SW]/i.test(hemi) ? -1 : 1);
            const first = { value: value(...dms.slice(1, 5)), isLat: /[NS]/i.test(dms[4]) };
            const second = { value: value(...dms.slice(5, 9)), isLat: /[NS]/i.test(dms[8]) };
            if (first.isLat === second.isLat) return null;
            return first.isLat ? Coords._point(first.value, second.value) : Coords._point(second.value, first.value);
        }

        const mgrs = s.replace(/\s+/g, '').toUpperCase();
        const grid = mgrs.match(/^(\d{1,2}[C-HJ-NP-X])([A-HJ-NP-Z]{2})((?:\d\d){0,5})$/);
        if (grid) {
            try {
                const decoded = proj4.Point.fromMGRS(mgrs);
                const point = Coords._point(decoded.y, decoded.x);
                // Kept as typed: re-encoding the decoded square's centre can land a metre off
                const digits = grid[3];
                const typed = [grid[1], grid[2], digits.slice(0, digits.length / 2), digits.slice(digits.length / 2)]
                    .filter(Boolean).join(' ');
                return point && { ...point, mgrs: typed };
            } catch {
                return null;
            }
        }
        return null;
    }

    static _point(lat, lng) {
        return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
            ? { lat, lng } : null;
    }

    /** "37U DP 11529 83686" (1 m), or '' outside MGRS latitudes (the polar UPS caps). */
    static toMgrs(lat, lng) {
        // proj4 still returns a string past 84°N (band "Z"), so the MGRS limits are checked here
        if (lat < -80 || lat > 84) return '';
        const parts = new proj4.Point(lng, lat).toMGRS(5).match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/);
        return parts ? parts.slice(1).join(' ') : '';
    }

    static formatLatLng(lat, lng) {
        return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    /** `48°35'21.8"N 38°00'07.6"E` — ASCII marks, as Google Maps/Earth paste and parse() read. */
    static formatDms(lat, lng) {
        const part = (value, positive, negative) => {
            const abs = Math.abs(value);
            let deg = Math.floor(abs);
            let min = Math.floor((abs - deg) * 60);
            let sec = Math.round(((abs - deg) * 60 - min) * 600) / 10;
            // Rounding to 0.1" can reach 60 and has to carry
            if (sec >= 60) { sec = 0; min += 1; }
            if (min >= 60) { min = 0; deg += 1; }
            return `${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${value < 0 ? negative : positive}`;
        };
        return `${part(lat, 'N', 'S')} ${part(lng, 'E', 'W')}`;
    }

    constructor(dashboard) {
        this.dashboard = dashboard;
        this.gridLayer = null;
        this._readoutLatLng = null;
        this._readoutFrame = null;
    }

    /** Sidebar readout under the cursor — lat/lng, then MGRS — written at most once per animation frame. */
    updateReadout(latlng) {
        this._readoutLatLng = latlng;
        if (this._readoutFrame) return;
        this._readoutFrame = requestAnimationFrame(() => {
            this._readoutFrame = null;
            const { lat, lng } = this._readoutLatLng.wrap();
            this.dashboard.setText('cursor-coords',
                [Coords.formatLatLng(lat, lng), Coords.toMgrs(lat, lng)].filter(Boolean).join('\n'));
        });
    }

    /**
     * Popup at a point with one row per format — lat/lng, MGRS, DMS. A click anywhere on
     * a row copies it and confirms for a moment. `mgrs` replaces the computed reference so
     * a typed one is echoed exactly; `title` names the place.
     */
    showPopup(latlng, { title = '', mgrs } = {}) {
        const { lat, lng } = latlng.wrap();
        const box = document.createElement('div');
        box.className = 'coords-popup';
        if (title) {
            const heading = document.createElement('div');
            heading.className = 'coords-popup-title';
            heading.textContent = title;
            box.appendChild(heading);
        }
        const rows = [
            ['Lat, lng', Coords.formatLatLng(lat, lng)],
            ['MGRS', mgrs || Coords.toMgrs(lat, lng)],
            ['DMS', Coords.formatDms(lat, lng)]
        ];
        for (const [label, text] of rows) {
            if (!text) continue;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'coords-row';
            row.title = `Copy ${label}`;
            const name = document.createElement('span');
            name.className = 'coords-label';
            name.textContent = label;
            const value = document.createElement('code');
            value.textContent = text;
            const status = document.createElement('span');
            status.className = 'coords-copy';
            status.textContent = 'Copy';
            row.append(name, value, status);
            let reset = null;
            row.addEventListener('click', () => {
                this.dashboard.copyToClipboard(text);
                row.classList.add('copied');
                status.textContent = 'Copied ✓';
                clearTimeout(reset);
                reset = setTimeout(() => {
                    row.classList.remove('copied');
                    status.textContent = 'Copy';
                }, 1500);
            });
            box.appendChild(row);
        }
        L.popup({ className: 'coords-popup-wrap', minWidth: 260, maxWidth: 360 })
            .setLatLng(latlng).setContent(box).openOn(this.dashboard.map);
    }

    /** Settlements whose local or English name contains `text`, largest first. */
    _matchSettlements(text, limit) {
        const term = String(text ?? '').trim().toLowerCase();
        const features = this.dashboard.settlementsData?.features;
        if (term.length < 2 || !features) return [];
        const population = f => this.dashboard.settlements.parsePopulation(f.properties.population);
        return features
            .filter(f => (f.properties.name || '').toLowerCase().includes(term)
                || (f.properties['name:en'] || '').toLowerCase().includes(term))
            .sort((a, b) => population(b) - population(a))
            .slice(0, limit);
    }

    /** Settlement matches under the go-to box; nothing while the text reads as a coordinate. */
    suggest(text) {
        const results = this.dashboard.getEl('goto-results');
        if (!results) return;
        const matches = Coords.parse(text) ? [] : this._matchSettlements(text, 8);
        results.replaceChildren(...matches.map(feature => {
            const props = feature.properties;
            const item = document.createElement('div');
            item.className = 'settlement-result-item';
            const name = document.createElement('div');
            name.className = 'settlement-name';
            name.textContent = props.name || props['name:en'] || 'Unknown';
            const info = document.createElement('div');
            info.className = 'settlement-info';
            info.textContent = [props['name:en'], props.place, props.population && `Pop: ${props.population}`]
                .filter(Boolean).join(' • ');
            item.append(name, info);
            item.addEventListener('click', () => this._goToSettlement(feature));
            return item;
        }));
        results.style.display = matches.length ? 'block' : 'none';
    }

    hideSuggestions() {
        const results = this.dashboard.getEl('goto-results');
        if (results) results.style.display = 'none';
    }

    /** Enter in the go-to box: fly to a coordinate, else to the top settlement match. False if neither. */
    goTo(text) {
        const point = Coords.parse(text);
        if (point) {
            this.hideSuggestions();
            const map = this.dashboard.map;
            map.setView([point.lat, point.lng], Math.max(map.getZoom(), 13));
            this.showPopup(L.latLng(point.lat, point.lng), { mgrs: point.mgrs });
            return true;
        }
        const [first] = this._matchSettlements(text, 1);
        if (first) this._goToSettlement(first);
        return Boolean(first);
    }

    _goToSettlement(feature) {
        const [lng, lat] = feature.geometry.coordinates;
        const props = feature.properties;
        this.hideSuggestions();
        this.dashboard.map.setView([lat, lng], 14);
        this.showPopup(L.latLng(lat, lng), { title: [...new Set([props.name, props['name:en']].filter(Boolean))].join(' · ') });
    }

    /** MGRS grid over the view. Spacing follows zoom; lines are clipped to each UTM zone. */
    renderGrid() {
        const map = this.dashboard.map;
        if (!this.dashboard.isChecked('mgrs-grid')) {
            if (this.gridLayer) map.removeLayer(this.gridLayer);
            this.gridLayer = null;
            return;
        }
        if (!this.gridLayer) this.gridLayer = L.layerGroup().addTo(map);
        this.gridLayer.clearLayers();

        // Padded so a short pan still has lines until moveend redraws them.
        const bounds = map.getBounds().pad(0.25);
        const south = Math.max(bounds.getSouth(), -80), north = Math.min(bounds.getNorth(), 84);
        const west = Math.max(bounds.getWest(), -180), east = Math.min(bounds.getEast(), 180);
        if (south >= north || west >= east) return;
        const spacing = Coords.gridSpacing(map.getZoom());

        const zones = [];
        const lastZone = Math.min(60, Math.floor((east + 180) / 6) + 1);
        for (let zone = Math.floor((west + 180) / 6) + 1; zone <= lastZone; zone++) {
            const zoneWest = -180 + (zone - 1) * 6;
            const box = [Math.max(west, zoneWest), south, Math.min(east, zoneWest + 6), north];
            if (box[0] >= box[2]) continue;
            // Northern UTM throughout: southern MGRS northings are offset by 10,000 km,
            // a multiple of every spacing, so the lines land in the same places.
            const utm = proj4('EPSG:4326', `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
            const edge = [];
            for (let i = 0; i <= 4; i++) {
                const lng = box[0] + (box[2] - box[0]) * i / 4, lat = box[1] + (box[3] - box[1]) * i / 4;
                edge.push([lng, box[1]], [lng, box[3]], [box[0], lat], [box[2], lat]);
            }
            const projected = edge.map(p => utm.forward(p));
            const eastings = projected.map(p => p[0]), northings = projected.map(p => p[1]);
            zones.push({
                zoneWest, box, utm,
                minE: Math.min(...eastings), maxE: Math.max(...eastings),
                minN: Math.min(...northings), maxN: Math.max(...northings)
            });
        }

        const style = { color: '#3b82f6', weight: 1, opacity: 0.7, interactive: false };
        const lineCount = zones.reduce((sum, z) => sum + (z.maxE - z.minE + z.maxN - z.minN) / spacing, 0);
        if (lineCount <= Coords.MAX_GRID_LINES) {
            for (const z of zones) {
                // A line straight in UTM, sampled back to lat/lng and cut at the zone edges
                const line = (from, to) => {
                    const coords = [];
                    for (let i = 0; i <= 20; i++) {
                        coords.push(z.utm.inverse([from[0] + (to[0] - from[0]) * i / 20, from[1] + (to[1] - from[1]) * i / 20]));
                    }
                    const clipped = turf.bboxClip(turf.lineString(coords), z.box).geometry;
                    const parts = clipped.type === 'LineString' ? [clipped.coordinates] : clipped.coordinates;
                    for (const part of parts) {
                        if (part.length > 1) L.polyline(part.map(([lng, lat]) => [lat, lng]), style).addTo(this.gridLayer);
                    }
                };
                for (let e = Math.ceil(z.minE / spacing) * spacing; e <= z.maxE; e += spacing) line([e, z.minN], [e, z.maxN]);
                for (let n = Math.ceil(z.minN / spacing) * spacing; n <= z.maxN; n += spacing) line([z.minE, n], [z.maxE, n]);
                if (map.getZoom() >= 7) this._labelSquares(z);
            }
        }
        for (const z of zones) {
            if (z.zoneWest > west && z.zoneWest < east) {
                L.polyline([[south, z.zoneWest], [north, z.zoneWest]], { ...style, weight: 2.5, opacity: 0.9 }).addTo(this.gridLayer);
            }
        }
    }

    /**
     * 100 km square letters (e.g. "DP"), one per square, at the middle of the part of
     * the square inside the zone's box — a square's own centre is usually off-screen
     * once zoomed in, which is exactly when the letters are needed.
     */
    _labelSquares(z) {
        const [west, south, east, north] = z.box;
        for (let e = Math.floor(z.minE / 1e5) * 1e5; e < z.maxE; e += 1e5) {
            for (let n = Math.floor(z.minN / 1e5) * 1e5; n < z.maxN; n += 1e5) {
                const [lng, lat] = z.utm.inverse([
                    (Math.max(e, z.minE) + Math.min(e + 1e5, z.maxE)) / 2,
                    (Math.max(n, z.minN) + Math.min(n + 1e5, z.maxN)) / 2
                ]);
                if (lng < west || lng > east || lat < south || lat > north) continue;
                const letters = Coords.toMgrs(lat, lng).split(' ')[1];
                if (!letters) continue;
                L.marker([lat, lng], {
                    interactive: false,
                    icon: L.divIcon({ className: 'mgrs-square-label', html: `<span>${letters}</span>`, iconSize: null })
                }).addTo(this.gridLayer);
            }
        }
    }
}

window.Coords = Coords;

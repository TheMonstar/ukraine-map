# Performance Improvements

## 1. setBaseLayer('nasa-gibs') called on every slider tick
**File:** `js/app.js:3043`
**Priority:** High

Every date-slider movement with NASA Satellite selected tears down the tile layer and creates a new one (`removeLayer` + `L.tileLayer` + `addTo`). A single drag fires dozens of teardowns, blanking the map and flooding the tile cache.

**Fix:** Track the last date used for the NASA layer and skip `setBaseLayer` if the date hasn't changed.

```js
const mapStyleEl = this.getEl('map-style');
if (mapStyleEl?.value === 'nasa-gibs') {
    const dateStr = this.formatDate(this.endDate); // YYYY-MM-DD
    if (dateStr !== this._lastNasaDate) {
        this._lastNasaDate = dateStr;
        this.layers.setBaseLayer('nasa-gibs');
    }
}
```

---

## 2. updateFreeShapeTransform fires on every pan pixel — no rAF guard
**File:** `js/app.js:1475`
**Priority:** High

Registered on Leaflet's `'move'` event which fires on every mousemove pixel during panning. Each call does 8 `latLngToLayerPoint` lookups + matrix3d computation synchronously, saturating the main thread and causing jank on mobile.

**Fix:** Throttle with `requestAnimationFrame`:

```js
this._updateFreeTransformBound = () => {
    if (!this._freeTransformRafPending) {
        this._freeTransformRafPending = true;
        requestAnimationFrame(() => {
            this._freeTransformRafPending = false;
            this.updateFreeShapeTransform();
        });
    }
};
```

---

## 3. motorlines-by-shadow-btn re-fetches motorlines.json on every click
**File:** `js/ui-bindings.js:325`
**Priority:** Medium

Unlike `motorlines-by-diff-btn` which uses `motorlinesCache`, the shadow button issues a full fetch on every click. The file can be several MB.

**Fix:** Read from the same `motorlinesCache` variable (or move the cache to a shared scope accessible by both handlers).

---

## 4. unionAll uses sequential turf.union reduce — O(n²) polygon growth
**File:** `js/ui-bindings.js:418`
**Priority:** Medium

`polys.reduce((acc, p) => acc ? turf.union(acc, p.geojson) : p.geojson, null)` — the accumulator grows with every merge. For large date ranges (60+ polygons) the final merges operate on near-complete territory outlines, potentially freezing the main thread.

**Fix:** Consider a divide-and-conquer tree union (merge pairs, then merge pairs of pairs) to reduce max intermediate polygon size. Alternatively, run in a Web Worker for large inputs.

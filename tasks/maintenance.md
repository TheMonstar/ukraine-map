# Maintenance & Code Quality

## 1. 'Artillery Brigade' hardcoded string filter in corps repositioning
**File:** `js/ui-bindings.js:2787`
**Priority:** Medium

`brigade.includes('Artillery Brigade')` excludes outlier units from the corps centroid average. This breaks silently if unit naming changes or if other outlier types emerge (e.g., 'Rocket Artillery Brigade').

**Fix:** Replace with a distance-from-median outlier filter — compute the median position of brigades first, then exclude any brigade beyond N km from the median. This generalizes to any outlier regardless of name.

---

## 2. NASA GIBS URL date replacement uses positional regex
**File:** `js/map-layers.js:118`
**Priority:** Low

`url.replace(/\/\d{4}-\d{2}-\d{2}\//, ...)` replaces the first date-shaped segment. If the WMTS URL ever gains a second date segment (version date, epoch), the wrong one is silently replaced.

**Fix:** Use a named placeholder in `mapStyles`:

```js
'nasa-gibs': {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{DATE}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg',
    ...
}
// In setBaseLayer:
url = url.replace('{DATE}', dateStr);
```

---

## 3. repoBounds magic numbers have no explanation
**File:** `js/ui-bindings.js:2778`
**Priority:** Low

The hardcoded lat/lng bounding box `(46.09, 31.93) → (52.32, 40.38)` has no comment. It's unclear whether it's an approximate Ukraine extent, a conflict-zone box, or something else.

**Fix:** Add a named constant with a comment:

```js
// Approximate eastern Ukraine conflict zone — excludes far-western rear positions
const UKRAINE_CONFLICT_BOUNDS = L.latLngBounds(...);
```

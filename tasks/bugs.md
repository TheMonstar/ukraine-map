# Bug Fixes

## 1. motorlines-by-shadow-btn: unhandled promise rejection
**File:** `js/ui-bindings.js:325`
**Priority:** High

The fetch has no `try/catch` and no `response.ok` check. Any network failure or non-200 response produces a silent unhandled rejection. The sibling `motorlines-by-diff-btn` handler has both guards.

**Fix:** Wrap the handler body in try/catch, add `if (!response.ok) throw new Error(...)` after fetch.

---

## 2. shadowUaPolygon null — shadow layer silently disappears
**File:** `js/ui-bindings.js:88`
**Priority:** High

`turf.intersect(turf.difference(shadowOnly, ruborder), uaborder)` can return `null` when the geometries don't overlap. The null is stored in `dashboard.shadowUaPolygon` and filtered out of rendering by `.filter(p => p.geojson)` — so the shadow layer simply doesn't render with no user feedback.

**Fix:** After line 87, check if `shadowExclRu` is null and show a console.warn or indicator.

---

## 3. Right-click subordinate highlight silently fails for units not in static OOB files
**File:** `js/ui-bindings.js:2184`
**Priority:** High

Old code used live `data.statistics.subordinateUnits` (always in sync). New code traverses `dashboard.linkedUnitsByParent` / `dashboard.ruLinkedUnitsByParent` from static JSON files. If a unit is in the map but absent from those files, the highlight set contains only the right-clicked unit — no error, partial result.

**Fix:** Fall back to scanning `data.statistics` when the static map lookup returns nothing, or log a warning.

---

## 4. Road-km results only logged to console — no UI feedback
**File:** `js/ui-bindings.js:320`
**Priority:** Medium

Clicking either "Road km" button gives zero visible feedback unless DevTools is open. Results are permanently lost when the console is cleared.

**Fix:** Display results in a small overlay/popup or a dedicated stats element in the sidebar.

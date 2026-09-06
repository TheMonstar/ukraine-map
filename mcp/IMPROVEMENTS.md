# MCP server — improvement backlog

Prioritised and actionable: work top-down. Resolved items are struck through and kept
for the record rather than deleted. Every item here was observed against the code,
not guessed. Line references were current at the time of writing — re-check before starting.

Scope is `mcp/` only. Items 2 and 13 are about this package but are fixed in files just outside
it; each says where. Defects in the app-side rendering the MCP drives — `js/poster.js`,
`js/draw.js` — are real but tracked separately and deliberately not listed here.

---

## P1 — Correctness: these can silently produce wrong output

### 1. Unsupported shape types are silently dropped
**Problem** — `addShapes` pushes whatever it is given onto `drawTool.shapes`. If the loaded
build's `_drawShape` has no branch for that `type`, the shape is stored, never drawn, and the
tool still reports `added: 1`.
**Why it matters** — this happened for real. Running against the deployed site before the
app-side changes shipped, `polygon`, `icon` and `pattern` all reported success and rendered
nothing; a whole plan came back blank with no error anywhere. Any version skew between the
server and the page reintroduces it.
**Fix** — have the bridge report which types the loaded `DrawingTool` actually renders (probe
`_drawShape`, or expose a capability list), and reject unknown types with a clear message
naming the missing type.
**Where** — `mcp/browser/agent-api.js:305` (`addShapes`), `mcp/tools/draw.js:492` (`REQUIRED`)
**Effort** — small

### 2. ~~`.gitignore` excluded `mcp/README.md` and all of `mcp/tools/`~~ — FIXED
**Problem** — the repo-root `.gitignore` had `*.md` and an unanchored `tools/`. A pattern
without a leading slash matches a directory of that name at *any* depth, so `mcp/tools/` — all
five tool modules — was excluded, along with the README. A clone would have got `server.js`
importing `./tools/read.js` and dying at startup.
**Status** — resolved and committed: `/tools/` is anchored, `!mcp/**/*.md` re-includes the docs,
and all five tool modules plus the README are tracked. Kept here as a record of the trap: an
unanchored directory pattern in `.gitignore` silently swallows same-named directories anywhere
in the tree.
**Where** — `.gitignore` (outside `mcp/`)

### 3. No committed tests
**Problem** — every verification run so far has lived in a session scratchpad. There is no
`mcp/test/`, and `package.json` has no `scripts` block at all.
**Why it matters** — scratchpad suites are session-scoped and disappear. Four of them vanished
mid-session, which is precisely the failure mode: a change lands, the suite that would have
caught the regression no longer exists. Items 1, 4, 7 and 8 all rewrite core paths and need a
net under them first.
**Fix** — commit the regression coverage as `mcp/test/regress.mjs` (place resolution, layer
toggling, unit placement by name and by id, ownership isolation, session round-trip) and add
`"test": "node test/regress.mjs"` to `package.json`.
**Where** — `mcp/package.json`, new `mcp/test/`
**Effort** — small — the script has been written before; it needs committing, not inventing

---

## P2 — Performance and payload

### 4. `roadPath` scans every road vertex in the country, twice per leg
**Problem** — `nearest()` is a plain linear scan over every road feature and every coordinate
in it, called once per endpoint, with nothing cached between calls.
**Why it matters** — `follow: "roads"` is one of the two levers that make a plan look
plausible, and it is the slowest tool in the set. A multi-leg axis pays the full scan for each
leg.
**Fix** — build a coarse lat/lng grid index once on first use and memoise it on the bridge;
`LineFeatures._buildIndex` is prior art for the bucketing.
**Where** — `mcp/browser/agent-api.js:567`
**Effort** — medium

### 5. `unitIcons()` returns every formation at once
**Problem** — the whole name→insignia map is returned unfiltered; with the daily layer loaded
that is 500–1600 entries.
**Why it matters** — it lands in the conversation in full on every call, for what is usually a
lookup of one or two formations.
**Fix** — add `query` (substring match on unit name) and `limit`, with a modest default. Keep
`inUse` as-is; it is small and genuinely useful for browsing.
**Where** — `mcp/browser/agent-api.js:405`, `mcp/tools/draw.js:393`
**Effort** — small

### 6. Terrain routing tuning is unreachable
**Problem** — `terrainPath` accepts `steps`, `spread`, `climbWeight`, `detour` and
`bendPenalty`, but the only caller passes `{}`.
**Why it matters** — an axis can never be told to hug low ground harder or to be allowed to
wander further around an obstacle. Over flat ground the default is correctly near-straight, so
the knobs are exactly what you would reach for when the default looks too plain.
**Fix** — expose one or two as friendly parameters on `map_draw_axis` (e.g. `avoid_climb`,
`detour`), mapped onto the underlying options.
**Where** — `mcp/tools/draw.js:303`
**Effort** — small

### 7. Every graphic is its own round trip
**Problem** — each semantic tool makes its own `page.evaluate` call, and each call ends with a
full canvas re-render.
**Why it matters** — a twenty-element plan is twenty-plus round trips and twenty full repaints,
with visible intermediate states.
**Fix** — an accumulate-then-flush path: queue shapes and commit them in one call with a single
render.
**Where** — `mcp/session.js:97` (`call`), `mcp/tools/draw.js`
**Effort** — medium

---

## P3 — Missing capability

### 8. Drawn shapes have no identity
**Problem** — `map_erase` takes only `ai`, `all` or `last`. Nothing returns a handle to a
specific graphic.
**Why it matters** — to change one arrow, everything must be cleared and redrawn. The
screenshot-and-correct loop is the core of this design, and correction is currently
all-or-nothing.
**Fix** — assign an id at creation, return it from each draw tool, and let `map_erase` target
it. A `map_update_shape` for restyling follows naturally.
**Where** — `mcp/browser/agent-api.js:305` (`addShapes`, `erase`), all of `mcp/tools/draw.js`
**Effort** — medium

### 9. No measurement tool
**Problem** — there is no way to ask for a distance, a bearing, or the area of a drawn zone.
**Why it matters** — an operational graphic should be justifiable: frontage in km, depth of an
advance, size of a pocket. Right now those numbers can only be eyeballed off the map.
**Fix** — `map_measure`, taking places or points and returning distance, bearing and — for a
closed ring — area. `geo.js` already has `distanceKm`, `bearing` and `centroid`.
**Where** — new tool in `mcp/tools/`, building on `mcp/geo.js`
**Effort** — small

### 10. `map_front_line` requires the territory layer to be on already
**Problem** — it throws if `diff-area` has not been enabled and loaded.
**Why it matters** — the error is clear and says what to do, so this is a papercut rather than
a trap, but it makes the single most valuable tool a two-step.
**Fix** — enable `diff-area`, wait for the data, then proceed; keep the error for the case
where the layer yields nothing in view.
**Where** — `mcp/tools/draw.js:326`
**Effort** — small

### 11. `map_list_features` cannot filter units by side
**Problem** — only `bbox` and `limit`; UA and RU come back interleaved.
**Why it matters** — asking "what RU formations are in this sector" means pulling both sides
and filtering by hand.
**Fix** — add an optional `side` for the `units` kind.
**Where** — `mcp/tools/read.js:16`, `mcp/browser/agent-api.js` (`features`)
**Effort** — trivial

---

## P4 — Housekeeping

### 12. `decimate()` duplicates an app-side helper
**Problem** — `decimate()` reimplements the same even-thinning as `DrawingTool._thin`, on the
other side of the bridge.
**Why it matters** — two copies of one algorithm drift. Low stakes, but it is free to fix.
**Fix** — keep the MCP-side copy (thinning before send is the right place) and note the
relationship in a comment, or drop one deliberately.
**Where** — `mcp/tools/draw.js:313`
**Effort** — trivial

### 13. `mcp/` is published to GitHub Pages
**Problem** — `deploy.yml` uploads `path: .`, so the whole server source ships to the public
site. `node_modules` is gitignored so it stays out, but the source does not.
**Why it matters** — harmless, just dead weight served publicly.
**Fix** — exclude `mcp/` from the upload step.
**Where** — `.github/workflows/deploy.yml` (outside `mcp/`)
**Effort** — trivial

### 14. Screenshot timing is fixed sleeps
**Problem** — `networkidle` with an 8 s cap, then a flat 700 ms, rather than waiting on
Leaflet's own tile-load events.
**Why it matters** — on a slow tile fetch the capture can catch a half-drawn basemap; the
grey-tiles screenshot earlier in development was this.
**Fix** — wait on the tile layer's `load` event with the timeout as a fallback.
**Where** — `mcp/session.js:116`
**Effort** — medium

### 15. No CI
**Problem** — nothing runs the tests on push.
**Why it matters** — depends entirely on item 3; worthless before it, straightforward after.
**Fix** — a workflow that installs, fetches Chromium and runs `npm test` in `mcp/`.
**Where** — new workflow file
**Effort** — small

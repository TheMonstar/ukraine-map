# 3D Terrain Viewer (`3d-view.html`)

Standalone, same-origin page that renders a 5 km hex tile from the main map as a
walkable 3D scene: real DEM relief, satellite drape, roads/water/ditches/buildings/
vegetation, sky/sun/shadows, and a WASD-controllable player character.

Pure ES modules via importmap — no build step, no bundler, consistent with the
rest of this repo (see top-level [CLAUDE.md](../../CLAUDE.md)). Three.js is pinned
to **r165** everywhere (importmap in [3d-view.html](../../3d-view.html), and the
`waternormals.jpg` CDN URL in `features/water.js`) — bump all references together
if upgrading.

## Entry point / trigger

[js/hex-tiles.js](../hex-tiles.js) adds a click handler to hex polygons when
`cellSizeKm <= 5`: it computes the hex centroid and opens
`3d-view.html?lat=..&lng=..&size=..&date=..` in a new tab. `main.js` reads these
URL params; `lat`/`lng` become the local-coordinate origin and `date` is passed to
the ditches fetch.

## Coordinate system (`geo.js`)

Local ENU meters centered on `(lat0, lng0)`:
- `x` = east, `z` = **south** (so Three.js forward `-z` = north)
- `proj.toLocal(lat, lng)` → `{x, z}`, `proj.toLatLng(x, z)` → `{lat, lng}`
- `proj.bbox(halfM)` → `[minLng, minLat, maxLng, maxLat]` for fetches

`SCENE_SIZE = 6000` / `SCENE_HALF = 3000` (meters) define the terrain plane extent
— exported from `terrain.js`. `GRID_SEGMENTS = 256` is the heightmap/mesh
resolution (257×257 vertices).

GeoJSON is always `[lng, lat]`; local/Three.js coords are always `{x, z}` /
`(x, y, z)`. Be explicit at every conversion boundary, same convention as
`GeometryUtils` on the main map.

## File map

| File | Responsibility |
|---|---|
| [main.js](main.js) | Entry module: scene/camera/renderer setup, lighting/sky/sun, orchestrates loading, wires all UI controls, owns the render loop |
| [geo.js](geo.js) | ENU projection + slippy-tile math (`makeProjection`, `latLngToTile*`, Mercator helpers) |
| [terrain.js](terrain.js) | `TerrainBuilder` — DEM heightmap, mesh, hypsometric/satellite material, `sampleHeight()`, `carveTrenches()`, `setExaggeration()` |
| [data-sources.js](data-sources.js) | Fetchers: combined Overpass query (forest/water/grass/buildings), `fetchMapboxBuildings` (Mapbox Streets vector tiles, z15, MVT-decoded via CDN-imported pbf + @mapbox/vector-tile), `fetchRoads` (motorlines.json), `fetchDitches` (app API) |
| [ribbon.js](ribbon.js) | Shared drape helpers: `buildDrapedRibbon` (roads/rivers/ditches), `buildDrapedPolygon` (lakes), `reDrapeMesh`; both builders clip geometry to ±`SCENE_HALF` (polyline runs / Sutherland–Hodgman) and may return `null` |
| [textures.js](textures.js) | Procedural `CanvasTexture`s — 4 wall styles (plaster ×2 window layouts, brick, industrial concrete panel), 3 roof styles (corrugated rust, clay tile, standing-seam gray), grass blades; no binary assets |
| [player.js](player.js) | `Player` — rounded low-poly soldier (capsule limbs/torso, helmet + balaclava, vest with pouches, rifle across the chest; walk-cycle animation, origin at feet), WASD/arrow movement, terrain-following, building collision via footprint rings |
| [drone.js](drone.js) | `Drone` — procedural quadcopter, WASD horizontal + R/F altitude, smoothed velocity with banking tilt, terrain clearance, spinning rotors |
| [game.js](game.js) | `HideSeekGame` — hide & seek mode: 3/5/10 soldiers (reusing `buildHumanoid`) hide at tree/building cover points within 1 km of center, relocate on a timer, flee to nearest cover and freeze when the drone is near; tag with T within 25 m; count-up timer HUD |
| [features/roads.js](features/roads.js) | Draped road ribbons, width/color by `highway` tag |
| [features/water.js](features/water.js) | River ribbons + lake polygons, animated normal-map shimmer |
| [features/ditches.js](features/ditches.js) | Fortification trench ribbons (dark, from app API) |
| [features/buildings.js](features/buildings.js) | Textured buildings merged into one mesh per texture style (≤8 draw calls; per-building style pick: industrial → panels/gray roofs, multi-story (apartments / `building:levels` ≥ 3 / height > 8.5 m) → brick/panel walls + flat bitumen roof, never gabled, houses → plaster/brick + tile/corrugated/seam, plus vertex-color tints), gabled roofs for small rectangular houses, capped at 15000; sourced from Mapbox vector tiles when `localStorage.mapboxToken` is set (same data as the main map's `buildings-3d` layer in `js/map-3d.js`), Overpass otherwise; Mapbox's placeholder `height: 3` is treated as unknown, and real OSM tags (type/levels/height) are borrowed from the Overpass buildings via centroid matching (`_enrichFromOsm`) — untagged apartment-type blocks default to 5 or 9 stories; exposes `footprints` for player collision and per-building style indices + vertex ranges for `reDrape` |
| [features/vegetation.js](features/vegetation.js) | Procedural instanced trees (3-tier conifer / multi-blob deciduous, per-instance color jitter), capped at 25000 |
| [features/grass.js](features/grass.js) | Instanced grass tufts (three crossed alpha-tested planes) on meadow/grass/farmland polygons; 120000 budget spread area-proportionally across all fields (steps scale up together when over budget, so no field is left bare) |

Each feature class follows the same shape: `load(bbox[, mapFeatures])` (fetch),
`build(terrain, proj)` (populate `this.group`/`this.meshes`), `reDrape(terrain)`
(re-run after exaggeration change), `dispose()`.

## Data flow / load sequence (`main.js` `init()`)

1. Parse `lat`/`lng`/`size`/`date` from URL → `makeProjection(lat, lng)`.
2. Renderer/scene/camera/`OrbitControls` setup, `Sky` + `DirectionalLight` (sun),
   `updateSun(13)` for default noon lighting.
3. `TerrainBuilder.build()` — fetch+stitch Terrarium DEM tiles (z14, z13
   fallback), build heightmap, build mesh with hypsometric vertex colors.
4. `terrain.applySatellite()` — stitch Mapbox (if `localStorage.mapboxToken`
   set) or ESRI World Imagery tiles, recompute UVs in Web Mercator, swap
   material to textured.
5. Fetch `mapFeatures` (Overpass, combined query, sessionStorage-cached),
   `roads.load()`, `ditches.load()` in parallel.
6. `terrain.carveTrenches(ditches.featureCollection, proj)` — rasterizes ditch
   lines into the heightmap (depression + berm) **before** any feature drapes,
   so everything else conforms to the carved terrain.
7. `water.load()`, `buildings.load()`, `vegetation.load()`, `grass.load()` (reuse `mapFeatures`).
8. Each feature's `build(terrain, proj)` → add `group` to scene; wire layer
   toggle checkboxes to `group.visible`.
9. Wire exaggeration slider (`terrain.setExaggeration()` + `features.forEach(f
   => f.reDrape(terrain))`), time-of-day slider (`updateSun(hours)`), shadow
   quality select, move-speed slider (`player.speedScale` / `drone.speedScale`,
   0.5–10×), walk-mode and drone-mode checkboxes.
10. Render loop: `controls.update()`, `water.update(elapsedSeconds)` (shimmer),
    and — if walk mode is on — `player.update(...)` plus camera/target
    follow-by-delta.

## Key conventions / gotchas

- **Scene-bounds clipping**: source features (fields, forests, roads, rivers)
  often extend far past the 6 km terrain plane. Everything placed or drawn
  must stay within ±`SCENE_HALF`: ribbon/polygon clipping lives in
  `ribbon.js`, and the grass/vegetation scatter loops clamp their grid (and
  jittered points) to the bounds. New feature types must do the same.
- **Draping**: every flat/line feature samples `terrain.sampleHeight(x, z)` per
  vertex and adds a small lift (0.15–0.5 m) to avoid z-fighting with the
  terrain mesh. `polygonOffset` is also set on ribbon/polygon materials.
  `reDrapeMesh()` / each feature's `reDrape()` must be called after
  `terrain.setExaggeration()` or after `carveTrenches()` changes the
  heightmap.
- **`_applyHeightToMesh()`** is the single place that rewrites mesh Y from
  `heightmap * exaggeration` and recomputes normals — both `_buildMesh()` and
  `carveTrenches()` go through it. `setExaggeration()` currently has its own
  loop (does the same thing) — fine, but if you touch height-rewrite logic,
  update both.
- **Walk / drone / free-camera modes** (`main.js`, the `#walk-mode` /
  `#drone-mode` / `#freecam-mode` checkbox handlers): mutually exclusive —
  checking one unchecks the others via `uncheckOthers()` (dispatched `change`
  events so each exit path runs). The shared overview state is captured once
  at startup and restored by `exitFollow()`. Walk/drone use a close
  third-person view (maxDistance 60 / 200); free camera keeps the camera
  where it is on entry and moves camera + `controls.target` by the same
  delta (WASD + Space/Shift, `FREECAM_SPEED` 80 m/s × move-speed slider),
  clamped to the sector and held ≥2 m above terrain. The render loop
  computes `forward`/`right` from `controls.target - camera.position`
  (XZ-projected) each frame, so OrbitControls mouse-orbit still works in all
  modes. Up/down in drone/freecam is R/F; Q/E yaw the camera around the
  orbit target (`applyYaw` in the render loop), which also turns the
  movement heading since movement is camera-relative.
- **Hide & seek mode** (`game.js`, panel "Hide & seek" row): Start forces
  drone mode on (via the checkbox `change` path) and spawns the squad at
  random cover points (tree placements from `vegetation.placements`, spots
  ~3 m outside `buildings.footprints` corners; open-field fallback if the
  center is barren). Soldier states: hiding → relocating (walk 3 m/s, every
  15–35 s while the drone is >250 m away) → fleeing (run 6 m/s to nearest
  cover when the drone is <120 m, then an 8 s hide cooldown) → tagged (red
  torus marker, permanent; tag key is **T** — F is drone-descend).
  `game.update(dt, dronePos)` runs every frame;
  `dronePos` is null outside drone mode, which disables tagging but keeps
  the squad moving. Any non-drone camera is the **observer view**: tall
  tapered light beams (150 m, sized to read from a multi-km overview) mark
  the drone (cyan) and every soldier (orange; green once tagged) — hidden
  while in drone mode so the hunt stays fair. The round ends via
  `_finish()` (overlay + `onEnd` callback resets the Start button); closing
  the overlay calls `stop()`.
- **rAF pauses in hidden tabs**: if the page's Chrome window is backgrounded,
  `requestAnimationFrame` stops firing — walk/drone/freecam movement and
  water shimmer freeze (state like key sets and mode flags still updates).
  When driving the page via automation, confirm `document.visibilityState`
  is `visible` before concluding movement is broken.
- **Shadow quality toggle**: changing it disposes `sun.shadow.map` and sets
  `sun.shadow.map = null` to force regeneration at the new `mapSize`.
- **External CDNs**: Terrarium DEM (`s3.amazonaws.com/elevation-tiles-prod`),
  Mapbox/ESRI satellite, Overpass (primary + kumi mirror, sessionStorage
  cache keyed by rounded bbox), `${API_BASE_URL}/ditches.geojson`,
  `${APP_STATIC_URL}/motorlines.json`. All have graceful fallbacks — the
  scene still renders (with a noted failure) if any of these are unreachable.
- **Overpass cache versioning**: the sessionStorage cache key carries a
  version (`3d-osm-features-v2-…`). Bump it whenever the Overpass query or
  `osmToGeoJSON` output changes, or stale cached data silently misses the
  new feature types (this is how building relations went missing in v1).
- **Buildings are merged**: all walls live in one `BufferGeometry`, all roofs
  in another (2 draw calls). Per-building vertex ranges + footprints are kept
  in `records` so `reDrape()` can shift each building vertically; collision
  uses `buildings.footprints`, not meshes.

## Local dev / verification

```bash
python3 -m http.server 8080
# open http://localhost:8080/3d-view.html?lat=48.5800&lng=37.9800&size=5&date=2026-06-09
```

The Claude Preview tool (`mcp__Claude_Preview__*`, server name `static`, port
8090) works the same way. Two known preview-tool-only quirks (not source bugs):
- Canvas renders 0×0 after navigation/reload until
  `window.dispatchEvent(new Event('resize'))` is run via `preview_eval`.
- `preview_click` on a checkbox can fire two toggle events (net no-op) — set
  `checkbox.checked` and dispatch a `change` event manually instead when you
  need a single, deterministic toggle.

For inspecting internal state (camera/controls/player/terrain), temporarily add
`window.__debug = {...}` near the end of `init()`, reload, query via
`preview_eval`, then **fully revert** the debug line before finishing.

`python3 -m http.server` sends no cache headers, so Chrome's heuristic HTTP
cache can serve **stale ES modules** after an edit (a plain reload does not
always revalidate subresources). If freshly edited behavior doesn't show up,
re-fetch the modules with `fetch(url, { cache: 'reload' })` (or hard-reload
with DevTools open) before reloading, and confirm via a cache-busted
`import('./js/3d/<file>.js?fresh=' + Date.now())` that exports match the
file on disk.

## Status / what's implemented

Phases 1–4 of the original plan
(`/Users/zeus/.claude/plans/binary-stirring-falcon.md`) are done: terrain +
satellite, roads/water/ditches with layer toggles, buildings + procedural
vegetation, sky/sun/time-of-day, shadows with quality toggle, animated water
shimmer, trench carving, and a walkable player (WASD/arrow keys, building
collision, grounded third-person camera in walk mode).

Realism pass (June 2026): building multipolygon relations fetched and
assembled, buildings merged + textured (procedural plaster/roof canvas
textures, per-building tint, gabled roofs on small rectangular houses),
richer procedural trees with per-instance color jitter, grass-tuft layer on
meadow/farmland polygons (`#layer-grass` toggle), humanoid player with walk
cycle.

**Explicitly out of scope / not implemented** (don't start without the user
asking):
- GLTF tree models (requires sourcing/committing binary assets)
- Phase 5: frontline/occupation overlay, ditch date-diffing (`?dateStart=`),
  screenshot export, quality presets + URL state, minimap inset

All work so far is uncommitted on the `3dview` branch.

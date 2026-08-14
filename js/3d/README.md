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
| [features/water-labels.js](features/water-labels.js) | River / canal / stream **name** labels floating over the watercourse, grouped by name so a river split across many OSM ways gets one label (repeated every ~1.6 km on long runs). Prefers `name:en` — the transliteration analysis uses — falling back to the local `name`. Off by default (`#layer-river-names`) |
| [features/fortifications.js](features/fortifications.js) | **Built** obstacles from the PlayFra datasets — one instance per type, `'wire'` and `'teeth'` — rendered with the same builders the sandbox draw tools use. Off by default and **lazily loaded** (`#layer-wire` / `#layer-teeth`) |
| [features/buildings.js](features/buildings.js) | Textured buildings merged into one mesh per texture style (≤8 draw calls; per-building style pick: industrial → panels/gray roofs, multi-story (apartments / `building:levels` ≥ 3 / height > 8.5 m) → brick/panel walls + flat bitumen roof, never gabled, houses → plaster/brick + tile/corrugated/seam, plus vertex-color tints), gabled roofs for small rectangular houses, capped at 15000; sourced from Mapbox vector tiles when `localStorage.mapboxToken` is set (same data as the main map's `buildings-3d` layer in `js/map-3d.js`), Overpass otherwise; Mapbox's placeholder `height: 3` is treated as unknown, and real OSM tags (type/levels/height) are borrowed from the Overpass buildings via centroid matching (`_enrichFromOsm`) — untagged apartment-type blocks default to 5 or 9 stories; exposes `footprints` for player collision and per-building style indices + vertex ranges for `reDrape` |
| [features/vegetation.js](features/vegetation.js) | Procedural instanced trees (3-tier conifer / multi-blob deciduous, per-instance color jitter), capped at 25000 |
| [features/grass.js](features/grass.js) | Instanced grass tufts (three crossed alpha-tested planes) on meadow/grass/farmland polygons; 120000 budget spread area-proportionally across all fields (steps scale up together when over budget, so no field is left bare) |
| [sprite-label.js](sprite-label.js) | `makeLabelSprite(text, heightM, accent)` — rounded-rect CanvasTexture pill in a camera-facing Sprite; shared by settlement titles and sandbox marker labels |

### Tactical sandbox (`sandbox/`)

Authoring tools layered on top of the read-only scene — draw, mark, destroy, fortify,
export. See "Tactical sandbox" below for the conventions.

| File | Responsibility |
|---|---|
| [sandbox/sandbox.js](sandbox/sandbox.js) | `Sandbox` — the only sandbox class `main.js` touches: active tool state machine, annotation group, undo stack, selection, toolbar wiring, serialise/deserialise, `reDrape` fan-out |
| [sandbox/picker.js](sandbox/picker.js) | The one `Raycaster`: `pickTerrain` / `pickBuilding` / `pickAnnotation` / `pickSurface`, plus `attachPointerHandlers` (click-vs-orbit-drag discrimination) and `ScreenSampler` (freehand point thinning) |
| [sandbox/arrows.js](sandbox/arrows.js) | `buildDrapedArrow` — Catmull-Rom-smoothed, terrain-draped advance arrows (tapered shaft + wedge head) and dashed phase lines, unlit with a dark outline layer |
| [sandbox/markers.js](sandbox/markers.js) | Red/blue map markers (canvas teardrop billboard, tip on the marked point) or symbol-head markers, text labels, foxhole positions; ground- or roof-anchored |
| [sandbox/unit-icons.js](sandbox/unit-icons.js) | Places the **real** APP-6 symbol PNGs from `images/ru/` and `images/ua/` — the same icons the main map draws on its unit markers — as bottom-anchored billboards |
| [sandbox/symbols.js](sandbox/symbols.js) | Hand-drawn APP-6-lite glyphs on CanvasTextures (hostile diamond / friendly rectangle × infantry, mech, armour, AT, MG, arty, OP, HQ), used for the Marker tool's optional symbol head. For real symbology prefer the Unit tool |
| [sandbox/damage.js](sandbox/damage.js) | Staged building damage (intact → gutted shell → rubble), footprint-clipped scorch, merged rubble piles, impact craters |
| [sandbox/obstacles.js](sandbox/obstacles.js) | Composite obstacle belts: dragon's teeth (InstancedMesh, 3 staggered rows), barbed-wire concertina (helix `TubeGeometry` + instanced stakes) and anti-tank ditches (a cross-section swept along the path). One drawn line can carry any combination — `laneLayout()` places them in parallel lanes. All are **passive**: obstacles belong to no side, so there is deliberately no `side` option |
| [sandbox/paint.js](sandbox/paint.js) | `TerrainPaint` — a full-tile paintable overlay (clone of the terrain geometry + a canvas texture you stamp soft dabs into). Instantiated twice: red/blue control paint, and the eraser's scorch |
| [sandbox/eraser.js](sandbox/eraser.js) | Zone eraser brush: hides trees, flattens buildings to rubble and scorches the ground over a painted area. One drag = one undo step |
| [sandbox/export.js](sandbox/export.js) | High-res PNG capture with an optional poster title block (title, date/coords, scale bar, north arrow), plus JSON download/upload helpers |

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
  uses `buildings.footprints`, not meshes. Because of the merge, a raycast hit
  is resolved back to a building by `buildings.buildingAt(mesh, faceIndex)` —
  the geometries are non-indexed, so vertex index = `faceIndex * 3`, and
  `wallPick`/`roofPick` binary-search the per-style vertex-range starts.
  Wall materials are `DoubleSide` so a roofless (sandbox-damaged) building
  reads as a hollow shell instead of paper-thin slivers.

## Tactical sandbox (`sandbox/`)

Authoring layer for illustration stills: terrain-following arrows and phase lines,
red/blue markers (pin or APP-6-lite symbol head, optional label), foxholes, staged
building destruction, impact craters, barbed wire and dragon's teeth, plus high-res
PNG export and save/load. Toolbar is `#sandbox-toolbar` in
[3d-view.html](../../3d-view.html); keys `1`–`0` pick a tool, `Esc` returns to
Select, `Delete` removes the selection, `Ctrl+Z` undoes.

- **Picking is gated on camera mode.** `sandbox.setEnabled(false)` runs whenever
  walk / drone / free camera is on (`syncSandbox()` in `main.js`) — those modes own
  the pointer. The toolbar greys out.
- **Click vs. orbit drag**: `attachPointerHandlers` only reports a click when the
  pointer went down and up within 5 px and 400 ms. Freehand line drawing is opt-in
  (the "Freehand drag" checkbox) and disables `controls` from a **capture-phase**
  `pointerdown` so OrbitControls never starts rotating.
- **Picker updates `camera.matrixWorld` before every ray** — raycasting after a
  programmatic camera move but before the next render otherwise places things
  somewhere else entirely.
- **Everything must implement re-drape.** `sandbox.reDrape(terrain)` is called from
  the exaggeration slider next to `features.forEach(...)`. Arrows/craters re-drape
  per vertex, markers re-derive Y from `userData.localX/localZ` (or the attached
  building's `wallTopY`), and obstacle belts are **rebuilt** from
  `userData.points` — the concertina helix and per-tooth rotations both depend on
  the terrain.
- **Arrow layers use `depthWrite: false`.** The fill and its dark outline sit ~5 cm
  apart, which the depth buffer cannot separate at multi-kilometre view distances;
  without this they z-fight into stripes. `renderOrder` (1 outline, 2 fill) keeps
  the stacking right, and they still depth-test against the terrain.
- **Destruction mutates the merged building geometry in place.** Collapsing a
  vertex range to a single point makes those triangles zero-area (invisible) with
  no rebuild. The pre-damage vertices are snapshotted into `record._orig` on first
  mutation and restored on undo, shifted by `record.baseY - _orig.baseY` so undo
  survives an exaggeration change in between. Per-vertex jitter uses a hash of the
  vertex index, so re-applying a state reproduces the same ruin exactly. State 2
  also removes the footprint from `buildings.footprints` (walk-mode collision).
- **Scorch follows the footprint, not a circle** — it reuses `buildDrapedOverlay`
  from `ribbon.js` (which needs `[lng,lat]`, hence the `proj.toLatLng` round-trip).
  A circular scorch swallows the neighbours on any large or L-shaped building.
- **Unit icons come from `images/{ru,ua}/icon-N.png`** — the same PNGs the main map
  puts on its unit markers (`getUnitIcon` in `ui-bindings.js` parses the KML
  `styleUrl` to build that path). The main map enumerates the available ids from
  whatever appears in the day's KML (`dashboard._dailyIconIds`); this page has no
  KML, so `UNIT_ICON_COUNTS` in `unit-icons.js` states the ranges — **ru 1–96,
  ua 1–57, both contiguous**. Add icons to those folders and bump the counts.
  The toolbar's Side buttons drive the palette: red → `ru`, blue → `ua`.
  Icon textures are **cached and shared** between placements, so they are flagged
  `userData.sharedTexture` and `disposeMarker` skips them — disposing one would
  blank every other unit using the same symbol.
- **A belt is a slot sequence, and ditches are its backbone.** Real lines are one complex
  obstacle built in parallel, so `laneLayout()` lays out ordered slots one Width apart,
  enemy side first:

  | ditches | cross-section |
  |---|---|
  | 0 | `teeth+wire` |
  | 1 | `ditch · teeth+wire` |
  | 2 | `ditch · teeth+wire · ditch` |
  | 3 | `ditch · teeth+wire · ditch · wire · ditch` |

  Rules: lay the ditches out; insert the teeth just behind the forward ditch; drop a wire
  lane into any gap left **between two adjacent ditches** (which is what produces the
  3-ditch tail — at 2 ditches the teeth already fill the only gap); optionally bookend
  with wire front/behind. Offsets come from the slot index measured from the teeth, so
  the drawn line is always the teeth centreline — or from the leading slot when teeth are
  unticked, which puts a lone ditch exactly on the line drawn. Wire also threads between
  the tooth rows whenever both are present: infantry is the threat wire answers, so it
  belongs on the teeth rather than strewn through every gap. Wire alone degenerates to a
  single centreline coil — the pre-belt Wire tool, unchanged.
  A lane is just the same builder fed a laterally shifted path (`offsetRun`), so the
  three builders know nothing about belts.
- **All ditches share one berm handedness**, from the Friendly side control — a belt
  faces one way, so the spoil is not mirrored per flank.
- **Lanes of the same type are built in one call.** `populate()` batches by
  `type:mirror` before calling a builder, which lets `buildWire` merge every coil in the
  belt into a single mesh. Without it a full belt was 45 meshes and ~1.17 M triangles;
  batching plus cheaper coil tessellation (`COIL_SAMPLES_PER_TURN` 6 on a 3-sided tube)
  brings that to **5 meshes** and roughly half the triangles. Note frame rate cannot be
  measured under swiftshader — it renders seconds per frame regardless — so triangle and
  draw-call counts are the metrics to watch here.
- **A mirrored ditch walks its profile backwards.** Negating the across-path offset alone
  would reverse the quad winding and light the trough from underneath, so `buildDitch`
  reverses the profile index at the same time, keeping offsets ascending either way.
- **Belt options are stored as semantics, never as derived lanes** —
  `{ components, ditchCount, friendlySide, wireFront, wireBehind, width, scale }`.
  `migrateBeltOpts()` normalises three vintages: current, the first belt round
  (ditches lived in `components` with `ditchesPerSide`/`ditchSide`), and pre-belt
  `{type, scale}`. Obstacle `opts` is
  serialised wholesale and passed straight back into `buildObstacleBelt()`, so save/load
  needed no changes; saves written before belts existed carry only `{type, scale}` and
  fall through to the single-component path.
- **Anti-tank ditches are geometry, never carved into the heightmap.**
  `carveTrenches` uses a 4 m reach but the heightmap cell is `SCENE_SIZE / 256`
  ≈ **23.4 m** on a 5 km tile, so a cut that width is far below grid resolution
  (and `-=` / `+=` make it non-idempotent). `buildDitch` instead sweeps a
  five-point cross-section — berm crest, near lip, floor ×2, far lip — along the
  draped path. `flatShading` plus per-band vertex colours are what make it read as
  an excavation rather than a painted stripe.
- **The paint overlay clones the terrain geometry and re-drapes by copying Y.**
  Heightmap index == terrain vertex index, so `TerrainPaint.reDrape` is an exact
  index-for-index Y copy, not a re-sample. The clone gets **plain 0..1 grid UVs**
  because the terrain's own UVs are re-fitted to Mercator by `_applyMercatorUVs`
  once satellite imagery loads. Watch the V convention: the vertex UVs use
  `v = 1 - iz/segments` and `CanvasTexture` already flips Y, so the canvas stamp
  must **not** flip again — doing both mirrors the paint in Z.
- **Hidden trees need the `hidden` map, not just a zeroed matrix.**
  `VegetationFeature.reDrape` decomposes every instance matrix, and a zero-scale
  matrix decomposes to a degenerate quaternion. `setHidden` therefore stores the
  original matrix (rotation and scale are randomised at build time and live
  nowhere else) and `reDrape` re-grounds that saved copy instead. `p.instanceIndex`
  is now recorded at build time so nothing depends on placement array order.
- **The eraser saves circles, not tree indices.** The vegetation scatter is
  re-randomised on every load, so a saved index list would clear an essentially
  random set of trees. `Eraser.serialize()` stores the painted `{x, z, r}` dabs and
  `load()` replays them, which reproduces the same cleared area; buildings still
  resolve through their own stable `record.id`.
- **Markers and unit icons are billboards at constant screen size.** 3D pin geometry reads as a
  stray line at map scale, so the marker is a canvas-drawn teardrop `Sprite` with
  `center.set(0.5, 0)` — its tip is exactly the marked point. `sandbox.update()`
  (called each frame from `animate()`) scales each marker by its distance to the
  camera, which cancels out perspective and keeps it the same size on screen from
  street level to a 5 km overview. The Size slider multiplies on top.
- **Obstacles have a display `scale`.** Real dragon's teeth are ~1.1 m tall and
  vanish in a 5 km overview shot, so the Size slider blows the whole belt up
  proportionally (same spirit as `vegetation.setZoomScale`). 1× is true scale;
  the OSM `fortifications` layer uses a fixed 2×. Positions are always true —
  only the objects standing on them are drawn larger.
- **River name labels lie flat along the water's course**, like a printed map
  label — a subdivided plane draped vertex-by-vertex (a single-height quad would
  punch through a valley side), yawed to the local bearing and flipped 180° when the
  course heads west so the text is never mirrored.
- **River names use OSM `name:en`, with the local `name` as fallback.** Analysis
  refers to rivers by transliteration ("Bakhmutka", "Donets"), which is exactly
  what `name:en` carries — it is set on 32 of the 35 named rivers across the
  Donbas box. Small streams usually only have the Cyrillic `name`, so some labels
  render in Cyrillic; that is the data, not a bug. Labels are **grouped by name**
  because OSM splits a river into many ways — without that, one river produces a
  dozen stacked labels. Rivers outrank canals outrank streams when `MAX_LABELS`
  runs out.
- **Built obstacles come from PlayFra, not OSM.**
  `https://playframap.github.io/{wire,teeth}.geojson` — the same files the 2D map's
  "Wire" / "Dragon teeth" toggles load through `DeepUtils.loadFeatures`
  (js/utils.js), which is also where the base URL lives if it moves again.
  Coverage is ~11k wire and ~9.5k teeth MultiLineStrings nationwide. (OSM was
  evaluated and rejected: `fence_type=barbed_wire` has ~76 ways on the entire
  front and `barrier=tank_trap` just **2**. `barrier=block` nodes are urban
  bollards, not teeth.)
- **The obstacle files are several MB, so both layers are lazy.** `load()`/`build()`
  are no-ops; `ensure(terrain, proj, bbox)` fetches, filters to the tile bbox and
  builds on the first tick of the checkbox, which is disabled meanwhile. The parsed
  file is cached in-module, so the second layer and any re-toggle cost nothing.
  A dense sector yields hundreds of belts (~273 teeth at 48.265, 37.185), each one
  InstancedMesh, hence `BELT_CAP` — longest lines first.
- **Screenshot export needs `preserveDrawingBuffer: true`** on the renderer
  (set in `main.js`) — without it `toDataURL` returns a blank image. The panel and
  toolbar are DOM overlays, so they are never in the capture.
- **Annotations serialise as lat/lng** so a saved scene survives a change of tile
  size or origin. Damaged buildings are keyed by `record.id` = footprint centroid
  rounded to 0.5 m — nothing stable survives the building merge, so a scene loaded
  against different building data skips unmatched ids with a console warning.
  A debounced autosave goes to `localStorage` per `lat,lng,size`, offered on load.

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

Tactical sandbox (August 2026): picking layer (`sandbox/picker.js`) plus the
authoring tools — terrain-following arrows and phase lines, pin/symbol markers
with labels, unit symbols placed from the map's own APP-6 icon set (on the
ground or on a building roof), foxholes, staged building destruction with rubble and scorch,
impact craters, barbed wire and dragon's teeth (drawn, or laid along every ditch
in one click), undo/select/delete, high-res PNG export with a poster title
block, and JSON save/load with localStorage autosave. A `fortifications` layer
renders the obstacles that are actually surveyed in OSM (see the coverage note
above) with the same builders.

**Explicitly out of scope / not implemented** (don't start without the user
asking):
- GLTF tree models (requires sourcing/committing binary assets)
- Frontline/occupation overlay, ditch date-diffing (`?dateStart=`),
  quality presets + URL state, minimap inset
- Smoke/fire particles on destroyed buildings

Known pre-existing issue: `features/water.js` requests `waternormals.jpg` from a
jsdelivr path that 404s for r165, so the water shimmer normal map never loads
(the water still renders).

All work so far is uncommitted on the `3dview` branch.

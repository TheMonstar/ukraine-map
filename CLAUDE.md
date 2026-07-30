# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Project: Ukraine Frontline Map

Interactive geospatial SPA for analyzing Ukraine conflict frontlines, territorial control, and military positions. Pure frontend JavaScript — no build step, no bundler, no npm.

### Running Locally

```bash
open index.html
# or, if browser blocks file:// fetch requests:
python3 -m http.server 8080
```

### Deployment

Push to `main` → GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) auto-deploys to GitHub Pages. No build step.

---

### Architecture

`AttackMapDashboard` (`js/app.js`) is the root controller. It instantiates all other classes and passes itself as `dashboard`. Modules do not reference each other — all cross-module coordination goes through `dashboard`. `UiBindings` owns all DOM event wiring.

| Module | Class | Responsibility |
|--------|-------|----------------|
| [js/app.js](js/app.js) | `AttackMapDashboard` | Root controller — map init, date state, layers, geographic data |
| [js/ui-bindings.js](js/ui-bindings.js) | `UiBindings` | All DOM event handlers and UI state (100+ bindings) |
| [js/map-layers.js](js/map-layers.js) | `MapLayers` | Basemaps, tile overlays, frontline/event/settlement layer management |
| [js/settlements.js](js/settlements.js) | `Settlements` | Settlement markers, search, population-based filtering |
| [js/line-features.js](js/line-features.js) | `LineFeatures` | Roads/waterways/railways — lazy per-class loading, canvas rendering, viewport filtering, road path finding |
| [js/map-uml-engine.js](js/map-uml-engine.js) | `MapUMLEngine` | Text-syntax parser/renderer for tactical diagrams |
| [js/draw.js](js/draw.js) | `DrawingTool` | Freehand and geometric drawing (state machine: idle→p1drag→p2wait→p2drag) |
| [js/utils.js](js/utils.js) | `DeepUtils` | DeepStateMap API calls, geodesic area calculation, LRU cache (30 entries, ~18 MB) |
| [js/hex-tiles.js](js/hex-tiles.js) | `HexTiles` | Hexagonal grid generation and occupation analysis |
| [js/geometry-utils.js](js/geometry-utils.js) | `GeometryUtils` | GeoJSON ↔ Leaflet coordinate conversions |
| [js/data-store.js](js/data-store.js) | `DataStore` | Data source stubs (private data removed in public version) |

Script load order in `index.html` matters — CDN libraries first, then `utils.js` → ... → `app.js`. `window.dashboard` is set at end of `index.html`.

### Key External Endpoints

| Purpose | URL |
|---------|-----|
| Territory control GeoJSON | `https://flask-app-kibakefmpq-ew.a.run.app/geojson-by-date?date=YYYY-MM-DD` |
| Fortification features | `<API_BASE_URL>/ditches.geojson` |
| Military events | `<API_BASE_URL>/events` |
| Settlements | `https://storage.googleapis.com/telegram-reader-static/static/settlements.json` |
| Roads / waterways / railways | `<APP_STATIC_URL>/{roads,water,rail}-*.json` — slim per-class files built by [tools/slim_geodata.py](tools/slim_geodata.py), served gzipped |

`API_BASE_URL` is defined at the top of [js/app.js](js/app.js).

### CDN Libraries (no install needed)

- **Leaflet 1.9.4** — base mapping
- **turf.js v6** — spatial analysis (area, union, intersection, hexGrid, pointInPolygon)
- **noUiSlider 15.7.1** — date range slider
- **Leaflet Draw 1.0.4** — polygon/shape drawing
- **Leaflet MarkerCluster 1.5.3** — clustered unit markers
- **toGeoJSON 4.4.1** — KML/GPX import
- **PapaParse 5.4.1** — CSV parsing

### Coding Conventions

- ES6+ classes; no modules — globals shared via `window` and instance references
- All CSS custom properties in [css/main.css](css/main.css); dark sidebar + light map theme
- **Coordinate order**: GeoJSON uses `[lon, lat]`, Leaflet uses `[lat, lng]` — `GeometryUtils` converts between them. Always be explicit.
- Expensive operations (hex tile redraw, ditch reload) are debounced in `UiBindings`

### Adding New Features

1. **New layer/overlay** — add to `MapLayers`, expose a toggle method, wire it in `UiBindings.register()`
2. **New UI control** — add HTML to `index.html`, bind in `UiBindings.register()`
3. **New API call** — add fetch logic in `utils.js` or `app.js`; follow the LRU cache pattern in `DeepUtils`
4. **New drawing mode** — extend the state machine in `draw.js`

### MapUML Syntax

Text entered in the MapUML panel is parsed by `MapUMLEngine`:

```
title Operation Example
regions Bakhmut, Avdiivka

ru attacker 5th Brigade
ua defender 93rd Brigade
settlement Chasiv Yar

ru advance Bakhmut->Chasiv Yar->W
ua objective Chasiv Yar->Kostiantynivka
ru note "Main axis" at Bakhmut
```

### Tactical Regions

Predefined in `regionCoordinates` in `app.js`: `Kharkiv`, `Kupiansk`, `Lyman`, `Kreminna`, `Bakhmut`, `Avdiivka`, `Donetsk`, `Zaporizhzhia`, `Kherson`. Used in hex tile border construction (`HexTiles.getBorderShape()`) and diff-area calculations.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

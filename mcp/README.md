# ukraine-map MCP server

Lets an AI open the frontline map, read what is currently on it, draw tactical graphics,
**look at a screenshot of its own output**, and correct itself.

It drives a real Chromium via Playwright. The app itself is never modified — all coupling
lives in [`browser/agent-api.js`](browser/agent-api.js), injected into the page at load.

## Install

```bash
cd mcp
npm install
npx playwright install chromium     # if Chromium isn't already present
```

Register it:

```bash
claude mcp add ukraine-map -- node /absolute/path/to/ukraine-map/mcp/server.js
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "ukraine-map": { "command": "node", "args": ["/absolute/path/to/ukraine-map/mcp/server.js"] }
  }
}
```

## The loop

```
map_open                                    # starts python3 -m http.server 8080 if needed
map_set_view   { region: "Pokrovsk", zoom: 11 }
map_list_features { kind: "units" }         # see what's actually there before drawing
map_draw_axis  { from: "Pokrovsk", to: "Myrnohrad", side: "ru", curve: 0.35, label: "Main axis" }
map_encircle   { around: "Myrnohrad", radius_km: 4, side: "ru", fill: true, label: "Pocket" }
map_screenshot                              # LOOK at it, then adjust
```

`map_screenshot` is the point of the whole design. Placement, scale and label collisions are
not reliably predictable from coordinates — take the picture and fix what's wrong.

## Tools

| Group | Tools |
|---|---|
| Lifecycle | `map_open` `map_screenshot` `map_close` |
| Read | `map_get_state` `map_find_place` `map_list_features` `map_list_regions` `map_list_layers` |
| View / time / layers | `map_set_view` `map_set_dates` `map_set_layers` |
| Draw (semantic) | `map_draw_axis` `map_encircle` `map_area` `map_line` `map_mark` `map_label` |
| Planning graphics | `map_place_icon` `map_objective` `map_phase_line` `map_boundary` |
| Terrain-aware | `map_front_line` `map_elevation` |
| Presentation | `map_poster` `map_export` |
| Draw (primitive) | `map_draw_shapes` `map_erase` `map_undo` |
| Persistence | `map_save_session` `map_load_session` `map_share_link` |

`map_list_features` accepts `settlements`, `units`, `events`, `ria_events`, `owl_events`,
`modr`, `territory`, and clips to the current viewport unless you pass a `bbox`.

## Conventions

**Coordinates are `[lat, lng]`, everywhere.** DrawingTool works in `[lat, lng]`; the
settlements GeoJSON is `[lng, lat]`. The flip happens in exactly two places —
`toLatLng` in `browser/agent-api.js` and `fromGeoJSON` in `geo.js`. Don't add a third.

**Ownership.** Every shape this server draws is tagged `owner: 'ai'`, reusing the field
`js/stream.js` already attaches for co-host shapes. That is what makes
`map_erase { scope: "ai" }` safe: it removes the AI's work and leaves the user's hand
drawings alone. `scope: "all"` does not discriminate.

**Colours** come from `MapUMLEngine.colors`, so AI output matches the app's own palette:
`ru` = `#d0021b` (red), `ua` = `#4a90e2` (blue), `neutral` = `#f5a623` (orange).
Any `color` argument overrides `side`.

**Place names** resolve through `MapUMLEngine.findCoordinates`, with one correction: an
exact settlement match always wins over the engine's first substring hit. Without it,
`"Pokrovsk"` resolves to `"Pokrovske"` ~800 km away. `map_find_place` returns ranked
`alternatives` — check them when a name is ambiguous.

## Making it look published

`map_poster` adds a title block and a legend; `map_export` captures at 2x. Together they
turn a screenshot into a deliverable.

```
map_set_view  { center:[48.62,37.72], zoom:10, basemap:"mapbox-kirk" }   # OpenTopo: contours + green landcover
map_area      { places:[...], side:"ru", pattern:"hatch" }               # terrain reads through a hatch
map_draw_axis { from:"Toretsk", to:"Kostiantynivka", side:"ru",
                style:"freehand", taper:true, thickness:7 }              # wedge arrow, one smooth sweep
map_poster    { title:"...", dateline:"...", caveat:"...", legend:{auto:true} }
map_export    { path:"plan.png", scale:2 }
```

Two things that make the difference between "annotated screenshot" and "published map":
**`taper: true`** on axes (constant-width strokes are the giveaway) and **`pattern`** on
control areas (a flat fill hides the ground it is describing).

**The legend is derived from what is drawn**, so it cannot drift out of sync. Call `map_poster`
once with no `rows` to see the derived labels, then rename them by label:
`rows: [{ match: "Russian area", label: "Contrôle russe" }]`. Matching is by label, never by
position, so re-drawing does not scramble the legend. `{ match: "...", hide: true }` drops a row.

While a title block is showing, the app's own date pill is hidden — the poster carries its own
dateline.

## Making it look natural, not synthetic

The single biggest quality lever. Straight lines between place names and convex hulls
over place points are what make a generated map look fake.

**Draw the real front, don't approximate it.** `map_front_line` reads the loaded DeepState
control boundary and renders it as a flowing dashed line. It is actual data, so it is
naturally sinuous — never hand-draw or hull a front line.

```
map_set_layers  { "diff-area": true }        # load the territory layer first
map_front_line  { thickness: 4 }
```

**Route axes over ground, not over the page.** `follow` on `map_draw_axis`:

| value | behaviour |
|---|---|
| `none` | straight or arc between waypoints |
| `terrain` | least-cost path over the Terrarium DEM — prefers valleys and saddles, avoids ridge climbs |
| `roads` | routes along the real road network via the app's road graph |

Over flat steppe a terrain route is *correctly* near-straight — the Donbas floor runs
50–70 m for tens of kilometres. `map_elevation` tells you where the ground actually rises
(Chasiv Yar sits at 246 m over Sloviansk's 66 m), which is what justifies an axis.

**Build zones as corridors, not hulls.** Give `map_area` two or more places plus `width_km`
(and optionally `follow`) and it traces a corridor along the route between them. Hulling two
places always yields a fat lozenge; a corridor follows the actual line of effort.

```
map_area { places:["Siversk","Sloviansk"], follow:"terrain", width_km:7,
           side:"ru", pattern:"hatch", pattern_angle:45 }
```

**Give overlapping zones different `pattern_angle`s** (45, 135, 0, 90) so they stay readable
where they cross. Polygon outlines are spline-rounded by default (`smooth:false` for hard edges).

## Shape reference (`map_draw_shapes`)

| type | required | notes |
|---|---|---|
| `freedraw` | `points[]` | polyline |
| `polygon` | `points[]` | closed; `fill`, `fillOpacity` optional |
| `line` / `arrow` | `start`, `end` | `arrow` draws a head at `end` |
| `ellipse` / `rect` | `p1`, `p2`, `p3?` | `p1→p2` is the major axis, `p3` sets half-width |
| `arc` | `p1`, `p2`, `p3?` | `p1→p2` is the chord, `p3` the bulge; `head: true` adds a tangent arrowhead |
| `text` | `p1`, `p2`, `text` | `p1→p2` sets the baseline angle; `fontSize`, `halo`, `bold` optional |
| `icon` | `at`, `icon` | a PNG from `images/events/`; `size`, `label` optional |

All shapes take `color`, `thickness` and `dash` (except `text`, which takes `color`,
`fontSize` and `halo`). `freedraw` and `arc` also take `head` and `taper`; `polygon` also takes
`pattern` (`hatch`, `crosshatch`, `dots`) and `patternOpacity`.

Text halos default to automatic contrast — white behind dark text, dark behind light — so a
white label never disappears into a white halo. Pass `halo: null` to disable.

Everything here is plain JSON on `drawTool.shapes`, so it round-trips through session
save/load and the PeerJS live stream unchanged.

## Notes

- `file://` is rejected — the app fetches JSON and needs an http origin.
- `map_open` defaults to `headless: false` so the user can watch the map being drawn.
- `map_screenshot` is the cheap feedback tool (JPEG, CSS resolution, ~380 KB). `map_export` is
  the deliverable (PNG at 2x device resolution, several MB).
- The browser renders at `deviceScaleFactor: 2` and the drawing canvas is devicePixelRatio-aware,
  so exported linework and halos are retina-sharp.
- `map_load_session` only accepts the app's version-1 session format.

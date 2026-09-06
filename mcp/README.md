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

## Working fast

The loop above is the honest description of the design. This section is the production
recipe — what to do to get a publishable illustration in one or two screenshot cycles
instead of six. Everything here was learned by doing it the slow way first.

### Resolve every place before drawing anything

**Coordinates work, but only in the labelled form.** `[Label: lat, lng]` resolves; a bare
`[48.74, 37.58]` or `48.74, 37.58` does **not** — see `findCoordinates` in
`js/map-uml-engine.js`. Any resolver param takes it:

```
map_mark  { at: "[SE outskirts: 48.5635, 35.7995]", label: "lodgement" }
map_draw_axis { from: "[start: 47.784, 36.327]", to: "Zlahoda" }
```

This matters more than it looks. Reports name streets, treelines, river confluences and
"2.5 km northeast of X" — none of which are settlements. Without the literal form the only
way to place them is to hand-generate polygon vertices and push them through
`map_draw_shapes`, which is slow and unreadable.

**Names rank by population, not by proximity.** The sort is `exact → starts → population`,
with no reference to where the map is looking. `Березове` framed on Novopavlivka returns a
village 700 km away; `Ставки` near Lyman returns the Vinnytsia one. So:

- resolve **all** names up front, in a batch of parallel `map_find_place` calls
- for any common name (`Мирне`, `Павлівка`, `Шевченко`, `Новомиколаївка`, `Степове`,
  `Федорівка`, `Привілля`) pass `limit: 15–40` and pick the candidate nearest your sector
- keep the chosen `[lat, lng]` and pass it back as `[Name: lat, lng]` — never re-resolve a
  name you have already disambiguated

**Faster than either:** frame the sector, turn on `show-settlements` with the `mapbox-kirk`
basemap, and take one screenshot. At z11–z12 the labels give you twenty place positions at a
glance, and reading coordinates off that picture beats twenty `map_find_place` round trips.

### Pick the frame from the content extent

Zoom determines the span, so compute it from the bounding box of what you must show:

| zoom | lon span | lat span |
|---|---|---|
| 10 | ~1.81° | ~0.84° |
| 11 | ~0.906° | ~0.427° |
| 12 | ~0.453° | ~0.214° |

Fractional zoom is silently snapped to an integer — if the content falls between two zooms,
either drop a peripheral feature or split into two maps.

Once framed, `map_get_state` gives `bounds`, and a `map_screenshot` is 1320 × 911:

```
x = (lon − west)  / (east − west)  × 1320
y = (north − lat) / (north − south) × 911
```

That converts a label's lat/lng to the pixel it will land on, which is how you place text
without a screenshot cycle. Text renders rightward from `p1` at roughly `fontSize × 0.5`
pixels per character.

**Keep two rectangles clear.** The title block occupies roughly `x < 530, y < 190`; the
legend occupies `x < 440, y > 700`, growing with the longest row. Content that lands there
will be covered. Shortening a legend label is usually cheaper than re-framing.

### Draw in one batch, then look once

Each semantic tool is its own round trip and its own full canvas repaint. For a
twenty-element plan, compute the geometry first and push it all through a single
`map_draw_shapes` call — areas, arrows and text together. Then set the view, then screenshot.

Order matters, because a later step invalidates the earlier ones:

```
1. map_open, map_set_layers (preset), map_set_dates      # session defaults reset on open
2. resolve places / read them off one screenshot
3. compute geometry (rings, corridors, dash runs)
4. map_draw_shapes  — everything, one call
5. map_set_view     — frame it
6. map_screenshot   — verify placement and collisions
7. map_poster       — title + legend last, once the frame is settled
8. map_export
```

Set layers before drawing: `map_open` comes back with `show-settlements` off and
`show-date-overlay` on, and the basemap reset — so a map drawn before the preamble looks
wrong for reasons that have nothing to do with the graphics.

### Label budget

Six to nine short labels is the working limit for a 1320 × 911 frame. Past that, they
collide and every fix moves two others. Push detail into the poster `subtitle`, `caveat` and
legend rows, which have their own space and never collide with the map.

Check the **end** of every label, not just its anchor: text runs rightward from `p1`, so a
34-character label at `fontSize: 14` needs ~240 px of clear space. Anchoring one near the
eastern edge silently truncates it off-frame.

**Don't let `map_encircle` place labels when rings are close together.** Its auto-placed label
cannot be moved without erasing the ring, and adjacent rings put their labels on each other.
Draw the rings unlabelled and place the text with separate `map_label` calls.

### Formations: use plates, not text

A red text label saying "120th Naval Inf Div here" is worse than the insignia plate for the
same formation — the plate carries echelon and arm of service in one glyph and matches how the
observed-position layers already draw units.

**Never guess an `icon` id.** Echelon is encoded in the symbol, so a brigade id on a division
is a factual error a reader will catch. Pass `unit` with the formation name and let the tool
look up its real insignia:

```
map_set_layers { "feature-positions-ru": true }        # required for name lookup
map_add_unit   { at: "[triangle: 47.84, 36.545]", side: "ru",
                 unit: "120th Naval Infantry Division", label: "120 ДМП" }
map_set_layers { "feature-positions-ru": false }       # your plates stay; observed units hide
```

Check `matchedUnit` in the response. A name means the lookup worked; `null` means it fell back
to whatever `icon` you supplied, which is exactly the case where the echelon will be wrong.

For reference, the RU ids differ by echelon in the way you would expect — motor rifle brigade 3
vs division 11, naval infantry brigade 27 vs division 38, tank division 15, air assault
division 20 — so brigade↔division substitutions are always visible.

**Don't call `map_list_unit_icons` to browse.** It returns the entire name→insignia map, ~1600
entries and ~97 KB, in one response. Two better routes:

- `map_list_features { kind: "units" }` is clipped to the viewport and returns the formations
  actually in your sector with their `icon` ids — usually 10–25 rows, and the right answer when
  you want to match a new plate to its neighbours.
- If you do need the full map, the oversized response is written to a file; `grep` it for the
  formation rather than reading it back.

Added plates are visually identical to observed ones, so say so in the poster `caveat` whenever
you place a formation the source only *names* rather than locates.

### Traps that cost a redraw

| symptom | cause | do this |
|---|---|---|
| dashed axis renders solid | `dash` is ignored when `taper: true` — the tapered path is *filled*, and `setLineDash` only affects strokes | emit the shaft as short segments plus one tapered head, or drop `taper` |
| title / dateline / caveat vanish | `map_poster` replaces the title block; passing only `subtitle` clears the rest | always send all four title fields together |
| `&` shows as `&amp;` | poster text is injected as markup | write "and" |
| legend has four rows called "Axis of advance" | `auto` derives generic labels and `rows[].match` matches *by label*, so duplicates cannot be renamed apart | use `legend: { auto: false, rows: [...] }` for anything published |
| `map_set_view` returns the old centre/zoom | the state read races the map move | trust the screenshot, not the return value; re-issue the call if the frame is wrong |
| two front lines on one map | `map_front_line` drawn while `diff-area` is on | pick one: the layer, or the line |
| an axis silently spans two oblasts | endpoint resolved to a same-named place elsewhere | check `alternatives`; `map_infiltration_route` will refuse outright with a corridor-size error |

### When the report names something the gazetteer doesn't have

Small hamlets, renamed villages and terrain features frequently miss. Do not substitute a
same-named settlement from another oblast, and do not invent a position. Draw the axis short,
stopping where the evidence stops, and carry the missing name in the label text. Say which
names went unplaced when handing over the map.

## Tools

| Group | Tools |
|---|---|
| Lifecycle | `map_open` `map_screenshot` `map_close` |
| Read | `map_get_state` `map_find_place` `map_list_features` `map_list_regions` `map_list_layers` |
| View / time / layers | `map_set_view` `map_set_dates` `map_set_layers` |
| Draw (semantic) | `map_draw_axis` `map_encircle` `map_area` `map_line` `map_mark` `map_label` |
| Planning graphics | `map_place_icon` `map_objective` `map_phase_line` `map_boundary` |
| Units | `map_add_unit` `map_list_unit_icons` |
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

Ranking is `exact → starts → population`, with no reference to the current viewport, so a
common name resolves to the largest settlement in the country rather than the one you are
looking at. Any resolver param also accepts a literal **`[Label: lat, lng]`** — the label is
required, a bare `[lat, lng]` does not parse. See [Working fast](#working-fast).

## Placing units

Unit insignia live in `images/{ua,ru}/icon-N.png` — the same assets the daily-position
layers draw. `map_add_unit` renders one in the app's bordered-plate style, so an added
unit reads like an observed one.

```
map_set_layers      { "feature-positions-ua": true, "feature-positions-ru": true }
map_list_unit_icons                                  # ids in use + name -> insignia map
map_add_unit        { at:"Kramatorsk", side:"ua", unit:"Presidential Brigade" }
map_add_unit        { at:"Druzhkivka", side:"ru", icon:20, label:"20 MRD" }
```

Give `unit` and the tool looks the formation up in the loaded layer and reuses **its own
insignia**; give `icon` to pick an id directly.

**Echelon sets the size.** `echelon: "army"` outranks `corps` outranks `division` outranks
`brigade`, down through regiment, battalion, company, platoon, section, squad and team — plate
size rises with the level, and the standard tick marks (XXXX, XXX, XX, X, III, II, I, •••) are
drawn above it. Aliases like `CAA`, `MRD`, `bde` and `bn` are accepted. Omit it and the tool
infers the echelon from the unit name where it can, reporting `echelonSource` so you know
whether it was told or guessed. `echelon_mark: false` keeps the sizing without the bar — worth
using when the formation's own insignia already carries its echelon, or the two will disagree. Without the positions layer loaded there is
no name→insignia mapping, and the tool says so rather than guessing.

`map_list_features { kind:"units" }` also returns each observed unit's `icon`, so you can
match a new marker to a neighbouring formation.

**Note:** an added unit is visually indistinguishable from an observed one. On a product that
mixes reported and asserted positions, say so in the `map_poster` caveat, or label added units
explicitly.

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

**With the DeepState layer on, the front is already drawn — leave it alone.** The `diff-area`
polygons *are* the line of contact, in colour, from data. Stroking `map_front_line` along their
edge adds a second line saying the same thing, and it reads as an operational graphic the
report never made. So:

```
map_set_layers  { "diff-area": true }        # the layer is the front — draw nothing over it
map_front_line  { thickness: 4 }             # ONLY when diff-area is off
```

Use `map_front_line` when the territory layer is deliberately hidden (a clean topo base) and
the sector still needs its boundary, or as a throwaway tracing reference you erase before
export. Never hand-draw or hull a front line in either case.

A line the report says was *reached* — ahead of the snapshot the layer is showing — is not a
front line and is worth drawing, but only if it is styled and labelled as a claim ("line
reached", solid dark red) rather than as control. If it merely retraces the layer's edge,
drop it.

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
| `unit` | `at`, `side`, `icon` | formation insignia from `images/{ua,ru}/icon-N.png` on a side-coloured plate; `label`, `size` optional |

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

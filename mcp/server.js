#!/usr/bin/env node
/**
 * MCP server for the Ukraine frontline map.
 *
 * Drives a real Chromium showing index.html via Playwright, so an AI can:
 *   read what is currently on the map → draw tactical graphics on it → screenshot
 *   the result → see its own output and correct itself.
 *
 * All app coupling lives in browser/agent-api.js, injected into the page at load.
 * The app itself is never modified.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as browser from './session.js';
import * as read from './tools/read.js';
import * as view from './tools/view.js';
import * as draw from './tools/draw.js';
import * as io from './tools/session-io.js';
import * as posterTools from './tools/poster.js';

const PLACE = 'A settlement name (English or Ukrainian, e.g. "Pokrovsk"), a unit name, or a literal [lat, lng] pair.';
const SIDE = { type: 'string', enum: ['ru', 'ua', 'neutral'], description: 'Colours the graphic with the app\'s own palette: ru = red, ua = blue, neutral = orange.' };
const COLOR = { type: 'string', description: 'Hex colour override, e.g. "#00ff88". Overrides `side`.' };

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
    // ── lifecycle ────────────────────────────────────────────────────────────
    {
        name: 'map_open',
        description: 'Open the Ukraine frontline map in a browser and wait for it to finish loading. Call this first. Starts a local static server if one is not already running.',
        inputSchema: obj({
            url: { type: 'string', description: 'Defaults to http://localhost:8080/index.html. file:// is not supported.' },
            headless: { type: 'boolean', description: 'Default false, so the user can watch the map being drawn.' },
            width: { type: 'number' },
            height: { type: 'number' },
        }),
        handler: (a) => browser.open(a),
    },
    {
        name: 'map_screenshot',
        description: 'Screenshot the map and return it as an image. Call this after drawing to SEE the result and correct placement, colour or scale. Cheap and lossy \u2014 use map_export for the finished product.',
        inputSchema: obj({
            selector: { type: 'string', description: 'CSS selector to clip to. Defaults to "#map" (map only, no sidebar).' },
            full_page: { type: 'boolean', description: 'Capture the whole page including the sidebar.' },
            png: { type: 'boolean', description: 'Return lossless PNG instead of JPEG. Much larger; only worth it for fine line detail.' },
        }),
        handler: async (a) => browser.screenshot({ selector: a.selector, fullPage: a.full_page, png: a.png }),
        returnsImage: true,
    },
    { name: 'map_close', description: 'Close the browser and stop the local static server.', inputSchema: obj({}), handler: () => browser.close() },

    // ── read ─────────────────────────────────────────────────────────────────
    {
        name: 'map_get_state',
        description: 'Current view (centre, zoom, bounds), date range, active layers and an inventory of drawn shapes. Use this to orient before drawing.',
        inputSchema: obj({}),
        handler: () => read.getState(),
    },
    {
        name: 'map_find_place',
        description: 'Resolve a settlement or unit name to coordinates, with ranked alternatives for disambiguation.',
        inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
        handler: (a) => read.findPlace(a),
    },
    {
        name: 'map_list_features',
        description: 'List what is currently loaded on the map — settlements, unit positions, events or territory control — clipped to the viewport by default. This is how you draw *based on the existing layout* rather than guessing.',
        inputSchema: obj({
            kind: { type: 'string', enum: ['settlements', 'units', 'events', 'ria_events', 'owl_events', 'modr', 'territory'] },
            bbox: obj({ north: { type: 'number' }, south: { type: 'number' }, east: { type: 'number' }, west: { type: 'number' } },
                      ['north', 'south', 'east', 'west']),
            limit: { type: 'number', description: 'Max items returned, default 150.' },
            viewport_only: { type: 'boolean', description: 'Default true — clip to the current view when no bbox is given.' },
        }, ['kind']),
        handler: (a) => read.listFeatures(a),
    },
    { name: 'map_list_regions', description: 'Named tactical regions available to map_set_view.', inputSchema: obj({}), handler: () => read.listRegions() },
    { name: 'map_list_layers', description: 'All toggleable layer ids and whether each is currently on.', inputSchema: obj({}), handler: () => read.listLayers() },

    // ── view / time / layers ─────────────────────────────────────────────────
    {
        name: 'map_set_view',
        description: 'Move the map and/or switch the basemap. Give one of place, region or center to move; basemap/topo_mode can be set on their own.',
        inputSchema: obj({
            place: { type: 'string', description: PLACE },
            region: { type: 'string', description: 'A named tactical region (see map_list_regions). Also draws its outline and area stats when one exists.' },
            center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[lat, lng]' },
            zoom: { type: 'number', description: '6 = whole country, 11 = operational, 13 = tactical.' },
            basemap: { type: 'string', description: "Basemap key. 'mapbox-kirk' is OpenTopo — contour lines and green landcover, the classic OSINT look. Others: carto (light), esri-elevation (satellite, default), osm, esri, mapbox, nasa-gibs." },
            topo_mode: { type: 'string', enum: ['off', 'color', 'bw', 'black-transparent'], description: "Relief shading over the basemap. Use 'black-transparent' \u2014 it shades by elevation while letting the basemap's own colours and labels through, so terrain reads without washing the map out. 'color' repaints the whole surface in a hypsometric ramp and fights with drawn graphics; prefer it only for pure elevation studies." },
        }),
        handler: (a) => view.setView(a),
    },
    {
        name: 'map_set_dates',
        description: 'Set the date range driving every time-based layer (territory diff, events, positions).',
        inputSchema: obj({ start: { type: 'string', description: 'YYYY-MM-DD' }, end: { type: 'string', description: 'YYYY-MM-DD' } }, ['start', 'end']),
        handler: (a) => view.setDates(a),
    },
    {
        name: 'map_set_layers',
        description: 'Turn map layers on or off by id. Use map_list_layers to discover valid ids.',
        inputSchema: obj({ layers: { type: 'object', description: '{ "show-settlements": true, "diff-area": false }', additionalProperties: { type: 'boolean' } } }, ['layers']),
        handler: (a) => view.setLayers(a),
    },

    {
        name: 'map_settlement_detail',
        description: 'Show the name label and/or administrative boundary outline for specific settlements. Unlike the show-settlement-names layer (which labels everything above a population threshold), this targets individual places \u2014 use it to name just the settlements an analysis actually references.',
        inputSchema: obj({
            places: { type: 'array', items: { type: 'string' }, description: 'Settlement names, English or Ukrainian.' },
            title: { type: 'boolean', description: 'Show the name label. Default true; false removes it.' },
            boundary: { type: 'boolean', description: 'Draw the administrative outline. Default false. Fetched on demand and cached; not every settlement has one.' },
            color: { type: 'string', description: 'Boundary colour, default #ff6600.' },
        }, ['places']),
        handler: (a) => view.settlementDetail(a),
    },

    // ── draw: semantic ───────────────────────────────────────────────────────
    {
        name: 'map_draw_axis',
        description: 'Draw an axis of advance as an arrow (or a curved arrow) from one place to another, optionally through waypoints.',
        inputSchema: obj({
            from: { type: 'string', description: PLACE },
            to: { type: 'string', description: PLACE },
            via: { type: 'array', items: { type: 'string' }, description: 'Intermediate places; each leg gets its own arrow.' },
            side: SIDE,
            curve: { type: 'number', description: 'Signed bulge as a fraction of chord length. 0 = straight arrow; ±0.2–0.4 = a natural curved axis. Positive bulges left of the travel direction.' },
            label: { type: 'string' },
            color: COLOR,
            thickness: { type: 'number' },
            dash: { type: 'boolean' },
            style: { type: 'string', enum: ['arc', 'freehand'], description: "'arc' (default) draws one arc per leg. 'freehand' fits a single smooth spline through every waypoint, so a multi-leg axis reads as one continuous sweep." },
            taper: { type: 'boolean', description: 'Wedge-shaped arrow \u2014 thin at the origin, thick at the head. This is what makes an axis look like a published operational graphic rather than a line.' },
            follow: { type: 'string', enum: ['none', 'terrain', 'roads'], description: "'terrain' routes over the elevation model, preferring valleys and saddles over ridge climbs. 'roads' routes along the real road network. Both produce naturally sinuous lines instead of ruler-straight ones \u2014 this is the main lever for making a plan look plausible." },
        }, ['from', 'to']),
        handler: (a) => draw.drawAxis(a),
    },
    {
        name: 'map_encircle',
        description: 'Draw an encirclement / pocket / area-of-interest ring around one place (radius_km) or around several places (padded hull).',
        inputSchema: obj({
            around: { type: 'string', description: PLACE },
            places: { type: 'array', items: { type: 'string' }, description: 'Encircle several places at once instead of `around`.' },
            radius_km: { type: 'number', description: 'Single-place radius. Default max(padding_km, 5).' },
            padding_km: { type: 'number', description: 'Outward padding on the multi-place hull. Default 4.' },
            side: SIDE,
            fill: { type: 'boolean', description: 'Translucent fill. Default true.' },
            label: { type: 'string' },
            color: COLOR,
            thickness: { type: 'number' },
            dash: { type: 'boolean', description: 'Default true — encirclements read better dashed.' },
            pattern: { type: 'string', enum: ['solid', 'hatch', 'crosshatch', 'dots'], description: 'Fill texture. Hatching reads as \'claimed/contested\' without hiding the terrain underneath.' },
            pattern_angle: { type: 'number', description: 'Hatch angle in degrees (default 45). Give overlapping zones different angles so they stay distinguishable where they cross.' },
        }),
        handler: (a) => draw.encircle(a),
    },
    {
        name: 'map_area',
        description: 'Draw an arbitrary control / objective area from explicit [lat, lng] points, or as a hull over named places.',
        inputSchema: obj({
            points: { type: 'array', description: '>=3 [lat, lng] pairs, in order.', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
            places: { type: 'array', items: { type: 'string' }, description: 'Alternative to points — a padded hull is built around them.' },
            padding_km: { type: 'number' },
            fill: { type: 'boolean' },
            side: SIDE,
            label: { type: 'string' },
            color: COLOR,
            thickness: { type: 'number' },
            dash: { type: 'boolean' },
            pattern: { type: 'string', enum: ['solid', 'hatch', 'crosshatch', 'dots'], description: 'Fill texture. Hatching reads as \'claimed/contested\' without hiding the terrain underneath.' },
            pattern_angle: { type: 'number', description: 'Hatch angle in degrees (default 45). Give overlapping zones different angles so they stay distinguishable where they cross.' },
            follow: { type: 'string', enum: ['none', 'terrain', 'roads'], description: "'terrain' routes over the elevation model, preferring valleys and saddles over ridge climbs. 'roads' routes along the real road network. Both produce naturally sinuous lines instead of ruler-straight ones \u2014 this is the main lever for making a plan look plausible." },
            width_km: { type: 'number', description: 'With 2+ places, builds a corridor this wide along the route between them instead of a convex hull. Hulling two places always yields a fat lozenge; a corridor follows the actual line of effort.' },
            smooth: { type: 'boolean', description: 'Round the outline (default true). Set false for hard-edged polygons.' },
        }),
        handler: (a) => draw.area(a),
    },
    {
        name: 'map_line',
        description: 'Draw a phase line, unit boundary or flank line between two places.',
        inputSchema: obj({
            from: { type: 'string', description: PLACE },
            to: { type: 'string', description: PLACE },
            kind: { type: 'string', enum: ['phase', 'boundary', 'flank', 'plain'] },
            side: SIDE,
            label: { type: 'string' },
            color: COLOR,
        }, ['from', 'to']),
        handler: (a) => draw.line(a),
    },
    {
        name: 'map_mark',
        description: 'Mark a position with a circle and an optional label.',
        inputSchema: obj({
            at: { type: 'string', description: PLACE },
            label: { type: 'string' },
            side: SIDE,
            radius_km: { type: 'number', description: 'Default 2.' },
            color: COLOR,
            thickness: { type: 'number' },
        }, ['at']),
        handler: (a) => draw.mark(a),
    },
    {
        name: 'map_label',
        description: 'Place a text label on the map at a named place or coordinate.',
        inputSchema: obj({
            at: { type: 'string', description: PLACE },
            text: { type: 'string' },
            size: { type: 'number', description: 'Font size in px. Default 18.' },
            bearing_deg: { type: 'number', description: 'On-screen rotation, clockwise positive. Default 0 (horizontal).' },
            side: SIDE,
            color: COLOR,
            halo: { type: 'string', description: 'Outline colour. Omit for automatic contrast (white behind dark text, dark behind light); pass null to disable.' },
        }, ['at', 'text']),
        handler: (a) => draw.label(a),
    },

    // ── draw: primitives ─────────────────────────────────────────────────────
    {
        name: 'map_draw_shapes',
        description: 'Escape hatch — push raw DrawingTool shapes. All coordinates are [lat, lng]. Types: freedraw{points}, polygon{points,fill,fillOpacity}, line{start,end}, arrow{start,end}, ellipse{p1,p2,p3}, rect{p1,p2,p3}, arc{p1,p2,p3,head,taper}, text{p1,p2,text,fontSize,halo,bold}, icon{at,icon,size,label}. freedraw also takes head/taper; polygon also takes pattern (hatch, crosshatch or dots). For ellipse/rect, p1→p2 is the major axis and p3 sets half-width; for arc, p1→p2 is the chord and p3 the bulge.',
        inputSchema: obj({ shapes: { type: 'array', items: { type: 'object' }, description: 'Array of shape objects.' } }, ['shapes']),
        handler: (a) => draw.drawShapes(a),
    },
    {
        name: 'map_erase',
        description: 'Remove drawn shapes. Scope "ai" removes only what this server drew and leaves the user\'s own drawings untouched.',
        inputSchema: obj({
            scope: { type: 'string', enum: ['ai', 'all', 'last'], description: 'Default "ai".' },
            n: { type: 'number', description: 'How many to remove when scope is "last". Default 1.' },
        }),
        handler: (a) => draw.erase(a),
    },
    { name: 'map_undo', description: 'Undo the last drawn shape.', inputSchema: obj({}), handler: () => draw.undo() },

    // ── poster / export ──────────────────────────────────────────────────────
    {
        name: 'map_poster',
        description: 'Add publication chrome: a title block (top-left) and a legend (bottom-left). The legend is derived from what is actually drawn, so it stays truthful; pass `legend.rows` to rename or reorder entries. Returns the resolved legend rows so you can see what was derived.',
        inputSchema: obj({
            title: { type: 'string', description: 'Main heading, e.g. "Sloviansk\u2013Kramatorsk sector".' },
            subtitle: { type: 'string' },
            dateline: { type: 'string', description: 'Small line above the title, e.g. "Frontline as of 07/08/2026".' },
            caveat: { type: 'string', description: 'Highlighted line under the title. Use it to state when a plan is projected or illustrative rather than observed.' },
            legend: obj({
                title: { type: 'string' },
                auto: { type: 'boolean', description: 'Derive rows from the drawn shapes. Default true.' },
                rows: { type: 'array', items: { type: 'object' }, description: 'Overrides. Use {match:"<derived label>", label:"<new name>"} to rename a derived row, or {match:"...", hide:true} to drop it — matching is by label, NOT position, so it survives redrawing. A row with its own type/color/icon/fill/dash/pattern is a standalone extra row. Output order follows this array, then any unmatched derived rows. Call with no rows first to see the derived labels.' },
                hide: { type: 'boolean' },
            }),
            show: { type: 'boolean' },
            clear: { type: 'boolean', description: 'Remove all poster chrome.' },
        }),
        handler: (a) => posterTools.poster(a),
    },
    {
        name: 'map_export',
        description: 'High-resolution capture of the finished map \u2014 the deliverable. Defaults to lossless PNG at 2x device resolution. Optionally writes to a file.',
        inputSchema: obj({
            path: { type: 'string', description: 'Where to write the image. Omit to only return it.' },
            width: { type: 'number', description: 'Resize the viewport first. Changes what is visible, so re-check framing.' },
            height: { type: 'number' },
            scale: { type: 'number', description: '2 (default) captures at full device resolution; 1 gives a CSS-pixel image.' },
            selector: { type: 'string', description: 'Defaults to "#map".' },
            png: { type: 'boolean', description: 'Default true. Set false for a smaller JPEG.' },
        }),
        handler: (a) => posterTools.exportMap(a),
        returnsImage: true,
    },

    // ── planning graphics ────────────────────────────────────────────────────
    {
        name: 'map_place_icon',
        description: `Place a tactical icon from the app's own set. Valid names: ${draw.ICON_NAMES.join(', ')}.`,
        inputSchema: obj({
            at: { type: 'string', description: PLACE },
            icon: { type: 'string', description: 'One of the names listed above, e.g. "red_fire", "broken_bridge", "red_explosion".' },
            size: { type: 'number', description: 'Pixels. Default 28.' },
            label: { type: 'string', description: 'Caption drawn beneath the icon, with a halo.' },
            label_size: { type: 'number' },
        }, ['at', 'icon']),
        handler: (a) => draw.placeIcon(a),
    },
    {
        name: 'map_objective',
        description: 'Mark an objective: a dashed ring around one or more places, with a label.',
        inputSchema: obj({
            at: { type: 'string', description: PLACE },
            places: { type: 'array', items: { type: 'string' }, description: 'Several places instead of `at`.' },
            radius_km: { type: 'number' },
            padding_km: { type: 'number' },
            label: { type: 'string' },
            side: SIDE,
            color: COLOR,
        }),
        handler: (a) => draw.objective(a),
    },
    {
        name: 'map_phase_line',
        description: 'Draw a phase line: a smooth dashed line through the given places, labelled at its start.',
        inputSchema: obj({
            from: { type: 'string', description: PLACE },
            to: { type: 'string', description: PLACE },
            via: { type: 'array', items: { type: 'string' } },
            label: { type: 'string', description: 'e.g. "PL BLUE".' },
            side: SIDE,
            color: COLOR,
            thickness: { type: 'number' },
        }, ['from', 'to']),
        handler: (a) => draw.phaseLine(a),
    },
    {
        name: 'map_boundary',
        description: 'Draw a unit boundary: a heavy dashed line with the formation on each side named.',
        inputSchema: obj({
            from: { type: 'string', description: PLACE },
            to: { type: 'string', description: PLACE },
            via: { type: 'array', items: { type: 'string' } },
            left: { type: 'string', description: 'Formation on the left of the from\u2192to direction.' },
            right: { type: 'string' },
            color: COLOR,
            thickness: { type: 'number' },
        }, ['from', 'to']),
        handler: (a) => draw.boundary(a),
    },

    // ── terrain-aware graphics ───────────────────────────────────────────────
    {
        name: 'map_front_line',
        description: 'Draw the REAL front line: the control boundary from the loaded DeepState territory, clipped to the view and rendered as a flowing dashed line. Use this instead of hand-drawing or hulling an approximate front \u2014 it is actual data, so it is naturally sinuous.',
        inputSchema: obj({
            bbox: obj({ north: { type: 'number' }, south: { type: 'number' }, east: { type: 'number' }, west: { type: 'number' } },
                      ['north', 'south', 'east', 'west']),
            date: { type: 'string', description: 'YYYY-MM-DD. Defaults to the current end date.' },
            color: COLOR,
            thickness: { type: 'number' },
            dash: { type: 'boolean', description: 'Default true.' },
            max_segments: { type: 'number', description: 'Longest N boundary runs in view. Default 3.' },
        }),
        handler: (a) => draw.frontLine(a),
    },
    {
        name: 'map_elevation',
        description: 'Sample ground elevation in metres at named places or coordinates. Use it to justify where an axis goes \u2014 which ridge dominates, which valley is the natural approach.',
        inputSchema: obj({
            places: { type: 'array', items: { type: 'string' } },
            points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
        }),
        handler: (a) => draw.elevation(a),
    },

    // ── persistence ──────────────────────────────────────────────────────────
    {
        name: 'map_save_session',
        description: 'Save the full map state (view, dates, layers, drawings) to a JSON file the app can reload.',
        inputSchema: obj({ path: { type: 'string' } }, ['path']),
        handler: (a) => io.saveSession(a),
    },
    {
        name: 'map_load_session',
        description: 'Restore a previously saved session JSON file into the open map.',
        inputSchema: obj({ path: { type: 'string' } }, ['path']),
        handler: (a) => io.loadSession(a),
    },
    { name: 'map_share_link', description: 'Produce a shareable URL encoding the current map state.', inputSchema: obj({}), handler: () => io.shareLink() },
];

const server = new Server(
    { name: 'ukraine-map', version: '0.1.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };

    try {
        const result = await tool.handler(req.params.arguments || {});
        if (tool.returnsImage) {
            return { content: [{
                type: 'image',
                data: result.buffer.toString('base64'),
                mimeType: result.png ? 'image/png' : 'image/jpeg',
            }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `${tool.name} failed: ${err.message}` }] };
    }
});

process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });

await server.connect(new StdioServerTransport());

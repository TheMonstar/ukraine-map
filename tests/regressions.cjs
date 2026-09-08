const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
// Exercise the same browser bundle as the CDN, installed only for Node tests.
const { dirname, join } = require('node:path');
const turf = require(join(dirname(require.resolve('@turf/turf/package.json')), 'turf.min.js'));
const quiet = { log() {}, warn() {}, error() {} };
function runtime(extra = {}) {
    const c = vm.createContext({ console: quiet, turf, Date, Map, Set, AbortSignal, URL,
        document: { getElementById() { return null; } }, ...extra });
    for (const file of ['territory-data', 'utils', 'geometry-utils', 'html-utils', 'territory-controller', 'hex-tiles', 'map-layers']) {
        c.window = c;
        vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), c);
    }
    return { c, run: code => vm.runInContext(code, c) };
}
const square = (x = 35, y = 48, width = 1) => [[x,y],[x+width,y],[x+width,y+width],[x,y+width],[x,y]];
const feature = rings => turf.polygon(rings, { stroke: '#a52714', fill: '#a52714' });
const collection = features => ({ type: 'FeatureCollection', features });
const options = { enabled: false, gradient: false, occupiedDepth: 20, oppositeDepth: 20 };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('failed fetch rejects, is not cached, and a retry succeeds', async () => {
    let count = 0;
    const { c, run } = runtime({ fetch: async () => {
        count++;
        if (count === 1) throw Error('offline');
        return { ok: true, json: async () => collection([feature([square()])]) };
    }, options });
    await assert.rejects(run('TerritoryData.polygons(new Date(2026, 0, 1), options)'), /offline/);
    const result = await run('TerritoryData.polygons(new Date(2026, 0, 1), options)');
    assert.equal(count, 2);
    assert.equal(result.polygons.length, 1);
});

test('invalid responses and unclosed rings reject instead of becoming empty territory', async () => {
    const { c, run } = runtime({ options });
    for (const data of [{ error: 'unavailable' }, collection([{ type:'Feature', properties:{}, geometry: { type:'Polygon', coordinates:[[[35,48],[36,48],[36,49],[35,49]]] } }])]) {
        c.fetch = async () => ({ ok:true, json:async () => data });
        await assert.rejects(run('TerritoryData.polygons(new Date(2026, 0, 1), options)'), /Invalid/);
    }
});

test('holes and MultiPolygons survive ingestion, differences, and Leaflet conversion', async () => {
    const donut = feature([square(), square(35.2,48.2,0.2).reverse()]);
    const multi = turf.multiPolygon([[square(38)], [square(40)]], donut.properties);
    const { c, run } = runtime({ options, fetch: async () => ({ ok:true, json:async () => collection([donut,multi]) }) });
    const data = await run('TerritoryData.polygons(new Date(2026, 0, 1), options)');
    assert.equal(data.polygons.length, 2);
    assert.equal(data.polygons[0].geojson.geometry.coordinates.length, 2);
    assert.equal(data.polygons[1].geojson.geometry.type, 'MultiPolygon');
    assert.equal(data.statistics['#a52714'], (turf.area(donut)+turf.area(multi))/1e6);
    c.data = data;
    const diff = run('TerritoryAnalysis.difference({polygons:[],statistics:{}}, data)');
    const gained = diff.polygons.find(p => p.type === 'difference').geojson;
    assert.equal(turf.booleanPointInPolygon(turf.point([35.3,48.3]), gained), false);
    assert.ok(turf.booleanPointInPolygon(turf.point([40.5,48.5]), gained));
    assert.equal(run('GeometryUtils.toLatLngPolygon(data.polygons[0].geojson.geometry).length'), 2);
});

test('geometry errors propagate and genuine empty dates retain valid gain/loss semantics', () => {
    const { c, run } = runtime();
    c.data = { polygons:[{ geojson:feature([square()]) }], statistics:{} };
    assert.equal(run('TerritoryAnalysis.difference(data, {polygons:[]}).polygons.at(-1).type'), 'reverse-difference');
    assert.equal(run('TerritoryAnalysis.difference({polygons:[]}, data).polygons[0].type'), 'difference');
    c.turf = { ...turf, difference() { throw Error('invalid topology'); } };
    assert.throws(() => run('TerritoryAnalysis.difference(data, data)'), /invalid topology/);
});

test('LRU promotes hits, evicts old entries, and deduplicates concurrent loads', async () => {
    const { c, run } = runtime();
    c.hold = deferred(); c.loads = 0;
    run('this.cache = new AsyncLruCache(2)');
    const a = run('cache.get("a", () => { loads++; return hold.promise; })');
    const b = run('cache.get("a", () => { loads++; return 99; })');
    c.hold.resolve(1);
    assert.equal(await a, 1); assert.equal(await b, 1); assert.equal(c.loads, 1);
    await run('cache.get("b", () => 2)');
    await run('cache.get("a", () => 9)');
    await run('cache.get("c", () => 3)');
    assert.equal(run('cache.values.has("b")'), false);
    assert.equal(run('cache.values.size'), 2);
});

test('processed cache separates shadow depths including the default depth', async () => {
    const { c, run } = runtime();
    run('DeepUtils.prototype.addDeepMap = async (date, options) => options');
    c.options = { ...options, occupiedDepth:10 };
    assert.equal((await run('TerritoryData.polygons(new Date(2026,0,1), options)')).occupiedDepth, 10);
    c.options = { ...options, occupiedDepth:30 };
    assert.equal((await run('TerritoryData.polygons(new Date(2026,0,1), options)')).occupiedDepth, 30);
});

function controllerRuntime() {
    const elements = new Map();
    const flags = new Set(['diff-area']);
    const rendered = [];
    const layer = () => ({ clearLayers() {}, addTo() { return this; } });
    const dashboard = {
        deepLayer: layer(), map:{}, selectedPolygons:[], startDate:new Date(2026,0,1), endDate:new Date(2026,0,2),
        isChecked: id => flags.has(id), setText: (id,text) => elements.set(id,text), getEl: () => null,
        getDiffSliceDates: () => [], charts:{ onTerritoryStats() {} }, regionPolygonCache:new Map(),
        directionBorders: {}, calculateSettlementsInDiffArea() {}, formatDate: d => d.toISOString(),
        calculateAttackStatistics: x => x, updateStatistics: x => { dashboard.stats=x; }
    };
    const { c, run } = runtime({ dashboard, AttackMapDashboard:{ TACTICAL_REGIONS:[] }, L:{ layerGroup:layer,
        geoJSON: () => ({ addTo() { return this; }, bindTooltip() { return this; } }) } });
    c.rendered=rendered;
    run('DeepUtils.prototype.renderMap = data => rendered.push(data); this.controller = new TerritoryController(dashboard).init()');
    return { c, run, dashboard, rendered, flags, elements };
}

test('out-of-order territory loads only commit the latest date', async () => {
    const { c, run, dashboard, rendered } = controllerRuntime();
    c.first = deferred(); c.second = deferred();
    run('TerritoryData.polygons = date => date.getDate() === 2 ? first.promise : second.promise');
    const first = run('controller.renderDeepLayer()');
    dashboard.endDate = new Date(2026,0,3);
    const second = run('controller.renderDeepLayer()');
    c.second.resolve({polygons:[], statistics:{}, tag:'latest'}); await second;
    c.first.resolve({polygons:[], statistics:{}, tag:'old'}); await first;
    assert.deepEqual(rendered.map(x=>x.tag), ['latest']);
});

test('failed comparison preserves the last rendered map and marks statistics unavailable', async () => {
    const { c, run, rendered, flags, elements } = controllerRuntime();
    run('TerritoryData.polygons = async () => ({ polygons:[], statistics:{} })');
    await run('controller.renderDeepLayer()');
    flags.add('diff-highlight');
    run('TerritoryData.polygons = async date => { if(date.getDate() === 1) throw Error("offline"); return {polygons:[],statistics:{}}; }');
    await run('controller.renderDeepLayer()');
    assert.equal(rendered.length, 1);
    assert.match(elements.get('territory-status'), /unavailable/);
    assert.equal(elements.get('total-gains'), '—');
});

test('regional Polygon area uses full GeoJSON, with holes subtracted', async () => {
    const { c, run, dashboard, flags } = controllerRuntime();
    const polygon = feature([square(),square(35.2,48.2,0.2).reverse()]);
    c.polygon=polygon;
    flags.add('diff-highlight'); flags.add('regions-highlight');
    dashboard.directionBorders={ region:feature([square()]) };
    dashboard.getDirectionColor=()=> 'red';
    run('TerritoryData.polygons = async date => ({polygons:date.getDate() === 1 ? [] : [{geojson:polygon,properties:polygon.properties}],statistics:{}})');
    await run('controller.renderDeepLayer()');
    assert.ok(dashboard.stats[0].gains > 0);
    assert.ok(Math.abs(dashboard.stats[0].gains - turf.area(polygon)/1e6) < 0.001);
});

test('disabling a pending territory request prevents it from painting', async () => {
    const { c, run, flags, rendered } = controllerRuntime();
    c.hold=deferred(); run('TerritoryData.polygons = () => hold.promise');
    const pending=run('controller.renderDeepLayer()');
    flags.delete('diff-area'); await run('controller.renderDeepLayer()');
    c.hold.resolve({polygons:[],statistics:{}}); await pending;
    assert.equal(rendered.length, 0);
});

test('overlay OFF invalidates a pending response', async () => {
    const hold=deferred(); let additions=0;
    const { c, run }=runtime({ fetch:()=>hold.promise, dashboard:{}, alert() {}, L:{layerGroup(){additions++;return {addTo(){return this}}}} });
    run('this.layers = new MapLayers(dashboard)');
    const pending=run('layers.toggleRussiaOverlay(true)');
    await run('layers.toggleRussiaOverlay(false)');
    hold.resolve({json:async()=>collection([])}); await pending;
    assert.equal(additions,0);
});

test('imported markup and unsafe link protocols cannot become executable HTML', () => {
    const { c, run }=runtime();
    c.payload='<img src=x onerror="alert(1)">';
    assert.equal(run('HtmlUtils.escape(payload)'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(run('HtmlUtils.link("javascript:alert(1)")'), '');
    assert.equal(run('HtmlUtils.link("data:text/html,<script>alert(1)</script>")'), '');
    assert.match(run('HtmlUtils.link("https://example.com/?a=1&b=2")'), /noopener noreferrer/);
});

test('a narrow occupied strip through the hex centroid remains a partial tile', async () => {
    let output;
    const hex = turf.hexGrid([35,48,35.4,48.4],10,{units:'kilometers'}).features[0];
    const [lng,lat] = turf.centroid(hex).geometry.coordinates;
    const occupied = turf.polygon([[[lng-0.02,lat-1],[lng+0.02,lat-1],[lng+0.02,lat+1],[lng-0.02,lat+1],[lng-0.02,lat-1]]]);
    const { c, run }=runtime({ L:{geoJSON(data){output=data;return {addTo(){return this}}}}, hex, occupied });
    run('this.tiles = new HexTiles(); tiles.getBorderShape = async () => hex; tiles._getHexGrid = () => ({features:[hex]})');
    await run('tiles.render({}, null, 10, [{geojson:occupied,style:{fillColor:"red"}}])');
    assert.equal(output.features[0].properties._hfill, '#888888');
});

test('RIA totals reject an unavailable date instead of counting an entire source as gains', async () => {
    const { c, run } = runtime({dashboard:{}});
    c.polygon=feature([square()]);
    run('this.layers = new MapLayers(dashboard); layers._loadRiaMerged = async date => { if(date === "20260101") throw Error("offline"); return polygon; }');
    await assert.rejects(run('layers.getRiaDiffAreaKm2(new Date(2026,0,1), new Date(2026,0,2))'), /offline/);
});

test('manifest totals reject geometry failures instead of falling back to entire end territory', async () => {
    const { c, run } = runtime({dashboard:{}});
    c.polygon=feature([square()]);
    run('this.layers = new MapLayers(dashboard); layers.loadManifestDataByDate = async () => ({}); layers.extractKmlFeatures = () => ({ruUnion:polygon})');
    c.turf={...turf,difference(){throw Error('invalid topology')}};
    await assert.rejects(run('layers.getManifestDiffAreaKm2("AMK", new Date(), new Date())'), /invalid topology/);
});

test('a failed slice request does not replace the last successful map', async () => {
    const { c, run, flags, dashboard, rendered } = controllerRuntime();
    run('TerritoryData.polygons = async () => ({polygons:[],statistics:{}})');
    await run('controller.renderDeepLayer()');
    flags.add('diff-highlight'); dashboard.endDate=new Date(2026,0,3);
    dashboard.getDiffSliceDates=()=>[new Date(2026,0,2)];
    run('TerritoryData.polygons = async date => { if(date.getDate() === 2) throw Error("missing slice"); return {polygons:[],statistics:{}}; }');
    await run('controller.renderDeepLayer()');
    assert.equal(rendered.length,1);
});

test('render errors leave the original Leaflet layer intact', () => {
    let cleared=false;
    const { c, run }=runtime({ L:{layerGroup:()=>({}),geoJSON(){throw Error('bad geometry')}}, layer:{clearLayers(){cleared=true}} });
    assert.throws(()=>run('new DeepUtils(layer).renderMap({polygons:[{geojson:{},style:{}}]})'), /bad geometry/);
    assert.equal(cleared,false);
});

test('a changed date invalidates an old response before the debounced render starts', async () => {
    const { c, run, dashboard, rendered } = controllerRuntime();
    c.hold=deferred(); run('TerritoryData.polygons = () => hold.promise');
    const pending=run('controller.renderDeepLayer()');
    dashboard.endDate=new Date(2026,0,3);
    c.hold.resolve({polygons:[],statistics:{}}); await pending;
    assert.equal(rendered.length,0);
});

test('frontline clipping measures every ring of holed Polygon and MultiPolygon boundaries', () => {
    const { c, run } = runtime();
    vm.runInContext(fs.readFileSync('js/app.js', 'utf8'), c);
    c.selection = turf.bboxPolygon([34,47,43,51]);
    const donut = feature([square(), square(35.2,48.2,0.2).reverse()]);
    const multi = turf.multiPolygon([donut.geometry.coordinates, [square(40)]], donut.properties);
    for (const polygon of [donut, multi]) {
        c.line = turf.polygonToLine(polygon);
        const segments = run('AttackMapDashboard.prototype.getLineSegmentsInBox(line, selection)');
        const measured = segments.reduce((sum, segment) => sum + turf.length(segment), 0);
        assert.ok(measured > 0);
        assert.ok(Math.abs(measured - turf.length(c.line)) < 1e-8);
        assert.equal(segments.length, polygon === donut ? 8 : 12);
    }
});

test('region clip failure preserves successful territory geometry and headline statistics', async () => {
    const { c, run, flags, dashboard, rendered, elements } = controllerRuntime();
    flags.add('diff-highlight'); flags.add('search-in-regions');
    c.AttackMapDashboard.TACTICAL_REGIONS.push('region');
    dashboard.regionPolygonCache.set('region', feature([square()]));
    dashboard.regionCoordinates={ region:[48.5,35.5] };
    c.polygon=feature([square()]);
    run('TerritoryData.polygons = async date => ({polygons:date.getDate() === 1 ? [] : [{geojson:polygon}],statistics:{"#a52714":date.getDate() === 1 ? 0 : 10}})');
    c.turf={...turf,intersect(){throw Error('bad region ring')}};
    await run('controller.renderDeepLayer()');
    assert.equal(rendered.length,1);
    assert.equal(elements.get('total-gains'),10);
    assert.match(elements.get('territory-status'),/Region breakdown unavailable/);
    assert.doesNotMatch(elements.get('territory-status'),/Previous map retained/);
});

test('each feature clears only its own status message', async () => {
    const { run, elements } = controllerRuntime();
    run('TerritoryStatus.set(dashboard,"hex","Hex failed"); TerritoryStatus.set(dashboard,"overlays","RIA unavailable")');
    run('TerritoryData.polygons = async () => ({polygons:[],statistics:{}})');
    await run('controller.renderDeepLayer()');
    assert.match(elements.get('territory-status'),/Hex failed/);
    assert.match(elements.get('territory-status'),/RIA unavailable/);
    run('TerritoryStatus.set(dashboard,"hex","")');
    assert.equal(elements.get('territory-status'),'RIA unavailable');
    run('TerritoryStatus.set(dashboard,"overlays","")');
    assert.equal(elements.get('territory-status'),'');
});

test('overlay totals retain successful sources and label partial results; recovery clears only overlay errors', async () => {
    const { c, run, flags, dashboard, elements }=controllerRuntime();
    flags.add('diff-highlight'); flags.add('amk-overlay'); flags.add('ria-overlay');
    let fail=true;
    dashboard.layers={getManifestDiffAreaKm2:async()=>({gains:12,losses:2}),getRiaDiffAreaKm2:async()=>{if(fail)throw Error('missing date');return {gains:4,losses:1}}};
    run('this.updateTotals=createOverlayDiffUpdater(dashboard,[{id:"amk-overlay",key:"AMK",label:"AMK"},{id:"ria-overlay",key:null,label:"RIA"}],{})');
    run('TerritoryStatus.set(dashboard,"hex","Hex failed")');
    await run('updateTotals()');
    assert.match(elements.get('total-gains'),/^10 .*partial \(AMK\)/);
    assert.match(elements.get('territory-status'),/Comparison unavailable: RIA/);
    fail=false; await run('updateTotals()');
    assert.equal(elements.get('total-gains'),'13 (↑16 ↓3)');
    assert.equal(elements.get('territory-status'),'Hex failed');
    flags.delete('diff-highlight'); await run('updateTotals()');
    assert.equal(elements.get('territory-status'),'Hex failed');
});

function riaRuntime() {
    const styles=[], texts=new Map(), toggle={checked:true};
    const layer=()=>({items:[],clearLayers(){this.items=[]},eachLayer(fn){this.items.forEach(fn)},addTo(target){target?.items?.push(this);return this},bindTooltip(){return this}});
    const dashboard={startDate:new Date(2026,0,1),endDate:new Date(2026,0,2),map:{},getEl:()=>toggle,isChecked:()=>true,setText:(id,text)=>texts.set(id,text)};
    const {c,run}=runtime({dashboard,L:{layerGroup:layer,geoJSON(geo,opts){styles.push(opts.style);return layer()}}});
    c.polygon=feature([square()]);
    run('this.layers = new MapLayers(dashboard); layers._loadRiaMerged = async () => polygon');
    return {c,run,dashboard,styles,texts,toggle};
}

test('RIA preserves its palette and renders same-day selection as a single current overlay', async () => {
    const {c,run,dashboard,styles}=riaRuntime();
    await run('layers.toggleRiaOverlay(true)');
    assert.equal(styles[0].color,'#FF655C'); assert.equal(styles[0].fillOpacity,0.2);
    styles.length=0; dashboard.startDate=dashboard.endDate;
    c.loads=0; run('layers._loadRiaMerged=async()=>{loads++;return polygon}');
    await run('layers.toggleRiaOverlay(true)');
    assert.equal(c.loads,1); assert.equal(styles.length,1);
    assert.equal(styles[0].color,'#FF655C'); assert.equal(styles[0].fillOpacity,0.35);
});

test('RIA failure turns its control off, removes stale geometry, and recovery clears its message', async () => {
    const {run,dashboard,toggle,texts}=riaRuntime();
    await run('layers.toggleRiaOverlay(true)');
    assert.ok(dashboard.riaOverlay.items.length);
    run('layers._loadRiaMerged=async()=>{throw Error("missing date")}');
    await run('layers.toggleRiaOverlay(true)');
    assert.equal(toggle.checked,false); assert.equal(dashboard.riaOverlay.items.length,0); assert.equal(dashboard.riaMergedPolygon,null);
    assert.match(texts.get('territory-status'),/RIA overlay unavailable/);
    toggle.checked=true; run('layers._loadRiaMerged=async()=>polygon');
    await run('layers.toggleRiaOverlay(true)');
    assert.equal(texts.get('territory-status'),'');
});

test('hex interior cells avoid intersections and reuse their classifications', async () => {
    const grid=turf.hexGrid([35.1,48.1,35.9,48.9],2,{units:'kilometers'});
    const land=feature([square()]); let intersections=0, unions=0;
    const {c,run}=runtime({grid,land,L:{geoJSON(){return {addTo(){return this}}}},map:{removeLayer(){}},turf:{...turf,
        intersect(...args){intersections++;return turf.intersect(...args)},union(...args){unions++;return turf.union(...args)}}});
    run('this.tiles=new HexTiles(); tiles.getBorderShape=async()=>land; tiles._getHexGrid=()=>grid');
    await run('tiles.render(map,null,2,[{geojson:land,style:{fillColor:"red"}}])');
    assert.ok(grid.features.length>100);
    assert.equal(intersections,0);
    await run('tiles.render(map,null,2,[{geojson:land,style:{fillColor:"red"}}])');
    assert.equal(intersections,0); assert.equal(unions,0);
});

test('indexed hex coverage matches exact intersections for cells along holes and narrow components', () => {
    const geometry=turf.multiPolygon([[square(),square(35.3,48.3,0.25).reverse()],[square(36.05,48.4,0.08)]]);
    const grid=turf.hexGrid([34.9,47.9,36.2,49.1],5,{units:'kilometers'});
    const {c,run}=runtime({geometry});
    run('this.prepared=HexTiles.prepareCoverage(geometry)');
    for(const hex of grid.features){
        c.hex=hex;
        const actual=run('HexTiles.coverage(hex,turf.bbox(hex),turf.area(hex),prepared)');
        const intersection=turf.intersect(hex,geometry);
        const expected=intersection?turf.area(intersection)/turf.area(hex):0;
        assert.ok(Math.abs(actual-expected)<1e-8,`${actual} vs ${expected}`);
    }
});

test('detailed occupation boundary limits Turf intersections to boundary cells', t => {
    const land = turf.circle([35,48],100,{steps:2048,units:'kilometers'});
    const grid = turf.hexGrid(turf.bbox(land),5,{units:'kilometers'});
    let calls=0;
    const {c,run}=runtime({land,turf:{...turf,intersect(...args){calls++;return turf.intersect(...args)}}});
    run('this.prepared=HexTiles.prepareCoverage(land)');
    for(const hex of grid.features){c.hex=hex;run('HexTiles.coverage(hex,turf.bbox(hex),turf.area(hex),prepared)');}
    assert.ok(calls>0);
    assert.ok(calls<grid.features.length/3,`${calls} intersections for ${grid.features.length} cells`);
    t.diagnostic(`${calls} intersections for ${grid.features.length} cells against a 2,048-vertex boundary`);
});

function playbackRuntime(enabled = ['diff-area', 'suriyak-overlay']) {
    const timers=new Map(), flags=new Set(enabled), calls=[];
    let nextTimer=0;
    const {c,run}=runtime({setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}});
    vm.runInContext(fs.readFileSync('js/app.js','utf8'),c);
    c.flags=flags; c.calls=calls;
    run(`this.player=Object.create(AttackMapDashboard.prototype);
        Object.assign(player,{isPlaying:false,startDate:new Date(2026,0,1),endDate:new Date(2026,0,2),maxDate:new Date(2026,0,4),
            getEl:id=>id==='playback-speed'?{value:'250'}:null,isChecked:id=>flags.has(id),
            updateSliderValues(){},renderDeepLayer:async()=>calls.push('deep:'+player.endDate.getDate()),
            layers:{toggleSuriyakOverlay:async()=>calls.push('suriyak:'+player.endDate.getDate())}});`);
    return {c,run,timers,calls,flags,fire(){const [id,fn]=timers.entries().next().value;timers.delete(id);return fn()}};
}

test('playback refreshes enabled layers at every step and does not advance past the final date', async () => {
    const {run,fire,calls,timers}=playbackRuntime();
    run('player.playAnimation()');
    await fire();
    assert.deepEqual(calls,['deep:3','suriyak:3']);
    assert.equal(run('player.isPlaying'),true);
    await fire();
    assert.deepEqual(calls,['deep:3','suriyak:3','deep:4','suriyak:4']);
    assert.equal(run('player.endDate.getDate()'),4);
    assert.equal(run('player.isPlaying'),false);
    assert.equal(timers.size,0);
});

test('playback waits for slow layers and pause prevents a queued next frame', async () => {
    const {c,run,fire,calls,timers}=playbackRuntime();
    c.hold=deferred();
    run('player.layers.toggleSuriyakOverlay=async()=>{calls.push("slow:"+player.endDate.getDate());await hold.promise}');
    run('player.playAnimation()');
    const pending=fire();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(run('player.endDate.getDate()'),3);
    assert.equal(timers.size,0);
    assert.deepEqual(calls,['deep:3','slow:3']);
    run('player.stopAnimation()');
    c.hold.resolve(); await pending;
    assert.equal(run('player.isPlaying'),false);
    assert.equal(timers.size,0);
    assert.equal(run('player.endDate.getDate()'),3);
});

test('manual date refresh includes all enabled dated overlays and awaits hex rendering', async () => {
    const names=['Amk','Radov','Isw','Suriyak','Ria','Creamy','Firms'];
    const {c,run,calls,timers}=playbackRuntime(names.map(name=>name.toLowerCase()+'-overlay').concat('hex-tiles'));
    c.names=names; c.hold=deferred();
    run(`for(const name of names)player.layers['toggle'+name+'Overlay']=async()=>calls.push(name);
        player.refreshHexTiles=async()=>{calls.push('hex');await hold.promise};
        player.scheduleDateDependentRefreshes(); player.scheduleDateDependentRefreshes();`);
    assert.equal(timers.size,1);
    const fn=timers.values().next().value;timers.clear();fn();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls,[...names,'hex']);
    assert.ok(run('player.dateRefreshPromise'));
    c.hold.resolve(); await run('player.dateRefreshPromise');
    assert.equal(run('player.dateRefreshPromise'),null);
});

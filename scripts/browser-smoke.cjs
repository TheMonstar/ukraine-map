// Browser smoke check: live pinned CDN libraries, with deterministic mocked data feeds.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../mcp/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const empty = { type:'FeatureCollection', features:[] };
const square = (x, size=1) => [[x,48],[x+size,48],[x+size,48+size],[x,48+size],[x,48]];
function territory(date) {
    return { type:'FeatureCollection', features:[{type:'Feature', properties:{stroke:'#a52714',fill:'#a52714','fill-opacity':0.3,fixtureDate:date},
        geometry:{type:'Polygon',coordinates:[square(date === '2026-01-01' ? 35 : 35.5)]}}] };
}
const server = http.createServer((req,res) => {
    const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };
    fs.readFile(filename, (error,data) => {
        if(error) { res.writeHead(404).end(); return; }
        res.writeHead(200, {'Content-Type':mime[path.extname(filename)] || 'application/octet-stream'}).end(data);
    });
});
(async () => {
    let browser;
    try {
        await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({headless:true});
        const page = await browser.newPage({viewport:{width:1440,height:1000}});
        const errors=[];
        page.on('pageerror', e=>errors.push(e.message));
        let failTerritory=false;
        const playbackLayerRequests=[];
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if(url.origin === origin || ['cdnjs.cloudflare.com','unpkg.com','cdn.jsdelivr.net'].includes(url.hostname)) return route.continue();
            if(url.pathname.endsWith('/geojson-by-date')) {
                return route.fulfill({status:failTerritory ? 503 : 200, json:failTerritory ? {error:'offline'} : territory(url.searchParams.get('date'))});
            }
            if(url.href === 'https://ukraineviews.org/data/manifest.json') {
                return route.fulfill({json:{sources:{suriyak:{files:['suriyak_2026_01_12.kml']}}}});
            }
            if(/suriyak_202601\d{2}\.kml$/.test(url.pathname)) {
                const day=Number(url.pathname.match(/suriyak_202601(\d{2})/)[1]);
                playbackLayerRequests.push(day);
                // Deliberately slower than 4x playback: the next frame must wait.
                await new Promise(resolve=>setTimeout(resolve,450));
                const coordinates=square(35+day/100).map(p=>p.join(',')+',0').join(' ');
                return route.fulfill({contentType:'application/vnd.google-earth.kml+xml',body:
                    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Russian Armed Forces</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`});
            }
            if(url.pathname.endsWith('.json') || url.pathname.endsWith('.geojson')) return route.fulfill({json:empty});
            if(route.request().resourceType() === 'stylesheet') return route.fulfill({contentType:'text/css',body:''});
            return route.fulfill({status:204,body:''});
        });
        await page.goto(`${origin}/index.html`, {waitUntil:'load'});
        await page.waitForFunction(()=>window.dashboard?.renderDeepLayer && window.dashboard?.regionsData);
        await page.evaluate(()=>{
            dashboard.minDate=new Date(2026,0,1); dashboard.maxDate=new Date(2026,0,5);
            dashboard.initSlider(dashboard.minDate, dashboard.maxDate, new Date(2026,0,1), new Date(2026,0,2));
            document.getElementById('date-start').value='2026-01-01';
            document.getElementById('date-end').value='2026-01-02';
        });
        // Actual checkbox binding must reach the extracted controller.
        await page.locator('label').filter({has:page.locator('#diff-area')}).click();
        await page.waitForFunction(()=>dashboard.deepLayer.getLayers().length > 0 && document.getElementById('territory-status').textContent === '');
        await page.locator('label').filter({has:page.locator('#diff-highlight')}).click();
        await page.waitForFunction(()=>dashboard.currentDiffResult?.polygons.some(p=>p.type==='difference'));
        const before = await page.evaluate(()=>JSON.stringify(dashboard.deepLayer.toGeoJSON()));
        failTerritory=true;
        await page.evaluate(async()=>{
            dashboard.endDate=new Date(2026,0,3);
            await dashboard.renderDeepLayer();
        });
        assert.match(await page.locator('#territory-status').textContent(), /unavailable/);
        assert.equal(await page.evaluate(()=>JSON.stringify(dashboard.deepLayer.toGeoJSON())),before);
        failTerritory=false;
        // Date input binding (not a direct controller call) retries the previously failed date.
        const retryResponse = page.waitForResponse(response => response.url().includes('geojson-by-date?date=2026-01-03') && response.status() === 200);
        await page.locator('#date-end').fill('2026-01-03');
        await page.locator('#date-end').dispatchEvent('change');
        await retryResponse;
        await page.waitForFunction(()=>document.getElementById('territory-status').textContent === '');
        const payload={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'<img src=x onerror="window.importExecuted=true">',description:'<svg onload="window.importExecuted=true"></svg>'},geometry:{type:'Polygon',coordinates:[square(35)]}}]};
        await page.locator('#custom-kml-file').setInputFiles({name:'smoke.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(payload))});
        await page.waitForFunction(()=>dashboard.customKmlData?.features.length === 1);
        await page.evaluate(async()=>{
            dashboard.map.setView([48.5,35.5],7,{animate:false});
            await dashboard.layers.toggleCustomKmlOverlay(true);
            const open = layer => { if (layer.getTooltip?.()) layer.openTooltip(); else layer.eachLayer?.(open); };
            dashboard.customKmlOverlay.eachLayer(open);
        });
        const result=await page.evaluate(()=>({executed:!!window.importExecuted, tooltip:document.querySelector('.leaflet-tooltip')?.textContent,
            injected:!!document.querySelector('.leaflet-tooltip img, .leaflet-tooltip svg')}));
        assert.equal(result.executed,false); assert.equal(result.injected,false);
        assert.match(result.tooltip,/onerror/);
        assert.deepEqual(errors,[]);
        fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
        await page.screenshot({path:path.join(root,'output/playwright/review-fixes.png')});
        await page.evaluate(()=>{
            document.getElementById('diff-highlight').checked=false;
            document.getElementById('suriyak-overlay').checked=true;
            document.getElementById('playback-speed').value='250';
            dashboard.minDate=new Date(2026,0,10); dashboard.maxDate=new Date(2026,0,13);
            dashboard.initSlider(dashboard.minDate,dashboard.maxDate,new Date(2026,0,10),new Date(2026,0,11));
        });
        await page.locator('#play-btn').click();
        await page.waitForFunction(()=>dashboard.isPlaying && dashboard.endDate.getDate()===12 &&
            dashboard.currentDeepResult?.polygons[0]?.geojson.properties.fixtureDate==='2026-01-12' &&
            Math.abs(turf.bbox(dashboard.suriyakMergedPolygon)[0]-35.12)<1e-8);
        await page.waitForFunction(()=>!dashboard.isPlaying && dashboard.endDate.getDate()===13 &&
            dashboard.currentDeepResult?.polygons[0]?.geojson.properties.fixtureDate==='2026-01-13' &&
            Math.abs(turf.bbox(dashboard.suriyakMergedPolygon)[0]-35.13)<1e-8);
        assert.deepEqual(playbackLayerRequests,[12,13]);
        assert.deepEqual(errors,[]);
        const game = await browser.newPage();
        game.on('pageerror', e=>errors.push(e.message));
        await game.route('**/*', route => {
            const url = new URL(route.request().url());
            return url.origin === origin || ['cdnjs.cloudflare.com','unpkg.com','cdn.jsdelivr.net'].includes(url.hostname)
                ? route.continue() : route.fulfill({status:204,body:''});
        });
        await game.goto(`${origin}/game/game.html`, {waitUntil:'load'});
        await game.waitForFunction(()=>window.gameUI && window.L?.version === '1.9.4' && typeof turf.area === 'function');
        assert.deepEqual(errors,[]);
        await game.close();
        console.log('Browser smoke passed: startup, date controls, comparison, failed fetch/retry, GeoJSON import, tooltip escaping, game startup with CDN dependencies, 4x playback with slow dated layers.');
    } finally {
        await browser?.close();
        if (server.listening) await new Promise(resolve=>server.close(resolve));
    }
})().catch(error=>{console.error(error);process.exitCode=1;});

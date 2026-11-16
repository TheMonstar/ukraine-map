#!/usr/bin/env node
// Render the link-preview card for mala-tokmachka.html (images/capture-preview.jpg, 1200×630)
// from the game itself: the street blocks split between the three sides, the whole village
// square-on, and a title card with the settlement sign on top.
// Our own picture: no third-party images or logos.
//
//   node scripts/capture-preview.mjs [--url http://localhost:8080/] [--out images/capture-preview.jpg]
//
// --url is where this checkout is served. Needs Playwright (npm ci --prefix mcp).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('url', 'http://localhost:8080/');
const out = arg('out', join(ROOT, 'images', 'capture-preview.jpg'));

let playwright;
try {
    playwright = createRequire(import.meta.url)('playwright');
} catch {
    playwright = createRequire(join(ROOT, 'mcp', 'package.json'))('playwright');
}

const CARD = `
<div id="og-card">
  <div class="og-shade"></div>
  <div class="og-sign"><b>МАЛА ТОКМАЧКА</b></div>
  <div class="og-text">
    <h1>‘Whoever Controls Mala Tokmachka Controls the World’</h1>
  </div>
</div>
<style>
  .cap-root { display: none !important; }
  #og-card { position: fixed; inset: 0; z-index: 9999; pointer-events: none; font-family: Georgia, 'Times New Roman', serif; color: #fff; }
  .og-shade { position: absolute; inset: 0;
    background: radial-gradient(ellipse 85% 70% at 50% 62%, rgba(8,10,16,0.02), rgba(8,10,16,0.62)),
                linear-gradient(180deg, rgba(8,10,16,0.86), rgba(8,10,16,0.55) 42%, rgba(8,10,16,0.05) 56%, rgba(8,10,16,0.05) 70%, rgba(8,10,16,0.72)); }
  /* a Ukrainian settlement sign */
  .og-sign { position: absolute; left: 50%; top: 30px; transform: translateX(-50%); padding: 6px 26px; background: #f4f4f0; color: #111; text-align: center;
    border: 3px solid #111; outline: 3px solid #f4f4f0; box-shadow: 0 6px 22px rgba(0,0,0,0.6); font-family: 'Arial Narrow', Arial, sans-serif; }
  .og-sign b { display: block; font-size: 30px; line-height: 1.1; letter-spacing: 3px; }
  .og-text { position: absolute; left: 80px; right: 80px; top: 132px; text-align: center; }
  .og-text h1 { margin: 0; font-size: 54px; line-height: 1.1; font-weight: 700; letter-spacing: -0.5px; text-shadow: 0 3px 18px rgba(0,0,0,0.75); }
</style>`;

const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    page.on('pageerror', err => console.warn('page error:', err.message));
    await page.goto(new URL('mala-tokmachka.html', base).toString());
    await page.waitForFunction(() => window.__capture?.mode === 'setup', null, { timeout: 180000 });
    await page.evaluate(() => {
        localStorage.setItem('capture-side', 'us');
        document.querySelector('.cap-primary').click();
    });
    await page.waitForFunction(() => window.__capture.mode === 'solo');
    await page.evaluate(() => {
        const c = window.__capture, st = c.state;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));   // pause: nobody moves
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })); // no selection ring
        // the same picture every time: China holds the west, the US the middle, Russia the east;
        // just the block colours, no columns on the map
        for (const b of st.blocks) {
            const x = c.world.blocks[b.id].x;
            Object.assign(b, { owner: x < -1300 ? 'cn' : x < 1300 ? 'us' : 'ru', troops: 35, lv: [0, 0, 0] });
        }
        st.groups = [];
        st.nextEventAt = Infinity;
        // the whole village, square-on from the south-south-west: the strip runs across the
        // middle of the frame, sky and title above it
        c.controls.target.set(432, 60, -1390);
        c.camera.position.set(-1370, 3000, 4960);
        c.controls.update();
    });
    await page.evaluate(card => document.body.insertAdjacentHTML('beforeend', card), CARD);
    await page.waitForTimeout(4000);           // let the frame settle
    await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
    console.log(`wrote ${out}`);
} finally {
    await browser.close();
}

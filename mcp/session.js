/**
 * Browser lifecycle for the MCP server: one Chromium, one page, one injected bridge.
 *
 * The app is a static site that fetches both remote APIs and local JSON, so it must be
 * served over http — file:// is rejected. If nothing is listening on the target port we
 * start `python3 -m http.server` from the repo root, exactly as .claude/launch.json does.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const BRIDGE_SRC = readFileSync(join(HERE, 'browser', 'agent-api.js'), 'utf8');

const DEFAULT_URL = 'http://localhost:8080/index.html';

let browser = null;
let page = null;
let httpServer = null;

function portOf(url) {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

function isListening(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host });
        const done = (v) => { sock.destroy(); resolve(v); };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.setTimeout(700, () => done(false));
    });
}

async function ensureServer(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    const port = portOf(url);
    if (await isListening(port)) return null;

    const proc = spawn('python3', ['-m', 'http.server', String(port)], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: false,
    });
    for (let i = 0; i < 40; i++) {
        if (await isListening(port)) return proc;
        await new Promise((r) => setTimeout(r, 150));
    }
    proc.kill();
    throw new Error(`could not start a static server on port ${port}`);
}

export async function open({ url = DEFAULT_URL, headless = false, width = 1600, height = 1000 } = {}) {
    if (url.startsWith('file://')) {
        throw new Error('file:// is not supported — the app fetches JSON and needs an http origin. Use http://localhost:8080/index.html');
    }
    await close();

    const { chromium } = await import('playwright');
    httpServer = await ensureServer(url);

    browser = await chromium.launch({ headless });
    // Render at 2x so the drawing canvas (which is devicePixelRatio-aware) and map
    // tiles are retina-sharp for poster exports. Cheap feedback screenshots ask
    // Playwright for `scale:'css'`, which hands back a 1x image from the same context.
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE_SRC);
    page = await context.newPage();

    page.on('console', (m) => {
        if (m.type() === 'error') process.stderr.write(`[page] ${m.text()}\n`);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ready = await page.evaluate(() => window.__agent.ready());
    return { url, headless, ...ready };
}

export function isOpen() {
    return !!page && !page.isClosed();
}

function requirePage() {
    if (!isOpen()) throw new Error('map is not open — call map_open first');
    return page;
}

/**
 * Runs `window.__agent[method](...args)` in the page.
 * All app coupling goes through the bridge, so this is the only evaluate path.
 */
export async function call(method, ...args) {
    const p = requirePage();
    return p.evaluate(
        ([m, a]) => {
            const fn = window.__agent[m];
            if (typeof fn !== 'function') throw new Error(`no bridge method "${m}"`);
            return fn(...a);
        },
        [method, args]
    );
}

/**
 * Captures the map.
 *
 * Defaults to JPEG at CSS resolution: satellite basemaps are photographic, so a
 * lossless 2x capture costs megabytes of base64 for no gain in a feedback loop.
 * `scale: 2` asks for the context's full device resolution — that is the poster path.
 */
export async function screenshot({ selector = '#map', fullPage = false, png = false,
                                   scale = 1, width, height } = {}) {
    const p = requirePage();

    if (width && height) {
        await p.setViewportSize({ width, height });
        await p.waitForTimeout(400);   // let Leaflet re-layout and fetch new tiles
    }

    // let map tiles finish loading, then let the canvas repaint, before capturing
    await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(700);

    const opts = {
        ...(png ? { type: 'png' } : { type: 'jpeg', quality: 82 }),
        scale: scale >= 2 ? 'device' : 'css',
    };
    if (fullPage || !selector) return { buffer: await p.screenshot({ ...opts, fullPage }), png };
    const el = await p.$(selector);
    if (!el) return { buffer: await p.screenshot(opts), png };
    return { buffer: await el.screenshot(opts), png };
}

export async function close() {
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    page = null;
    if (httpServer) { httpServer.kill(); httpServer = null; }
    return { closed: true };
}

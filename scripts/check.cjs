const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.name === 'node_modules' ? [] : e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const scripts = ['js', 'game/js', 'mcp', 'tests', 'scripts'].flatMap(files).filter(f => /\.(?:js|cjs)$/.test(f));
for (const file of scripts) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
let cdnAssets = 0;
for (const page of ['index.html', 'game/game.html']) {
    const html = readFileSync(page, 'utf8');
    for (const [tag, src] of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"[^>]*>/g)) {
        if (!tag.startsWith('<script') && !tag.includes('rel="stylesheet"')) continue;
        if (src === 'https://www.googletagmanager.com/gtag/js?id=G-TDKVEL6LDH' && page === 'index.html') continue;
        if (src.startsWith('https://fonts.googleapis.com/') && page === 'index.html') continue;
        if (/^(?:https?:)?\/\//.test(src)) {
            const url = new URL(src);
            assert.equal(url.protocol, 'https:', `${page}: insecure dependency ${src}`);
            const pinned = url.hostname === 'cdnjs.cloudflare.com'
                ? /\/ajax\/libs\/[^/]+\/\d+\.\d+\.\d+(?:-[^/]+)?\//.test(url.pathname)
                : ['unpkg.com', 'cdn.jsdelivr.net'].includes(url.hostname) && /@\d+\.\d+\.\d+(?:-[^/]+)?\//.test(url.pathname);
            assert.ok(pinned, `${page}: dependency must use an exact CDN version: ${src}`);
            assert.match(tag, /integrity="sha384-[A-Za-z0-9+/]{64}"/, `${page}: missing integrity for ${src}`);
            assert.ok(tag.includes('crossorigin="anonymous"'), `${page}: missing CORS attribute for ${src}`);
            cdnAssets++;
        } else {
            readFileSync(join(page.includes('/') ? 'game' : '.', src.split('?')[0]));
        }
    }
}
console.log(`Syntax checked ${scripts.length} scripts; verified ${cdnAssets} pinned CDN references and entry-point files.`);
const result = spawnSync(process.execPath, ['--test', 'tests/regressions.cjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);

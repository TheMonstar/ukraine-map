// High-resolution screenshot export, with an optional poster title block.
//
// The panel/toolbar are DOM overlays, so they are never in the WebGL capture — only the
// canvas needs handling. The renderer must be created with `preserveDrawingBuffer: true`
// (see main.js) or toDataURL returns a blank image.

import * as THREE from 'three';

const BAND_FRACTION = 0.11;   // poster band height as a fraction of image height

function niceRound(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

// Approximate ground metres per pixel at the orbit target's depth. The camera is
// perspective and usually tilted, so this is only exact at the scene centre — the
// poster labels it as such.
function metersPerPixel(camera, controls, heightPx) {
    const dist = camera.position.distanceTo(controls.target);
    const worldH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;
    return worldH / heightPx;
}

// Screen-space angle of grid north (local -Z), in radians clockwise from "up".
function northAngle(camera, controls) {
    const a = controls.target.clone().project(camera);
    const b = controls.target.clone().add(new THREE.Vector3(0, 0, -100)).project(camera);
    return Math.atan2(b.x - a.x, b.y - a.y);
}

function drawNorthArrow(ctx, cx, cy, r, angle) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.55, r * 0.7);
    ctx.lineTo(0, r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(-r * 0.55, r * 0.7);
    ctx.lineTo(0, r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#f8fafc';
    ctx.font = `600 ${Math.round(r * 0.8)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy + r * 1.7);
}

function drawScaleBar(ctx, x, y, maxPx, mPerPx) {
    const targetM = niceRound(maxPx * mPerPx);
    const px = targetM / mPerPx;
    const h = Math.max(6, maxPx * 0.03);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(x, y, px, h);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x + px / 2, y, px / 2, h);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(1, h * 0.15);
    ctx.strokeRect(x, y, px, h);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = `500 ${Math.round(h * 2)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    const label = targetM >= 1000 ? `${(targetM / 1000).toFixed(targetM % 1000 ? 1 : 0)} km` : `${targetM} m`;
    ctx.fillText(`${label}  (approx. at scene centre)`, x, y + h * 3.4);
}

function drawPoster(ctx, w, h, info, camera, controls) {
    const bandH = Math.round(h * BAND_FRACTION);
    const y0 = h - bandH;

    const grad = ctx.createLinearGradient(0, y0 - bandH * 0.5, 0, h);
    grad.addColorStop(0, 'rgba(15, 23, 42, 0)');
    grad.addColorStop(0.4, 'rgba(15, 23, 42, 0.85)');
    grad.addColorStop(1, 'rgba(15, 23, 42, 0.96)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0 - bandH * 0.5, w, bandH * 1.5);

    const pad = Math.round(bandH * 0.28);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = `700 ${Math.round(bandH * 0.34)}px Inter, system-ui, sans-serif`;
    ctx.fillText(info.title || '3D Terrain Viewer', pad, y0 + bandH * 0.42);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `500 ${Math.round(bandH * 0.19)}px Inter, system-ui, sans-serif`;
    ctx.fillText(info.subtitle || '', pad, y0 + bandH * 0.72);

    drawScaleBar(ctx, Math.round(w * 0.42), y0 + bandH * 0.3, Math.round(w * 0.16),
        metersPerPixel(camera, controls, h));

    const r = bandH * 0.28;
    drawNorthArrow(ctx, w - pad - r, y0 + bandH * 0.42, r, northAngle(camera, controls));
}

/**
 * Render the scene at `scale`× the on-screen size and download a PNG.
 * @param {object} ctx3d { renderer, scene, camera, controls }
 * @param {object} opts { scale, poster, title, subtitle, filename }
 */
export function captureScreenshot(ctx3d, opts = {}) {
    const { renderer, scene, camera, controls } = ctx3d;
    const { scale = 2, poster = false, title = '', subtitle = '', filename } = opts;

    const w = window.innerWidth, h = window.innerHeight;
    const outW = Math.round(w * scale), outH = Math.round(h * scale);
    const prevPixelRatio = renderer.getPixelRatio();

    renderer.setPixelRatio(1);
    renderer.setSize(outW, outH, false);
    camera.aspect = outW / outH;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    let dataUrl;
    try {
        if (!poster) {
            dataUrl = renderer.domElement.toDataURL('image/png');
        } else {
            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const c2d = canvas.getContext('2d');
            c2d.drawImage(renderer.domElement, 0, 0, outW, outH);
            drawPoster(c2d, outW, outH, { title, subtitle }, camera, controls);
            dataUrl = canvas.toDataURL('image/png');
        }
    } finally {
        renderer.setPixelRatio(prevPixelRatio);
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
    }

    const link = document.createElement('a');
    link.download = filename || `3d-view-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    link.href = dataUrl;
    link.click();
}

export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJSONFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            try {
                resolve(JSON.parse(await file.text()));
            } catch (e) {
                console.warn('Sandbox JSON parse failed:', e);
                resolve(null);
            }
        });
        input.click();
    });
}

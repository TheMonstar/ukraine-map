// Procedural canvas textures for the 3D viewer — drawn at runtime, no binary assets.

import * as THREE from 'three';

// World-space size (meters) covered by one texture tile. Geometry UVs are in
// meters, so materials set texture.repeat = 1 / TILE_M.
export const WALL_TILE_M = 3;
export const ROOF_TILE_M = 2;

function canvasTexture(size, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    draw(ctx, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function speckle(ctx, size, count, alpha) {
    for (let i = 0; i < count; i++) {
        const v = Math.floor(Math.random() * 70) - 35;
        ctx.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},${alpha})`;
        ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
}

// Window with frame, glass reflection gradient, cross bars and sill.
function drawWindow(ctx, x, y, w, h) {
    ctx.fillStyle = '#7d7464';                       // frame
    ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
    ctx.fillStyle = '#2e3d4f';                       // glass
    ctx.fillRect(x, y, w, h);
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, 'rgba(180,200,220,0.45)');
    grad.addColorStop(0.5, 'rgba(180,200,220,0.05)');
    grad.addColorStop(1, 'rgba(120,140,160,0.3)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#6b6354';                       // cross bars
    ctx.fillRect(x + w / 2 - 3, y, 6, h);
    ctx.fillRect(x, y + h / 2 - 3, w, 6);
    ctx.fillStyle = '#9a9182';                       // sill
    ctx.fillRect(x - 10, y + h + 6, w + 20, 8);
}

// Plaster wall, one 3 m × 3 m tile. Variant 0: single wide window;
// variant 1: two narrow windows.
export function makePlasterWallTexture(variant = 0) {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = variant === 0 ? '#d6cdbb' : '#d8d2c2';
        ctx.fillRect(0, 0, size, size);
        speckle(ctx, size, 900, 0.08);
        if (variant === 0) {
            drawWindow(ctx, (size - 94) / 2, size - 145 - 60, 94, 120);
        } else {
            drawWindow(ctx, 42, size - 140 - 55, 60, 110);
            drawWindow(ctx, 154, size - 140 - 55, 60, 110);
        }
    });
}

// Brick wall with staggered mortar courses and a window with a concrete lintel.
export function makeBrickWallTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#9e5a40';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#c7b9a5';                       // mortar
        for (let y = 0, row = 0; y < size; y += 18, row++) {
            ctx.fillRect(0, y, size, 2);
            for (let x = (row % 2) * 22; x < size; x += 44) {
                ctx.fillRect(x, y, 2, 18);
            }
        }
        for (let i = 0; i < 50; i++) {                   // brick shade variation
            const bx = Math.floor(Math.random() * 6) * 44 + (Math.floor(Math.random() * 14) % 2) * 22;
            const by = Math.floor(Math.random() * 14) * 18;
            ctx.fillStyle = `rgba(${60 + Math.random() * 60},30,20,${0.1 + Math.random() * 0.2})`;
            ctx.fillRect(bx + 2, by + 2, 42, 16);
        }
        speckle(ctx, size, 500, 0.06);
        const w = 86, h = 112, x = (size - w) / 2, y = size - 140 - h / 2;
        ctx.fillStyle = '#b9b0a0';                       // lintel
        ctx.fillRect(x - 12, y - 18, w + 24, 12);
        drawWindow(ctx, x, y, w, h);
    });
}

// Prefab concrete panels with seams and a horizontal window band (industrial).
export function makePanelWallTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#b6b9b3';
        ctx.fillRect(0, 0, size, size);
        speckle(ctx, size, 700, 0.07);
        ctx.fillStyle = '#8f928c';                       // panel seams
        for (let x = 0; x <= size; x += 85) ctx.fillRect(x - 1, 0, 3, size);
        for (let y = 0; y <= size; y += 85) ctx.fillRect(0, y - 1, size, 3);
        for (let i = 0; i < 10; i++) {                   // weathering streaks
            const x = Math.random() * size;
            const grad = ctx.createLinearGradient(x, 0, x, size);
            grad.addColorStop(0, 'rgba(60,65,60,0.12)');
            grad.addColorStop(1, 'rgba(60,65,60,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(x, 0, 3 + Math.random() * 5, size);
        }
        const w = 170, h = 54, x = (size - w) / 2, y = 60;
        ctx.fillStyle = '#5a6058';                       // window band frame
        ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
        ctx.fillStyle = '#37444f';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#5a6058';
        for (let mx = x + 34; mx < x + w; mx += 34) ctx.fillRect(mx - 2, y, 4, h); // mullions
    });
}

// Corrugated metal roof sheeting (rusty red — tinted per building via vertex colors).
export function makeCorrugatedRoofTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#9c4f38';
        ctx.fillRect(0, 0, size, size);
        for (let x = 0; x < size; x += 16) {            // corrugation ridges
            const grad = ctx.createLinearGradient(x, 0, x + 16, 0);
            grad.addColorStop(0, 'rgba(0,0,0,0.25)');
            grad.addColorStop(0.4, 'rgba(255,255,255,0.12)');
            grad.addColorStop(1, 'rgba(0,0,0,0.25)');
            ctx.fillStyle = grad;
            ctx.fillRect(x, 0, 16, size);
        }
        for (let i = 0; i < 40; i++) {                  // rust patches
            ctx.fillStyle = `rgba(${90 + Math.random() * 50},${40 + Math.random() * 25},25,${0.1 + Math.random() * 0.15})`;
            const r = 4 + Math.random() * 14;
            ctx.beginPath();
            ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
            ctx.fill();
        }
        speckle(ctx, size, 400, 0.06);
    });
}

// Clay tile roof: scalloped rows of terracotta tiles.
export function makeTileRoofTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#b05636';
        ctx.fillRect(0, 0, size, size);
        for (let y = 0; y < size; y += 32) {
            for (let x = 0; x < size; x += 32) {
                const shade = (Math.random() - 0.5) * 0.2;
                ctx.fillStyle = shade > 0
                    ? `rgba(255,220,200,${shade})` : `rgba(70,30,15,${-shade})`;
                ctx.fillRect(x, y, 32, 32);              // per-tile shade variation
                ctx.strokeStyle = '#7e3a24';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(x + 16, y + 32, 16, Math.PI, 0); // scalloped lower edge
                ctx.stroke();
                ctx.strokeStyle = 'rgba(255,235,220,0.18)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x + 16, y + 30, 13, Math.PI * 1.15, Math.PI * 1.85);
                ctx.stroke();
            }
        }
        speckle(ctx, size, 300, 0.05);
    });
}

// Flat bitumen roof (multi-story/apartment blocks): dark gray with tar seams and patches.
export function makeFlatRoofTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#6b6a64';
        ctx.fillRect(0, 0, size, size);
        speckle(ctx, size, 900, 0.07);
        ctx.fillStyle = 'rgba(35,33,30,0.35)';           // tar roll seams
        for (let y = 32; y < size; y += 64) ctx.fillRect(0, y, size, 4);
        for (let i = 0; i < 14; i++) {                   // repair patches & stains
            const w = 20 + Math.random() * 50, h = 16 + Math.random() * 40;
            ctx.fillStyle = Math.random() < 0.5 ? 'rgba(30,28,26,0.18)' : 'rgba(120,118,110,0.2)';
            ctx.fillRect(Math.random() * size, Math.random() * size, w, h);
        }
        for (let i = 0; i < 5; i++) {                    // puddle-like darker blots
            ctx.fillStyle = 'rgba(40,42,46,0.15)';
            ctx.beginPath();
            ctx.ellipse(Math.random() * size, Math.random() * size,
                12 + Math.random() * 22, 8 + Math.random() * 14, Math.random() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

// Standing-seam gray metal roof.
export function makeSeamRoofTexture() {
    return canvasTexture(256, (ctx, size) => {
        ctx.fillStyle = '#76828d';
        ctx.fillRect(0, 0, size, size);
        speckle(ctx, size, 500, 0.05);
        for (let x = 0; x < size; x += 36) {
            ctx.fillStyle = '#59646e';                   // seam shadow
            ctx.fillRect(x, 0, 2, size);
            ctx.fillStyle = 'rgba(255,255,255,0.18)';    // seam highlight
            ctx.fillRect(x + 2, 0, 1, size);
            const grad = ctx.createLinearGradient(x, 0, x + 36, 0);
            grad.addColorStop(0, 'rgba(0,0,0,0.08)');
            grad.addColorStop(0.5, 'rgba(255,255,255,0.04)');
            grad.addColorStop(1, 'rgba(0,0,0,0.08)');
            ctx.fillStyle = grad;
            ctx.fillRect(x, 0, 36, size);
        }
    });
}

// Grass blade tuft on transparent background, for alpha-tested crossed planes.
export function makeGrassTexture() {
    return canvasTexture(128, (ctx, size) => {
        ctx.clearRect(0, 0, size, size);
        for (let i = 0; i < 120; i++) {
            const x0 = 8 + Math.random() * (size - 16);
            const lean = (Math.random() - 0.5) * 34;
            const h = size * (0.45 + Math.random() * 0.5);
            const g = 95 + Math.floor(Math.random() * 70);
            ctx.strokeStyle = `rgb(${g * 0.55},${g},${g * 0.35})`;
            ctx.lineWidth = 1.5 + Math.random() * 2;
            ctx.beginPath();
            ctx.moveTo(x0, size);
            ctx.quadraticCurveTo(x0 + lean * 0.3, size - h * 0.6, x0 + lean, size - h);
            ctx.stroke();
        }
    });
}

// APP-6-lite unit symbols drawn to CanvasTextures — friendly frames are rectangles,
// hostile frames are diamonds, matching the red/blue convention the rest of the app uses.
// Same procedural-canvas approach as textures.js; no binary assets.

import * as THREE from 'three';

const PX = 192;

export const SYMBOL_TYPES = ['infantry', 'mech', 'armour', 'at', 'mg', 'arty', 'op', 'hq'];

const FILL = { red: '#f08a8a', blue: '#8ab4f0' };
const STROKE = { red: '#7f1d1d', blue: '#1e3a8a' };

function framePath(ctx, side, x, y, w, h) {
    ctx.beginPath();
    if (side === 'red') {           // hostile: diamond
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w / 2, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
    } else {                        // friendly: rectangle
        ctx.rect(x, y, w, h);
    }
}

function drawGlyph(ctx, type, cx, cy, r) {
    ctx.lineWidth = PX * 0.035;
    ctx.lineCap = 'round';
    const cross = () => {
        ctx.beginPath();
        ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
        ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
        ctx.stroke();
    };
    const oval = (fill) => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 1.15, r * 0.62, 0, 0, Math.PI * 2);
        if (fill) ctx.fill(); else ctx.stroke();
    };
    switch (type) {
        case 'infantry': cross(); break;
        case 'mech': oval(false); cross(); break;
        case 'armour': oval(false); break;
        case 'at':
            ctx.beginPath();
            ctx.moveTo(cx - r, cy + r * 0.8);
            ctx.lineTo(cx, cy - r * 0.9);
            ctx.lineTo(cx + r, cy + r * 0.8);
            ctx.stroke();
            break;
        case 'mg':
            ctx.beginPath();
            ctx.moveTo(cx, cy + r); ctx.lineTo(cx, cy - r);
            ctx.moveTo(cx - r * 0.7, cy + r); ctx.lineTo(cx, cy + r * 0.1);
            ctx.lineTo(cx + r * 0.7, cy + r);
            ctx.stroke();
            break;
        case 'arty':
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
            ctx.fill();
            break;
        case 'op':
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.75, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
            ctx.fill();
            break;
        case 'hq':
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.8, cy + r); ctx.lineTo(cx - r * 0.8, cy - r);
            ctx.lineTo(cx + r * 0.9, cy - r); ctx.lineTo(cx + r * 0.9, cy - r * 0.15);
            ctx.lineTo(cx - r * 0.8, cy - r * 0.15);
            ctx.stroke();
            break;
    }
}

export function makeSymbolCanvas(type, side) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PX;
    const ctx = canvas.getContext('2d');
    const pad = PX * 0.08;
    const w = PX - pad * 2;
    const h = side === 'red' ? w : w * 0.78;
    const y = (PX - h) / 2;

    ctx.fillStyle = FILL[side] || FILL.blue;
    ctx.strokeStyle = STROKE[side] || STROKE.blue;
    framePath(ctx, side, pad, y, w, h);
    ctx.fill();
    ctx.lineWidth = PX * 0.045;
    ctx.stroke();

    ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#0f172a';
    drawGlyph(ctx, type, PX / 2, PX / 2, PX * (side === 'red' ? 0.15 : 0.18));
    return canvas;
}

export function makeSymbolTexture(type, side) {
    const texture = new THREE.CanvasTexture(makeSymbolCanvas(type, side));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    return texture;
}

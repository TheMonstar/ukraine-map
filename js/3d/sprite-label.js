// Camera-facing text label: a rounded-rect CanvasTexture pill wrapped in a Sprite,
// sized in world meters (sizeAttenuation on). Shared by the settlement titles layer
// and the sandbox marker labels.

import * as THREE from 'three';

const FONT_PX = 48;

export function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Draw the pill onto a fresh canvas; `accent` tints the border.
export function makeLabelCanvas(text, accent = 'rgba(148, 163, 184, 0.6)') {
    const padX = 18, padY = 12;
    const measure = document.createElement('canvas').getContext('2d');
    const font = `600 ${FONT_PX}px Inter, system-ui, sans-serif`;
    measure.font = font;
    const textW = Math.ceil(measure.measureText(text).width);

    const canvas = document.createElement('canvas');
    canvas.width = textW + padX * 2;
    canvas.height = FONT_PX + padY * 2;
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 12);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 11);
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(text, padX, canvas.height / 2 + 2);
    return canvas;
}

function labelTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    return texture;
}

// `heightM` is the sprite height in world meters; `accent` tints the border.
export function makeLabelSprite(text, heightM = 70, accent = 'rgba(148, 163, 184, 0.6)') {
    const canvas = makeLabelCanvas(text, accent);
    const material = new THREE.SpriteMaterial({ map: labelTexture(canvas), transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(heightM * canvas.width / canvas.height, heightM, 1);
    return sprite;
}

/**
 * The same label, but lying flat on the ground like a printed map label instead of
 * facing the camera. Subdivided so it can be draped over a slope rather than clipping
 * into it; the caller grounds each vertex and sets `rotation.y` to the bearing.
 */
export function makeLabelPlane(text, heightM = 45, accent = 'rgba(148, 163, 184, 0.6)') {
    const canvas = makeLabelCanvas(text, accent);
    const widthM = heightM * canvas.width / canvas.height;
    const geometry = new THREE.PlaneGeometry(widthM, heightM, 8, 2);
    geometry.rotateX(-Math.PI / 2);   // lie flat, +u running along local +x
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        map: labelTexture(canvas), transparent: true, depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    }));
    mesh.renderOrder = 3;
    return mesh;
}

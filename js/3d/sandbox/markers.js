// Sandbox markers: the familiar red/blue map marker (optionally swapped for an
// APP-6-lite symbol head) with a text label, sitting on open ground or on a building
// roof, plus foxhole positions.
//
// The marker is a camera-facing billboard rather than 3D geometry: a thin post reads
// as a stray line at map scale, while the teardrop silhouette stays instantly
// recognisable from any distance or camera angle.
//
// Ground-relative Y is re-derived in reDrape from `userData.localX/localZ`, the same
// pattern the settlement label sprites use. Roof-mounted markers instead follow the
// building record's `wallTopY`, which buildings.reDrape keeps current.

import * as THREE from 'three';
import { makeLabelSprite } from '../sprite-label.js';
import { makeSymbolTexture } from './symbols.js';

export const SIDE_HEX = { red: 0xdc2626, blue: 0x2563eb, neutral: 0xf8fafc };
const SIDE_CSS = { red: '#dc2626', blue: '#2563eb', neutral: '#f8fafc' };

// Markers hold a constant on-screen size (see Sandbox.update), so these are really
// screen sizes in disguise: at Size 1 a marker renders ~2.7 px per metre of base
// height, i.e. ~24 px for the pin and ~16 px for the label pill. Sized to be right at
// Size 1 rather than needing the slider pinned to its minimum.
const PIN_HEIGHT = 9;         // ≈ 24 px on screen at Size 1
const LABEL_HEIGHT = 6;       // ≈ 16 px on screen at Size 1
const FOXHOLE_RADIUS = 3.2;

// Classic map-marker silhouette: a disc with two tangent lines running down to the
// tip, so the point of the marker is exactly the thing being marked.
function makeMarkerTexture(cssColor) {
    const r = 60, pad = 8, stroke = 7;
    const cx = pad + stroke / 2 + r;
    const cy = pad + stroke / 2 + r;
    const tipDist = r * 2.25;                       // centre → tip
    const tipY = cy + tipDist;
    const spread = Math.acos(r / tipDist);          // half-angle of the bottom wedge

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(cx * 2);
    canvas.height = Math.ceil(tipY + stroke / 2 + 1);
    const ctx = canvas.getContext('2d');

    // canvas angles run clockwise with y down, so +90° is straight down toward the tip
    const start = Math.PI / 2 + spread;
    const end = Math.PI / 2 - spread;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end + Math.PI * 2);   // the long way round, over the top
    ctx.lineTo(cx, tipY);
    ctx.closePath();

    ctx.fillStyle = cssColor;
    ctx.fill();
    ctx.lineWidth = stroke;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.lineWidth = stroke * 0.55;
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    return texture;
}

// Camera-facing map marker, anchored so its tip sits on the placement point.
function buildPinMesh(side, scale) {
    const group = new THREE.Group();
    const h = PIN_HEIGHT * scale;
    const texture = makeMarkerTexture(SIDE_CSS[side] || SIDE_CSS.red);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.scale.set(h * texture.image.width / texture.image.height, h, 1);
    sprite.center.set(0.5, 0);   // bottom-centre = the marker tip
    group.add(sprite);
    return group;
}

// Camera-facing unit symbol, likewise standing on the placement point.
function buildSymbolMesh(side, symbol, scale) {
    const group = new THREE.Group();
    const s = PIN_HEIGHT * scale * 0.9;
    const texture = makeSymbolTexture(symbol, side === 'red' ? 'red' : 'blue');
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.scale.set(s, s, 1);
    sprite.center.set(0.5, 0);
    group.add(sprite);
    return group;
}

/**
 * @param {object} opts { side, symbol|null, label, scale }
 * @returns {THREE.Group} origin at the marker tip / base
 */
export function buildMarker(opts = {}) {
    const { side = 'red', symbol = null, label = '', scale = 1 } = opts;
    const group = symbol ? buildSymbolMesh(side, symbol, scale) : buildPinMesh(side, scale);
    group.name = 'marker';

    if (label) {
        const sprite = makeLabelSprite(label, LABEL_HEIGHT * scale,
            side === 'red' ? 'rgba(220, 38, 38, 0.9)' : 'rgba(37, 99, 235, 0.9)');
        // Stacked with `center`, not world Y, so the pill shares the marker's anchor and
        // stays exactly centred on it — see the note in unit-icons.js.
        const markerH = PIN_HEIGHT * scale * (symbol ? 0.9 : 1);
        const gap = LABEL_HEIGHT * scale * 0.15;
        sprite.center.set(0.5, -(markerH + gap) / (LABEL_HEIGHT * scale));
        group.add(sprite);
    }
    group.userData = { kind: 'marker', opts: { side, symbol, label, scale } };
    return group;
}

// A dug-in position: dark pit disc, earth berm ring, and a small side-coloured chip
// so it stays findable from the overview camera.
export function buildFoxhole(opts = {}) {
    const { side = 'red', scale = 1 } = opts;
    const r = FOXHOLE_RADIUS * scale;
    const group = new THREE.Group();
    group.name = 'foxhole';

    const pit = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.6, 16),
        new THREE.MeshBasicMaterial({
            color: 0x14100c, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        }));
    pit.rotation.x = -Math.PI / 2;
    pit.position.y = 0.08;
    group.add(pit);

    // berm: half-torus profile lathed around the pit
    const profile = [];
    for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        profile.push(new THREE.Vector2(r * (0.6 + 0.4 * t), Math.sin(Math.PI * t) * 0.55 * scale));
    }
    const berm = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 18),
        new THREE.MeshStandardMaterial({ color: 0x4a3d2c, roughness: 1 }));
    berm.castShadow = true;
    berm.receiveShadow = true;
    group.add(berm);

    const chip = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.28, 12),
        new THREE.MeshBasicMaterial({ color: SIDE_HEX[side] ?? SIDE_HEX.red, side: THREE.DoubleSide }));
    chip.rotation.x = -Math.PI / 2;
    chip.position.y = 0.7 * scale;
    group.add(chip);

    group.userData = { kind: 'foxhole', opts: { side, scale } };
    return group;
}

// Ground/roof placement. `attach` = { record } to sit on a building roof instead.
export function placeMarker(object, x, z, terrain, attach = null) {
    object.position.x = x;
    object.position.z = z;
    object.userData.localX = x;
    object.userData.localZ = z;
    if (attach) {
        object.userData.buildingId = attach.record.id;
        object.userData.record = attach.record;
        object.position.y = attach.record.wallTopY;
    } else {
        object.position.y = terrain.sampleHeight(x, z);
    }
    return object;
}

export function reDrapeMarker(object, terrain) {
    const rec = object.userData.record;
    object.position.y = rec
        ? rec.wallTopY
        : terrain.sampleHeight(object.userData.localX, object.userData.localZ);
}

export function disposeMarker(object) {
    object.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            // unit-icon textures are cached and shared between placements — disposing
            // one would blank every other unit using the same symbol
            if (o.material.map && !o.userData.sharedTexture) o.material.map.dispose();
            o.material.dispose();
        }
    });
}

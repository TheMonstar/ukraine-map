// Unit icons: the same APP-6 symbol PNGs the main map draws on its unit markers
// (`images/ru/icon-N.png`, `images/ua/icon-N.png`), placed on the diorama as
// camera-facing billboards.
//
// The main map builds its icon list at runtime from whatever appears in the day's
// KML (`dashboard._dailyIconIds` in ui-bindings.js). This page has no KML, so the
// ranges are stated here — both directories are contiguous from 1.

import * as THREE from 'three';
import { makeLabelSprite } from '../sprite-label.js';

export const UNIT_ICON_COUNTS = { ru: 96, ua: 57 };
export const SIDE_TO_DIR = { red: 'ru', blue: 'ua', neutral: 'ru' };

const ICON_W = 128, ICON_H = 120;   // all icons share these pixel dimensions
// As with markers, these are screen sizes in disguise — constant-screen-size scaling
// renders ~2.7 px per metre of base height at Size 1.
const ICON_HEIGHT_M = 10;           // ≈ 27 px on screen at Size 1
const LABEL_HEIGHT_M = 6;           // ≈ 16 px on screen at Size 1

// Textures are shared between every placement of the same icon — `disposeMarker`
// skips maps flagged `sharedTexture` so removing one unit cannot blank the others.
const textureCache = new Map();
const loader = new THREE.TextureLoader();

export function unitIconUrl(dir, id) {
    return `./images/${dir}/icon-${id}.png`;
}

export function loadUnitTexture(dir, id) {
    const key = `${dir}:${id}`;
    let texture = textureCache.get(key);
    if (!texture) {
        // TextureLoader returns the texture synchronously and fills in the image when
        // it arrives, so the sprite can be built immediately.
        texture = loader.load(unitIconUrl(dir, id));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        textureCache.set(key, texture);
    }
    return texture;
}

/**
 * @param {object} opts { side: 'red'|'blue', id, label, scale }
 * @returns {THREE.Group} origin at the icon's bottom edge (the marked point)
 */
export function buildUnitIcon(opts = {}) {
    const { side = 'red', id = 1, label = '', scale = 1 } = opts;
    const dir = SIDE_TO_DIR[side] || 'ru';
    const group = new THREE.Group();
    group.name = 'unit';

    const h = ICON_HEIGHT_M * scale;
    // The designation sits centred *under* the symbol, the way a unit is annotated on a
    // map. The label is bottom-anchored on the marked point and the symbol is lifted
    // clear above it, so the whole assembly still stands on the ground rather than
    // burying the text in the terrain.
    const labelH = label ? LABEL_HEIGHT_M * scale : 0;
    const labelGap = labelH * 0.18;   // keep the pill off the symbol's bottom edge

    // Both sprites sit at the *same* world anchor and are stacked apart with `center`,
    // which offsets in the sprite's own screen-aligned space. Offsetting the symbol in
    // world Y instead would give the two a different anchor, and perspective projects
    // two points at one ground position but different heights to slightly different
    // screen X — verticals lean toward the vanishing point. On a short label like "1st"
    // that lean is a large fraction of the pill's width and reads as bad centring.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: loadUnitTexture(dir, id), transparent: true
    }));
    sprite.scale.set(h * ICON_W / ICON_H, h, 1);
    // negative center.y lifts the symbol clear of the label, measured in symbol heights
    sprite.center.set(0.5, -(labelH + labelGap) / h);
    sprite.userData.sharedTexture = true;
    group.add(sprite);

    if (label) {
        const accent = dir === 'ru' ? 'rgba(220, 38, 38, 0.9)' : 'rgba(37, 99, 235, 0.9)';
        const labelSprite = makeLabelSprite(label, labelH, accent);
        labelSprite.center.set(0.5, 0);   // stands on the anchor, directly under the symbol
        group.add(labelSprite);
    }

    group.userData = { kind: 'unit', opts: { side, id, label, scale } };
    return group;
}

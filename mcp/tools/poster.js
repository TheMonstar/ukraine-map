/** Poster chrome: title block and legend. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as session from '../session.js';

export function poster(args) {
    const { title, subtitle, dateline, caveat, legend, show, clear } = args;
    if (legend && legend.rows && !Array.isArray(legend.rows)) {
        throw new Error('legend.rows must be an array of { label, ... }');
    }
    return session.call('poster', { title, subtitle, dateline, caveat, legend, show, clear });
}

/**
 * High-resolution capture. Separate from map_screenshot, which stays the cheap
 * JPEG feedback-loop tool — this one is the deliverable.
 */
export async function exportMap({ path, width, height, scale = 2, selector = '#map', png = true }) {
    const { buffer, png: isPng } = await session.screenshot({ selector, png, scale, width, height });
    const out = { bytes: buffer.length, format: isPng ? 'png' : 'jpeg', scale };
    if (path) {
        const abs = resolve(path);
        await writeFile(abs, buffer);
        out.path = abs;
    }
    return { buffer, png: isPng, meta: out };
}

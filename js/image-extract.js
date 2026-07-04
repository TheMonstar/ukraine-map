/**
 * ImageExtractor — converts painted zones in a positioned image overlay
 * into georeferenced GeoJSON polygons.
 *
 * Pipeline: image → offscreen canvas → color classification (red preset or
 * eyedropper-sampled color) → connected components → boundary tracing →
 * pixel→LatLng georeferencing (rect bounds or free-shape homography) →
 * turf simplify/union → L.geoJSON layer + merged polygon for comparison.
 */
class ImageExtractor {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.pickedColor = null;   // {r,g,b} sampled via eyedropper, null = red preset
        this.MAX_DIM = 1400;       // cap canvas long side
        this.MIN_COMPONENT_PX = 30;
        this.MIN_AREA_KM2 = 5;
    }

    /** Resolve the overlay to extract from: active editing slot, else last saved. */
    _resolveSource() {
        const d = this.dashboard;
        if (d.customImageOverlay && d.currentImageBounds) {
            return {
                url: d.customImageOverlay._url,
                bounds: d.currentImageBounds,
                freeCorners: d.imageFreeCorners,
                meshPoints: d.imageMeshPoints
            };
        }
        const recs = d.imageOverlayLayers || [];
        if (recs.length) {
            const rec = recs[recs.length - 1];
            return {
                url: rec.url || rec.overlay._url,
                bounds: rec.bounds,
                freeCorners: rec.freeCorners,
                meshPoints: rec.meshPoints
            };
        }
        return null;
    }

    _loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            if (!url.startsWith('data:') && !url.startsWith('blob:')) {
                img.crossOrigin = 'anonymous';
            }
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not load overlay image'));
            img.src = url;
        });
    }

    /** Build the pixel→LatLng mapper for the source georeferencing. */
    _makeProjector(src) {
        if (src.meshPoints && src.meshPoints.points?.length) {
            const { n, points } = src.meshPoints;
            const cells = n - 1;
            const cellCorners = (ri, ci) => [
                points[ri * n + ci], points[ri * n + ci + 1],
                points[(ri + 1) * n + ci], points[(ri + 1) * n + ci + 1]
            ];
            const bilinear = (p00, p10, p01, p11, s, t) => [
                (1 - t) * ((1 - s) * p00.lng + s * p10.lng) + t * ((1 - s) * p01.lng + s * p11.lng),
                (1 - t) * ((1 - s) * p00.lat + s * p10.lat) + t * ((1 - s) * p01.lat + s * p11.lat)
            ];
            const fwd = (u, v) => {
                const cu = Math.min(Math.max(u, 0), 1) * cells;
                const cv = Math.min(Math.max(v, 0), 1) * cells;
                const ci = Math.min(Math.floor(cu), cells - 1);
                const ri = Math.min(Math.floor(cv), cells - 1);
                const [p00, p10, p01, p11] = cellCorners(ri, ci);
                return bilinear(p00, p10, p01, p11, cu - ci, cv - ri);
            };
            // Newton inversion per cell (≤9 cells, cheap); used by the eyedropper
            const inv = (lng, lat) => {
                for (let ri = 0; ri < cells; ri++) {
                    for (let ci = 0; ci < cells; ci++) {
                        const [p00, p10, p01, p11] = cellCorners(ri, ci);
                        let s = 0.5, t = 0.5;
                        for (let it = 0; it < 15; it++) {
                            const [X, Y] = bilinear(p00, p10, p01, p11, s, t);
                            const rx = X - lng, ry = Y - lat;
                            const dXds = (1 - t) * (p10.lng - p00.lng) + t * (p11.lng - p01.lng);
                            const dXdt = (1 - s) * (p01.lng - p00.lng) + s * (p11.lng - p10.lng);
                            const dYds = (1 - t) * (p10.lat - p00.lat) + t * (p11.lat - p01.lat);
                            const dYdt = (1 - s) * (p01.lat - p00.lat) + s * (p11.lat - p10.lat);
                            const det = dXds * dYdt - dXdt * dYds;
                            if (Math.abs(det) < 1e-15) break;
                            s -= (rx * dYdt - ry * dXdt) / det;
                            t -= (ry * dXds - rx * dYds) / det;
                        }
                        if (s >= -0.01 && s <= 1.01 && t >= -0.01 && t <= 1.01) {
                            const [X, Y] = bilinear(p00, p10, p01, p11, s, t);
                            if (Math.abs(X - lng) < 1e-6 && Math.abs(Y - lat) < 1e-6) {
                                return [(ci + Math.min(Math.max(s, 0), 1)) / cells,
                                        (ri + Math.min(Math.max(t, 0), 1)) / cells];
                            }
                        }
                    }
                }
                return [-1, -1]; // outside the mesh
            };
            return { fwd, inv };
        }
        if (src.freeCorners && src.freeCorners.length === 4) {
            // saveImageOverlay order: [sw, se, ne, nw]; image space: nw=TL, ne=TR, se=BR, sw=BL
            const [sw, se, ne, nw] = src.freeCorners;
            const H = ImageExtractor._squareToQuad(
                { x: nw.lng, y: nw.lat }, { x: ne.lng, y: ne.lat },
                { x: se.lng, y: se.lat }, { x: sw.lng, y: sw.lat }
            );
            const fwd = (u, v) => {
                const w = H[6] * u + H[7] * v + 1;
                return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]; // [lng, lat]
            };
            const Hinv = ImageExtractor._invert3x3(H);
            const inv = (lng, lat) => {
                const w = Hinv[6] * lng + Hinv[7] * lat + Hinv[8];
                return [
                    (Hinv[0] * lng + Hinv[1] * lat + Hinv[2]) / w,
                    (Hinv[3] * lng + Hinv[4] * lat + Hinv[5]) / w
                ]; // [u, v]
            };
            return { fwd, inv };
        }
        const [[south, west], [north, east]] = src.bounds;
        return {
            fwd: (u, v) => [west + u * (east - west), north - v * (north - south)],
            inv: (lng, lat) => [(lng - west) / (east - west), (north - lat) / (north - south)]
        };
    }

    /** Homography mapping unit square (0,0)TL,(1,0)TR,(1,1)BR,(0,1)BL → quad. Returns [a,b,c,d,e,f,g,h]. */
    static _squareToQuad(tl, tr, br, bl) {
        const dx1 = tr.x - br.x, dx2 = bl.x - br.x, dx3 = tl.x - tr.x + br.x - bl.x;
        const dy1 = tr.y - br.y, dy2 = bl.y - br.y, dy3 = tl.y - tr.y + br.y - bl.y;
        let a, b, c, d, e, f, g, h;
        if (dx3 === 0 && dy3 === 0) { // affine
            a = tr.x - tl.x; b = br.x - tr.x; c = tl.x;
            d = tr.y - tl.y; e = br.y - tr.y; f = tl.y;
            g = 0; h = 0;
        } else {
            const denom = dx1 * dy2 - dx2 * dy1;
            g = (dx3 * dy2 - dx2 * dy3) / denom;
            h = (dx1 * dy3 - dx3 * dy1) / denom;
            a = tr.x - tl.x + g * tr.x;
            b = bl.x - tl.x + h * bl.x;
            c = tl.x;
            d = tr.y - tl.y + g * tr.y;
            e = bl.y - tl.y + h * bl.y;
            f = tl.y;
        }
        return [a, b, c, d, e, f, g, h];
    }

    /** Invert the 3x3 homography [a,b,c;d,e,f;g,h,1]. Returns 9 elements row-major. */
    static _invert3x3(H) {
        const m = [H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7], 1];
        const det =
            m[0] * (m[4] * m[8] - m[5] * m[7]) -
            m[1] * (m[3] * m[8] - m[5] * m[6]) +
            m[2] * (m[3] * m[7] - m[4] * m[6]);
        const inv = [
            (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
            (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
            (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det
        ];
        return inv;
    }

    static _rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const dlt = max - min;
        let h = 0;
        if (dlt > 0) {
            if (max === r) h = 60 * (((g - b) / dlt) % 6);
            else if (max === g) h = 60 * ((b - r) / dlt + 2);
            else h = 60 * ((r - g) / dlt + 4);
        }
        if (h < 0) h += 360;
        return [h, max === 0 ? 0 : dlt / max, max];
    }

    /** Build classifier fn(r,g,b) → bool from current mode + tolerance (0..100). */
    _makeClassifier(tolerance) {
        const t = tolerance / 100;
        if (this.pickedColor) {
            const { r: tr, g: tg, b: tb } = this.pickedColor;
            const maxDist = 40 + 100 * t;
            return (r, g, b) => {
                const dr = r - tr, dg = g - tg, db = b - tb;
                return Math.sqrt(dr * dr + dg * dg + db * db) <= maxDist;
            };
        }
        // Red preset: hue near 0/360, enough saturation to exclude pale map paper
        const hueWin = 20 + 25 * t;
        const satMin = Math.max(0.08, 0.35 - 0.27 * t);
        const valMin = 0.25;
        return (r, g, b) => {
            const [h, s, v] = ImageExtractor._rgbToHsv(r, g, b);
            return (h <= hueWin || h >= 360 - hueWin) && s >= satMin && v >= valMin;
        };
    }

    /** Sample the overlay color at a map latlng (eyedropper). Returns true if sampled. */
    async pickColorAt(latlng) {
        const src = this._resolveSource();
        if (!src) return false;
        const { inv } = this._makeProjector(src);
        const [u, v] = inv(latlng.lng, latlng.lat);
        if (u < 0 || u > 1 || v < 0 || v > 1) return false;

        const img = await this._loadImage(src.url);
        const { canvas, ctx } = this._drawToCanvas(img);
        let px;
        try {
            px = ctx.getImageData(
                Math.min(canvas.width - 1, Math.round(u * canvas.width)),
                Math.min(canvas.height - 1, Math.round(v * canvas.height)),
                1, 1
            ).data;
        } catch (e) {
            throw new Error('Image is cross-origin and blocks pixel access. Use "Load Local Image" instead.');
        }
        this.pickedColor = { r: px[0], g: px[1], b: px[2] };
        return true;
    }

    _drawToCanvas(img) {
        const scale = Math.min(1, this.MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { canvas, ctx };
    }

    /** Main entry: extract polygons from the current overlay. */
    async extract(tolerance = 50) {
        const src = this._resolveSource();
        if (!src) throw new Error('Load and position an image overlay first');

        const img = await this._loadImage(src.url);
        const { canvas, ctx } = this._drawToCanvas(img);

        let data;
        try {
            data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            throw new Error('Image is cross-origin and blocks pixel access. Use "Load Local Image" instead.');
        }

        const w = canvas.width, h = canvas.height;
        const classify = this._makeClassifier(tolerance);
        const mask = new Uint8Array(w * h);
        for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
            if (data[i + 3] > 100 && classify(data[i], data[i + 1], data[i + 2])) mask[j] = 1;
        }

        const rings = this._traceComponents(mask, w, h);
        const { fwd } = this._makeProjector(src);

        const polygons = [];
        for (const ring of rings) {
            const coords = ring.map(([x, y]) => fwd((x + 0.5) / w, (y + 0.5) / h));
            coords.push(coords[0]);
            if (coords.length < 5) continue;
            try {
                let poly = turf.polygon([coords]);
                poly = turf.simplify(poly, { tolerance: 0.003, highQuality: false });
                poly = turf.cleanCoords(poly);
                if (turf.area(poly) / 1e6 >= this.MIN_AREA_KM2) polygons.push(poly);
            } catch (e) { /* skip degenerate ring */ }
        }

        if (!polygons.length) {
            throw new Error('No zones matched. Try raising tolerance or picking the zone color.');
        }

        let merged = polygons[0];
        for (let i = 1; i < polygons.length; i++) {
            try { merged = turf.union(merged, polygons[i]); }
            catch (e) { console.warn('Union failed for polygon', i); }
        }

        return {
            featureCollection: turf.featureCollection(polygons),
            merged,
            totalKm2: turf.area(merged) / 1e6,
            count: polygons.length
        };
    }

    /**
     * Connected-component labeling (4-connectivity flood fill) + Moore-neighbor
     * boundary tracing. Returns outer boundary rings as [x,y] pixel arrays.
     */
    _traceComponents(mask, w, h) {
        const labels = new Int32Array(w * h);
        const rings = [];
        let nextLabel = 1;
        const stack = [];

        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || labels[start]) continue;

            // flood fill this component
            const label = nextLabel++;
            let count = 0;
            let topLeft = start;
            stack.length = 0;
            stack.push(start);
            labels[start] = label;
            while (stack.length) {
                const idx = stack.pop();
                count++;
                if (idx < topLeft) topLeft = idx;
                const x = idx % w, y = (idx / w) | 0;
                if (x > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = label; stack.push(idx - 1); }
                if (x < w - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = label; stack.push(idx + 1); }
                if (y > 0 && mask[idx - w] && !labels[idx - w]) { labels[idx - w] = label; stack.push(idx - w); }
                if (y < h - 1 && mask[idx + w] && !labels[idx + w]) { labels[idx + w] = label; stack.push(idx + w); }
            }
            if (count < this.MIN_COMPONENT_PX) continue;

            const ring = this._traceBoundary(labels, label, w, h, topLeft % w, (topLeft / w) | 0);
            if (ring && ring.length >= 4) rings.push(ring);
        }
        return rings;
    }

    /** Moore-neighbor tracing, clockwise, starting at the component's top-left pixel. */
    _traceBoundary(labels, label, w, h, sx, sy) {
        // neighbor order: E, SE, S, SW, W, NW, N, NE
        const dx = [1, 1, 0, -1, -1, -1, 0, 1];
        const dy = [0, 1, 1, 1, 0, -1, -1, -1];
        const inside = (x, y) => x >= 0 && x < w && y >= 0 && y < h && labels[y * w + x] === label;

        const ring = [[sx, sy]];
        let cx = sx, cy = sy;
        let dir = 6; // came heading north (start is top-left, previous is outside above-left)
        const maxSteps = w * h * 4;

        for (let step = 0; step < maxSteps; step++) {
            // scan clockwise starting just after the backtrack direction
            let found = -1;
            for (let k = 0; k < 8; k++) {
                const nd = (dir + 5 + k) % 8; // backtrack + rotate
                if (inside(cx + dx[nd], cy + dy[nd])) { found = nd; break; }
            }
            if (found === -1) break; // isolated pixel
            cx += dx[found]; cy += dy[found]; dir = found;
            if (cx === sx && cy === sy) break;
            // decimate: keep every pixel; simplify() reduces later
            ring.push([cx, cy]);
        }
        return ring;
    }
}

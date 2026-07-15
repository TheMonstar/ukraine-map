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
        this.MAX_DIM = 1400;       // cap canvas long side (raster images)
        this.SVG_MAX_DIM = 4096;   // vector sources rasterize larger — no quality cost
        this.MIN_COMPONENT_PX = 12;
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
            img.onload = async () => {
                // Detect SVG sources — they rasterize at higher resolution
                // (vector data loses zone detail at photo-sized canvases)
                img._isSvg = /^data:image\/svg/i.test(url) || /\.svg([?#]|$)/i.test(url);
                if (!img._isSvg && url.startsWith('blob:')) {
                    try {
                        const b = await (await fetch(url)).blob();
                        img._isSvg = b.type.includes('svg');
                    } catch (e) { /* keep false */ }
                }
                // SVGs without intrinsic size: recover the aspect from the viewBox
                // so rasterization matches the on-map rendering (no letterboxing)
                if ((!img.naturalWidth || !img.naturalHeight)) {
                    img._isSvg = true;
                    try {
                        const text = await (await fetch(url)).text();
                        const vb = text.match(/viewBox\s*=\s*["']\s*[\d.eE+-]+[\s,]+[\d.eE+-]+[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/);
                        if (vb) img._vbSize = { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
                    } catch (e) { /* fall back to square rasterization */ }
                }
                resolve(img);
            };
            img.onerror = () => reject(new Error('Could not load overlay image'));
            img.src = url;
        });
    }

    /**
     * Build the pixel→LatLng mapper for the source georeferencing.
     * All interpolation runs in projected Web Mercator (EPSG:3857) space, because
     * that is how Leaflet renders the overlay (imageOverlay / matrix3d / mesh all
     * interpolate layer points). Interpolating raw latitudes instead skews zones
     * north–south on images with a large latitude span.
     */
    _makeProjector(src) {
        const crs = L.CRS.EPSG3857;
        const prj = ll => crs.project(L.latLng(ll.lat, ll.lng));       // → {x, y} meters
        const unprj = (x, y) => {
            const ll = crs.unproject(L.point(x, y));
            return [ll.lng, ll.lat];
        };
        if (src.meshPoints && src.meshPoints.points?.length) {
            const { n } = src.meshPoints;
            const points = src.meshPoints.points.map(prj);
            const cells = n - 1;
            const cellCorners = (ri, ci) => [
                points[ri * n + ci], points[ri * n + ci + 1],
                points[(ri + 1) * n + ci], points[(ri + 1) * n + ci + 1]
            ];
            const bilinear = (p00, p10, p01, p11, s, t) => [
                (1 - t) * ((1 - s) * p00.x + s * p10.x) + t * ((1 - s) * p01.x + s * p11.x),
                (1 - t) * ((1 - s) * p00.y + s * p10.y) + t * ((1 - s) * p01.y + s * p11.y)
            ];
            const fwd = (u, v) => {
                const cu = Math.min(Math.max(u, 0), 1) * cells;
                const cv = Math.min(Math.max(v, 0), 1) * cells;
                const ci = Math.min(Math.floor(cu), cells - 1);
                const ri = Math.min(Math.floor(cv), cells - 1);
                const [p00, p10, p01, p11] = cellCorners(ri, ci);
                return unprj(...bilinear(p00, p10, p01, p11, cu - ci, cv - ri));
            };
            // Newton inversion per cell (≤9 cells, cheap); used by the eyedropper
            const inv = (lng, lat) => {
                const target = prj({ lat, lng });
                for (let ri = 0; ri < cells; ri++) {
                    for (let ci = 0; ci < cells; ci++) {
                        const [p00, p10, p01, p11] = cellCorners(ri, ci);
                        let s = 0.5, t = 0.5;
                        for (let it = 0; it < 15; it++) {
                            const [X, Y] = bilinear(p00, p10, p01, p11, s, t);
                            const rx = X - target.x, ry = Y - target.y;
                            const dXds = (1 - t) * (p10.x - p00.x) + t * (p11.x - p01.x);
                            const dXdt = (1 - s) * (p01.x - p00.x) + s * (p11.x - p10.x);
                            const dYds = (1 - t) * (p10.y - p00.y) + t * (p11.y - p01.y);
                            const dYdt = (1 - s) * (p01.y - p00.y) + s * (p11.y - p10.y);
                            const det = dXds * dYdt - dXdt * dYds;
                            if (Math.abs(det) < 1e-9) break;
                            s -= (rx * dYdt - ry * dXdt) / det;
                            t -= (ry * dXds - rx * dYds) / det;
                        }
                        if (s >= -0.01 && s <= 1.01 && t >= -0.01 && t <= 1.01) {
                            const [X, Y] = bilinear(p00, p10, p01, p11, s, t);
                            if (Math.abs(X - target.x) < 0.5 && Math.abs(Y - target.y) < 0.5) {
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
            const [sw, se, ne, nw] = src.freeCorners.map(prj);
            const H = ImageExtractor._squareToQuad(nw, ne, se, sw);
            const fwd = (u, v) => {
                const w = H[6] * u + H[7] * v + 1;
                return unprj((H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w);
            };
            const Hinv = ImageExtractor._invert3x3(H);
            const inv = (lng, lat) => {
                const p = prj({ lat, lng });
                const w = Hinv[6] * p.x + Hinv[7] * p.y + Hinv[8];
                return [
                    (Hinv[0] * p.x + Hinv[1] * p.y + Hinv[2]) / w,
                    (Hinv[3] * p.x + Hinv[4] * p.y + Hinv[5]) / w
                ]; // [u, v]
            };
            return { fwd, inv };
        }
        const [[south, west], [north, east]] = src.bounds;
        const nwPt = prj({ lat: north, lng: west });
        const sePt = prj({ lat: south, lng: east });
        return {
            fwd: (u, v) => unprj(nwPt.x + u * (sePt.x - nwPt.x), nwPt.y + v * (sePt.y - nwPt.y)),
            inv: (lng, lat) => {
                const p = prj({ lat, lng });
                return [(p.x - nwPt.x) / (sePt.x - nwPt.x), (p.y - nwPt.y) / (sePt.y - nwPt.y)];
            }
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
        // sample a 7x7 neighborhood and average the opaque-enough pixels —
        // robust against antialiasing, hairline gaps and transparent backgrounds
        const cx = Math.min(canvas.width - 1, Math.max(0, Math.round(u * canvas.width)));
        const cy = Math.min(canvas.height - 1, Math.max(0, Math.round(v * canvas.height)));
        const R = 3;
        const x0 = Math.max(0, cx - R), y0 = Math.max(0, cy - R);
        const wN = Math.min(canvas.width, cx + R + 1) - x0;
        const hN = Math.min(canvas.height, cy + R + 1) - y0;
        let data;
        try {
            data = ctx.getImageData(x0, y0, wN, hN).data;
        } catch (e) {
            throw new Error('Image is cross-origin and blocks pixel access. Use "Load Local Image" instead.');
        }
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] >= 2) {
                r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
            }
        }
        if (!n) {
            throw new Error('That spot is transparent — click a filled area of the image');
        }
        this.pickedColor = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        return true;
    }

    _drawToCanvas(img) {
        // Vector sources rasterize at higher resolution — SVG zone exports often
        // use huge coordinate spaces with sub-pixel fragments that vanish at
        // photo-sized canvases. Raster images gain nothing beyond native size.
        const maxDim = img._isSvg ? this.SVG_MAX_DIM : this.MAX_DIM;
        // SVGs without explicit width/height report naturalWidth/Height 0 —
        // rasterize at the viewBox aspect when known (matches on-map rendering),
        // else square (aspect distortion is harmless: georeferencing runs in
        // normalized uv space)
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) {
            if (img._vbSize?.w > 0 && img._vbSize?.h > 0) {
                w = img._vbSize.w;
                h = img._vbSize.h;
            } else {
                w = maxDim;
                h = maxDim;
            }
        }
        const scale = (img._isSvg ? maxDim / Math.max(w, h) : Math.min(1, maxDim / Math.max(w, h)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
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
        let maskCount = 0;
        for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
            // alpha >= 2: translucent fills and sub-pixel vector fragments keep
            // their true RGB — only fully transparent pixels carry no color
            // (the color classifier is the real gate)
            if (data[i + 3] >= 2 && classify(data[i], data[i + 1], data[i + 2])) {
                mask[j] = 1;
                maskCount++;
            }
        }

        // morphological closing (dilate+erode, r=1): bridges hairline gaps between
        // the fragment paths that vector zone exports are often tiled from,
        // so they trace as coherent zones instead of thousands of slivers
        this._morphClose(mask, w, h);

        const rings = this._traceComponents(mask, w, h);
        const { fwd } = this._makeProjector(src);

        // adaptive thresholds: small overlays (or thin frontline strips) must not
        // be wiped out by limits tuned for country-scale briefing maps
        const cornerLL = [fwd(0, 0), fwd(1, 0), fwd(1, 1), fwd(0, 1)];
        let overlayKm2 = 0;
        try {
            overlayKm2 = turf.area(turf.polygon([[...cornerLL, cornerLL[0]]])) / 1e6;
        } catch (e) { /* keep 0 → minimum thresholds */ }
        const minAreaKm2 = Math.max(0.01, Math.min(this.MIN_AREA_KM2, overlayKm2 * 1e-4));
        const lats = cornerLL.map(c => c[1]);
        const lngs = cornerLL.map(c => c[0]);
        const spanDeg = Math.max(
            Math.max(...lats) - Math.min(...lats),
            Math.max(...lngs) - Math.min(...lngs)
        );
        const simplifyTol = Math.min(0.003, Math.max(1e-5, spanDeg / 800));

        const polygons = [];
        for (const ring of rings) {
            const coords = ring.map(([x, y]) => fwd((x + 0.5) / w, (y + 0.5) / h));
            coords.push(coords[0]);
            if (coords.length < 5) continue;
            try {
                let poly = turf.polygon([coords]);
                poly = turf.simplify(poly, { tolerance: simplifyTol, highQuality: false });
                poly = turf.cleanCoords(poly);
                if (turf.area(poly) / 1e6 >= minAreaKm2) polygons.push(poly);
            } catch (e) { /* skip degenerate ring */ }
        }

        if (!polygons.length) {
            if (!maskCount) {
                throw new Error('No pixels matched the color. Try raising tolerance or picking the zone color.');
            }
            throw new Error(`Color matched ${maskCount.toLocaleString()} px, but every zone was below ` +
                `${minAreaKm2.toFixed(2)} km² after tracing. Zones may be too thin/small at this overlay size.`);
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

    /** In-place morphological closing (3x3 dilate, then 3x3 erode). */
    _morphClose(mask, w, h) {
        const dil = new Uint8Array(mask.length);
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (mask[i]) { dil[i] = 1; continue; }
                const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
                let hit = 0;
                for (let yy = y0; yy <= y1 && !hit; yy++) {
                    for (let xx = x0; xx <= x1; xx++) {
                        if (mask[yy * w + xx]) { hit = 1; break; }
                    }
                }
                dil[i] = hit;
            }
        }
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (!dil[i]) { mask[i] = 0; continue; }
                const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
                let all = 1;
                for (let yy = y0; yy <= y1 && all; yy++) {
                    for (let xx = x0; xx <= x1; xx++) {
                        if (!dil[yy * w + xx]) { all = 0; break; }
                    }
                }
                mask[i] = all;
            }
        }
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
        // start convention: the scan that found the start pixel moved east
        // (row-major search), so the backtrack is W and the clockwise scan
        // begins at NW — guaranteed background for a topmost-leftmost pixel
        let dir = 0;
        let firstX = null, firstY = null; // the first boundary step out of the start
        const maxSteps = w * h * 4;

        for (let step = 0; step < maxSteps; step++) {
            // scan clockwise starting just after the backtrack direction
            let found = -1;
            for (let k = 0; k < 8; k++) {
                const nd = (dir + 5 + k) % 8; // backtrack + rotate
                if (inside(cx + dx[nd], cy + dy[nd])) { found = nd; break; }
            }
            if (found === -1) break; // isolated pixel
            const nx = cx + dx[found], ny = cy + dy[found];
            // Jacob's stopping criterion: the boundary may legitimately pass
            // through the start pixel several times (pinch points, common in
            // fragment-tiled zones) — stop only when re-entering the start AND
            // about to repeat the very first boundary move
            if (cx === sx && cy === sy && step > 0 && nx === firstX && ny === firstY) break;
            cx = nx; cy = ny; dir = found;
            if (step === 0) { firstX = cx; firstY = cy; }
            // decimate: keep every pixel; simplify() reduces later
            ring.push([cx, cy]);
        }
        return ring;
    }
}

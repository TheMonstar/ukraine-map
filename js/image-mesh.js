/**
 * ImageMeshWarp — renders an image warped onto an n×n control-point mesh
 * (bilinear patches) as a canvas in the map overlay pane. Used for 9/16-point
 * image overlay warping where a single CSS matrix3d (4-point perspective)
 * cannot bend the image locally.
 *
 * mesh = { n, points } — points: row-major n×n L.latLng, rows north→south,
 * cols west→east (points[r*n+c]).
 */
class ImageMeshWarp {
    static SUBDIV = 6; // sub-quads per cell edge; higher = smoother bend

    constructor(map, imageUrl, mesh) {
        this.map = map;
        this.mesh = mesh;
        this.opacity = 0.7;
        this._img = null;
        this._rafPending = false;

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        map.getPanes().overlayPane.appendChild(this.canvas);

        this._onViewChange = () => {
            if (this._rafPending) return;
            this._rafPending = true;
            requestAnimationFrame(() => {
                this._rafPending = false;
                this._redraw();
            });
        };
        map.on('zoom zoomend viewreset moveend', this._onViewChange);

        const img = new Image();
        if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:')) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            this._img = img;
            this._redraw();
        };
        img.src = imageUrl;
    }

    setMesh(mesh) {
        this.mesh = mesh;
        this._redraw();
    }

    setOpacity(v) {
        this.opacity = v;
        this.canvas.style.opacity = String(v);
    }

    destroy() {
        this.map.off('zoom zoomend viewreset moveend', this._onViewChange);
        this.canvas.remove();
    }

    _redraw() {
        if (!this._img || !this.mesh) return;
        const { n, points } = this.mesh;
        const map = this.map;

        // project mesh to layer points, compute bbox
        const pts = points.map(ll => map.latLngToLayerPoint(ll));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const w = Math.max(1, Math.ceil(maxX - minX));
        const h = Math.max(1, Math.ceil(maxY - minY));
        this.canvas.width = w;
        this.canvas.height = h;
        this.canvas.style.opacity = String(this.opacity);
        L.DomUtil.setPosition(this.canvas, L.point(minX, minY));

        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        const img = this._img;
        const S = ImageMeshWarp.SUBDIV;
        const cells = n - 1;
        const local = (i) => ({ x: pts[i].x - minX, y: pts[i].y - minY });

        for (let r = 0; r < cells; r++) {
            for (let c = 0; c < cells; c++) {
                // dest cell corners (bilinear patch)
                const d00 = local(r * n + c), d10 = local(r * n + c + 1);
                const d01 = local((r + 1) * n + c), d11 = local((r + 1) * n + c + 1);
                // source cell rect (image is undistorted in source space)
                const sx0 = (c / cells) * img.naturalWidth, sx1 = ((c + 1) / cells) * img.naturalWidth;
                const sy0 = (r / cells) * img.naturalHeight, sy1 = ((r + 1) / cells) * img.naturalHeight;

                const dstAt = (s, t) => ({
                    x: (1 - t) * ((1 - s) * d00.x + s * d10.x) + t * ((1 - s) * d01.x + s * d11.x),
                    y: (1 - t) * ((1 - s) * d00.y + s * d10.y) + t * ((1 - s) * d01.y + s * d11.y)
                });
                const srcAt = (s, t) => ({
                    x: sx0 + s * (sx1 - sx0),
                    y: sy0 + t * (sy1 - sy0)
                });

                for (let a = 0; a < S; a++) {
                    for (let b = 0; b < S; b++) {
                        const s0 = a / S, s1 = (a + 1) / S, t0 = b / S, t1 = (b + 1) / S;
                        const dTL = dstAt(s0, t0), dTR = dstAt(s1, t0), dBL = dstAt(s0, t1), dBR = dstAt(s1, t1);
                        const sTL = srcAt(s0, t0), sTR = srcAt(s1, t0), sBL = srcAt(s0, t1), sBR = srcAt(s1, t1);
                        this._drawTriangle(ctx, img, sTL, sTR, sBL, dTL, dTR, dBL);
                        this._drawTriangle(ctx, img, sTR, sBR, sBL, dTR, dBR, dBL);
                    }
                }
            }
        }
    }

    /** Affine-map the src triangle of the image onto the dst triangle. */
    _drawTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
        const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
        if (Math.abs(denom) < 1e-9) return;

        const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
        const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
        const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
        const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
        const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
        const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;

        // clip to the dest triangle, slightly inflated from its centroid to hide seams
        const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
        const grow = (p) => ({ x: cx + (p.x - cx) * 1.04, y: cy + (p.y - cy) * 1.04 });
        const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(g0.x, g0.y);
        ctx.lineTo(g1.x, g1.y);
        ctx.lineTo(g2.x, g2.y);
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(a, b, c, d, e, f);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
    }
}

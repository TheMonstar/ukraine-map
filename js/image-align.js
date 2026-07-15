/**
 * ImageAligner — GIS-style control-point registration for image overlays.
 *
 * The user alternates clicks: a landmark ON the overlaid image, then the same
 * location on the basemap. After each pair the overlay re-warps to fit:
 * 1 pair = translation, 2 = similarity, 3 = affine, 4+ = projective
 * (DLT least squares). All fitting runs in EPSG:3857 meters.
 */
class ImageAligner {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.pairs = [];          // { uv: [u,v], target: L.LatLng }
        this.active = false;
        this.awaiting = 'image';  // 'image' | 'map'
        this._pendingUV = null;
        this._pendingMarker = null;
        this.markers = [];        // [{ img: L.marker, tgt: L.marker, line: L.polyline }]
        this._downPt = null;
        this._onDown = (e) => { this._downPt = { x: e.clientX, y: e.clientY }; };
        this._onUp = (e) => {
            if (!this._downPt) return;
            const dist = Math.hypot(e.clientX - this._downPt.x, e.clientY - this._downPt.y);
            this._downPt = null;
            if (dist >= 6) return; // pan, not a click
            e.preventDefault();
            e.stopPropagation();
            this._handleClick(this.dashboard.map.mouseEventToLatLng(e));
        };
    }

    _status(msg) {
        const el = this.dashboard.getEl('align-status');
        if (!el) return;
        el.style.display = msg ? 'block' : 'none';
        el.textContent = msg || '';
    }

    _currentProjector() {
        const d = this.dashboard;
        return d.imageExtractor._makeProjector({
            bounds: d.currentImageBounds,
            freeCorners: d.imageFreeCorners,
            meshPoints: d.imageMeshPoints
        });
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.awaiting = 'image';
        const d = this.dashboard;
        // hide draggable image-edit markers — they would intercept alignment clicks
        d.hideImageCornerMarkers();
        d.hideMeshMarkers();
        const container = d.map.getContainer();
        // capture phase so clicks win over interactive layers; no preventDefault
        // on mousedown — map panning must keep working between clicks
        container.addEventListener('mousedown', this._onDown, true);
        container.addEventListener('mouseup', this._onUp, true);
        this._status('Click a landmark ON the image');
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        const d = this.dashboard;
        const container = d.map.getContainer();
        container.removeEventListener('mousedown', this._onDown, true);
        container.removeEventListener('mouseup', this._onUp, true);
        this.resetPairs();
        this._status(null);
        // restore edit markers for whatever mode the user had
        if (d.imageMeshPoints) {
            d.showMeshMarkers();
        } else if (d.imageResizeMode) {
            d.showImageCornerMarkers();
            if (d.imageFreeCorners && d.imageCornerMarkers.length === 5) {
                for (let i = 0; i < 4; i++) d.imageCornerMarkers[i + 1].setLatLng(d.imageFreeCorners[i]);
                d._updateFreeShapeCenterMarker();
            }
        }
    }

    resetPairs() {
        this.pairs = [];
        this.awaiting = 'image';
        this._pendingUV = null;
        if (this._pendingMarker) {
            this.dashboard.map.removeLayer(this._pendingMarker);
            this._pendingMarker = null;
        }
        for (const m of this.markers) {
            this.dashboard.map.removeLayer(m.img);
            this.dashboard.map.removeLayer(m.tgt);
            this.dashboard.map.removeLayer(m.line);
        }
        this.markers = [];
        if (this.active) this._status('Click a landmark ON the image');
    }

    _mkMarker(latlng, color, label) {
        return L.marker(latlng, {
            interactive: false,
            icon: L.divIcon({
                className: 'image-corner-marker',
                html: `<div style="width:18px;height:18px;background:${color};border:2px solid white;` +
                    `border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.4);color:#fff;font-size:11px;` +
                    `font-weight:bold;display:flex;align-items:center;justify-content:center;">${label}</div>`,
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            })
        }).addTo(this.dashboard.map);
    }

    _handleClick(latlng) {
        const d = this.dashboard;
        if (!d.customImageOverlay || !d.currentImageBounds) {
            this._status('Load an image overlay first');
            return;
        }
        if (this.awaiting === 'image') {
            const proj = this._currentProjector();
            const [u, v] = proj.inv(latlng.lng, latlng.lat);
            if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
                this._status('That was outside the image — click ON the image');
                return;
            }
            this._pendingUV = [u, v];
            this._pendingMarker = this._mkMarker(latlng, '#0066FF', this.pairs.length + 1);
            this.awaiting = 'map';
            this._status(`Point ${this.pairs.length + 1}: now click its TRUE map location`);
        } else {
            const pairNo = this.pairs.length + 1;
            this.pairs.push({ uv: this._pendingUV, target: latlng });
            const imgMarker = this._pendingMarker;
            this._pendingMarker = null;
            this._pendingUV = null;
            const tgtMarker = this._mkMarker(latlng, '#2e7d32', pairNo);
            const line = L.polyline([imgMarker.getLatLng(), latlng], {
                color: '#555', weight: 1, dashArray: '4 4', interactive: false
            }).addTo(this.dashboard.map);
            this.markers.push({ img: imgMarker, tgt: tgtMarker, line });
            this.awaiting = 'image';
            this._solveAndApply();
        }
    }

    _solveAndApply() {
        const d = this.dashboard;
        const crs = L.CRS.EPSG3857;
        const prj = (ll) => crs.project(ll);

        // capture the projector BEFORE mutating warp state
        const proj = this._currentProjector();
        const sources = this.pairs.map(p => {
            const [lng, lat] = proj.fwd(p.uv[0], p.uv[1]);
            return prj(L.latLng(lat, lng));
        });
        const targets = this.pairs.map(p => prj(p.target));
        const unprj = (q) => crs.unproject(L.point(q.x, q.y));

        if (d.imageFreeCorners) {
            // user chose 4-point perspective: fit up to a full homography
            const H = ImageAligner.fitTransform(sources, targets);
            if (!H) return;
            d.imageFreeCorners = d.imageFreeCorners.map(c => unprj(ImageAligner._applyH(H, prj(c))));
            d.updateFreeShapeTransform();
        } else if (d.imageMeshPoints) {
            // user chose a mesh: transform every mesh point, keep interior bends
            const H = ImageAligner.fitTransform(sources, targets);
            if (!H) return;
            d.imageMeshPoints.points = d.imageMeshPoints.points.map(p0 => unprj(ImageAligner._applyH(H, prj(p0))));
            if (d.imageMeshWarp) d.imageMeshWarp.setMesh(d.imageMeshPoints);
        } else {
            // warp Off (default): keep the overlay a plain rectangle —
            // axis-aligned translate + scale, no rotation, no perspective
            const fit1d = (ss, ts) => {
                const n = ss.length;
                const sm = ss.reduce((a, b) => a + b, 0) / n;
                const tm = ts.reduce((a, b) => a + b, 0) / n;
                let num = 0, den = 0;
                for (let i = 0; i < n; i++) {
                    num += (ss[i] - sm) * (ts[i] - tm);
                    den += (ss[i] - sm) ** 2;
                }
                let s = den > 1e-6 ? num / den : 1;
                if (!(s > 0.01 && s < 100)) s = 1; // degenerate spread → translate only
                return { s, t: tm - s * sm };
            };
            const fx = fit1d(sources.map(p => p.x), targets.map(p => p.x));
            const fy = fit1d(sources.map(p => p.y), targets.map(p => p.y));
            const [[south, west], [north, east]] = d.currentImageBounds;
            const nw = prj(L.latLng(north, west));
            const se = prj(L.latLng(south, east));
            const nw2 = unprj({ x: fx.s * nw.x + fx.t, y: fy.s * nw.y + fy.t });
            const se2 = unprj({ x: fx.s * se.x + fx.t, y: fy.s * se.y + fy.t });
            d.currentImageBounds = [[se2.lat, nw2.lng], [nw2.lat, se2.lng]];
            d.customImageOverlay.setBounds(d.currentImageBounds);
        }

        this._refreshMarkers();
    }

    _refreshMarkers() {
        const proj = this._currentProjector();
        let residualSum = 0;
        this.markers.forEach((m, i) => {
            const p = this.pairs[i];
            const [lng, lat] = proj.fwd(p.uv[0], p.uv[1]);
            const now = L.latLng(lat, lng);
            m.img.setLatLng(now);
            m.line.setLatLngs([now, p.target]);
            residualSum += now.distanceTo(p.target);
        });
        const meanKm = residualSum / this.pairs.length / 1000;
        this._status(`${this.pairs.length} pair${this.pairs.length > 1 ? 's' : ''} — residual ${meanKm.toFixed(2)} km. ` +
            'Click the next landmark ON the image');
    }

    // ── transform fitting (EPSG:3857 points {x,y}) ───────────────
    /** Returns a 3x3 row-major homography [a,b,c,d,e,f,g,h,i] mapping src → tgt, or null. */
    static fitTransform(S, T) {
        const n = S.length;
        if (n === 0) return null;
        if (n === 1) {
            return [1, 0, T[0].x - S[0].x, 0, 1, T[0].y - S[0].y, 0, 0, 1];
        }
        if (n === 2) {
            const dSx = S[1].x - S[0].x, dSy = S[1].y - S[0].y;
            const dTx = T[1].x - T[0].x, dTy = T[1].y - T[0].y;
            const den = dSx * dSx + dSy * dSy;
            if (den < 1e-12) return null;
            const a = (dSx * dTx + dSy * dTy) / den;
            const b = (dSx * dTy - dSy * dTx) / den;
            // [a -b; b a] rotation+scale
            const tx = T[0].x - (a * S[0].x - b * S[0].y);
            const ty = T[0].y - (b * S[0].x + a * S[0].y);
            return [a, -b, tx, b, a, ty, 0, 0, 1];
        }
        if (n === 3) {
            const den = S[0].x * (S[1].y - S[2].y) + S[1].x * (S[2].y - S[0].y) + S[2].x * (S[0].y - S[1].y);
            if (Math.abs(den) < 1e-12) return null;
            const co = (v0, v1, v2) => [
                (v0 * (S[1].y - S[2].y) + v1 * (S[2].y - S[0].y) + v2 * (S[0].y - S[1].y)) / den,
                (v0 * (S[2].x - S[1].x) + v1 * (S[0].x - S[2].x) + v2 * (S[1].x - S[0].x)) / den,
                (v0 * (S[1].x * S[2].y - S[2].x * S[1].y) + v1 * (S[2].x * S[0].y - S[0].x * S[2].y) +
                 v2 * (S[0].x * S[1].y - S[1].x * S[0].y)) / den
            ];
            const [a, b, c] = co(T[0].x, T[1].x, T[2].x);
            const [dd, e, f] = co(T[0].y, T[1].y, T[2].y);
            return [a, b, c, dd, e, f, 0, 0, 1];
        }
        return ImageAligner._fitProjective(S, T);
    }

    /** DLT least squares with Hartley normalization. */
    static _fitProjective(S, T) {
        const norm = (P) => {
            let cx = 0, cy = 0;
            P.forEach(p => { cx += p.x; cy += p.y; });
            cx /= P.length; cy /= P.length;
            let md = 0;
            P.forEach(p => { md += Math.hypot(p.x - cx, p.y - cy); });
            md /= P.length;
            const s = md > 1e-12 ? Math.SQRT2 / md : 1;
            return {
                pts: P.map(p => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
                M: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]
            };
        };
        const ns = norm(S), nt = norm(T);

        // normal equations for the 2n×8 DLT system
        const M = Array.from({ length: 8 }, () => new Float64Array(8));
        const v = new Float64Array(8);
        const addRow = (row, rhs) => {
            for (let i = 0; i < 8; i++) {
                v[i] += row[i] * rhs;
                for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j];
            }
        };
        for (let k = 0; k < ns.pts.length; k++) {
            const { x, y } = ns.pts[k];
            const { x: X, y: Y } = nt.pts[k];
            addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X);
            addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y);
        }

        // Gaussian elimination with partial pivoting
        const A = M.map((r, i) => [...r, v[i]]);
        for (let col = 0; col < 8; col++) {
            let piv = col;
            for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
            if (Math.abs(A[piv][col]) < 1e-12) return null;
            [A[col], A[piv]] = [A[piv], A[col]];
            for (let r = 0; r < 8; r++) {
                if (r === col) continue;
                const f = A[r][col] / A[col][col];
                for (let c = col; c <= 8; c++) A[r][c] -= f * A[col][c];
            }
        }
        const h = A.map((r, i) => r[8] / r[i]);
        const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

        // denormalize: H = inv(Nt) · Hn · Ns
        const inv3 = ImageAligner._inv3;
        const mul3 = ImageAligner._mul3;
        return mul3(mul3(inv3(nt.M), Hn), ns.M);
    }

    static _applyH(H, p) {
        const w = H[6] * p.x + H[7] * p.y + H[8];
        return {
            x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
            y: (H[3] * p.x + H[4] * p.y + H[5]) / w
        };
    }

    static _mul3(A, B) {
        const C = new Array(9);
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
        return C;
    }

    static _inv3(m) {
        const det =
            m[0] * (m[4] * m[8] - m[5] * m[7]) -
            m[1] * (m[3] * m[8] - m[5] * m[6]) +
            m[2] * (m[3] * m[7] - m[4] * m[6]);
        return [
            (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
            (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
            (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det
        ];
    }
}

import * as THREE from 'three';
import { latLngToTileFraction, lngToMercX, latToMercY } from './geo.js';

const DEM_ZOOM = 14;
const DEM_ZOOM_FALLBACK = 13;
const SAT_ZOOM = 16;
const SAT_CANVAS_CAP = 4096;
// Edge length of the terrain plane, in meters (default = 5 km tile + 1 km margin).
// Mutable live binding: set once at startup via setSceneSize() before TerrainBuilder.build().
export let SCENE_SIZE = 6000;
export let SCENE_HALF = SCENE_SIZE / 2;
export const GRID_SEGMENTS = 256;
const GRID_SIZE = GRID_SEGMENTS + 1;

// Size the terrain plane to a tile size in km (with a 1 km margin). Mesh resolution
// (GRID_SEGMENTS) is unchanged, so larger tiles trade per-cell detail for coverage.
export function setSceneSize(tileKm) {
    SCENE_SIZE = tileKm * 1000 + 1000;
    SCENE_HALF = SCENE_SIZE / 2;
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
        img.src = url;
    });
}

// Decode AWS Terrarium PNG encoding: elevation = R*256 + G + B/256 - 32768
function decodeElevation(data, idx) {
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    return (r * 256 + g + b / 256) - 32768;
}

// Shortest distance from point (px,pz) to segment a-b, all in local ENU meters.
function distToSegment(px, pz, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cz = a.z + t * dz;
    return Math.hypot(px - cx, pz - cz);
}

function bilinearElevation(imageData, px, py) {
    const w = imageData.width, h = imageData.height;
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(py)));
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = Math.min(1, Math.max(0, px - x0));
    const fy = Math.min(1, Math.max(0, py - y0));
    const data = imageData.data;
    const e00 = decodeElevation(data, (y0 * w + x0) * 4);
    const e10 = decodeElevation(data, (y0 * w + x1) * 4);
    const e01 = decodeElevation(data, (y1 * w + x0) * 4);
    const e11 = decodeElevation(data, (y1 * w + x1) * 4);
    const top = e00 * (1 - fx) + e10 * fx;
    const bottom = e01 * (1 - fx) + e11 * fx;
    return top * (1 - fy) + bottom * fy;
}

// Compute the tile index range covering a bbox at a given zoom
function tileRangeForBbox(bbox, zoom) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const corners = [
        latLngToTileFraction(minLat, minLng, zoom),
        latLngToTileFraction(minLat, maxLng, zoom),
        latLngToTileFraction(maxLat, minLng, zoom),
        latLngToTileFraction(maxLat, maxLng, zoom)
    ];
    const fxs = corners.map(c => c.fx);
    const fys = corners.map(c => c.fy);
    return {
        zoom,
        txMin: Math.floor(Math.min(...fxs)),
        txMax: Math.floor(Math.max(...fxs)),
        tyMin: Math.floor(Math.min(...fys)),
        tyMax: Math.floor(Math.max(...fys))
    };
}

async function stitchTiles(range, tilePx, urlForTile) {
    const cols = range.txMax - range.txMin + 1;
    const rows = range.tyMax - range.tyMin + 1;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tilePx;
    canvas.height = rows * tilePx;
    const ctx = canvas.getContext('2d');

    const fetches = [];
    for (let tx = range.txMin; tx <= range.txMax; tx++) {
        for (let ty = range.tyMin; ty <= range.tyMax; ty++) {
            const url = urlForTile(range.zoom, tx, ty);
            fetches.push(
                loadImage(url).then(img => {
                    ctx.drawImage(img, (tx - range.txMin) * tilePx, (ty - range.tyMin) * tilePx, tilePx, tilePx);
                }).catch(() => { /* leave blank — partial stitch is fine */ })
            );
        }
    }
    await Promise.all(fetches);
    return canvas;
}

export class TerrainBuilder {
    constructor(proj) {
        this.proj = proj;
        this.heightmap = new Float32Array(GRID_SIZE * GRID_SIZE);
        this.exaggeration = 1.5;
        this.geometry = null;
        this.mesh = null;
        this.satelliteApplied = false;
    }

    // Bilinear-sample the (un-exaggerated) heightmap at local ENU coords (meters); returns exaggerated elevation
    sampleHeight(x, z) {
        const gx = (x + SCENE_HALF) / SCENE_SIZE * GRID_SEGMENTS;
        const gz = (z + SCENE_HALF) / SCENE_SIZE * GRID_SEGMENTS;
        const x0 = Math.max(0, Math.min(GRID_SEGMENTS, Math.floor(gx)));
        const z0 = Math.max(0, Math.min(GRID_SEGMENTS, Math.floor(gz)));
        const x1 = Math.min(GRID_SEGMENTS, x0 + 1);
        const z1 = Math.min(GRID_SEGMENTS, z0 + 1);
        const fx = Math.min(1, Math.max(0, gx - x0));
        const fz = Math.min(1, Math.max(0, gz - z0));
        const h00 = this.heightmap[z0 * GRID_SIZE + x0];
        const h10 = this.heightmap[z0 * GRID_SIZE + x1];
        const h01 = this.heightmap[z1 * GRID_SIZE + x0];
        const h11 = this.heightmap[z1 * GRID_SIZE + x1];
        const top = h00 * (1 - fx) + h10 * fx;
        const bottom = h01 * (1 - fx) + h11 * fx;
        return (top * (1 - fz) + bottom * fz) * this.exaggeration;
    }

    async build() {
        await this._buildHeightmap();
        this._buildMesh();
    }

    async _buildHeightmap() {
        const bbox = this.proj.bbox(SCENE_HALF);
        let demCanvas, demRange;
        try {
            demRange = tileRangeForBbox(bbox, DEM_ZOOM);
            demCanvas = await stitchTiles(demRange, 256, (z, x, y) =>
                `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
        } catch (e) {
            demRange = tileRangeForBbox(bbox, DEM_ZOOM_FALLBACK);
            demCanvas = await stitchTiles(demRange, 256, (z, x, y) =>
                `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
        }

        const ctx = demCanvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, demCanvas.width, demCanvas.height);

        for (let iy = 0; iy < GRID_SIZE; iy++) {
            const zLocal = iy * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
            for (let ix = 0; ix < GRID_SIZE; ix++) {
                const xLocal = ix * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
                const { lat, lng } = this.proj.toLatLng(xLocal, zLocal);
                const { fx, fy } = latLngToTileFraction(lat, lng, demRange.zoom);
                const px = (fx - demRange.txMin) * 256;
                const py = (fy - demRange.tyMin) * 256;
                let elev = bilinearElevation(imageData, px, py);
                if (!isFinite(elev)) elev = 0;
                elev = Math.max(-100, Math.min(3000, elev));
                this.heightmap[iy * GRID_SIZE + ix] = elev;
            }
        }
    }

    // Rewrite mesh Y positions from the (possibly carved) heightmap and recompute normals.
    _applyHeightToMesh() {
        const pos = this.geometry.attributes.position;
        for (let i = 0; i < this.heightmap.length; i++) {
            pos.setY(i, this.heightmap[i] * this.exaggeration);
        }
        pos.needsUpdate = true;
        this.geometry.computeVertexNormals();
    }

    // Carve trench depressions (with raised side berms) into the heightmap along ditch lines.
    carveTrenches(featureCollection, proj) {
        const lines = [];
        (featureCollection?.features || []).forEach(f => {
            if (f.geometry?.type === 'LineString') lines.push(f.geometry.coordinates);
            else if (f.geometry?.type === 'MultiLineString') lines.push(...f.geometry.coordinates);
        });
        if (!lines.length) return;

        const DEPTH = 2.5;
        const BERM_HEIGHT = 0.8;
        const TRENCH_HALF = 1.5;
        const BERM_WIDTH = 2.5;
        const REACH = TRENCH_HALF + BERM_WIDTH;
        const cell = SCENE_SIZE / GRID_SEGMENTS;

        lines.forEach(coords => {
            const pts = coords.map(([lng, lat]) => proj.toLocal(lat, lng));
            if (pts.length < 2) return;

            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            pts.forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            });

            const ix0 = Math.max(0, Math.floor((minX - REACH + SCENE_HALF) / cell));
            const ix1 = Math.min(GRID_SEGMENTS, Math.ceil((maxX + REACH + SCENE_HALF) / cell));
            const iz0 = Math.max(0, Math.floor((minZ - REACH + SCENE_HALF) / cell));
            const iz1 = Math.min(GRID_SEGMENTS, Math.ceil((maxZ + REACH + SCENE_HALF) / cell));

            for (let iz = iz0; iz <= iz1; iz++) {
                const z = iz * cell - SCENE_HALF;
                for (let ix = ix0; ix <= ix1; ix++) {
                    const x = ix * cell - SCENE_HALF;
                    let minDist = Infinity;
                    for (let i = 0; i < pts.length - 1; i++) {
                        const d = distToSegment(x, z, pts[i], pts[i + 1]);
                        if (d < minDist) minDist = d;
                        if (minDist < TRENCH_HALF) break;
                    }
                    const idx = iz * GRID_SIZE + ix;
                    if (minDist <= TRENCH_HALF) {
                        const t = minDist / TRENCH_HALF;
                        this.heightmap[idx] -= DEPTH * (1 - t * 0.3);
                    } else if (minDist <= REACH) {
                        const t = (minDist - TRENCH_HALF) / BERM_WIDTH;
                        this.heightmap[idx] += BERM_HEIGHT * (1 - t);
                    }
                }
            }
        });

        this._applyHeightToMesh();
    }

    _buildMesh() {
        const geometry = new THREE.PlaneGeometry(SCENE_SIZE, SCENE_SIZE, GRID_SEGMENTS, GRID_SEGMENTS);
        geometry.rotateX(-Math.PI / 2);
        this.geometry = geometry;

        this._applyHeightToMesh();

        this._applyHypsometricColors(geometry);

        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.95,
            metalness: 0.0
        });

        this.material = material;
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.receiveShadow = true;
    }

    _applyHypsometricColors(geometry) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < this.heightmap.length; i++) {
            if (this.heightmap[i] < min) min = this.heightmap[i];
            if (this.heightmap[i] > max) max = this.heightmap[i];
        }
        const range = Math.max(1, max - min);

        const low = new THREE.Color('#5a7a3a');
        const high = new THREE.Color('#c9b896');
        const colors = new Float32Array(this.heightmap.length * 3);
        const tmp = new THREE.Color();
        for (let i = 0; i < this.heightmap.length; i++) {
            const t = (this.heightmap[i] - min) / range;
            tmp.copy(low).lerp(high, t);
            colors[i * 3] = tmp.r;
            colors[i * 3 + 1] = tmp.g;
            colors[i * 3 + 2] = tmp.b;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    // Fetch and apply satellite imagery as a texture; falls back from Mapbox to ESRI World Imagery.
    // Returns true on success, false if both sources failed (hypsometric coloring remains).
    async applySatellite() {
        const bbox = this.proj.bbox(SCENE_HALF);
        const token = localStorage.getItem('mapboxToken');

        let canvas = null, range = null, source = null;

        if (token) {
            try {
                ({ canvas, range } = await this._fetchSatCanvas(bbox, token));
                source = 'mapbox';
            } catch (e) { /* fall through to ESRI */ }
        }

        if (!canvas) {
            try {
                ({ canvas, range } = await this._fetchEsriCanvas(bbox));
                source = 'esri';
            } catch (e) {
                return false;
            }
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.needsUpdate = true;

        this._applyMercatorUVs(range);

        this.material.map = texture;
        this.material.vertexColors = false;
        this.material.needsUpdate = true;
        this.satelliteApplied = true;
        this.satelliteSource = source;
        return true;
    }

    async _fetchSatCanvas(bbox, token) {
        const tilePx = 512; // @2x mapbox tiles
        let zoom = SAT_ZOOM;
        let range = tileRangeForBbox(bbox, zoom);
        while (((range.txMax - range.txMin + 1) * tilePx > SAT_CANVAS_CAP ||
                (range.tyMax - range.tyMin + 1) * tilePx > SAT_CANVAS_CAP) && zoom > 10) {
            zoom--;
            range = tileRangeForBbox(bbox, zoom);
        }
        const canvas = await stitchTiles(range, tilePx, (z, x, y) =>
            `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg?access_token=${token}`);
        return { canvas, range };
    }

    async _fetchEsriCanvas(bbox) {
        const tilePx = 256;
        let zoom = SAT_ZOOM;
        let range = tileRangeForBbox(bbox, zoom);
        while (((range.txMax - range.txMin + 1) * tilePx > SAT_CANVAS_CAP ||
                (range.tyMax - range.tyMin + 1) * tilePx > SAT_CANVAS_CAP) && zoom > 10) {
            zoom--;
            range = tileRangeForBbox(bbox, zoom);
        }
        // Note: ESRI World Imagery uses {z}/{y}/{x} order
        const canvas = await stitchTiles(range, tilePx, (z, x, y) =>
            `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
        return { canvas, range };
    }

    // Recompute UV coordinates so the stitched satellite canvas aligns with the terrain mesh
    _applyMercatorUVs(range) {
        const n = Math.pow(2, range.zoom);
        const cols = range.txMax - range.txMin + 1;
        const rows = range.tyMax - range.tyMin + 1;
        const uv = this.geometry.attributes.uv;

        for (let iy = 0; iy < GRID_SIZE; iy++) {
            const zLocal = iy * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
            for (let ix = 0; ix < GRID_SIZE; ix++) {
                const xLocal = ix * (SCENE_SIZE / GRID_SEGMENTS) - SCENE_HALF;
                const { lat, lng } = this.proj.toLatLng(xLocal, zLocal);
                const fx = lngToMercX(lng) * n;
                const fy = latToMercY(lat) * n;
                const u = (fx - range.txMin) / cols;
                const v = 1 - (fy - range.tyMin) / rows;
                const idx = iy * GRID_SIZE + ix;
                uv.setXY(idx, u, v);
            }
        }
        uv.needsUpdate = true;
    }

    setExaggeration(k) {
        this.exaggeration = k;
        const pos = this.geometry.attributes.position;
        for (let i = 0; i < this.heightmap.length; i++) {
            pos.setY(i, this.heightmap[i] * k);
        }
        pos.needsUpdate = true;
        this.geometry.computeVertexNormals();
    }

    dispose() {
        if (this.geometry) this.geometry.dispose();
        if (this.material) {
            if (this.material.map) this.material.map.dispose();
            this.material.dispose();
        }
    }
}

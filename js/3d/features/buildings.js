import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
    makePlasterWallTexture, makeBrickWallTexture, makePanelWallTexture,
    makeCorrugatedRoofTexture, makeTileRoofTexture, makeSeamRoofTexture, makeFlatRoofTexture,
    WALL_TILE_M, ROOF_TILE_M
} from '../textures.js';
import { fetchMapboxBuildings } from '../data-sources.js';

// All buildings are merged into two meshes (walls / roofs), so the cap is a
// memory bound rather than a draw-call bound.
const BUILDING_CAP = 15000;

// Texture styles; each used style becomes one merged mesh (≤7 draw calls total).
const WALL_MAKERS = [
    () => makePlasterWallTexture(0),  // 0: plaster, single window
    () => makePlasterWallTexture(1),  // 1: plaster, double window
    makeBrickWallTexture,             // 2: brick
    makePanelWallTexture              // 3: concrete panels (industrial)
];
const ROOF_MAKERS = [
    makeCorrugatedRoofTexture,        // 0: corrugated rust
    makeTileRoofTexture,              // 1: clay tile
    makeSeamRoofTexture,              // 2: standing-seam gray
    makeFlatRoofTexture               // 3: flat bitumen (multi-story)
];
const GABLE_MAX_AREA = 600;   // m² — bigger quads keep flat roofs
const GABLE_RISE = 2.2;       // m of ridge above the wall top
const BASE_SINK = 0.5;        // m the footprint sinks below the lowest terrain corner
const INDUSTRIAL_TYPES = new Set(['industrial', 'warehouse', 'commercial', 'retail', 'manufacture']);
const MULTISTORY_TYPES = new Set(['apartments', 'dormitory', 'office', 'hotel']);

function heightForBuilding(tags) {
    // Mapbox tiles report height=3 for every building it knows nothing about —
    // treat that placeholder as unknown rather than rendering 3 m buildings.
    const height = parseFloat(tags.height);
    if (isFinite(height) && height > 3.01) return height;
    const levels = parseFloat(tags['building:levels']);
    if (isFinite(levels) && levels > 0) return levels * 3 + 1;
    // untagged apartment-type blocks: default to 5 or 9 stories, not cottage height
    if (MULTISTORY_TYPES.has(tags.building)) return (Math.random() < 0.7 ? 5 : 9) * 3 + 1;
    return 4 + Math.random() * 3;
}

// Shoelace area of a [lng,lat] ring (units don't matter, only used for relative sorting).
function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(area / 2);
}

// Shoelace area of a local {x,z} ring, in m².
function localRingArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return Math.abs(area / 2);
}

// Fill a constant per-building tint as a vertex color attribute (multiplies the texture).
function addTint(geometry, r, g, b) {
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
}

// Copy a vertex range of a non-indexed geometry into a standalone geometry.
function sliceGeometry(geo, start, count) {
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
        const attr = geo.attributes[name];
        if (!attr) continue;
        out.setAttribute(name, new THREE.BufferAttribute(
            attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize), attr.itemSize));
    }
    return out;
}

// True if the open {x,z} quad is convex with roughly right-angled corners.
function isRectangularQuad(pts) {
    for (let i = 0; i < 4; i++) {
        const p = pts[(i + 3) % 4], q = pts[i], r = pts[(i + 1) % 4];
        const ax = p.x - q.x, az = p.z - q.z, bx = r.x - q.x, bz = r.z - q.z;
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
        if (la < 1 || lb < 1) return false;
        const cos = (ax * bx + az * bz) / (la * lb);
        if (Math.abs(cos) > 0.45) return false; // corner outside ~63°–117°
    }
    return true;
}

// Hand-built gabled house: 4 walls + 2 gable triangles (wall material) and 2 roof slopes.
// pts is the open quad, baseY the world height of the floor.
function buildGabledGeometry(pts, baseY, wallH, ridgeRise) {
    pts = pts.slice();
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cz = (pts[0].z + pts[1].z + pts[2].z + pts[3].z) / 4;
    // ensure winding so wall normals (-dz, 0, dx) point outward
    {
        const ex = pts[1].x - pts[0].x, ez = pts[1].z - pts[0].z;
        const mx = (pts[0].x + pts[1].x) / 2 - cx, mz = (pts[0].z + pts[1].z) / 2 - cz;
        if (-ez * mx + ex * mz < 0) pts.reverse();
    }
    // rotate so edges (0→1) and (2→3) are the short gable ends
    const len = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
    if (len(pts[0], pts[1]) + len(pts[2], pts[3]) > len(pts[1], pts[2]) + len(pts[3], pts[0])) {
        pts.push(pts.shift());
    }
    const [a, b, c, d] = pts;
    const topY = baseY + wallH, ridgeY = topY + ridgeRise;
    const m0 = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const m1 = { x: (c.x + d.x) / 2, z: (c.z + d.z) / 2 };

    const makePusher = () => {
        const positions = [], uvs = [];
        return {
            positions, uvs,
            tri(p1, p2, p3, t1, t2, t3) {
                positions.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
                uvs.push(t1[0], t1[1], t2[0], t2[1], t3[0], t3[1]);
            },
            quad(p1, p2, p3, p4, t1, t2, t3, t4) {
                this.tri(p1, p2, p3, t1, t2, t3);
                this.tri(p1, p3, p4, t1, t3, t4);
            }
        };
    };

    const walls = makePusher();
    let u = 0;
    // Map the full wall height to exactly one vertical texture tile so the window
    // row appears once (at its designed sill height) instead of repeating up the
    // wall. U still advances in meters, so windows stay spaced ~WALL_TILE_M apart.
    for (let i = 0; i < 4; i++) {
        const p = pts[i], q = pts[(i + 1) % 4];
        const w = len(p, q);
        walls.quad(
            [p.x, baseY, p.z], [q.x, baseY, q.z], [q.x, topY, q.z], [p.x, topY, p.z],
            [u, 0], [u + w, 0], [u + w, WALL_TILE_M], [u, WALL_TILE_M]);
        u += w;
    }
    // Gable triangles: sample a plain band near the top of the tile (above the
    // window/frame/lintel) so the gable reads as solid wall, never a stray window.
    const GV0 = WALL_TILE_M * 0.88, GV1 = WALL_TILE_M;
    walls.tri([a.x, topY, a.z], [b.x, topY, b.z], [m0.x, ridgeY, m0.z],
        [0, GV0], [len(a, b), GV0], [len(a, b) / 2, GV1]);
    walls.tri([c.x, topY, c.z], [d.x, topY, d.z], [m1.x, ridgeY, m1.z],
        [0, GV0], [len(c, d), GV0], [len(c, d) / 2, GV1]);

    const roof = makePusher();
    const slope = Math.hypot(len(a, b) / 2, ridgeRise) + 0.001;
    roof.quad(
        [b.x, topY, b.z], [c.x, topY, c.z], [m1.x, ridgeY, m1.z], [m0.x, ridgeY, m0.z],
        [0, 0], [len(b, c), 0], [len(b, c), slope], [0, slope]);
    roof.quad(
        [d.x, topY, d.z], [a.x, topY, a.z], [m0.x, ridgeY, m0.z], [m1.x, ridgeY, m1.z],
        [0, 0], [len(d, a), 0], [len(d, a), slope], [0, slope]);

    const toGeo = (p) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.positions), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.uvs), 2));
        geo.computeVertexNormals();
        return geo;
    };
    return { walls: toGeo(walls), roof: toGeo(roof) };
}

export class BuildingsFeature {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'buildings';
        this.meshes = [];
        this.wallMeshes = [];  // per wall-texture style (null where unused)
        this.roofMeshes = [];  // per roof-texture style (null where unused)
        this.records = [];     // per-building style indices + vertex ranges for reDrape
        this.footprints = [];  // local {x,z} outer rings for player collision
        this.textures = [];
        // faceIndex → record lookup, per texture style (built after merging)
        this.wallPick = [];
        this.roofPick = [];
    }

    // Prefers Mapbox vector tiles (same source the main map's buildings-3d layer
    // renders, so coverage matches it); falls back to the shared Overpass
    // FeatureCollection when there is no token or the tile fetch yields nothing.
    async load(bbox, mapFeatures) {
        this.mapFeatures = mapFeatures;
        try {
            this.mvtFeatures = await fetchMapboxBuildings(bbox);
        } catch (e) {
            console.warn('Mapbox building tiles failed, falling back to Overpass:', e);
            this.mvtFeatures = null;
        }
    }

    build(terrain, proj) {
        const usingMvt = !!this.mvtFeatures?.features?.length;
        let features = (usingMvt ? this.mvtFeatures.features
            : (this.mapFeatures?.features || [])).filter(f =>
                f.geometry?.type === 'Polygon' && f.properties?.building && f.geometry.coordinates[0]?.length >= 4);
        if (usingMvt) this._enrichFromOsm(features);

        if (features.length > BUILDING_CAP) {
            features = features
                .map(f => ({ f, area: ringArea(f.geometry.coordinates[0]) }))
                .sort((a, b) => b.area - a.area)
                .slice(0, BUILDING_CAP)
                .map(x => x.f);
        }
        if (!features.length) return;

        // bucket per texture style; vertex offsets are tracked per bucket for reDrape
        const wallBuckets = WALL_MAKERS.map(() => ({ geos: [], offset: 0 }));
        const roofBuckets = ROOF_MAKERS.map(() => ({ geos: [], offset: 0 }));
        features.forEach(f => {
            const rec = this._buildOne(f, terrain, proj);
            if (!rec) return;
            const wb = wallBuckets[rec.wallStyle], rb = roofBuckets[rec.roofStyle];
            rec.wallStart = wb.offset;
            rec.wallCount = rec.walls.attributes.position.count;
            rec.roofStart = rb.offset;
            rec.roofCount = rec.roof.attributes.position.count;
            wb.offset += rec.wallCount;
            rb.offset += rec.roofCount;
            wb.geos.push(rec.walls);
            rb.geos.push(rec.roof);
            this.records.push(rec);
            this.footprints.push(rec.footprint);
        });
        if (!this.records.length) return;

        const buildBucket = (bucket, makeTexture, tileM, roughness, metalness, kind, style) => {
            if (!bucket.geos.length) return null;
            const geometry = mergeGeometries(bucket.geos);
            bucket.geos.forEach(g => g.dispose());
            const texture = makeTexture();
            texture.repeat.set(1 / tileM, 1 / tileM);
            this.textures.push(texture);
            // Walls are double-sided so a building whose roof the sandbox has blown off
            // reads as a hollow shell rather than a few paper-thin slivers.
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
                map: texture, vertexColors: true, roughness, metalness,
                side: kind === 'wall' ? THREE.DoubleSide : THREE.FrontSide
            }));
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.userData.buildingPart = kind;   // 'wall' | 'roof' — read by the sandbox picker
            mesh.userData.style = style;
            this.group.add(mesh);
            this.meshes.push(mesh);
            return mesh;
        };
        this.wallMeshes = wallBuckets.map((b, s) => buildBucket(b, WALL_MAKERS[s], WALL_TILE_M, 0.9, 0.0, 'wall', s));
        this.roofMeshes = roofBuckets.map((b, s) => buildBucket(b, ROOF_MAKERS[s], ROOF_TILE_M, 0.75, 0.15, 'roof', s));
        this._buildPickIndex();
        this.records.forEach(r => { delete r.walls; delete r.roof; });
    }

    // Per style, the sorted vertex-range starts and the record they belong to.
    // Records were pushed in build order, so within a style the starts are already
    // ascending — `buildingAt` binary-searches them.
    _buildPickIndex() {
        const collect = (startKey, styleKey) => {
            const perStyle = [];
            this.records.forEach((r, i) => {
                const s = r[styleKey];
                (perStyle[s] || (perStyle[s] = [])).push(i);
            });
            return perStyle.map(list => list && ({
                starts: Int32Array.from(list, i => this.records[i][startKey]),
                recs: Int32Array.from(list)
            }));
        };
        this.wallPick = collect('wallStart', 'wallStyle');
        this.roofPick = collect('roofStart', 'roofStyle');
    }

    // Resolve a raycast hit on one of the merged meshes back to a building record.
    // The merged geometries are non-indexed, so vertex index = faceIndex * 3.
    buildingAt(mesh, faceIndex) {
        const kind = mesh.userData.buildingPart;
        if (!kind) return null;
        const index = (kind === 'wall' ? this.wallPick : this.roofPick)[mesh.userData.style];
        if (!index) return null;
        const vertex = faceIndex * 3;
        const countKey = kind === 'wall' ? 'wallCount' : 'roofCount';
        const startKey = kind === 'wall' ? 'wallStart' : 'roofStart';
        let lo = 0, hi = index.starts.length - 1, hit = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (index.starts[mid] <= vertex) { hit = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (hit < 0) return null;
        const rec = this.records[index.recs[hit]];
        return vertex < rec[startKey] + rec[countKey] ? rec : null;
    }

    // Mapbox tiles carry placeholder heights and a generic type for most buildings;
    // OSM (via Overpass) has the real tags where mapped. Copy type/levels/height
    // from the OSM building containing each MVT footprint's centroid.
    _enrichFromOsm(features) {
        const tagged = (this.mapFeatures?.features || [])
            .filter(f => {
                if (f.geometry?.type !== 'Polygon' || !f.properties?.building) return false;
                const p = f.properties;
                return p.building !== 'yes' || p['building:levels'] || p.height;
            })
            .map(f => {
                const ring = f.geometry.coordinates[0];
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                ring.forEach(([x, y]) => {
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                });
                return { ring, props: f.properties, minX, maxX, minY, maxY };
            });
        if (!tagged.length) return;

        const inRing = (x, y, ring) => {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i], [xj, yj] = ring[j];
                if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
            }
            return inside;
        };

        features.forEach(f => {
            const ring = f.geometry.coordinates[0];
            let cx = 0, cy = 0;
            ring.forEach(([x, y]) => { cx += x; cy += y; });
            cx /= ring.length; cy /= ring.length;
            const hit = tagged.find(t =>
                cx >= t.minX && cx <= t.maxX && cy >= t.minY && cy <= t.maxY && inRing(cx, cy, t.ring));
            if (!hit) return;
            const p = f.properties;
            if (hit.props.building !== 'yes') p.building = hit.props.building;
            if (!p['building:levels'] && hit.props['building:levels']) p['building:levels'] = hit.props['building:levels'];
            if (!(parseFloat(p.height) > 3.01) && hit.props.height) p.height = hit.props.height;
        });
    }

    // Returns { walls, roof, footprint, baseY } with geometry baked in world coords.
    _buildOne(feature, terrain, proj) {
        const coords = feature.geometry.coordinates;
        const toLocal = ([lng, lat]) => proj.toLocal(lat, lng);
        const footprint = coords[0].map(toLocal);

        let minH = Infinity;
        footprint.forEach(p => {
            const h = terrain.sampleHeight(p.x, p.z);
            if (h < minH) minH = h;
        });
        if (!isFinite(minH)) minH = 0;
        const baseY = minH - BASE_SINK;

        const tags = feature.properties || {};
        const industrial = INDUSTRIAL_TYPES.has(tags.building);
        const height = heightForBuilding(tags);
        const levels = parseFloat(tags['building:levels']);
        const multistory = MULTISTORY_TYPES.has(tags.building) ||
            height > 8.5 || (isFinite(levels) && levels >= 3);

        let parts = null;
        let wallTopY;   // world Y of the wall top (eaves) — where damage cuts and roof markers go
        const openQuad = footprint.slice(0, -1);
        if (!industrial && !multistory && coords.length === 1 && openQuad.length === 4 &&
            localRingArea(footprint) < GABLE_MAX_AREA && isRectangularQuad(openQuad)) {
            const wallH = Math.max(2.5, height - GABLE_RISE) + BASE_SINK;
            parts = buildGabledGeometry(openQuad, baseY, wallH, GABLE_RISE);
            wallTopY = baseY + wallH;
        } else {
            parts = this._buildExtruded(coords, height + BASE_SINK, baseY, toLocal);
            wallTopY = baseY + height + BASE_SINK;
        }
        if (!parts) return null;

        // texture style + tint: industrial → concrete panels with gray roofs;
        // multi-story blocks → flat bitumen roofs; houses mix plaster variants
        // and brick under tile/corrugated/seam roofs
        let wallStyle, roofStyle, wallTint, roofTint;
        const w = 0.82 + Math.random() * 0.22;
        if (industrial) {
            wallStyle = 3;
            wallTint = [w * 0.92, w * 0.94, w * 0.96];
            roofStyle = Math.random() < 0.6 ? 2 : 0;
            const g = 0.6 + Math.random() * 0.3;
            roofTint = roofStyle === 0 ? [g, g * 1.02, g * 1.08] : [g, g, g];
        } else if (multistory) {
            const pick = Math.random();                  // apartment blocks: brick or panel
            wallStyle = pick < 0.4 ? 2 : pick < 0.7 ? 3 : 0;
            wallTint = wallStyle === 3 ? [w * 0.95, w * 0.96, w * 0.97] : [w, w, w];
            roofStyle = 3;
            const g = 0.8 + Math.random() * 0.3;
            roofTint = [g, g, g];
        } else {
            const pick = Math.random();
            wallStyle = pick < 0.4 ? 0 : pick < 0.7 ? 1 : 2;
            wallTint = wallStyle === 2
                ? [w, w, w]                              // brick: brightness only
                : [                                      // plaster: warm/green/yellow/blue washes
                    [w, w * 0.97, w * 0.9],
                    [w * 0.95, w, w * 0.93],
                    [w, w * 0.93, w * 0.84],
                    [w * 0.93, w * 0.96, w]
                ][Math.floor(Math.random() * 4)];
            const roofPick = Math.random();
            roofStyle = roofPick < 0.45 ? 1 : roofPick < 0.85 ? 0 : 2;
            const b = 0.8 + Math.random() * 0.3;
            roofTint = roofStyle === 2 ? [b * 0.9, b * 0.92, b] : [b, b * 0.95, b * 0.93];
        }
        addTint(parts.walls, ...wallTint);
        addTint(parts.roof, ...roofTint);

        // Stable-ish key for save/load: footprint centroid rounded to 0.5 m. There is no
        // OSM id left after the merge, and it would not survive the Mapbox/Overpass split.
        let cx = 0, cz = 0;
        footprint.forEach(p => { cx += p.x; cz += p.z; });
        cx /= footprint.length; cz /= footprint.length;
        const id = `${Math.round(cx * 2)}_${Math.round(cz * 2)}`;

        return {
            walls: parts.walls, roof: parts.roof, footprint, baseY, wallStyle, roofStyle,
            id, wallTopY, centroid: { x: cx, z: cz }, damage: 0
        };
    }

    _buildExtruded(coords, depth, baseY, toLocal) {
        const toVec2 = (pt) => {
            const p = toLocal(pt);
            return new THREE.Vector2(p.x, -p.z);
        };
        const shape = new THREE.Shape(coords[0].map(toVec2));
        coords.slice(1).forEach(hole => {
            if (hole.length >= 4) shape.holes.push(new THREE.Path(hole.map(toVec2)));
        });

        const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, baseY, 0);
        geometry.computeVertexNormals();

        // ExtrudeGeometry groups: 0 = caps (roof), 1 = side walls
        const capGroup = geometry.groups.find(g => g.materialIndex === 0);
        const sideGroup = geometry.groups.find(g => g.materialIndex === 1);
        if (!capGroup || !sideGroup) { geometry.dispose(); return null; }
        const parts = {
            roof: sliceGeometry(geometry, capGroup.start, capGroup.count),
            walls: sliceGeometry(geometry, sideGroup.start, sideGroup.count)
        };
        geometry.dispose();
        return parts;
    }

    reDrape(terrain) {
        if (!this.records.length) return;
        const wallPositions = this.wallMeshes.map(m => m && m.geometry.attributes.position);
        const roofPositions = this.roofMeshes.map(m => m && m.geometry.attributes.position);
        this.records.forEach(r => {
            let minH = Infinity;
            r.footprint.forEach(p => {
                const h = terrain.sampleHeight(p.x, p.z);
                if (h < minH) minH = h;
            });
            if (!isFinite(minH)) minH = 0;
            const delta = (minH - BASE_SINK) - r.baseY;
            if (delta === 0) return;
            const wallPos = wallPositions[r.wallStyle];
            const roofPos = roofPositions[r.roofStyle];
            for (let i = r.wallStart; i < r.wallStart + r.wallCount; i++) {
                wallPos.setY(i, wallPos.getY(i) + delta);
            }
            for (let i = r.roofStart; i < r.roofStart + r.roofCount; i++) {
                roofPos.setY(i, roofPos.getY(i) + delta);
            }
            r.baseY += delta;
            r.wallTopY += delta;
            // `_orig` (damage undo snapshot) keeps its own baseY on purpose: restore shifts
            // the snapshot by (current baseY − snapshot baseY) so undo survives re-draping.
        });
        this.meshes.forEach(m => {
            m.geometry.attributes.position.needsUpdate = true;
            m.geometry.computeBoundingSphere();
        });
    }

    dispose() {
        this.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        this.textures.forEach(t => t.dispose());
        this.meshes = [];
        this.wallMeshes = [];
        this.roofMeshes = [];
        this.records = [];
        this.footprints = [];
        this.textures = [];
        this.wallPick = [];
        this.roofPick = [];
    }
}

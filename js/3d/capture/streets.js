// Capture Mala Tokmachka: the walkable street graph and block-to-block routes.
// Pure (no three.js, no DOM) so the sim can run headless in node tests.
//
// The preset is in lat/lng; `toLocal(lat, lng) → {x, z}` is the viewer's projection
// (x east, z south). Each block centre joins the graph through "yard" edges to every
// street node on its edge (its gates), so a column leaves by the corner nearest its
// target; neighbours whose shared border has no street get a footpath across it.
// Every route is a graph path from one block centre to another, and block centres are
// never passed through, so columns can meet on any edge, yards included.

class MinHeap {
    constructor() { this.a = []; }
    push(d, n) {
        const a = this.a;
        a.push([d, n]);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p][0] < a[i][0] || (a[p][0] === a[i][0] && a[p][1] <= a[i][1])) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                const less = (x, y) => a[x][0] < a[y][0] || (a[x][0] === a[y][0] && a[x][1] < a[y][1]);
                if (l < a.length && less(l, m)) m = l;
                if (r < a.length && less(r, m)) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
    get size() { return this.a.length; }
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);

function polylineLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
    return len;
}

/**
 * Build the playable world from a preset.
 * @returns {{blocks, nodes, edges, route(from, to), routeLen(from, to)}}
 *   blocks[i] = {id, x, z, area, houses, edge, poly:[{x,z}], node}
 *   edges[e] = {a, b, kind: 'street'|'path'|'yard', pts:[{x,z}], len}
 */
export function buildWorld(preset, toLocal) {
    const L = ([lat, lng]) => toLocal(lat, lng);
    const nodes = preset.streets.nodes.map(L);
    const edges = preset.streets.edges.map(([a, b, isPath, inner]) => {
        const pts = [nodes[a], ...inner.map(L), nodes[b]];
        return { a, b, kind: isPath ? 'path' : 'street', pts, len: polylineLength(pts) };
    });
    const yard = (a, b) => edges.push({ a, b, kind: 'yard', pts: [nodes[a], nodes[b]], len: Math.max(1, dist(nodes[a], nodes[b])) });
    const blocks = preset.blocks.map(b => {
        const c = toLocal(b.lat, b.lng);
        const node = nodes.length;
        nodes.push(c);
        for (const g of b.gates || [b.anchor]) yard(node, g);
        return {
            id: b.id, x: c.x, z: c.z, area: b.area, houses: b.houses, edge: b.edge,
            poly: b.poly.map(L), node,
        };
    });
    for (const [i, j, mid] of preset.links || []) {
        const m = nodes.length;
        nodes.push(L(mid));
        yard(blocks[i].node, m);
        yard(m, blocks[j].node);
    }
    const centre = new Uint8Array(nodes.length);
    for (const b of blocks) centre[b.node] = 1;
    const adj = nodes.map(() => []);
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });

    // one Dijkstra per block centre: prev-edge pointers back to the source
    const trees = blocks.map(blk => {
        const d = new Float64Array(nodes.length).fill(Infinity);
        const prev = new Int32Array(nodes.length).fill(-1);
        const heap = new MinHeap();
        d[blk.node] = 0;
        heap.push(0, blk.node);
        while (heap.size) {
            const [du, u] = heap.pop();
            if (du > d[u]) continue;
            if (centre[u] && u !== blk.node) continue;     // other blocks are ends, never shortcuts
            for (const ei of adj[u]) {
                const e = edges[ei];
                const v = e.a === u ? e.b : e.a;
                const nd = du + e.len;
                if (nd < d[v] - 1e-9 || (Math.abs(nd - d[v]) <= 1e-9 && ei < prev[v])) {
                    d[v] = nd;
                    prev[v] = ei;
                    heap.push(nd, v);
                }
            }
        }
        return { d, prev };
    });

    const cache = new Map();
    function route(from, to) {
        const key = from * blocks.length + to;
        if (cache.has(key)) return cache.get(key);
        const { prev } = trees[from];
        const target = blocks[to].node, source = blocks[from].node;
        if (from !== to && prev[target] < 0) throw new Error(`no street route ${from} → ${to}`);
        // walk back from the target, then lay the edges out source → target
        const chain = [];
        for (let v = target; v !== source;) {
            const ei = prev[v];
            const e = edges[ei];
            const u = e.a === v ? e.b : e.a;
            chain.push({ ei, fwd: e.a === u });
            v = u;
        }
        chain.reverse();
        const pts = [blocks[from]];
        const cum = [0];
        const spans = [];
        let run = 0;
        for (const { ei, fwd } of chain) {
            const e = edges[ei];
            const seq = fwd ? e.pts : [...e.pts].reverse();
            spans.push({ e: ei, d0: run, d1: run + e.len, fwd });
            for (let k = 1; k < seq.length; k++) {
                run += dist(seq[k - 1], seq[k]);
                pts.push(seq[k]);
                cum.push(run);
            }
            spans[spans.length - 1].d1 = run;
        }
        const r = { from, to, len: Math.max(run, 1), pts, cum, spans };
        cache.set(key, r);
        return r;
    }
    const routeLen = (from, to) => trees[from].d[blocks[to].node];

    return { blocks, nodes, edges, route, routeLen };
}

/** Point at distance d along a route: {x, z, dx, dz} (unit heading). */
export function pointAt(r, d) {
    const { pts, cum } = r;
    if (d <= 0) return heading(pts[0], pts[Math.min(1, pts.length - 1)], pts[0]);
    if (d >= cum[cum.length - 1]) return heading(pts[pts.length - 2] || pts[0], pts[pts.length - 1], pts[pts.length - 1]);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const t = (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    const p = pts[lo], q = pts[hi];
    return heading(p, q, { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
}

function heading(p, q, at) {
    const dx = q.x - p.x, dz = q.z - p.z, n = Math.hypot(dx, dz) || 1;
    return { x: at.x, z: at.z, dx: dx / n, dz: dz / n };
}

/** Which graph edge a column at distance d is on, and how far along that edge from its `a` end. */
export function edgeAt(r, d) {
    const spans = r.spans;
    let lo = 0, hi = spans.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].d1 < d) lo = mid + 1; else hi = mid;
    }
    const s = spans[lo];
    const along = Math.min(Math.max(d - s.d0, 0), s.d1 - s.d0);
    return { e: s.e, s: s.fwd ? along : (s.d1 - s.d0) - along };
}

/** Ray-cast style point-in-polygon on local {x,z} rings. */
export function inPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.z > pt.z) !== (b.z > pt.z) && pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
}

/** Block under a local point, or -1. */
export function blockAt(world, x, z) {
    for (const b of world.blocks) if (inPolygon({ x, z }, b.poly)) return b.id;
    return -1;
}

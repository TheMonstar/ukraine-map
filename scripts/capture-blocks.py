#!/usr/bin/env python3
"""Build the Capture Mala Tokmachka preset: street blocks + walkable street graph.

    python3 scripts/capture-blocks.py --footprints <microsoft-buildings.geojson> \
        [--streets-json <overpass.json>] [--preview <out.svg>]

Needs shapely (the repo's .building-venv has it). Writes js/3d/capture/mala-tokmachka.js.

Blocks are the areas the village's OSM streets close off, with the street grid
carried on to the village edge, long edge strips cut, slivers dropped and small
or long-narrow pieces united with a neighbour (the division the user approved,
16 Nov 2026). Footprints are only counted ("houses" sizes production); the game
never draws them. `--streets-json` reuses a saved Overpass response (it is
written there after a fresh fetch) so the build is reproducible.
"""
import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, substring, unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'js', '3d', 'capture', 'mala-tokmachka.js')
SETTLEMENT_KEY = 'nodes_337674989'          # Мала Токмачка in data/settlements_boundaries.json
FRAME = {'lat': 47.5368, 'lng': 35.8918, 'size': 9.5}
BBOX = (47.515, 35.830, 47.558, 35.955)     # s, w, n, e — the outline plus a margin
OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.openstreetmap.fr/api/interpreter']

LAT0, LNG0 = FRAME['lat'], FRAME['lng']
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110570


def to_xy(lng, lat):
    return ((lng - LNG0) * KX, (LAT0 - lat) * KY)


def to_latlng(x, y):
    return [round(LAT0 - y / KY, 6), round(LNG0 + x / KX, 6)]


def fetch_streets(path):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    s, w, n, e = BBOX
    query = f'[out:json][timeout:60];way[highway]({s},{w},{n},{e});out geom;'
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=body, headers={'User-Agent': 'map-tools/1.0'})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            if path:
                with open(path, 'w') as f:
                    json.dump(data, f)
            return data
        except Exception as err:  # busy server or HTML error page: try the mirror
            last = err
    sys.exit(f'Overpass failed: {last}')


def mrr_sides(poly):
    c = list(poly.minimum_rotated_rectangle.exterior.coords)
    a, b = math.dist(c[0], c[1]), math.dist(c[1], c[2])
    return min(a, b), max(a, b), c, a >= b


def compactness(poly):
    return 4 * math.pi * poly.area / poly.length ** 2


def continue_streets(segs, outline):
    """Carry the street grid on: dead ends run on straight; T-junction stems cross the bar to the edge."""
    edge = outline.exterior
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    inc = defaultdict(list)

    def out_dir(ls, at_start):
        c = list(ls.coords) if at_start else list(ls.coords)[::-1]
        p0, q, run = c[0], c[1], 0
        for a, b in zip(c, c[1:]):
            run += math.dist(a, b)
            q = b
            if run >= 25:
                break
        v = (q[0] - p0[0], q[1] - p0[1])
        n = math.hypot(*v) or 1
        return (v[0] / n, v[1] / n)

    for s in segs:
        c = list(s.coords)
        inc[key(c[0])].append(out_dir(s, True))
        inc[key(c[-1])].append(out_dir(s, False))
    barrier = unary_union(segs + [edge])
    ext = []

    def extend(p, v, to_street_ok):
        ray = LineString([p, (p[0] + v[0] * 900, p[1] + v[1] * 900)])
        hit = ray.intersection(barrier.difference(Point(p).buffer(1.0)))
        if hit.is_empty:
            return
        pts = []
        for g in getattr(hit, 'geoms', [hit]):
            pts += list(g.coords)
        q = min(pts, key=lambda c: math.dist(c, p))
        length = math.dist(p, q)
        if length < 30 or length > 800:
            return
        if edge.distance(Point(q)) >= 1.0 and not to_street_ok:
            return
        seg = LineString([p, q])
        if outline.buffer(5).contains(seg):
            ext.append(seg)

    for k, dirs in sorted(inc.items()):
        if not outline.buffer(30).contains(Point(k)):
            continue
        if len(dirs) == 1:
            v = dirs[0]
            extend(k, (-v[0], -v[1]), True)
        elif len(dirs) == 3:
            bar = None
            for i in range(3):
                for j in range(i + 1, 3):
                    if dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] < -0.85:
                        bar = (i, j)
            if bar:
                v = dirs[({0, 1, 2} - set(bar)).pop()]
                extend(k, (-v[0], -v[1]), False)
    return ext


def build_blocks(segs, ext, outline):
    edge = outline.exterior
    faces = [f for f in polygonize(unary_union(segs + ext + [edge]))
             if outline.contains(f.representative_point())]
    touches_edge = lambda f: f.boundary.intersection(edge).length > 5
    pieces = []
    for f in faces:
        if touches_edge(f) and f.area >= 20000:
            _, length, c, first = mrr_sides(f)
            if length > 1000:
                a, b = (c[0], c[1]) if first else (c[1], c[2])
                ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
                n = math.ceil(length / 650)
                cuts = []
                for i in range(1, n):
                    mx, my = a[0] + ux * length * i / n, a[1] + uy * length * i / n
                    cut = LineString([(mx - uy * 2000, my + ux * 2000), (mx + uy * 2000, my - ux * 2000)])
                    cuts.append(cut.intersection(f.buffer(1)))
                for g in polygonize(unary_union([f.boundary] + cuts)):
                    if f.contains(g.representative_point()):
                        pieces.append(g)
                continue
        pieces.append(f)
    blocks = [p for p in pieces if p.area >= 3000]

    def neighbour(i):
        best, shared = None, 0
        for j, g in enumerate(blocks):
            if j != i:
                s = blocks[i].boundary.buffer(0.5).intersection(g.boundary).length
                if s > shared:
                    best, shared = j, s
        return best

    def unite(i):
        j = neighbour(i)
        if j is None:
            return False
        blocks[j] = unary_union([blocks[i].buffer(0.3), blocks[j].buffer(0.3)]).buffer(-0.3)
        blocks.pop(i)
        return True

    while True:  # slices under 2 ha
        blocks.sort(key=lambda p: p.area)
        i = next((i for i, p in enumerate(blocks) if p.area < 20000), None)
        if i is None or not unite(i):
            break
    while True:  # small long-narrow pieces
        cand = [(compactness(p), i) for i, p in enumerate(blocks) if p.area < 70000 and compactness(p) < 0.4]
        if not cand or not unite(min(cand)[1]):
            break
    out = []
    for p in blocks:
        if p.geom_type == 'MultiPolygon':
            p = max(p.geoms, key=lambda g: g.area)
        out.append(Polygon(p.exterior))
    out.sort(key=lambda p: (round(p.centroid.x), p.centroid.y))
    return out


def build_graph(lines, ext, outline):
    """Noded walkable graph: streets near the village plus the continued paths."""
    reach = outline.buffer(200)
    clipped = []
    for ls in lines:
        g = ls.intersection(reach)
        for part in getattr(g, 'geoms', [g]):
            if part.geom_type == 'LineString' and part.length > 1:
                clipped.append(part)
    noded = unary_union(clipped + ext)
    segs = [s for s in getattr(noded, 'geoms', [noded]) if s.length > 0.5]
    ext_zone = unary_union([e.buffer(0.5) for e in ext]) if ext else None
    nodes, index = [], {}

    def node(p):
        k = (round(p[0], 1), round(p[1], 1))
        if k not in index:
            index[k] = len(nodes)
            nodes.append(k)
        return index[k]

    edges = []
    for s in segs:
        c = list(s.simplify(1.0).coords)
        kind = 'path' if ext_zone is not None and ext_zone.contains(s) else 'street'
        edges.append({'a': node(c[0]), 'b': node(c[-1]), 'kind': kind, 'line': LineString(c)})
    # join stray components to the main one with short paths
    while True:
        parent = list(range(len(nodes)))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for e in edges:
            parent[find(e['a'])] = find(e['b'])
        comps = defaultdict(list)
        for i in range(len(nodes)):
            comps[find(i)].append(i)
        if len(comps) <= 1:
            break
        main = max(comps.values(), key=len)
        stray = min(comps.values(), key=len)
        a, b = min(((i, j) for i in stray for j in main), key=lambda ij: math.dist(nodes[ij[0]], nodes[ij[1]]))
        edges.append({'a': a, 'b': b, 'kind': 'path', 'line': LineString([nodes[a], nodes[b]])})
    return nodes, edges


def add_anchors(blocks, nodes, edges, outline):
    """Each block gets a node on its own boundary street, nearest its centre (edges split there)."""
    splits = defaultdict(list)          # edge index -> [(distance along, block index)]
    anchors = [None] * len(blocks)
    for bi, poly in enumerate(blocks):
        centre = poly.centroid if poly.contains(poly.centroid) else poly.representative_point()
        ring = poly.exterior.buffer(1.5)
        best = None
        for ei, e in enumerate(edges):
            if e['line'].intersection(ring).length < 5:
                continue
            d = e['line'].project(centre)
            p = e['line'].interpolate(d)
            dist = p.distance(centre)
            if best is None or dist < best[0]:
                best = (dist, ei, d)
        if best is None:  # no street along it: nearest node anywhere
            anchors[bi] = min(range(len(nodes)), key=lambda i: math.dist(nodes[i], (centre.x, centre.y)))
            continue
        _, ei, d = best
        splits[ei].append((d, bi))
    new_edges = []
    for ei, e in enumerate(edges):
        if ei not in splits:
            new_edges.append(e)
            continue
        line, prev, prev_d = e['line'], e['a'], 0.0
        for d, bi in sorted(splits[ei]):
            if d < 3:
                anchors[bi] = e['a']
                continue
            if line.length - d < 3:
                anchors[bi] = e['b']
                continue
            if d - prev_d < 3:          # two anchors at the same spot share a node
                anchors[bi] = prev
                continue
            p = line.interpolate(d)
            k = (round(p.x, 1), round(p.y, 1))
            nodes.append(k)
            mid = len(nodes) - 1
            new_edges.append({'a': prev, 'b': mid, 'kind': e['kind'], 'line': substring(line, prev_d, d)})
            prev, prev_d = mid, d
            anchors[bi] = mid
        new_edges.append({'a': prev, 'b': e['b'], 'kind': e['kind'], 'line': substring(line, prev_d, line.length)})
    return anchors, new_edges


def add_gates_and_links(blocks, nodes, edges):
    """Where columns can leave or enter each block, and footpaths across street-less borders.

    gates: every graph node on (or inside) the block's edge, so a column leaves by the
    corner nearest its target instead of one fixed exit. links: neighbouring blocks whose
    shared border has no street on it (cut lines, merged pieces) get a footpath across
    its midpoint, so they are not a walk around the whole block apart.
    """
    pts = [Point(n) for n in nodes]
    gates = []
    for poly in blocks:
        zone = poly.buffer(3.0)
        gates.append([i for i, p in enumerate(pts) if zone.contains(p)])
    streets = unary_union([e['line'] for e in edges]).buffer(2.5)
    links = []
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            shared = blocks[i].boundary.intersection(blocks[j].buffer(1.0))
            if shared.is_empty or shared.length < 25:
                continue
            if shared.intersection(streets).length / shared.length > 0.5:
                continue
            parts = [g for g in getattr(shared, 'geoms', [shared]) if g.length > 0]
            longest = max(parts, key=lambda g: g.length)
            mid = longest.interpolate(0.5, normalized=True)
            links.append((i, j, to_latlng(mid.x, mid.y)))
    return gates, links


def count_houses(blocks, footprints_path):
    with open(footprints_path) as f:
        fc = json.load(f)
    pts = []
    for feat in fc['features']:
        ring = feat['geometry']['coordinates']
        while isinstance(ring[0][0], list):
            ring = ring[0]
        poly = Polygon([to_xy(*p[:2]) for p in ring])
        if poly.is_valid and poly.area >= 30:
            pts.append(poly.centroid)
    tree = STRtree(pts)
    return [len(tree.query(b, predicate='contains')) for b in blocks]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--footprints', required=True, help='Microsoft footprints GeoJSON covering the village')
    ap.add_argument('--streets-json', help='saved Overpass response (read if present, written after a fetch)')
    ap.add_argument('--preview', help='write an SVG preview of the division here')
    args = ap.parse_args()

    with open(os.path.join(ROOT, 'data', 'settlements_boundaries.json')) as f:
        ring = json.load(f)[SETTLEMENT_KEY]['boundary']['coordinates'][0]
    while isinstance(ring[0][0], list):
        ring = ring[0]
    outline = Polygon([to_xy(*p) for p in ring])

    osm = fetch_streets(args.streets_json)
    lines = [LineString([to_xy(g['lon'], g['lat']) for g in el['geometry']])
             for el in osm['elements'] if el.get('type') == 'way' and len(el.get('geometry', [])) >= 2]
    noded = unary_union(lines)
    segs = list(getattr(noded, 'geoms', [noded]))
    ext = continue_streets(segs, outline)
    blocks = build_blocks(segs, ext, outline)
    nodes, edges = build_graph(lines, ext, outline)
    anchors, edges = add_anchors(blocks, nodes, edges, outline)
    gates, links = add_gates_and_links(blocks, nodes, edges)
    houses = count_houses(blocks, args.footprints)

    out_blocks = []
    for i, poly in enumerate(blocks):
        centre = poly.centroid if poly.contains(poly.centroid) else poly.representative_point()
        lat, lng = to_latlng(centre.x, centre.y)
        out_blocks.append({
            'id': i, 'lat': lat, 'lng': lng, 'area': round(poly.area), 'houses': houses[i],
            'edge': poly.boundary.intersection(outline.exterior).length > 5,
            'anchor': anchors[i],
            'gates': sorted(set(gates[i]) | {anchors[i]}),
            'poly': [to_latlng(x, y) for x, y in poly.simplify(2.0).exterior.coords[:-1]],
        })
    preset = {
        'id': 'mala-tokmachka', 'name': 'Mala Tokmachka', 'frame': FRAME,
        'outline': [[round(p[0], 6), round(p[1], 6)] for p in ring],
        'streets': {
            'nodes': [to_latlng(x, y) for x, y in nodes],
            'edges': [[e['a'], e['b'], 1 if e['kind'] == 'path' else 0,
                       [to_latlng(x, y) for x, y in e['line'].coords[1:-1]]] for e in edges],
        },
        'blocks': out_blocks,
        'links': [[i, j, mid] for i, j, mid in links],
    }
    header = ('// Generated by scripts/capture-blocks.py: do not edit by hand.\n'
              '// Village outline and streets: © OpenStreetMap contributors (ODbL).\n'
              '// House counts: Microsoft Global ML Building Footprints (CDLA-Permissive-2.0).\n'
              '// outline: [lng, lat]; everything else: [lat, lng]. streets.edges: [a, b, isPath, innerPoints].\n'
              '// blocks[].gates: street nodes on the block edge; links: [blockA, blockB, footpath midpoint].\n')
    js = json.dumps(preset, separators=(',', ':'))
    js = js.replace('],"', '],\n"').replace('},{"id"', '},\n{"id"')
    with open(OUT, 'w') as f:
        f.write(header + 'export const MALA_TOKMACHKA = ' + js + ';\n')
    print(f'{len(out_blocks)} blocks, {len(links)} border footpaths, '
          f'{sum(len(b["gates"]) for b in out_blocks)} gates, {len(nodes)} nodes, {len(edges)} edges '
          f'({sum(e["kind"] == "path" for e in edges)} paths), {sum(houses)} houses, '
          f'{os.path.getsize(OUT) // 1024} KB -> {os.path.relpath(OUT, ROOT)}')

    if args.preview:
        minx, miny, maxx, maxy = outline.bounds
        s = 1600 / (maxx - minx)
        T = lambda x, y: f'{(x - minx) * s + 20:.1f},{(y - miny) * s + 20:.1f}'
        h = (maxy - miny) * s + 40
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1640" height="{h:.0f}" style="background:#fff">']
        for b, poly in zip(out_blocks, blocks):
            hue = (b['id'] * 47) % 360
            parts.append(f'<polygon points="{" ".join(T(*c) for c in poly.exterior.coords)}" '
                         f'fill="hsl({hue},55%,70%)" stroke="#333" stroke-width="0.6"/>')
        for e in edges:
            col = '#d85a30' if e['kind'] == 'path' else '#555'
            parts.append(f'<polyline points="{" ".join(T(*c) for c in e["line"].coords)}" fill="none" stroke="{col}" stroke-width="1"/>')
        for b, poly in zip(out_blocks, blocks):
            ax, ay = nodes[b['anchor']]
            parts.append(f'<circle cx="{T(ax, ay).split(",")[0]}" cy="{T(ax, ay).split(",")[1]}" r="2.5" fill="#000"/>')
            c = poly.representative_point()
            x, y = T(c.x, c.y).split(',')
            parts.append(f'<text x="{x}" y="{y}" font-size="10" text-anchor="middle">{b["id"]}·{b["houses"]}</text>')
        parts.append('</svg>')
        with open(args.preview, 'w') as f:
            f.write('\n'.join(parts))


if __name__ == '__main__':
    main()

// Capture Mala Tokmachka: preset, street routes and game rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MALA_TOKMACHKA as P } from '../js/3d/capture/mala-tokmachka.js';
import { makeProjection } from '../js/3d/geo.js';
import { buildWorld, edgeAt, pointAt, inPolygon } from '../js/3d/capture/streets.js';
import {
    FACTIONS, PERKS, RULES, capOf, command, createGame, holdShare, marchSpeed, neutralGarrison, prodRate, step,
} from '../js/3d/capture/sim.js';
import { playHeadless } from '../js/3d/capture/ai.js';
import { SIDES, UPGRADES, blockName, eventLine } from '../js/3d/capture/text.js';

const proj = makeProjection(P.frame.lat, P.frame.lng);
const world = buildWorld(P, proj.toLocal);
const N = world.blocks.length;

// a quiet game: no events, everything local with `troops` in it, except three
// far-away homes at the east end that keep every side in the game
function blank(troops = 20) {
    const st = createGame(world, { seed: 7 });
    st.blocks.forEach(b => { b.owner = null; b.troops = troops; b.lv = [0, 0, 0]; });
    FACTIONS.forEach((f, k) => Object.assign(st.blocks[N - 1 - k], { owner: f, troops: 5 }));
    st.log = [];
    st.nextEventAt = Infinity;
    return st;
}
// a neighbouring pair of blocks (short route), for marching tests
const [A, B] = (() => {
    let best = [0, 1];
    for (let j = 1; j < N; j++) if (world.routeLen(0, j) < world.routeLen(0, best[1])) best = [0, j];
    return best;
})();
function march(st, g) {
    st.groups.push({ id: st.nextGroup++, d: 0, lastE: -1, lastS: 0, atk: 1, ...g });
}
function runUntil(st, done, maxS = 400) {
    for (let i = 0; i < maxS / RULES.tick && !done(); i++) step(world, st);
}

test('preset: 60–68 street blocks covering the village outline', () => {
    assert.ok(N >= 60 && N <= 68, `${N} blocks`);
    P.blocks.forEach((b, i) => assert.equal(b.id, i));
    const outline = P.outline.map(([lng, lat]) => proj.toLocal(lat, lng));
    const area = ring => Math.abs(ring.reduce((s, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return s + p.x * q.z - q.x * p.z;
    }, 0)) / 2;
    const covered = world.blocks.reduce((s, b) => s + area(b.poly), 0) / area(outline);
    assert.ok(covered >= 0.95 && covered <= 1.02, `blocks cover ${(covered * 100).toFixed(1)}% of the outline`);
    for (const b of world.blocks) {
        assert.ok(inPolygon(b, outline), `block ${b.id} centre inside the village`);
        assert.ok(Number.isInteger(b.houses) && b.houses >= 0);
        assert.ok(P.blocks[b.id].anchor >= 0 && P.blocks[b.id].anchor < P.streets.nodes.length);
    }
    const half = P.frame.size * 500;
    assert.ok(outline.every(p => Math.abs(p.x) <= half && Math.abs(p.z) <= half), 'frame contains the outline');
});

test('streets: every block reaches every other, never shorter than the crow flies', () => {
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
            if (i === j) continue;
            const r = world.route(i, j);
            const crow = Math.hypot(world.blocks[i].x - world.blocks[j].x, world.blocks[i].z - world.blocks[j].z);
            assert.ok(Number.isFinite(r.len) && r.len >= crow - 1, `${i}→${j}`);
            assert.ok(Math.abs(r.len - world.routeLen(i, j)) < 1e-6);
        }
    }
    // touching blocks are close by street too: a column leaves by the nearest corner,
    // and borders without a street have a footpath (no walking round the whole block)
    const segDist = (p, a, b) => {
        const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L));
        return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
    };
    const touch = (P1, P2) => P1.poly.some(p => P2.poly.some((q, k) => segDist(p, q, P2.poly[(k + 1) % P2.poly.length]) < 12));
    const detours = [];
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            if (!touch(world.blocks[i], world.blocks[j])) continue;
            detours.push(world.routeLen(i, j) / Math.hypot(world.blocks[i].x - world.blocks[j].x, world.blocks[i].z - world.blocks[j].z));
        }
    }
    detours.sort((a, b) => a - b);
    assert.ok(detours[detours.length >> 1] <= 1.2, `median neighbour detour ${detours[detours.length >> 1].toFixed(2)}`);
    assert.ok(detours.at(-1) <= 3.5, `worst neighbour detour ${detours.at(-1).toFixed(2)}`);

    const r = world.route(A, B);
    const end = pointAt(r, r.len);
    assert.ok(Math.hypot(end.x - world.blocks[B].x, end.z - world.blocks[B].z) < 1e-6);
    const { e, s } = edgeAt(r, r.len / 2);
    assert.ok(e >= 0 && s >= 0 && s <= world.edges[e].len + 1e-6);
});

test('combat: 30 attackers on 20 locals leave 10, defence and attack levels count', () => {
    let st = blank(20);
    march(st, { f: 'us', from: A, to: B, n: 30 });
    runUntil(st, () => !st.groups.length);
    assert.equal(st.blocks[B].owner, 'us');
    assert.ok(Math.abs(st.blocks[B].troops - 10) < 1e-6, String(st.blocks[B].troops));

    st = blank(20);
    st.blocks[B].lv = [2, 2, 1];
    march(st, { f: 'us', from: A, to: B, n: 40 });   // 40 vs 20 × 1.6 = 32 → 8 left
    runUntil(st, () => !st.groups.length);
    assert.equal(st.blocks[B].owner, 'us');
    assert.ok(Math.abs(st.blocks[B].troops - 8) < 1e-6);
    assert.deepEqual(st.blocks[B].lv, [1, 1, 0], 'capture drops each level by one');

    st = blank(20);
    st.blocks[A].owner = 'us';
    st.blocks[A].troops = 100;
    st.blocks[A].lv = [0, 0, 2];
    assert.ok(command(world, st, 'us', { type: 'send', from: [A], to: B, frac: 0.5 }).ok);
    assert.equal(st.groups[0].n, 50);
    assert.equal(st.groups[0].atk, 1.5, 'the gym level travels with the column');
    assert.equal(st.blocks[A].troops, 50);
});

test('street clash: columns meeting in a lane fight there, the survivor marches on', () => {
    const st = blank(5);
    march(st, { f: 'us', from: A, to: B, n: 30 });
    march(st, { f: 'cn', from: B, to: A, n: 20 });
    runUntil(st, () => st.groups.length < 2);
    assert.equal(st.groups.length, 1);
    const [g] = st.groups;
    assert.equal(g.f, 'us');
    assert.ok(Math.abs(g.n - 10) < 1e-6);
    assert.ok(g.d < world.route(A, B).len, 'met before arriving');
    runUntil(st, () => !st.groups.length);
    assert.equal(st.blocks[B].owner, 'us', 'the survivor took the block');
    assert.ok(Math.abs(st.blocks[B].troops - 5) < 1e-6);
});

test('perks: US marches faster, China produces faster, Russia has more but weaker troops', () => {
    const st = blank(0);
    assert.equal(marchSpeed(st, 'us'), RULES.speed * PERKS.us.speed);
    assert.equal(marchSpeed(st, 'cn'), RULES.speed);
    st.blocks[A].owner = 'us';
    const us = prodRate(world, st, A), usCap = capOf(world, st, A);
    st.blocks[A].owner = 'cn';
    assert.ok(Math.abs(prodRate(world, st, A) / us - PERKS.cn.prod) < 1e-9);
    st.blocks[A].owner = 'ru';
    assert.ok(Math.abs(capOf(world, st, A) / usCap - PERKS.ru.head) < 1e-9);

    const fight = blank(20);
    march(fight, { f: 'ru', from: A, to: B, n: 30 });          // 30 × 0.65 = 19.5 < 20
    runUntil(fight, () => !fight.groups.length);
    assert.equal(fight.blocks[B].owner, null);
    assert.ok(Math.abs(fight.blocks[B].troops - 0.5) < 1e-6);
});

test('mud halves marching for everyone', () => {
    const st = blank(0);
    st.mudUntil = st.t + RULES.mudTime;
    for (const f of FACTIONS) assert.equal(marchSpeed(st, f), RULES.speed * PERKS[f].speed * RULES.mudSlow);
});

test('commands: bad or illegal orders are refused', () => {
    const st = blank(20);
    st.blocks[A].owner = 'us';
    const no = cmd => assert.equal(command(world, st, 'us', cmd).ok, false, JSON.stringify(cmd));
    no({ type: 'send', from: [B], to: A, frac: 0.5 });          // not ours
    no({ type: 'send', from: [A], to: B, frac: 0 });
    no({ type: 'send', from: [A], to: N + 3, frac: 0.5 });
    no({ type: 'send', from: [A], to: A, frac: 1 });
    no({ type: 'upgrade', block: B, track: 0 });                // not ours
    no({ type: 'upgrade', block: A, track: 5 });
    st.blocks[A].troops = RULES.upgradeCost[0] - 1;
    no({ type: 'upgrade', block: A, track: 0 });                // too few troops
    st.blocks[A].troops = 500;
    for (let k = 0; k < RULES.maxLevel; k++) assert.ok(command(world, st, 'us', { type: 'upgrade', block: A, track: 0 }).ok);
    no({ type: 'upgrade', block: A, track: 0 });                // maxed
    no({ type: 'dance' });
    assert.equal(command(world, st, 'xx', { type: 'send', from: [A], to: B, frac: 1 }).ok, false);
});

test('seeded games are deterministic; every event type shows up; nobody goes negative', () => {
    const a = playHeadless(world, { seed: 11 });
    const b = playHeadless(world, { seed: 11 });
    assert.deepEqual(a.log, b.log);
    assert.equal(a.winner, b.winner);
    const seen = new Set();
    for (let seed = 1; seed <= 6; seed++) {
        const st = createGame(world, { seed });
        let last = 0;
        for (let i = 0; i < 4000; i++) {
            // keep three columns marching so tractors and Mavics have targets
            if (i % 50 === 0) {
                for (const f of FACTIONS) {
                    const from = st.blocks.find(x => x.owner === f && x.troops >= 12);
                    if (from) command(world, st, f, { type: 'send', from: [from.id], to: (from.id + 7) % N, frac: 0.8 });
                }
            }
            step(world, st);
            for (const x of st.blocks) assert.ok(x.troops >= -1e-9, 'block troops');
            for (const g of st.groups) assert.ok(g.n >= 0.5, 'column size');
            for (const e of st.log) if (e.seq > last) { seen.add(e.type); last = e.seq; }
            if (st.winner) break;
        }
    }
    for (const type of Object.keys(RULES.events)) assert.ok(seen.has(type), `${type} fired`);
});

test('winning: last side standing, holding the share, the easing share and the time limit', () => {
    let st = blank(5);
    st.blocks.forEach(b => { b.owner = 'us'; });
    step(world, st);
    assert.equal(st.winner, 'us');
    assert.equal(st.winReason, 'last');

    assert.equal(holdShare(0), RULES.holdShare);
    assert.equal(holdShare(RULES.decayStart), RULES.holdShare);
    assert.ok(Math.abs(holdShare(RULES.timeLimit) - RULES.endShare) < 1e-9);
    assert.ok(Math.abs(holdShare((RULES.decayStart + RULES.timeLimit) / 2) - (RULES.holdShare + RULES.endShare) / 2) < 1e-9);

    st = blank(5);
    const need = Math.ceil(RULES.holdShare * N);
    st.blocks.forEach((b, i) => { b.owner = i < need ? 'cn' : i % 2 ? 'us' : 'ru'; });
    runUntil(st, () => st.winner, RULES.holdTime + 2);
    assert.equal(st.winner, 'cn');
    assert.equal(st.winReason, 'hold');
    assert.ok(st.t >= RULES.holdTime && st.t <= RULES.holdTime + 0.3);

    st = blank(5);
    st.blocks.forEach((b, i) => { b.owner = FACTIONS[i % 3]; });
    st.blocks[0].owner = 'ru';
    st.t = RULES.timeLimit - RULES.tick / 2;
    step(world, st);
    assert.equal(st.winReason, 'time');
    assert.equal(st.winner, 'ru', 'most blocks wins at the limit');
});

test('text: every log line fills its blanks', () => {
    const types = ['start', 'capture', 'clash', 'tractor', 'babusya', 'mud', 'mavic', 'upgrade', 'rally', 'win'];
    for (const type of types) {
        for (let seq = 0; seq < 8; seq++) {
            for (const other of [null, 'us']) {
                const line = eventLine({ type, seq, f: 'ru', other, n: 12, block: seq, track: seq % 3 });
                assert.ok(line.length > 5 && !/[{}]/.test(line), `${type}: ${line}`);
            }
        }
    }
    assert.equal(new Set(world.blocks.map(b => blockName(b.id))).size, N, 'unique block names');
    assert.deepEqual(Object.keys(SIDES), FACTIONS);
    assert.equal(UPGRADES.length, 3);
    assert.equal(neutralGarrison(0), RULES.neutralBase);
});

test('net: snapshots round-trip, guest commands are cleaned, PeerJS pin matches index.html', async () => {
    const { PEERJS, applySnapshot, cleanCommand, cleanName, encodeSnapshot } = await import('../js/3d/capture/net.js');
    const { readFileSync } = await import('node:fs');
    const st = playHeadless(world, { seed: 3, maxT: 120 });
    const snap = encodeSnapshot(st, () => 14);
    const json = JSON.parse(JSON.stringify(snap));             // what crosses the wire
    const m = applySnapshot(json);
    assert.equal(m.blocks.length, N);
    m.blocks.forEach((b, i) => {
        assert.equal(b.owner, st.blocks[i].owner);
        assert.ok(Math.abs(b.troops - st.blocks[i].troops) <= 0.051);
        assert.deepEqual(b.lv, st.blocks[i].lv);
    });
    assert.equal(m.groups.length, st.groups.length);
    m.groups.forEach((g, i) => {
        assert.equal(g.id, st.groups[i].id);
        assert.equal(g.f, st.groups[i].f);
        assert.ok(Math.abs(g.d - st.groups[i].d) <= 0.051);
        assert.equal(g.v, 14);
    });
    assert.ok(Math.abs(m.t - st.t) <= 0.051);
    assert.equal(m.log.at(-1).seq, st.log.at(-1).seq);
    assert.deepEqual(m.rally, st.rally, 'gathering points reach the guests');
    const again = applySnapshot(json, m);                        // the same log twice is not doubled
    assert.equal(again.log.length, m.log.length);

    assert.deepEqual(cleanCommand({ type: 'send', from: [1, 2], to: 3, frac: 0.5 }, N), { type: 'send', from: [1, 2], to: 3, frac: 0.5 });
    assert.deepEqual(cleanCommand({ type: 'upgrade', block: 4, track: 2, extra: 'x' }, N), { type: 'upgrade', block: 4, track: 2 });
    assert.deepEqual(cleanCommand({ type: 'rally', block: 5 }, N), { type: 'rally', block: 5 });
    assert.deepEqual(cleanCommand({ type: 'rally', block: null }, N), { type: 'rally', block: null });
    assert.equal(cleanCommand({ type: 'rally', block: N }, N), null);
    for (const bad of [null, 'send', { type: 'send', from: [1], to: N, frac: 0.5 }, { type: 'send', from: [1.5], to: 2, frac: 1 },
        { type: 'send', from: [], to: 2, frac: 1 }, { type: 'send', from: [1], to: 2, frac: 2 }, { type: 'upgrade', block: 1, track: 3 }, { type: 'nuke' }]) {
        assert.equal(cleanCommand(bad, N), null, JSON.stringify(bad));
    }
    assert.equal(cleanName('  <b>Bob</b>\n' + 'x'.repeat(40)).length, 24);
    assert.equal(cleanName(''), 'Guest');

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const tag = html.match(/<script src="(https:\/\/unpkg\.com\/peerjs@[^"]+)" integrity="([^"]+)"/);
    assert.ok(tag, 'index.html loads PeerJS');
    assert.equal(PEERJS.src, tag[1]);
    assert.equal(PEERJS.integrity, tag[2]);
});

test('field pack: presaved heights, OSM layers, buildings and lanes for the preset frame', async () => {
    const { readFileSync } = await import('node:fs');
    const { loadFieldPack } = await import('../js/3d/capture/field-pack.js');
    const meta = JSON.parse(readFileSync(new URL('../data/capture/field/field.json', import.meta.url), 'utf8'));
    const heights = new Int16Array(readFileSync(new URL('../data/capture/field/heights.bin', import.meta.url)).buffer.slice(0));
    assert.deepEqual(meta.frame, P.frame);
    assert.equal(meta.sceneSize, P.frame.size * 1000 + 1000, 'matches setSceneSize() in terrain.js');
    assert.equal(heights.length, (meta.grid + 1) ** 2);
    const metres = [...heights].map(v => v * meta.heightScale);
    assert.ok(Math.min(...metres) > 0 && Math.max(...metres) < 300, 'Mala Tokmachka sits 50–200 m up');
    const houses = meta.osm.features.filter(f => f.properties.building).length;
    assert.ok(houses > 3000, `${houses} buildings`);
    assert.ok(meta.osm.features.some(f => f.properties.waterway), 'the river');
    assert.ok(meta.roads.features.filter(f => f.properties.highway === 'residential').length > 200, 'village lanes');
    assert.match(meta.attribution, /OpenStreetMap/);
    assert.equal(await loadFieldPack({ lat: 48, lng: 37, size: 9.5, sceneSize: 10500 }), null, 'other frames load live');
});

test('gathering point: rear blocks send their spare troops, front blocks keep theirs', async () => {
    const { isFront } = await import('../js/3d/capture/sim.js');
    const st = blank(5);
    // the west end is ours; one enemy block next to it makes a front
    const mine = world.blocks.filter(b => b.x < world.blocks[A].x + 1500).map(b => b.id).filter(i => i < N - 3);
    for (const i of mine) Object.assign(st.blocks[i], { owner: 'us', troops: 40 });
    const enemy = mine.find(i => i !== A && world.routeLen(A, i) < 400) ?? mine[1];
    Object.assign(st.blocks[enemy], { owner: 'ru', troops: 40 });
    const own = mine.filter(i => i !== enemy);
    assert.equal(command(world, st, 'us', { type: 'rally', block: enemy }).ok, false, 'only on your own block');
    const rally = own.find(i => i !== A);
    assert.ok(command(world, st, 'us', { type: 'rally', block: rally }).ok);
    st.t = st.nextRally - RULES.tick;
    step(world, st);
    const fed = new Set(st.groups.filter(g => g.f === 'us').map(g => g.from));
    assert.ok(fed.size > 0, 'some blocks feed the gathering point');
    for (const g of st.groups.filter(g => g.f === 'us')) assert.equal(g.to, rally);
    for (const i of own) {
        if (i === rally) continue;
        if (isFront(world, st, i, 'us')) assert.ok(!fed.has(i), `front block ${i} keeps its troops`);
        else assert.ok(fed.has(i) && st.blocks[i].troops >= RULES.rallyKeep && st.blocks[i].troops < RULES.rallyKeep + 1, `rear block ${i} sent its spare`);
    }
    assert.ok(command(world, st, 'us', { type: 'rally', block: null }).ok);
    assert.equal(st.rally.us, null);
    command(world, st, 'us', { type: 'rally', block: rally });
    st.blocks[rally].owner = 'cn';                      // the gathering point falls
    st.t = st.nextRally - RULES.tick;
    step(world, st);
    assert.equal(st.rally.us, null, 'a lost gathering point is cleared');
});

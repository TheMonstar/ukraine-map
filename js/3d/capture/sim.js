// Capture Mala Tokmachka: the rules. Pure and deterministic: the same world, seed
// and commands give the same game, so the host is the only one who runs it and
// node tests can play whole matches headless.
//
// world = buildWorld(...) from streets.js (static); state = createGame(...) (all
// that changes). Every number that tunes the game lives in RULES or PERKS.

import { edgeAt } from './streets.js';

export const FACTIONS = ['us', 'cn', 'ru'];

export const RULES = {
    tick: 0.1,                 // s per step
    speed: 28,                 // m/s along the streets (cartoon fast: a neighbour is ~10 s away)
    prodBase: 0.2,             // troops/s of an owned block…
    prodPerHouse: 1 / 90,      // …plus this per house
    capBase: 20,
    capPerHouse: 0.6,
    overCapDecay: 0.02,        // share of the excess over cap lost per second
    neutralBase: 6,            // locals in a neutral block: base + houses × perHouse
    neutralPerHouse: 1 / 4,
    startTroops: 20,
    startMinApart: 2500,       // m by street between start blocks
    upgradeCost: [15, 30, 50], // troops of that block, per level bought
    maxLevel: 3,
    spawnProd: 0.5,            // per spawn level: production +50 %…
    spawnCap: 0.3,             // …and cap +30 %
    defPerLevel: 0.3,          // garrison strength per defence level
    atkPerLevel: 0.25,         // column strength per attack level of the block it left
    clashRange: 15,            // m: hostile columns this close on one street fight
    firstEvent: 75,
    eventGap: [30, 60],
    events: { tractor: 25, babusya: 30, mud: 15, mavic: 30 },
    mudSlow: 0.5,
    mudTime: 30,
    babusyaGift: 10,
    mavicShare: 0.3,
    mavicMin: 3,
    holdShare: 0.6,            // hold this share of blocks…
    holdTime: 20,              // …for this long to win
    decayStart: 300,           // from 5:00 the share eases…
    timeLimit: 780,            // …to endShare at 13:00, when the most blocks wins
    endShare: 0.5,
    rallyEvery: 3,             // s between deliveries to a gathering point
    rallyKeep: 5,              // troops a feeding block keeps at home
    rallyMin: 6,               // smallest column it sends
    rallyFront: 600,           // m by street: blocks this close to an enemy block keep their troops
};

// speed: march speed ×; prod: production ×; head: headcount × (production, cap, start,
// gifts); str: what one soldier is worth in a fight.
export const PERKS = {
    us: { speed: 1.45, prod: 1, head: 1, str: 1 },
    cn: { speed: 1, prod: 1.15, head: 1, str: 1 },
    ru: { speed: 1, prod: 1, head: 1.7, str: 0.65 },
};

/** Seeded uniform [0, 1) from the state's own mulberry32 stream. */
export function rand(st) {
    let t = (st.rng = (st.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const strOf = f => (f ? PERKS[f].str : 1);
export const defMult = lv => 1 + RULES.defPerLevel * lv;
export const atkMult = lv => 1 + RULES.atkPerLevel * lv;
export const neutralGarrison = houses => Math.round(RULES.neutralBase + houses * RULES.neutralPerHouse);

export function prodRate(world, st, i) {
    const b = st.blocks[i];
    if (!b.owner) return 0;
    const p = PERKS[b.owner];
    return (RULES.prodBase + world.blocks[i].houses * RULES.prodPerHouse) * (1 + RULES.spawnProd * b.lv[0]) * p.prod * p.head;
}

export function capOf(world, st, i) {
    const b = st.blocks[i];
    if (!b.owner) return neutralGarrison(world.blocks[i].houses);
    return (RULES.capBase + world.blocks[i].houses * RULES.capPerHouse) * (1 + RULES.spawnCap * b.lv[0]) * PERKS[b.owner].head;
}

export const marchSpeed = (st, f) => RULES.speed * PERKS[f].speed * (st.t < st.mudUntil ? RULES.mudSlow : 1);
export const upgradeCost = level => RULES.upgradeCost[level];

function pickWeighted(st, items, weight) {
    let total = 0;
    for (const it of items) total += weight(it);
    if (!(total > 0)) return null;
    let r = rand(st) * total;
    for (const it of items) {
        r -= weight(it);
        if (r < 0) return it;
    }
    return items[items.length - 1];
}

function log(st, ev) {
    st.log.push({ seq: ++st.seq, t: Math.round(st.t * 10) / 10, ...ev });
    if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
}

/** A fresh game: three sides on start blocks far apart by street, everything else local. */
export function createGame(world, { seed = 1 } = {}) {
    const st = {
        t: 0, tick: 0, rng: seed >>> 0, seq: 0, nextGroup: 1,
        blocks: world.blocks.map(b => ({ id: b.id, owner: null, troops: neutralGarrison(b.houses), lv: [0, 0, 0] })),
        groups: [], log: [],
        mudUntil: 0, nextEventAt: RULES.firstEvent,
        rally: Object.fromEntries(FACTIONS.map(f => [f, null])), nextRally: RULES.rallyEvery,
        hold: null, winner: null, winReason: null,
        stats: Object.fromEntries(FACTIONS.map(f => [f, { captured: 0, lost: 0, clashesWon: 0 }])),
    };
    const sorted = world.blocks.map(b => b.houses).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cand = world.blocks.filter(b => b.houses >= median).map(b => b.id);
    const starts = [cand[Math.floor(rand(st) * cand.length)]];
    while (starts.length < FACTIONS.length) {
        const gap = c => Math.min(...starts.map(s => world.routeLen(s, c)));
        const far = cand.filter(c => !starts.includes(c) && gap(c) >= RULES.startMinApart);
        starts.push(far.length ? far[Math.floor(rand(st) * far.length)]
            : cand.filter(c => !starts.includes(c)).reduce((a, c) => (gap(c) > gap(a) ? c : a)));
    }
    const order = [...FACTIONS];
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand(st) * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((f, k) => {
        const b = st.blocks[starts[k]];
        b.owner = f;
        b.troops = RULES.startTroops * PERKS[f].head;
        log(st, { type: 'start', f, block: b.id });
    });
    return st;
}

/** Apply one player's command. Commands from the network go through here too. */
export function command(world, st, f, cmd) {
    if (st.winner) return { ok: false, reason: 'game over' };
    if (!FACTIONS.includes(f) || !cmd || typeof cmd !== 'object') return { ok: false, reason: 'bad command' };
    const valid = i => Number.isInteger(i) && i >= 0 && i < st.blocks.length;
    if (cmd.type === 'send') {
        const from = [...new Set(Array.isArray(cmd.from) ? cmd.from : [cmd.from])];
        const frac = Number(cmd.frac);
        if (!valid(cmd.to) || !from.every(valid) || !(frac >= 0.05 && frac <= 1)) return { ok: false, reason: 'bad send' };
        let sent = 0;
        for (const i of from) {
            const b = st.blocks[i];
            if (b.owner !== f || i === cmd.to) continue;
            const n = Math.floor(b.troops * frac);
            if (n < 1) continue;
            b.troops -= n;
            st.groups.push({ id: st.nextGroup++, f, from: i, to: cmd.to, n, atk: atkMult(b.lv[2]), d: 0, lastE: -1, lastS: 0 });
            sent += n;
        }
        return sent ? { ok: true, sent } : { ok: false, reason: 'nobody to send' };
    }
    if (cmd.type === 'rally') {
        // a gathering point: your rear blocks keep sending it their troops (null clears it)
        if (cmd.block === null) {
            st.rally[f] = null;
            return { ok: true };
        }
        if (!valid(cmd.block) || st.blocks[cmd.block].owner !== f) return { ok: false, reason: 'not yours' };
        st.rally[f] = cmd.block;
        log(st, { type: 'rally', f, block: cmd.block });
        return { ok: true };
    }
    if (cmd.type === 'upgrade') {
        if (!valid(cmd.block) || ![0, 1, 2].includes(cmd.track)) return { ok: false, reason: 'bad upgrade' };
        const b = st.blocks[cmd.block];
        if (b.owner !== f) return { ok: false, reason: 'not yours' };
        const level = b.lv[cmd.track];
        if (level >= RULES.maxLevel) return { ok: false, reason: 'maxed' };
        const cost = upgradeCost(level);
        if (b.troops < cost) return { ok: false, reason: 'too few troops' };
        b.troops -= cost;
        b.lv[cmd.track] = level + 1;
        log(st, { type: 'upgrade', f, block: b.id, track: cmd.track, level: level + 1 });
        return { ok: true };
    }
    return { ok: false, reason: 'unknown command' };
}

function fight(st, a, b) {
    const sa = strOf(a.f) * a.atk, sb = strOf(b.f) * b.atk;
    const pa = a.n * sa, pb = b.n * sb;
    const [w, l, pw, pl, sw] = pa >= pb ? [a, b, pa, pb, sa] : [b, a, pb, pa, sb];
    // only big street fights make the log, at most one every few seconds
    if (Math.min(a.n, b.n) >= 15 && st.t - (st.lastClashLog ?? -99) >= 4) {
        st.lastClashLog = st.t;
        log(st, { type: 'clash', f: w.f, other: l.f, n: Math.round(l.n), block: l.to });
    }
    if (pw > pl) st.stats[w.f].clashesWon++;
    w.n = (pw - pl) / sw;
    l.n = 0;
}

function arrive(st, g) {
    const b = st.blocks[g.to];
    if (b.owner === g.f) {
        b.troops += g.n;
        return;
    }
    const sa = strOf(g.f) * g.atk;
    const sd = strOf(b.owner) * defMult(b.lv[1]);
    const attack = g.n * sa, defence = b.troops * sd;
    if (attack > defence) {
        const prev = b.owner;
        b.owner = g.f;
        b.troops = (attack - defence) / sa;
        b.lv = b.lv.map(l => Math.max(0, l - 1));
        st.stats[g.f].captured++;
        if (prev) st.stats[prev].lost++;
        log(st, { type: 'capture', f: g.f, other: prev, block: b.id });
    } else {
        b.troops = (defence - attack) / sd;
    }
}

/** Is block i (owned by f) close to an enemy block, so it should keep its troops? */
export function isFront(world, st, i, f) {
    for (const o of st.blocks) {
        if (o.owner && o.owner !== f && world.routeLen(i, o.id) < RULES.rallyFront) return true;
    }
    return false;
}

// gathering points: every few seconds each side's rear blocks send their spare troops there
function feedRallies(world, st) {
    for (const f of FACTIONS) {
        const r = st.rally[f];
        if (r == null) continue;
        if (st.blocks[r].owner !== f) {      // the gathering point fell
            st.rally[f] = null;
            continue;
        }
        for (const b of st.blocks) {
            if (b.owner !== f || b.id === r || isFront(world, st, b.id, f)) continue;
            const n = Math.floor(b.troops - RULES.rallyKeep * PERKS[f].head);
            if (n < RULES.rallyMin) continue;
            b.troops -= n;
            st.groups.push({ id: st.nextGroup++, f, from: b.id, to: r, n, atk: atkMult(b.lv[2]), d: 0, lastE: -1, lastS: 0 });
        }
    }
}

function fireEvent(world, st) {
    const owned = Object.fromEntries(FACTIONS.map(f => [f, 0]));
    for (const b of st.blocks) if (b.owner) owned[b.owner]++;
    const type = pickWeighted(st, Object.keys(RULES.events), k => RULES.events[k]);
    if (type === 'tractor') {
        const g = pickWeighted(st, st.groups.filter(x => x.n >= 4), x => 1 + owned[x.f]);
        if (g) {
            log(st, { type, f: g.f, n: Math.round(g.n), block: g.to });
            g.n = 0;
            return;
        }
    } else if (type === 'mavic') {
        const g = pickWeighted(st, st.groups.filter(x => x.n >= 6), x => (1 + owned[x.f]) ** 2);
        if (g) {
            const lost = Math.min(g.n, Math.max(RULES.mavicMin, Math.round(g.n * RULES.mavicShare)));
            g.n -= lost;
            log(st, { type, f: g.f, n: lost, block: g.to });
            return;
        }
    } else if (type === 'babusya') {
        const b = pickWeighted(st, st.blocks.filter(x => x.owner), x => 1 / (1 + owned[x.owner]));
        if (b) {
            const gift = RULES.babusyaGift * PERKS[b.owner].head;
            b.troops += gift;
            log(st, { type, f: b.owner, n: gift, block: b.id });
            return;
        }
    }
    if (st.t >= st.mudUntil) {  // mud, or the fallback when nobody fits the event
        st.mudUntil = st.t + RULES.mudTime;
        log(st, { type: 'mud' });
    }
}

/** Share of blocks needed to start the hold clock at time t. */
export function holdShare(t) {
    if (t <= RULES.decayStart) return RULES.holdShare;
    const k = Math.min(1, (t - RULES.decayStart) / (RULES.timeLimit - RULES.decayStart));
    return RULES.holdShare + (RULES.endShare - RULES.holdShare) * k;
}

/** Sides by blocks, then troops (in blocks and on the march). */
export function standings(st) {
    const rows = Object.fromEntries(FACTIONS.map(f => [f, { f, blocks: 0, troops: 0 }]));
    for (const b of st.blocks) if (b.owner) { rows[b.owner].blocks++; rows[b.owner].troops += b.troops; }
    for (const g of st.groups) rows[g.f].troops += g.n;
    return Object.values(rows)
        .map(r => ({ ...r, alive: r.blocks > 0 || r.troops >= 1 }))
        .sort((a, b) => b.blocks - a.blocks || b.troops - a.troops || FACTIONS.indexOf(a.f) - FACTIONS.indexOf(b.f));
}

function checkWin(st) {
    const rows = standings(st);
    const alive = rows.filter(r => r.alive);
    const win = (f, reason) => {
        st.winner = f;
        st.winReason = reason;
        log(st, { type: 'win', f, reason });
    };
    if (alive.length <= 1) return win(alive[0]?.f ?? rows[0].f, 'last');
    const lead = rows[0];
    if (lead.blocks / st.blocks.length >= holdShare(st.t) && lead.blocks > rows[1].blocks) {
        if (!st.hold || st.hold.f !== lead.f) st.hold = { f: lead.f, since: st.t };
        else if (st.t - st.hold.since >= RULES.holdTime) return win(lead.f, 'hold');
    } else {
        st.hold = null;
    }
    if (st.t >= RULES.timeLimit) win(lead.f, 'time');
}

/** One fixed 0.1 s tick: production → marching and street clashes → arrivals → events → win check. */
export function step(world, st) {
    if (st.winner) return;
    const dt = RULES.tick;
    st.t = Math.round((st.t + dt) * 1000) / 1000;
    st.tick++;

    st.blocks.forEach((b, i) => {
        if (!b.owner) return;
        const cap = capOf(world, st, i);
        if (b.troops < cap) b.troops = Math.min(cap, b.troops + prodRate(world, st, i) * dt);
        else b.troops -= (b.troops - cap) * RULES.overCapDecay * dt;
    });

    if (st.t >= st.nextRally) {
        feedRallies(world, st);
        st.nextRally = st.t + RULES.rallyEvery;
    }

    const onEdge = new Map();
    for (const g of st.groups) {
        g.d += marchSpeed(st, g.f) * dt;
        const r = world.route(g.from, g.to);
        if (g.d >= r.len) continue;
        const { e, s } = edgeAt(r, g.d);
        g.e = e;
        g.s = s;
        if (!onEdge.has(e)) onEdge.set(e, []);
        onEdge.get(e).push(g);
    }
    for (const [e, list] of onEdge) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j];
                if (a.f === b.f || a.n <= 0 || b.n <= 0) continue;
                const near = Math.abs(a.s - b.s) < RULES.clashRange;
                const crossed = a.lastE === e && b.lastE === e && Math.sign(a.lastS - b.lastS) * Math.sign(a.s - b.s) < 0;
                if (near || crossed) fight(st, a, b);
            }
        }
    }
    for (const g of st.groups) {
        g.lastE = g.e ?? -1;
        g.lastS = g.s ?? 0;
    }
    st.groups = st.groups.filter(g => g.n >= 0.5);

    const arrived = st.groups.filter(g => g.d >= world.route(g.from, g.to).len);
    if (arrived.length) {
        for (const g of arrived) arrive(st, g);
        st.groups = st.groups.filter(g => g.d < world.route(g.from, g.to).len);
    }

    if (st.t >= st.nextEventAt) {
        fireEvent(world, st);
        st.groups = st.groups.filter(g => g.n >= 0.5);
        st.nextEventAt = st.t + RULES.eventGap[0] + rand(st) * (RULES.eventGap[1] - RULES.eventGap[0]);
    }
    checkWin(st);
}

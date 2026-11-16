// Capture Mala Tokmachka: computer players. Pure: think() reads the state and
// returns commands; the host (or a headless test) applies them through
// sim.command like anyone else's.

import { FACTIONS, PERKS, RULES, atkMult, capOf, command, createGame, defMult, marchSpeed, prodRate, step, upgradeCost } from './sim.js';

// attacks: targets per think; overwhelm: share of the sources' spare troops an attack takes
// at least; funnel: rear blocks near their cap feed the front
export const AI_LEVELS = {
    easy: { every: 4, margin: 1.5, attacks: 1, overwhelm: 0, upgrades: false, defend: false, funnel: false },
    normal: { every: 2.5, margin: 1.2, attacks: 2, overwhelm: 0.5, upgrades: true, defend: false, funnel: true },
    hard: { every: 1.5, margin: 1.1, attacks: 3, overwhelm: 0.6, upgrades: true, defend: true, funnel: true },
};

const KEEP = 3;            // troops a source keeps at home
const REACH = 2500;        // m by street: farthest source used
const MAX_SOURCES = 4;
const FRONT = 900;         // m by street: a block this close to an enemy block is "front"

/** Troops side f must send to take block `to` after `travel` seconds (its own columns already en route count). */
export function estimateNeed(world, st, f, to, travel = 0) {
    const b = st.blocks[to];
    if (b.owner === f) return 0;
    let troops = b.troops;
    if (b.owner) troops = Math.max(troops, Math.min(capOf(world, st, to), troops + prodRate(world, st, to) * travel));
    let power = troops * (b.owner ? PERKS[b.owner].str : 1) * defMult(b.lv[1]);
    for (const g of st.groups) if (g.to === to && g.f === f) power -= g.n * PERKS[f].str * (g.atk ?? 1);
    return Math.max(0, power / PERKS[f].str);
}

/** Commands side f wants to give now. */
export function think(world, st, f, levelName = 'normal') {
    const level = AI_LEVELS[levelName] || AI_LEVELS.normal;
    const mine = st.blocks.filter(b => b.owner === f);
    if (!mine.length || st.winner) return [];
    const cmds = [];
    const spare = new Map(mine.map(b => [b.id, Math.max(0, Math.floor(b.troops) - KEEP)]));

    if (level.defend) {
        for (const b of mine) {
            let threat = 0;
            for (const g of st.groups) if (g.to === b.id && g.f !== f) threat += g.n * PERKS[g.f].str * g.atk;
            const hold = b.troops * PERKS[f].str * defMult(b.lv[1]);
            if (threat <= hold) continue;
            const helper = mine
                .filter(s => s.id !== b.id && spare.get(s.id) >= 5 && world.routeLen(s.id, b.id) < REACH / 2)
                .sort((p, q) => world.routeLen(p.id, b.id) - world.routeLen(q.id, b.id))[0];
            if (!helper) continue;
            const n = Math.min(spare.get(helper.id), Math.ceil((threat - hold) / PERKS[f].str) + 2);
            spare.set(helper.id, spare.get(helper.id) - n);
            cmds.push({ type: 'send', from: [helper.id], to: b.id, frac: Math.min(1, (n + 0.5) / helper.troops) });
        }
    }

    const speed = marchSpeed(st, f);
    const targeted = new Set();
    let attacked = 0;
    for (let k = 0; k < level.attacks; k++) {
        let best = null;
        for (const t of st.blocks) {
            if (t.owner === f || targeted.has(t.id)) continue;
            const sources = mine
                .filter(s => spare.get(s.id) > 0 && world.routeLen(s.id, t.id) <= REACH)
                .sort((p, q) => world.routeLen(p.id, t.id) - world.routeLen(q.id, t.id))
                .slice(0, MAX_SOURCES);
            if (!sources.length) continue;
            const dist = world.routeLen(sources[0].id, t.id);
            const need = estimateNeed(world, st, f, t.id, dist / speed) * level.margin + 1;
            if (need <= 1) continue;          // our columns already have it covered
            let have = 0;
            for (const s of sources) have += spare.get(s.id) * atkMult(s.lv[2]);
            if (have < need) continue;
            const houses = world.blocks[t.id].houses;
            const score = (houses + 20) / (need + 10) / (1 + dist / 800) * (t.owner ? 1.3 : 1);
            if (!best || score > best.score) best = { t, sources, need, score };
        }
        if (!best) break;
        targeted.add(best.t.id);
        attacked++;
        // overwhelm rather than trickle: at least half of what the sources can spare,
        // so the block is held after it falls and fewer small columns die in the lanes
        let pool = 0;
        for (const s of best.sources) pool += spare.get(s.id) * atkMult(s.lv[2]);
        let left = Math.max(best.need, level.overwhelm * pool);
        for (const s of best.sources) {
            if (left <= 0) break;
            const power = atkMult(s.lv[2]);
            const n = Math.min(spare.get(s.id), Math.ceil(left / power));
            if (n < 1) continue;
            left -= n * power;
            spare.set(s.id, spare.get(s.id) - n);
            cmds.push({ type: 'send', from: [s.id], to: best.t.id, frac: Math.min(1, (n + 0.5) / s.troops) });
        }
    }

    const enemyNear = new Map(mine.map(b => [b.id,
        st.blocks.some(o => o.owner && o.owner !== f && world.routeLen(b.id, o.id) < FRONT)]));
    if (level.funnel) {
        // rear blocks sitting at their cap send the surplus to the nearest front block
        // fronts already holding a big stack get no more
        const fronts = mine.filter(b => enemyNear.get(b.id) && b.troops < 3 * capOf(world, st, b.id));
        let fed = 0;
        for (const b of mine) {
            if (fed >= 2 || !fronts.length || enemyNear.get(b.id)) continue;
            if (b.troops < 0.8 * capOf(world, st, b.id) || spare.get(b.id) < 8) continue;
            const to = fronts.reduce((p, q) => (world.routeLen(b.id, q.id) < world.routeLen(b.id, p.id) ? q : p));
            const n = Math.floor(spare.get(b.id) * 0.7);
            spare.set(b.id, spare.get(b.id) - n);
            cmds.push({ type: 'send', from: [b.id], to: to.id, frac: Math.min(1, (n + 0.5) / b.troops) });
            fed++;
        }
    }

    if (!attacked && level.upgrades) {
        const nearEnemy = b => enemyNear.get(b.id);
        for (const b of mine) {
            const cap = capOf(world, st, b.id);
            const track = nearEnemy(b) ? 1 : 0;
            const lv = b.lv[track];
            if (lv >= RULES.maxLevel || b.troops < 0.7 * cap || b.troops < upgradeCost(lv) + KEEP) continue;
            cmds.push({ type: 'upgrade', block: b.id, track });
            break;
        }
    }
    return cmds;
}

/** A whole game with computer players only (tests, balance runs). */
export function playHeadless(world, { seed = 1, levels = {}, maxT = RULES.timeLimit + 5 } = {}) {
    const st = createGame(world, { seed });
    const lv = Object.fromEntries(FACTIONS.map(f => [f, levels[f] || 'normal']));
    const timer = Object.fromEntries(FACTIONS.map((f, i) => [f, AI_LEVELS[lv[f]].every * (i + 1) / FACTIONS.length]));
    while (!st.winner && st.t < maxT) {
        for (const f of FACTIONS) {
            timer[f] -= RULES.tick;
            if (timer[f] > 0) continue;
            timer[f] += AI_LEVELS[lv[f]].every;
            for (const c of think(world, st, f, lv[f])) command(world, st, f, c);
        }
        step(world, st);
    }
    return st;
}

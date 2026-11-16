// Capture Mala Tokmachka: whole AI-vs-AI games as a balance guard.
// CAPTURE_SEEDS=200 node --test tests/capture-ai.test.mjs for a tuning run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MALA_TOKMACHKA as P } from '../js/3d/capture/mala-tokmachka.js';
import { makeProjection } from '../js/3d/geo.js';
import { buildWorld } from '../js/3d/capture/streets.js';
import { FACTIONS, RULES } from '../js/3d/capture/sim.js';
import { playHeadless } from '../js/3d/capture/ai.js';

const world = buildWorld(P, makeProjection(P.frame.lat, P.frame.lng).toLocal);
const SEEDS = Number(process.env.CAPTURE_SEEDS || 40);

test(`three normal AIs: games end on time with a fair spread of winners (${SEEDS} seeds)`, () => {
    const wins = Object.fromEntries(FACTIONS.map(f => [f, 0]));
    const minutes = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
        const st = playHeadless(world, { seed });
        assert.ok(st.winner, `seed ${seed} has a winner`);
        assert.ok(st.t <= RULES.timeLimit + RULES.tick, `seed ${seed} ended by the limit`);
        for (const b of st.blocks) assert.ok(Number.isFinite(b.troops) && b.troops >= 0);
        wins[st.winner]++;
        minutes.push(st.t / 60);
    }
    minutes.sort((a, b) => a - b);
    const median = minutes[minutes.length >> 1];
    assert.ok(median >= 6 && median <= 11, `median game ${median.toFixed(1)} min`);
    for (const f of FACTIONS) {
        const share = wins[f] / SEEDS;
        assert.ok(share >= 0.15 && share <= 0.5, `${f} wins ${(share * 100).toFixed(0)}%`);
    }
});

test('a hard AI beats two easy ones most of the time, whichever side it plays', () => {
    let won = 0, games = 0;
    for (const f of FACTIONS) {
        const levels = Object.fromEntries(FACTIONS.map(x => [x, x === f ? 'hard' : 'easy']));
        for (let seed = 1; seed <= 15; seed++) {
            if (playHeadless(world, { seed, levels }).winner === f) won++;
            games++;
        }
    }
    assert.ok(won / games >= 0.6, `hard won ${won}/${games}`);
});

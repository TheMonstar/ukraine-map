# FRONTLINE Hex Game — Improvement Plan (for a separate implementation session)

> **Status (2026-06-12): ALL 4 PHASES + UX/BALANCE ROUND IMPLEMENTED.** UX round (same day): card action buttons replaced by a docked `#action-bar`; drones fly (flat move cost 1); minimum-move rule (always 1 adjacent hex); move-cost labels on the highlighted range; terrain hover chip + `?` rules/legend overlay (terrain, zones, ISR, action costs, dice); 👁 spotted / 🎯 marked badges; `STATUS_LABELS` key-case bug fixed. New units: ua_vampire & ru_heavy_drone (heavy bombers), ua_ugv_miner & ru_zemledeliye (remote miners, `remote_mine`/`mine_volley` skills). Economy: AP 8, move = 1 AP flat (AI mirrored), crits (nat 6) pierce saves. Balance (via `FRONTLINE_DEV.autoBattle` headless AI-vs-AI sims): Shtorm-Z 2→3 RP, decisive-lead end 25→30 VP, UA +3 starting CP (NATO C2) — pooled faction winrate ~50/50 over 80 matches (was 70% RU), tanks mid-table with 50–75% death rates (were near-unkillable). Sim caveat: greedy harness under-uses UA special orders, so UA may be slightly stronger in human play than sims show. fitBounds is now deferred + self-healing on resize.
>
> **Real-front hexagonal battlefield (2026-06-13):** the board is now a radius-7 hexagon (~162 hexes) centred on the chosen point; each hex is classified UA/RU-side from the real territory-control GeoJSON (`TerrainLoader.classifyFront`, cached via `TerrainLoader.fetchControlGeo`, fills `#a52714`/`#880e4f` = occupied); the real front renders as a red dashed line; spawn bands hug the front at distance 2–3 (2-hex no-man's-land), supply traces to the board-rim rear (`getRearHexIds` — also fixed a pre-existing bug where supply compared `'player'` to `'ua'` and always traced to AI spawn), breakthrough = entering the enemy rim, forward positions = enemy hexes ≥4 from the front. "Random Frontline Point" samples the occupied-polygon boundary with a 4-probe balance test. Presets were replaced with 6 named front axes (Kupiansk/Lyman/Kostiantynivka/Pokrovsk/Zaporizhzhia/Kherson) that auto-snap at setup load to the nearest balanced point on the live front within ~50 km (`ui._refreshPresetButtons` / `_frontCandidates`, sampling ALL occupied polygons — the northern front lives in separate polygons from the main one); unsnapped anchors keep their coords and fall back to the synthetic front with a log note. RU free tokens (Mobilization Wave, surge events) now arrive in the rear. **Edge deployment (later 2026-06-13):** armies now deploy on opposing BOARD EDGES oriented by the front, not hugging the line — `getSpawnHexIds` picks own-side rim hexes (frontDist≥2, nearest rim) so e.g. at Pokrovsk UA=NW corner, RU=SE corner (verified). Front line now renders via `turf.polygonToLine` clipped to bbox (LineString) — fixes the stray dashed-rectangle frame `bboxClip` on the polygon drew. Presets snap with board-scale probes (±16 km, 2/4 inside the union) so a preset predicts the real on-board split instead of a local notch. **Known follow-up**: at dense urban frontline points (e.g. snapped Pokrovsk 48.33/37.22) the OSM settlement classifier over-matches — 115/162 hexes flagged settlement-objective because `_classifyFromOSM` uses a residential way's BBOX (covers a ~15 km urban agglomeration) instead of true point-in-polygon; carpets the map with objective markers and flattens VP. Fix = assemble residential way polygons from node coords and use `booleanPointInPolygon` for settlements. **Root-cause balance fix**: procedural terrain noise had a fixed phase that always clustered settlements on the north (RU) side (~12 vs 4 objectives) — random per-board phase added; synthetic front also splits at the median hex latitude. Post-fix sims: 52% RU over 60 matches, objectives 11.5/10.2.
>
> **Combat visibility (2026-06-13):** on-screen battle log panel (collapsible, top-right over map, turn-stamped, enemy attacks in red with dice breakdowns, kills highlighted); every AI attack now logs and flashes the target hex; all unit deaths (any damage path, both sides) are recorded in `state.fallenUnits` via `_recordNewDeaths()` in `_notify` and rendered as persistent ✕ markers at the loss position with name/turn tooltip.
>
> **Phase 4 notes:** Phase 4 notes: 9 active skills (`ACTIVE_SKILLS` in cards.js) across 18 units, dispatched via `GameEngine.useUnitSkill`/`_executeSkill` with per-unit `skillCd`; commander cards replaced by 2 doctrines per faction (`DOCTRINES`) — army passive + 3-charge active (CD 5), picked at setup (AI follows its battlegroup); the formerly dead `wave_bonus`/`human_wave_aura`/`flanking_bonus`/`_humanWaveBonus` flags are now implemented in the dice pipeline; Commander's Resolve event grants +1 charge instead of resetting commanders. AI uses doctrine actives (trigger per doctrine) and skills (canister/smoke/illumination/exfil/mark — dash/scoot/sabotage/resupply have no AI triggers yet). Still open: engine-side overwatch-on-move uses the old flat formula; AI dice results not surfaced in UI; statuses tick twice per full turn (after each side's phase — pre-existing).
>
> **Phase 3 notes:** Phase 3 notes: dice pipeline lives in `combat.js` (`_attackParams` / `_rollDice` / `_saveTarget` / `previewAttack`); simulation via `FRONTLINE_DEV.simulate()` shows heavy matchups within ±22% of the old formula while formerly useless 1-dmg attacks gain ~+67% by design (variance compression). One-shot munitions (FPV) are now expended even on a whiff. Overwatch return fire and area attacks use the same dice pipeline; the engine-side overwatch-on-move in `game-engine.js _checkOverwatchTriggers` is still the old flat formula (convert in Phase 4 if it matters). AI dice results are not surfaced in the UI (engine never logged AI attack results — pre-existing). Extra fix: eliminations from event-deck damage now end the match (`_advanceTurn` victory catch-all).
>
> **Phase 2 notes:** Phase 2 notes: board is ~158 hexes at 35×30 km (turf hexGrid yields slightly fewer than the ~190 estimate); AI turns run in ~10 ms. Extra fixes: OSM settlement classification dropped its 1.2 km bbox pad (villages were smearing into 3×3 hex blobs — 126/158 hexes classified as settlements); new `key_position` objective type (2 VP/turn) guarantees an objective per map third; map view now fits the whole battlefield via fitBounds; stale veteran-promotion overlays are cleared on New Game.
>
> **Phase 1 notes:** Deviations: the "first to 10/15 VP" rule never existed in code — replaced with a decisive-lead early end (lead ≥ 25 from turn 10). Wave Bonus / Human Wave Aura stacking fix was moot: those abilities (and `flanking_bonus`, `_humanWaveBonus`) are tooltip-only flags never read by combat — left as-is, candidates for Phase 4. Extra VP-economy bugs found and fixed: VP was scored twice per turn; order/loitering kills awarded no kill VP and skipped the victory check; the AI earned forward-position VP for garrisoning its own rear.

## Context

`game/game.html` is a turn-based hex wargame on real Ukraine frontline terrain (OSM data, Leaflet + Turf hexes). It is feature-rich (40 unit cards, orders, events, statuses, AI postures) but the user finds it **repetitive and unbalanced**. Agreed direction:

- **Warhammer element**: replace deterministic combat with **dice-roll combat** (visible probabilities, drama).
- **Scale**: ~2x — bigger battlefield (~180–200 hexes) and bigger unit budget (35–40 RP).
- **Priority**: fix balance + match variety first; new systems after.
- Unit/commander **active & passive skills** (from the original request) come as a later phase.

### Why it feels repetitive / unbalanced (diagnosis)

1. **Fixed preset decks + fixed 20 RP** → every match fields nearly the same army.
2. **~88-hex board with 4 AP/turn** → no flanks or reserves; combat collapses into one central scrum around the same settlement objectives.
3. **Deterministic damage** (`max(0, ATK+mods − DEF+mods)`) → fights are pre-solved; high-DEF units (T-90M DEF 6) are immune to most attackers, 0-damage attacks feel pointless.
4. **VP economy favors static play**: settlements 1–2 VP/turn, forward position 3 VP/turn vs kill VP of 0/1/3 → camp objectives, ignore maneuver.
5. **Stacking modifiers without caps**: artillery miss chance can hit 80%; FPV+anti-armor trivializes armor; RU wave bonuses stack with aura.
6. **AI** activates units sorted by raw ATK and uses commander only as a desperation move — predictable.

### Key files

| File | Role |
|---|---|
| `game/js/cards.js` | All unit/order/event stat tables (CARD_CATALOG, ORDERS_CATALOG, terrain rules) |
| `game/js/combat.js` | `resolveAttack` damage formula, statuses, veteran progression |
| `game/js/board.js` | Hex grid generation (Turf hexGrid, 1.5 km cells), spawn zones, distance |
| `game/js/game-engine.js` | Turn flow, AP/CP/VP economy, deployment, constants (TOTAL_RP=20, AP=4, 20 turns, 10 VP) |
| `game/js/ai.js` | Threat scoring, posture, action selection |
| `game/js/ui.js` | Leaflet render, cards, HUD |
| `game/js/terrain-loader.js` | OSM Overpass terrain, procedural fallback |

---

## Phase 1 — Balance & match variety (core loop must be fun first)

### 1a. VP economy rework (`game-engine.js`, `cards.js`)
- Kill VP: C=1, U=2, R=4 (currently 0/1/3) — make attrition a real path to victory.
- Objective hold VP: S1 settlement 1/turn (keep), S2 2/turn (keep), **forward position 3 → 2/turn** and make it contestable (reverts to neutral if an enemy unit is adjacent and uncontested).
- Victory threshold scales with new economy: **first to 15 VP** (raise from 10) or highest at turn 20.
- Add **"breakthrough" VP**: +2 one-time for first friendly unit to enter the enemy rear zone (rewards maneuver).

### 1b. Modifier caps & outlier fixes (`combat.js`, `cards.js`)
- Cap total ATK bonuses at +3 and total DEF bonuses at +3 (terrain + fortify + auras).
- Cap artillery miss chance at 50% (currently stacks to 80%).
- Reactive Armor (T-90M): halve first hit **per turn** instead of once per match — keeps it strong but not binary; in exchange reduce DEF 6 → 5.
- FPV Anti-Armor +3 → +2; FPV RP cost 4 → 5 for UA (it deletes any vehicle for 4 RP today).
- RU Wave Bonus and Human Wave Aura no longer stack (take the better one).
- Audit pass: print expected damage of every attacker vs every defender class in a console table (small dev script in `combat.js` behind a flag) and flatten anything that is 0 or one-shots.

### 1c. Match variety without full free army building (`cards.js`, `game-engine.js`, setup UI in `ui.js`/`game.html`)
- Replace the single locked preset with **3 selectable battlegroups per faction** (e.g., UA: Mech Fist / Drone War / Defensive Line; RU: Armor Spearhead / Mass Assault / Fires Group). Each is a themed RP-legal list from the existing catalog — no new cards needed.
- After picking a battlegroup, draw **2 random reserve cards** from the faction catalog (excluded duplicates) — small roguelite spice per match.
- AI also picks a random battlegroup; AI posture seeds from its battlegroup (Fires Group → defensive/artillery-heavy, etc.).

### 1d. AI variety (`ai.js`)
- Activation order: sort by threat-score contribution, not raw ATK.
- Commander use: trigger on opportunity (e.g., ISR-spotted R-tier target) rather than only when losing at turn ≥ 15.
- Add per-match random "doctrine" weight (±20% on aggression in `_posture`) so two matches on the same map play differently.

**Verify**: play 2–3 matches per faction (Normal AI). Checks: armies differ between matches; no unit is auto-include or never-picked; matches end by both VP race and turn limit; no 0-damage stalemate units.

## Phase 2 — 2x scale (`board.js`, `game-engine.js`, `terrain-loader.js`, `ai.js`)

- Battlefield 25×20 km → **35×30 km**; keep 1.5 km hex side → ~190–200 hexes. Verify Leaflet/Turf render perf (full redraw of ~200 GeoJSON polygons is fine; keep the existing single `_renderAll`).
- **TOTAL_RP 20 → 36**, MAX CP 8 → 10, **player AP 4 → 6/turn** (AI budget scales via existing `difficultyFactor`: 5/6/7).
- Turn limit 20 → 24; turn timer 20s → 30s (more units to move).
- Objectives: guarantee **3+ spread objectives** (settlement clusters, bridge, road junction) across the wider map in `terrain-loader.js` so fronts form in multiple places; widen spawn zones along the full north/south edges.
- AI: BFS pathfinding currently limits 4 hexes lookahead — raise to 6 and make the AI commit unit *groups* to the nearest objective (assign each AI unit an objective at deploy, re-evaluate every 4 turns) so it doesn't smear across the bigger map.
- Stack limits unchanged (terrain-based) — bigger board naturally spreads forces.

**Verify**: turn render + AI turn completes < 2 s on a 200-hex board; AI contests at least 2 objectives per match; deployment UI handles ~14–18 units without overflow (card hand may need horizontal scroll in `game.css`).

## Phase 3 — Dice-roll combat, Warhammer-style (`combat.js`, `ui.js`)

Replace `damage = max(0, ATK − DEF)` with a roll pipeline (keep all existing modifiers, but they now move thresholds instead of adding flat damage):

1. **Attack dice**: attacker rolls **d6 per ATK point** (after ATK modifiers, capped per 1b).
2. **To-hit**: base 4+; veteran/flank/ISR-spotted −1 (3+); suppressed/night(RU)/EW +1 (5+). Clamp 2+..6+.
3. **Save**: defender saves each hit on `7 − min(DEF_total, 5)`+, where DEF_total = unit DEF tier (0–3, derived: DEF 0–1→0, 2–3→1, 4–5→2, 6→3) + terrain DEF + fortify. Clamp 2+..6+. Ambush/Precision = no save.
4. **Damage**: each unsaved hit = 1 HP. A natural 6 to-hit that also wounds = 2 HP ("crit") and applies Suppressed.
5. **One-shot/area weapons** keep their special rules; area attacks roll 3 dice per affected hex.

Tuning rule: expected damage should land near the old deterministic values for the common matchups (the 1b console table makes before/after comparison directly checkable) — this is a variance change, not a power rebalance.

UI (`ui.js`):
- **Pre-attack probability preview** on target hover: hit%, expected damage, kill% — the Warhammer "do the math" moment.
- **Dice tray animation** in the combat log: show rolled dice, hits, saves (simple DOM chips, no canvas needed; reuse the event-popup pattern).
- Combat log line: "FPV Operator: 5 dice → 3 hits → 1 saved → 2 dmg (1 crit)".

**Verify**: scripted simulation (dev flag) runs 1,000 resolutions of 5–6 canonical matchups and asserts mean damage within ±20% of old formula; manual play confirms preview percentages match observed outcomes.

## Phase 4 — Active & passive skills for units and commander (`cards.js`, `combat.js`, `game-engine.js`, `ui.js`)

Formalize the existing 42 ability flags into a skill framework rather than inventing parallel content:

- **Schema**: each card gets `passive: [...]` (always-on, already mostly exists as flags) and `active: { id, cooldown, apCost, effect }` (new). Migrate existing one-off abilities that are really actives (Shoot & Scoot, Exfil, Sabotage, FPV Intercept) into the `active` slot with cooldowns instead of bespoke checks scattered through `combat.js`/`game-engine.js`.
- **One new active per ~10 key units** (not all 40), e.g.: Tank "Canister Shot" (1-hex AoE 2 dice, CD 3), Sniper "Mark Target" (target −1 save, CD 2), IFV "Smoke Screen" (adjacent hex blocks LOS 1 turn, CD 3), Mortar "Illumination" (negate night penalty radius 3, CD 2).
- **Commander becomes a 3-charge ability kit** instead of one once-per-match button: pick 1 of 2 doctrines at setup (UA: Precision vs Resilience; RU: Mass vs Fires), each with one active (CD 5) + one army-wide passive. Commander stays off-map (no hero unit — out of scope per user choice).
- UI: active-skill button on the unit info sidebar with cooldown pips; AI gets simple triggers per skill (use when condition met, e.g., Smoke when HP < 40%).

**Verify**: each new active usable exactly per its cooldown; AI uses at least some actives in a test match; no regression in existing ability flags (re-run Phase 3 simulation).

---

## Sequencing & scope notes

- Phases are independent enough to ship one per session in order 1 → 2 → 3 → 4. Phase 1 alone should already noticeably reduce repetitiveness.
- No build step exists — all changes are plain ES6 in `game/js/*`; test by `python3 -m http.server 8080` and opening `game/game.html`.
- Out of scope (explicitly not chosen by user): free-form army building, commander as on-map hero unit, persistent meta-progression between matches.

## End-to-end verification (per session)

1. `python3 -m http.server 8080`, open `http://localhost:8080/game/game.html`.
2. Play one full match per faction at Normal; confirm victory screen reachable both by VP and turn limit.
3. Console clean of errors during deploy, combat, AI turn, and event resolution.
4. Use the dev simulation flag (added in 1b/3) for combat-math regression checks.

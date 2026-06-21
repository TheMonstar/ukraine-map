# FRONTLINE Hex Game — Improvement Plan (for a separate implementation session)

> **Status (2026-06-12): ALL 4 PHASES + UX/BALANCE ROUND IMPLEMENTED.** UX round (same day): card action buttons replaced by a docked `#action-bar`; drones fly (flat move cost 1); minimum-move rule (always 1 adjacent hex); move-cost labels on the highlighted range; terrain hover chip + `?` rules/legend overlay (terrain, zones, ISR, action costs, dice); 👁 spotted / 🎯 marked badges; `STATUS_LABELS` key-case bug fixed. New units: ua_vampire & ru_heavy_drone (heavy bombers), ua_ugv_miner & ru_zemledeliye (remote miners, `remote_mine`/`mine_volley` skills). Economy: AP 8, move = 1 AP flat (AI mirrored), crits (nat 6) pierce saves. Balance (via `FRONTLINE_DEV.autoBattle` headless AI-vs-AI sims): Shtorm-Z 2→3 RP, decisive-lead end 25→30 VP, UA +3 starting CP (NATO C2) — pooled faction winrate ~50/50 over 80 matches (was 70% RU), tanks mid-table with 50–75% death rates (were near-unkillable). Sim caveat: greedy harness under-uses UA special orders, so UA may be slightly stronger in human play than sims show. fitBounds is now deferred + self-healing on resize.
>
> **Real-front hexagonal battlefield (2026-06-13):** the board is now a radius-7 hexagon (~162 hexes) centred on the chosen point; each hex is classified UA/RU-side from the real territory-control GeoJSON (`TerrainLoader.classifyFront`, cached via `TerrainLoader.fetchControlGeo`, fills `#a52714`/`#880e4f` = occupied); the real front renders as a red dashed line; spawn bands hug the front at distance 2–3 (2-hex no-man's-land), supply traces to the board-rim rear (`getRearHexIds` — also fixed a pre-existing bug where supply compared `'player'` to `'ua'` and always traced to AI spawn), breakthrough = entering the enemy rim, forward positions = enemy hexes ≥4 from the front. "Random Frontline Point" samples the occupied-polygon boundary with a 4-probe balance test. Presets were replaced with 6 named front axes (Kupiansk/Lyman/Kostiantynivka/Pokrovsk/Zaporizhzhia/Kherson) that auto-snap at setup load to the nearest balanced point on the live front within ~50 km (`ui._refreshPresetButtons` / `_frontCandidates`, sampling ALL occupied polygons — the northern front lives in separate polygons from the main one); unsnapped anchors keep their coords and fall back to the synthetic front with a log note. RU free tokens (Mobilization Wave, surge events) now arrive in the rear. **Edge deployment (later 2026-06-13):** armies now deploy on opposing BOARD EDGES oriented by the front, not hugging the line — `getSpawnHexIds` picks own-side rim hexes (frontDist≥2, nearest rim) so e.g. at Pokrovsk UA=NW corner, RU=SE corner (verified). Front line now renders via `turf.polygonToLine` clipped to bbox (LineString) — fixes the stray dashed-rectangle frame `bboxClip` on the polygon drew. Presets snap with board-scale probes (±16 km, 2/4 inside the union) so a preset predicts the real on-board split instead of a local notch. **Known follow-up**: at dense urban frontline points (e.g. snapped Pokrovsk 48.33/37.22) the OSM settlement classifier over-matches — 115/162 hexes flagged settlement-objective because `_classifyFromOSM` uses a residential way's BBOX (covers a ~15 km urban agglomeration) instead of true point-in-polygon; carpets the map with objective markers and flattens VP. Fix = assemble residential way polygons from node coords and use `booleanPointInPolygon` for settlements. **Root-cause balance fix**: procedural terrain noise had a fixed phase that always clustered settlements on the north (RU) side (~12 vs 4 objectives) — random per-board phase added; synthetic front also splits at the median hex latitude. Post-fix sims: 52% RU over 60 matches, objectives 11.5/10.2.
>
> **Smarter, legible AI (2026-06-13):** the two lowest-scoring dimensions (AI 5.5 / strategic 6.5). **Part A — win-condition-aware AI** (ai.js `_strategicGoal` from `gameEngine.victoryProgress()`): goals **hold / press / breakthrough / counter / balanced**, faction-tempered (RU presses & breaks through, UA holds earlier — playing to strength). Wired into `_posture` (hold/counter→defensive, press/breakthrough→aggressive), `_assignObjectives` (breakthrough → 2 fastest units sent to player rear rim; hold/counter → prioritize enemy-held objectives incl. their forward positions; garrison AI-held), `_selectAction` (hold → units on an AI objective garrison/fortify; press/breakthrough → keep advancing instead of fortifying). **Part B — legible turn**: split `takeTurn` into `beginTurn`+`nextAction` (one unit's action per call) and a stepped engine driver `_runAITurn`/`_aiStep` paced by `AI_STEP_MS=220` (+render ≈0.8s) so the player **watches each AI move/attack resolve** (move flashes destination, attack flashes target, phase label narrates "Enemy: X attacks/digs in"); headless sims run it synchronously (unchanged). Verified: AI acts one-at-a-time (~1s apart, narrated), turn advances cleanly; goals vary in sims (counter/press/hold/breakthrough); balance restored from a 37% UA dip to **~47% pooled UA** via the faction-temperament fix; console clean. Files: ai.js, game-engine.js, ui.js. (Turn-1 all-fortify is correct — no contact across the no-man's-land.)
>
> **Onboarding & clarity (2026-06-13):** weakest dimension (4/10) in the game evaluation — addressed. **Quick Battle** button on setup: picks the recommended battlegroup+doctrine (index 0, ★ rec badges) + Pokrovsk axis + Normal, then `GameEngine.autoDeployPlayer()` (greedy RP-legal fill, mirrors `_deployAIUnits`) + `finishDeployment()` → lands the player in turn 1 with a ready 5-unit army. Manual **DEPLOY TO FRONT (manual)** path keeps full control + a new **AUTO-DEPLOY** button (fills then lets you tweak). **First-run welcome primer** (`_maybeShowWelcome`, `localStorage frontline_intro_v1`): 5-step core-loop explainer incl. the 4 win paths; pauses the turn timer while shown (fixed a bug where turn 1 ticked away under the modal) and resumes on dismiss; shows once. **One-time contextual hints** (`_hintOnce` + localStorage): deploy / first-select / first-attack. Verified: Quick Battle → turn 1 + primer + timer paused; dismiss persists & won't re-show; auto-deploy 0→5 units / RP 36→1; finish hides auto-btn → END TURN; sim 50% UA / 14 turns unaffected; console clean. Files: ui.js, game-engine.js, game.html, game.css.
>
> **Strategic Foundation — objective/terrain economy fixed (2026-06-13):** the #1 weakness from the game evaluation. Root cause: `terrain-loader.js _classifyFromOSM` tested a residential way's **bounding box**, so a ~15 km urban area marked the whole board settled, and every settled hex auto-became a VP objective (~137 objectives at Pokrovsk). Fixes: (A) `_buildAreas` assembles real polygons from OSM node coords and uses `turf.booleanPointInPolygon` for area features (settlement/forest/industrial/wetland); roads/rivers/bridges use vertex-proximity (~1 km) not bbox. (B/D) settlement/junction/bridge are now terrain *features*, not objectives; `_ensureSpreadObjectives` is the sole authority — greedy farthest-point spread of ~5 feature-based objectives (bridge>settlement>junction>ridgeline) across the central band; `game-engine._flagForwardPositions` capped to ≤3 deep enemy-rear objectives (was all hexes ≥4 from front). **Result at real urban Pokrovsk: settlements 115→19, objectives ~137→8; map is readable.** **C. victory-condition variety + HUD — DONE:** four symmetric win paths checked each full turn in `game-engine._checkWinConditions` (called from `_endOfTurnProcessing('ai')`): VP race (existing), **Breakthrough** (hold ≥3 enemy rear-rim hexes with ground units), **Hold** (control ≥75% of contested objectives for 3 consecutive turns — `_updateHoldStreak` + `holdStreak` state), **Attrition** (enemy ≤25% of `startForce`, captured at `finishDeployment`). `victoryProgress()` feeds a `#hud-victory` readout (🚩 rim / ★ obj·streak / 💀 force%) + a "HOW TO WIN" legend block; `_endGame` guarded against double-fire (`s._gameOver`). Verified: all four paths trigger with correct winner/reason; sims now end via attrition(26)/VP(11)/breakthrough(1)/turn-limit(2) instead of only VP, 45% UA, console clean. Note: in maximally-aggressive AI-vs-AI sims attrition dominates (greedy driver fights to the death); human play will mix more.
>
> **Unit icons matched to type (2026-06-13):** the game's `images/{ua,ru}/icon-N.png` are NATO map symbols that mirror the `icon-ci-N` taxonomy in the DeepState position KMLs (`.../daily/YYYYMMDD/{ukrainian,russian}_positions_*.kml`, where each placemark's `<styleUrl>#icon-ci-{id}</styleUrl>` + `SIDC:` code encodes the unit role). The KMLs contain no icon hrefs — `icon-ci-N` is purely a type category (1=armor/heavy-mech, 3=TDF, 5/6=motor-rifle, 11/44/45/51-54=UAV, 12/19=recon, 18/21=artillery, 20=airborne, 24=assault, 14/17/46=AA, 32=EW, etc.). Remapped all 41 cards' `iconPath` in cards.js from the old sequential numbering to the type-matching icon (e.g. ua_tank icon-12→1 armor, ua_fpv icon-2→11 UAV, ru_tank_72→5 tank-regiment, ru_arty_regt→21 artillery). Verified all icons load on cards and map markers; console clean.
>
> **Distance-based movement AP + useful recon/indirect fire (2026-06-13):** fixed the 32-tile exploit — `moveUnit` now charges AP equal to the terrain-weighted movement-point cost of the chosen hex (a 3-tile move = 3 AP), budget capped at `min(unit.mov, playerAP)`, so total movement/turn ≤ AP (8); grind unchanged (all AP). `selectUnit` highlights only affordable hexes; blue labels now read as AP cost (legend updated). Verified: 3-away=3 AP, 5-away=5 AP, total capped at 8. **Recon/ISR buffed**: `computeIntelZones` passive radius = the drone's `rng` (min 3) instead of hardcoded 3 — ISR Bayraktar (rng 6→10) now illuminates ~109 hexes/turn vs ~37; recon ranges Mavic 5→8, Orlan 5→7; `reconReveal` drops the size penalty (reveals every non-stealth enemy in range). **Indirect-fire blind attack**: artillery/mortar/MLRS can fire at any in-range hex with no visible enemy — `attackUnit` resolves against hidden units there (revealing them on a hit) and wastes the shell (AP spent, "rounds land on empty ground") on an empty hex; smoke no longer blocks indirect fire; UI attack-mode + hover preview support blind targeting. Sim after: 47% UA / 13.3 turns over 60 matches, console clean. AI movement/targeting unaffected (AI steps 1 hex/AP and targets known player units).
>
> **Movement escape + AP display + deploy accessibility (2026-06-13):** units are never trapped — `board.reachableHexes` is now honest (dropped the minimum-move hack), and new `board.escapeHexes` returns ALL adjacent non-stack-full hexes incl. impassable river_major/wetland. `selectUnit` sets `s.grindRange`; `moveUnit` is two-tier: normal move = 1 AP, grind across hard/impassable terrain = ALL remaining AP (verified 8→0; a tank ringed by major rivers still had 4 orange escapes). Grind hexes render as orange ⤧ labels + border, distinct from blue 1-AP move tiles; legend + CSS (`.grind-cost-label`) updated. **AP budget display fixed** — `#ap-display` was permanently overwritten with "RP n" by `_renderDeployHand` so `#ap-pips` never existed during play; `_renderHUD` now rebuilds the gold AP pip row (`AP ▮▮▮ n/8`) each player turn (deploy still shows RP). **Deploy accessibility**: hovering a spawn hex with a card selected previews that unit's move/grind reach (`_deployReachPreview`, reuses reachableHexes/escapeHexes). Sim driver got a grind fallback so units never stall; autoBattle 45% UA / avg 14 turns, console clean. Removed stray `[MOVE]`/`[HEX CLICK]` debug logs. **Deploy-click regression (same day, fixed):** the deploy accessibility preview called `board.renderHexes` on every mouseover, rebuilding the clickable hex layer under the cursor so the deploy click was swallowed → "can't deploy units". Fix: the hover preview now only redraws the non-interactive effect/range layers (`renderEffects`/`showRange`), never `renderHexes`. (Note: `preview_click` can't drive Leaflet vector-layer clicks — synthetic DOM events skip Leaflet's mousedown→mouseup pipeline — so verify deploy via the engine/handler path or real manual clicking, not the MCP click tool.)
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

---

## Unit Roles, Detection & Armor Counters round — DONE 2026-06-17

Goal: the armor trio (IFV/Tank/Mech Brigade) was near-identical and stacking it "guaranteed victory in almost all matches." Differentiated roles + detection range + stealth ambush + stronger mines.

- **Part 1 — armor trio roles** (`cards.js`, `combat.js`, `ui.js`): new `anti_infantry` ability = +2 dice vs INFANTRY (mirror of `anti_armor`), added to `ua_ifv` + `ru_btr` (skirmishers, no edge vs armor). Tank `rng 2→3` for `ua_tank`/`ru_tank_72`/`ru_tank_90` (long-range armor-killer). Mech Brigade aura broadened: `_hasMechBrigadeAdjacent` now grants adjacent friendlies **+1 ATK** (new, in `_attackParams`) **as well as +1 DEF** (removed the old `faction==='player'` gate on the DEF bonus so UA-AI gets it too). Tooltips: added `anti_infantry`, fixed stale `nato_ammo` label.
- **Part 2 — detection + stealth-till-attack** (`board.js`, `game-engine.js`, `ai.js`): new `board.detectRange(card)` (DRONE/`recon_reveal`/`permanent_isr` → rng; `deep_recon` → 2; else → 1). `_isUnitVisible` generalized to `isVisibleTo(unit, viewerFaction, gameState)` (own units, RECON_SPOTTED, within a friendly viewer's detect range, or in a friendly intel zone — stealth excepted). **Stealth units are invisible even when adjacent until they move or attack.** Opening fire sets RECON_SPOTTED (2 turns, 3 w/ precision doctrine) in both `attackUnit` (player) and `executeAIAction` (AI). AI `_scoredThreats` now skips player units not visible to the AI — player ambush finally works vs the AI.
- **Part 3 — ambush & mines** (`combat.js`, `game-engine.js`): sniper **concealed opening shot** = +1 die when a still-hidden `stealth_stationary` attacker fires (in `_attackParams`). Mine entry tracked/wheeled **5→6** dmg + Suppressed + reveals the hex (RECON_SPOTTED on the AI mover); aligned the AI `executeAIAction` mine path with the player path (now honors `mine_immune_first`, wheeled, suppress, reveal).
- **Part 4 — variability tool** (`combat.js`): new `FRONTLINE_DEV.deckMatchup(n)` runs each UA battlegroup as the greedy player vs the random RU AI and reports win%.

**Verification (browser, headless engine):** all `node --check` pass; console clean. `autoBattle(80)` = 44% UA (pooled 120 matches ~41%, in 40–60% band), avg ~12 turns. `deckMatchup(30)`: Mech Fist **33%** (armor no longer dominant — claim disproved), Defensive Line 63%, Drone War 3%. Confirmed mechanically: IFV 8 dice vs infantry / 6 vs tank; sniper 4 dice concealed / 3 after moving; stealth sniper invisible to AI until RECON_SPOTTED; mech brigade aura +1 ATK die and +1 DEF; BTR eats 6 from a mine and is revealed; detectRange ISR 10 / Mavic 8 / SOF 2 / line 1.

**Caveat:** `deckMatchup` drives the UA side with the crude greedy sim driver vs the smarter engine AI, so absolute win% is skewed by driver skill (Drone War's 3% is the driver crashing fragile drones, not a balance bug — no console errors). Use it for *relative* deck ranking, not absolute balance; `autoBattle` (AI-vs-AI) remains the trustworthy balance metric. Possible follow-up: let `deckMatchup` force the AI's battlegroup so both sides run the engine AI for a true deck-vs-deck read.
4. Use the dev simulation flag (added in 1b/3) for combat-math regression checks.

---

## Activate Dormant Unit Abilities round — DONE 2026-06-20

A skill audit found **~30 of ~73 unit abilities were flavor-only** (printed on cards + `ABILITY_LABELS` but never referenced by the engine). Activated them in 5 phases, reusing existing hooks. **After this round the re-audit shows ZERO flavor-only abilities — every printed ability is wired or removed.**

- **Phase 1 — defensive (`combat.js _saveTarget`)**: `armor_class` (+1 DEF vs INFANTRY attacker), `trench_def` (+2 DEF fortified on settlement/forest), `settlement_hold` (+1 DEF on settlement), `hold_the_line` (+1 DEF on objective hex).
- **Phase 2 — offensive (`combat.js _attackParams`/`resolveAttack`)**: `combined_arms` (+1 die beside a different-class friendly, new helper `_hasAdjacentDifferentClass`), `precision_optics` (+1 die vs RECON_SPOTTED), `night_raid` (skip night to-hit penalty), `suppressive_fire` (folded into the `suppress_on_hit` path), `area_suppression` (suppress ALL enemies on the target hex).
- **Phase 3 — auras/end-of-turn (`game-engine.js`)**: `defensive_depth` (adjacent friendlies get OVERWATCH each turn, in `_startTurn`), `fragile` (destroyed if an enemy is adjacent at end of turn, in `_endOfTurnProcessing`), `assault_tempo` (a kill refunds 1 AP, max 2/turn — player `s.playerAP`, AI `this.ai._apRemaining`; reset via `u._tempoAP=0`), `hq_action` (player HQ unit grants `s.freeOrderUse=1`).
- **Phase 4 — reactions/fires/movement**: `counter_battery` (return fire when hit by enemy indirect fire, in `resolveAttack`), `anti_air_reaction` + `recon_shield` (new `_checkAntiAirTriggers`/`_rollAA`, called on drone moves in `moveUnit`/`executeAIAction`), `double_fire`/`rapid_fire` (free second volley), `road_bonus` + `amphibious` (threaded `abilities` through `board.reachableHexes`→`_moveCost`; amphibious crosses river_major at cost 2 instead of 99, road_bonus −1 road cost).
- **Phase 5 — niche + cleanup**: `carrier`/`transport` reimplemented as a **mechanized-lift aura** (+1 MOV to adjacent friendly infantry, `_carryLift`, in both `movBudget` spots) — no load/unload UI; `jammable` (strike-time EW recheck cancels a Switchblade strike, `hex.loiteringJammable`). **Removed** 8 orphaned/duplicate abilities (`weapon_mount`, `stealth_mine`, `dual_role`, `video_feed`, `sabotage_order`, `shoot_and_scoot`, `mine_coordination`, `zone_denial_passive`) from card `abilities`, `ABILITY_LABELS`, and reconciled the affected card descs. Also removed the stray `console.log('[MOVE]'…)` debug line in `moveUnit`.

**Verification:** `node --check` all pass; console clean; re-audit = 0 flavor-only. Per-phase browser engine checks all passed (armor_class/trench_def/settlement_hold/hold_the_line save deltas; combined_arms/precision_optics +1 die, night_raid −1 to-hit; defensive_depth overwatch, fragile death, assault_tempo AP refund, hq_action freeOrderUse; counter_battery return dmg, anti-air fires reliably + recon_shield blocks, road_bonus 2→1, amphibious 99→3; carrier lift 0→1, jammable cancels under EW). Balance: `autoBattle(60)` = **56.7% UA**, ~15 turns (in band); `deckMatchup(24)`: Mech Fist **54%** (mid-pack, not dominant), Defensive Line 63%, Drone War 4% (crude-driver artifact). No tuning needed.

**Note:** `carrier`/`transport` are now a MOV aura, not a literal load/unload transport — a full embark/disembark sub-system is deferred. Deferred comparator backlog (not in this round): morale/break ladder (Combat Commander/ASL), command/activation friction (Undaunted/C&C), faction-asymmetric win paths (COIN/Root).

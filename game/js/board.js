'use strict';
// ── board.js — Hex Grid Generation + Leaflet Rendering ───────────────────

class HexBoard {
    constructor() {
        this.hexes = new Map();       // hexId → { feature, terrainType, overlays, ... }
        this.hexLayer = null;         // L.geoJSON hex polygons
        this.effectLayer = null;      // L.layerGroup for EW/intel zones
        this.unitMarkers = new Map(); // unitId → L.marker
        this.rangeLayer = null;       // L.geoJSON movement/attack range highlight
        this._map = null;
        this.bbox = null;
        this.centerLat = null;
        this.centerLng = null;
    }

    // ── Grid Generation ──────────────────────────────────────────────────────

    // Hexagonal battlefield: radius-7 hexagon around the centre (~169 hexes,
    // cellSide 1.5 km) so the board has no corners and centres on the front.
    generate(centerLat, centerLng) {
        this.centerLat = centerLat;
        this.centerLng = centerLng;
        this.cellSide = 1.5; // km — used by neighbour detection
        this.frontGeo = null;

        // Square bbox big enough to contain the radius-7 hexagon (±18 km)
        const dLng = (18 / (111.32 * Math.cos(centerLat * Math.PI / 180)));
        const dLat = 18 / 110.574;

        this.bbox = [
            centerLng - dLng,
            centerLat - dLat,
            centerLng + dLng,
            centerLat + dLat
        ];

        const rawGrid = turf.hexGrid(this.bbox, 1.5, { units: 'kilometers' });

        // Assign stable IDs using axial-ish index from centroid
        this.hexes.clear();
        rawGrid.features.forEach((f, idx) => {
            const c = turf.centroid(f);
            const id = `h${idx}`;
            f.properties.hexId = id;
            f.properties.centroid = c.geometry.coordinates; // [lng, lat]
            this.hexes.set(id, {
                id,
                feature: f,
                centroid: c.geometry.coordinates,
                terrainType: 'open',
                overlays: new Set(),
                controlledBy: null,
                settlementHeldTurns: { player: 0, ai: 0 },
                minedBy: null,
                loiteringTarget: null,
                loiteringCountdown: 0,
                isObjective: false,
                objectiveType: null,
                hasRoad: false,
                hasRiver: false,
                hasBridge: false,
                interdictedTurns: 0
            });
        });

        this._buildNeighbourMap();

        // Cut the square grid down to a true hexagon: keep hexes within
        // hex-distance 7 of the centre, then rebuild neighbours and bbox.
        const centerHex = this.getHexAt(centerLat, centerLng);
        const keep = new Set([centerHex, ...this.hexesInRange(centerHex, 7)]);
        [...this.hexes.keys()].forEach(id => { if (!keep.has(id)) this.hexes.delete(id); });
        this._buildNeighbourMap();

        this.bbox = turf.bbox({
            type: 'FeatureCollection',
            features: [...this.hexes.values()].map(h => h.feature)
        });
        return this.hexes;
    }

    // Build neighbour lookup: hexId → [hexId, ...]
    _buildNeighbourMap() {
        const hexList = [...this.hexes.values()];
        // Adjacent hex centres are cellSide*√3 apart. Allow 15% margin.
        const ADJ_DIST_KM = this.cellSide * Math.sqrt(3) * 1.15;
        hexList.forEach(h => {
            h.neighbours = [];
            const [cx, cy] = h.centroid;
            hexList.forEach(other => {
                if (other.id === h.id) return;
                const [ox, oy] = other.centroid;
                const dx = (ox - cx) * 111.32 * Math.cos((cy + oy) / 2 * Math.PI / 180);
                const dy = (oy - cy) * 110.574;
                const distKm = Math.sqrt(dx * dx + dy * dy);
                if (distKm < ADJ_DIST_KM) h.neighbours.push(other.id);
            });
        });
    }

    // Multi-source BFS distance from the frontline hexes (hexId → distance)
    frontDistances() {
        const dist = new Map();
        let frontier = [];
        this.hexes.forEach((h, id) => {
            if (h.isFrontline) { dist.set(id, 0); frontier.push(id); }
        });
        let d = 0;
        while (frontier.length) {
            d++;
            const next = [];
            for (const id of frontier) {
                for (const nid of this.neighbours(id)) {
                    if (!dist.has(nid)) { dist.set(nid, d); next.push(nid); }
                }
            }
            frontier = next;
        }
        return dist;
    }

    // Armies deploy along opposing board edges, oriented by the front: each
    // side spawns on its own-side hexes nearest the rim (e.g. at Pokrovsk the
    // UA edge is north-west and the RU edge south-east), away from the line.
    getSpawnHexIds(playerFaction) {
        const aiFaction = playerFaction === 'ua' ? 'ru' : 'ua';
        const frontDist = this.frontDistances();

        // Distance from the board rim (multi-source BFS)
        const rimDist = new Map();
        let frontier = [];
        this.hexes.forEach((h, id) => {
            if (h.neighbours.length < 6) { rimDist.set(id, 0); frontier.push(id); }
        });
        let d = 0;
        while (frontier.length) {
            d++;
            const next = [];
            for (const id of frontier) {
                for (const nid of this.neighbours(id)) {
                    if (!rimDist.has(nid)) { rimDist.set(nid, d); next.push(nid); }
                }
            }
            frontier = next;
        }

        const bandFor = side => {
            for (let depth = 0; depth <= 3; depth++) {
                const band = [];
                this.hexes.forEach((h, id) => {
                    if (h.side === side && !h.isFrontline &&
                        (frontDist.get(id) ?? 99) >= 2 &&
                        (rimDist.get(id) ?? 99) <= depth) band.push(id);
                });
                if (band.length >= 14) return band;
            }
            // Last resort: the whole side minus the frontline
            const all = [];
            this.hexes.forEach((h, id) => { if (h.side === side && !h.isFrontline) all.push(id); });
            return all;
        };

        const playerHexes = bandFor(playerFaction);
        const aiHexes = bandFor(aiFaction);

        // Tint the bands on the map (used by _hexStyle)
        this.hexes.forEach(h => { h.spawnZone = null; });
        playerHexes.forEach(id => { this.hexes.get(id).spawnZone = playerFaction; });
        aiHexes.forEach(id => { this.hexes.get(id).spawnZone = aiFaction; });

        return { playerHexes, aiHexes };
    }

    // Rear = own-side hexes on the board rim. Supply traces here; entering the
    // enemy rear scores the breakthrough VP.
    getRearHexIds(side) {
        const rear = [];
        this.hexes.forEach((h, id) => {
            if (h.side === side && h.neighbours.length < 6) rear.push(id);
        });
        return rear;
    }

    getHexAt(lat, lng) {
        let best = null;
        let bestDist = Infinity;
        this.hexes.forEach(h => {
            const [cx, cy] = h.centroid; // [lng, lat]
            const d = (cx - lng) ** 2 + (cy - lat) ** 2;
            if (d < bestDist) { bestDist = d; best = h.id; }
        });
        return best;
    }

    neighbours(hexId) {
        return this.hexes.get(hexId)?.neighbours || [];
    }

    hexesInRange(fromHexId, range) {
        if (range <= 0) return [fromHexId];
        const visited = new Set([fromHexId]);
        let frontier = [fromHexId];
        for (let i = 0; i < range; i++) {
            const next = [];
            frontier.forEach(hid => {
                this.neighbours(hid).forEach(nid => {
                    if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
                });
            });
            frontier = next;
        }
        visited.delete(fromHexId);
        return [...visited];
    }

    hexDistance(aId, bId) {
        // BFS distance
        if (aId === bId) return 0;
        const visited = new Set([aId]);
        let frontier = [aId];
        let dist = 0;
        while (frontier.length > 0) {
            dist++;
            const next = [];
            for (const hid of frontier) {
                for (const nid of this.neighbours(hid)) {
                    if (nid === bId) return dist;
                    if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
                }
            }
            frontier = next;
        }
        return 99;
    }

    // BFS reachable hexes within AP budget given terrain costs
    reachableHexes(fromHexId, apBudget, unitClass, playerFaction, gameState) {
        const result = new Map(); // hexId → apCost
        const queue = [{ id: fromHexId, cost: 0 }];
        const visited = new Map([[fromHexId, 0]]);

        while (queue.length > 0) {
            queue.sort((a, b) => a.cost - b.cost);
            const { id, cost } = queue.shift();

            this.neighbours(id).forEach(nid => {
                const hex = this.hexes.get(nid);
                if (!hex) return;
                const moveCost = this._moveCost(hex, unitClass, gameState);
                const newCost = cost + moveCost;
                if (newCost <= apBudget && (!visited.has(nid) || visited.get(nid) > newCost)) {
                    visited.set(nid, newCost);
                    result.set(nid, newCost);
                    queue.push({ id: nid, cost: newCost });
                }
            });
        }

        // Minimum-move rule: a unit can always crawl one adjacent passable hex,
        // even when every neighbour costs more than its MOV budget.
        if (result.size === 0) {
            this.neighbours(fromHexId).forEach(nid => {
                const hex = this.hexes.get(nid);
                if (hex && this._moveCost(hex, unitClass, gameState) < 99) {
                    result.set(nid, apBudget);
                }
            });
        }
        return result;
    }

    _moveCost(hex, unitClass, gameState) {
        // Drones fly: flat cost, no terrain/river/mud penalties
        if (unitClass === UNIT_CLASS.DRONE) return 1;
        const terrain = TERRAIN_RULES[hex.terrainType] || TERRAIN_RULES.open;
        let cost = terrain.moveCost || 1;
        if (hex.overlays.has('road_paved') || hex.overlays.has('road_motorway')) {
            cost = Math.max(0, cost - 1);
        }
        if (hex.overlays.has('river_minor')) cost += 2;
        if (hex.overlays.has('river_major') && !hex.hasBridge) return 99; // impassable
        if (unitClass === UNIT_CLASS.WHEELED && terrain.noWheeled) return 99;
        if (gameState?.mudTurns > 0 && !hex.hasRoad) cost += 1;
        return Math.max(1, cost);
    }

    // ── Supply BFS ───────────────────────────────────────────────────────────

    computeSupplyTrace(unitHexId, faction, gameState) {
        // Returns 'supplied' | 'low_supply' | 'unsupplied'.
        // `faction` is the unit side ('player' | 'ai'); supply traces to that
        // side's rear (board rim), falling back to its spawn band.
        const rear = faction === 'player' ? gameState.rearHexIds?.player : gameState.rearHexIds?.ai;
        const spawnIds = rear?.length ? rear
            : (faction === 'player' ? gameState.spawnHexIds.playerHexes : gameState.spawnHexIds.aiHexes);

        const BASE_RANGE = 5;
        const queue = [{ id: unitHexId, steps: 0, roadBonus: 0 }];
        const visited = new Set([unitHexId]);

        while (queue.length > 0) {
            const { id, steps, roadBonus } = queue.shift();
            if (spawnIds.includes(id)) {
                const effectiveRange = BASE_RANGE + roadBonus;
                if (steps <= effectiveRange) return 'supplied';
                if (steps <= effectiveRange + 1) return 'low_supply';
                return 'unsupplied';
            }
            if (steps >= 12) continue;
            for (const nid of this.neighbours(id)) {
                if (visited.has(nid)) continue;
                const hex = this.hexes.get(nid);
                if (!hex) continue;
                // Blocked by enemy hexes
                const enemyFaction = faction === 'player' ? 'ai' : 'player';
                if (this._hexHasFriendlyUnit(nid, enemyFaction, gameState)) continue;
                // Blocked by interdicted or major river without bridge
                if (hex.overlays.has('river_major') && !hex.hasBridge) continue;
                if (hex.interdictedTurns > 0) continue;
                visited.add(nid);
                const bonus = hex.hasRoad ? roadBonus + 1 : roadBonus;
                queue.push({ id: nid, steps: steps + 1, roadBonus: bonus });
            }
        }
        return 'unsupplied';
    }

    _hexHasFriendlyUnit(hexId, faction, gameState) {
        if (!gameState?.units) return false;
        for (const u of gameState.units.values()) {
            if (u.faction === faction && u.hexId === hexId && u.hp > 0) return true;
        }
        return false;
    }

    // EW zone: compute all hexes within ewRadius of each EW unit
    computeEWZones(gameState) {
        const zones = new Map(); // hexId → Set<faction>
        if (!gameState?.units) return zones;

        gameState.units.forEach(unit => {
            const card = CARD_CATALOG[unit.cardId];
            if (!card?.abilities?.includes('ew_jamming') || unit.hp <= 0) return;
            if (unit.sabotagedTurns > 0) return; // disabled by Sabotage skill
            const r = card.ewRadius || 2;
            const inRange = [unit.hexId, ...this.hexesInRange(unit.hexId, r)];
            inRange.forEach(hid => {
                if (!zones.has(hid)) zones.set(hid, new Set());
                zones.get(hid).add(unit.faction);
            });
        });
        return zones;
    }

    // Intel zones from drone units
    computeIntelZones(gameState) {
        const zones = new Map(); // hexId → faction
        if (!gameState?.units) return zones;

        gameState.units.forEach(unit => {
            const card = CARD_CATALOG[unit.cardId];
            if (!card?.abilities?.includes('intel_zone') && !card?.abilities?.includes('permanent_isr')) return;
            if (unit.hp <= 0) return;
            const r = 3;
            [unit.hexId, ...this.hexesInRange(unit.hexId, r)].forEach(hid => {
                zones.set(hid, unit.faction);
            });
        });
        return zones;
    }

    // ── Leaflet Rendering ────────────────────────────────────────────────────

    destroy() {
        if (this._map) {
            this._map.remove();
            this._map = null;
        }
        this.frontGeo = null;
        this.hexes.clear();
        this.unitMarkers.clear();
        this.hexLayer = null;
        this.effectLayer = null;
        this.rangeLayer = null;
    }

    initLeafletMap(mapDivId) {
        this._map = L.map(mapDivId, {
            center: [this.centerLat, this.centerLng],
            zoom: 12,
            zoomControl: true,
            scrollWheelZoom: true
        });
        // Fit the whole battlefield (bbox is [minLng, minLat, maxLng, maxLat]).
        // Deferred + self-healing: the container may have no size yet at init
        // time (hidden tab/panel) — refit whenever the map regains a real size.
        if (this.bbox) {
            const bounds = [[this.bbox[1], this.bbox[0]], [this.bbox[3], this.bbox[2]]];
            const fit = () => {
                if (!this._map) return;
                this._map.invalidateSize();
                if (this._map.getSize().x > 0) this._map.fitBounds(bounds);
            };
            setTimeout(fit, 50);
            this._map.on('resize', () => {
                if (this._map.getZoom() <= 2) fit();
            });
        }

        L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            { attribution: 'Imagery © Esri', maxZoom: 19 }
        ).addTo(this._map);

        this.effectLayer = L.layerGroup().addTo(this._map);
        return this._map;
    }

    renderHexes(gameState) {
        if (!this._map) return;
        if (this.hexLayer) this._map.removeLayer(this.hexLayer);

        const features = [];
        this.hexes.forEach(hex => {
            const f = { ...hex.feature, properties: { ...hex.feature.properties, hexId: hex.id } };
            features.push(f);
        });

        this.hexLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            style: f => this._hexStyle(f.properties.hexId, gameState),
            onEachFeature: (f, layer) => {
                layer.on('click', () => {
                    if (this.onHexClick) this.onHexClick(f.properties.hexId);
                });
                layer.on('mouseover', () => {
                    if (this.onHexHover) this.onHexHover(f.properties.hexId);
                });
                layer.on('mouseout', () => {
                    if (this.onHexHover) this.onHexHover(null);
                });
            }
        }).addTo(this._map);
    }

    _hexStyle(hexId, gameState) {
        const hex = this.hexes.get(hexId);
        if (!hex) return {};
        const base = this._terrainColor(hex.terrainType);
        let fillOpacity = 0.55;
        let color = '#444';
        let weight = 0.8;

        // Spawn bands tinted by faction side
        if (hex.spawnZone === 'ua') { color = '#1a6fc4'; weight = 1.5; }
        if (hex.spawnZone === 'ru') { color = '#b33a3a'; weight = 1.5; }

        // Objective highlight
        if (hex.isObjective) { weight = 2; }

        // Controlled
        if (hex.controlledBy === 'player') fillOpacity = 0.35;
        if (hex.controlledBy === 'ai') fillOpacity = 0.65;

        // Selected / range highlight injected by UI
        if (gameState?.selectedHex === hexId) { color = '#fff'; weight = 3; }
        if (gameState?.moveRange?.has(hexId)) { color = '#4af'; weight = 2; fillOpacity = 0.25; }
        if (gameState?.attackRange?.has(hexId)) { color = '#f44'; weight = 2; fillOpacity = 0.25; }

        return { fillColor: base, fillOpacity, color, weight, opacity: 0.9 };
    }

    _terrainColor(type) {
        const colors = {
            open:          '#c8b87a',
            agricultural:  '#d4c98a',
            forest_light:  '#4a7c4e',
            forest_dense:  '#2a5a2e',
            settlement_s1: '#a08060',
            settlement_s2: '#805040',
            wetland:       '#6a8a6a',
            industrial:    '#707070',
            ridgeline:     '#9a8060'
        };
        return colors[type] || '#c8b87a';
    }

    renderEffects(gameState) {
        if (!this._map || !this.effectLayer) return;
        this.effectLayer.clearLayers();

        // EW zones
        const ewZones = gameState.ewZones || new Map();
        this.hexes.forEach((hex, hexId) => {
            if (ewZones.has(hexId)) {
                const factions = ewZones.get(hexId);
                const color = factions.has('ru') ? '#9b59b6' : '#3498db';
                L.geoJSON(hex.feature, {
                    interactive: false,
                    style: { fillColor: color, fillOpacity: 0.22, color, weight: 0.5, opacity: 0.4 }
                }).addTo(this.effectLayer);
            }
        });

        // Intel zones
        const intelZones = gameState.intelZones || new Map();
        this.hexes.forEach((hex, hexId) => {
            if (intelZones.has(hexId)) {
                const faction = intelZones.get(hexId);
                const color = faction === 'player' ? '#1abc9c' : '#e67e22';
                L.geoJSON(hex.feature, {
                    interactive: false,
                    style: { fillColor: 'none', fillOpacity: 0, color, weight: 2, opacity: 0.8, dashArray: '5,3' }
                }).addTo(this.effectLayer);
            }
        });

        // Mined hexes
        this.hexes.forEach((hex, hexId) => {
            if (hex.overlays.has('mined')) {
                const [lng, lat] = hex.centroid;
                L.marker([lat, lng], {
                    icon: L.divIcon({ className: '', html: '<div class="mine-icon">💣</div>', iconSize: [20, 20] })
                }).addTo(this.effectLayer);
            }
        });

        // Loitering countdowns
        this.hexes.forEach((hex, hexId) => {
            if (hex.loiteringCountdown > 0) {
                const [lng, lat] = hex.centroid;
                L.marker([lat, lng], {
                    icon: L.divIcon({ className: '', html: `<div class="loiter-icon">⏱${hex.loiteringCountdown}</div>`, iconSize: [28, 28] })
                }).addTo(this.effectLayer);
            }
        });

        // The front line: real control boundary (red dashed), or — with the
        // synthetic fallback — the frontline hex borders
        if (this.frontGeo) {
            L.geoJSON(this.frontGeo, {
                interactive: false,
                style: { fill: false, color: '#e53935', weight: 2.5, opacity: 0.9, dashArray: '8,5' }
            }).addTo(this.effectLayer);
        } else {
            this.hexes.forEach(hex => {
                if (!hex.isFrontline) return;
                L.geoJSON(hex.feature, {
                    interactive: false,
                    style: { fill: false, color: '#e53935', weight: 1.5, opacity: 0.7, dashArray: '4,4' }
                }).addTo(this.effectLayer);
            });
        }

        // Death markers — where units were lost (hover shows who and when)
        (gameState.fallenUnits || []).forEach(f => {
            const hex = this.hexes.get(f.hexId);
            if (!hex) return;
            const [lng, lat] = hex.centroid;
            L.marker([lat, lng], {
                interactive: false,
                icon: L.divIcon({
                    className: '',
                    html: `<div class="death-marker ${f.faction === 'player' ? 'death-player' : 'death-ai'}" title="${f.name} — lost on turn ${f.turn}">✕</div>`,
                    iconSize: [16, 16], iconAnchor: [8, 8]
                })
            }).addTo(this.effectLayer);
        });

        // Move-cost labels on the selected unit's movement range
        const moveRange = gameState.moveRange;
        if (moveRange && moveRange.size) {
            moveRange.forEach((cost, hexId) => {
                const hex = this.hexes.get(hexId);
                if (!hex) return;
                const [lng, lat] = hex.centroid;
                L.marker([lat, lng], {
                    interactive: false,
                    icon: L.divIcon({ className: '', html: `<div class="move-cost-label">${cost}</div>`, iconSize: [18, 18] })
                }).addTo(this.effectLayer);
            });
        }

        // Objective markers
        this.hexes.forEach((hex, hexId) => {
            if (hex.isObjective) {
                const [lng, lat] = hex.centroid;
                const ctrl = hex.controlledBy;
                const color = ctrl === 'player' ? '#4af' : ctrl === 'ai' ? '#f44' : '#fff';
                L.circleMarker([lat, lng], {
                    radius: 6, color, weight: 2, fill: true, fillColor: color, fillOpacity: 0.7
                }).addTo(this.effectLayer);
            }
        });
    }

    // ── Unit Markers ─────────────────────────────────────────────────────────

    renderUnit(unit, gameState) {
        if (!this._map) return;
        if (this.unitMarkers.has(unit.id)) {
            this._map.removeLayer(this.unitMarkers.get(unit.id));
        }
        if (unit.hp <= 0) {
            this.unitMarkers.delete(unit.id);
            return;
        }

        const hex = this.hexes.get(unit.hexId);
        if (!hex) return;
        const [lng, lat] = hex.centroid;
        const card = CARD_CATALOG[unit.cardId];
        const isPlayer = unit.faction === 'player';
        const isVisible = this._isUnitVisible(unit, gameState);

        if (!isVisible) return; // Fog of war

        const hpPct = Math.max(0, unit.hp / unit.maxHp);
        const hpColor = hpPct > 0.6 ? '#4caf50' : hpPct > 0.3 ? '#ffc107' : '#f44336';
        const selected = gameState.selectedUnit === unit.id;
        const exp = unit.experience;
        const expBadge = exp >= 3 ? '⭐' : exp >= 1 ? '·' : '';
        const statusIcons = this._buildStatusIcons(unit);

        const html = `
<div class="unit-marker ${isPlayer ? 'unit-player' : 'unit-ai'} ${selected ? 'unit-selected' : ''}">
  <img src="${card.iconPath}" class="unit-icon" onerror="this.style.display='none'">
  <div class="unit-hp-bar" style="--pct:${Math.round(hpPct*100)}%;--clr:${hpColor}"></div>
  ${expBadge ? `<div class="unit-exp">${expBadge}</div>` : ''}
  ${statusIcons ? `<div class="unit-status-icons">${statusIcons}</div>` : ''}
  ${unit.inDepot ? '<div class="depot-badge">D</div>' : ''}
</div>`;

        const marker = L.marker([lat, lng], {
            icon: L.divIcon({ className: '', html, iconSize: [40, 48], iconAnchor: [20, 24] }),
            zIndexOffset: isPlayer ? 100 : 0
        });
        marker.on('click', () => {
            if (this.onUnitClick) this.onUnitClick(unit.id);
        });
        marker.addTo(this._map);
        this.unitMarkers.set(unit.id, marker);
    }

    _isUnitVisible(unit, gameState) {
        if (unit.faction === 'player') return true;
        if (unit.status.has(STATUS.RECON_SPOTTED)) return true;

        // Adjacent to any player unit — always visible
        const neighbours = this.neighbours(unit.hexId);
        for (const u of gameState.units.values()) {
            if (u.faction === 'player' && u.hp > 0) {
                if (u.hexId === unit.hexId || neighbours.includes(u.hexId)) return true;
            }
        }

        const intelZones = gameState.intelZones || new Map();
        if (!intelZones.has(unit.hexId)) return false;

        // In Intel Zone: visibility depends on unit size and stealth
        const card = CARD_CATALOG[unit.cardId];
        const size = card?.size ?? 2;
        const stealthy = card?.abilities?.includes('stealth_stationary') && !unit.movedThisTurn;

        if (stealthy) return false;           // size-1 stationary snipers/SF are invisible
        if (size >= 2) return true;            // medium/large always visible in intel zone
        // size 1 infantry: only visible in intel zone if they moved (disturbed the foliage)
        return !!unit.movedThisTurn;
    }

    // Flash temporary area-effect highlight (e.g. after artillery/MLRS fires)
    showAreaEffect(hexIds, durationMs = 1600) {
        if (!this._map) return;
        const features = hexIds.map(hid => this.hexes.get(hid)?.feature).filter(Boolean);
        if (!features.length) return;
        const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
            interactive: false,
            style: { fillColor: '#ff6600', fillOpacity: 0.55, color: '#ff2200', weight: 2 }
        }).addTo(this._map);
        setTimeout(() => { try { this._map.removeLayer(layer); } catch (_) {} }, durationMs);
    }

    _buildStatusIcons(unit) {
        const icons = [];
        if (unit.status.has(STATUS.RECON_SPOTTED)) icons.push('<span class="si si-spot" title="Spotted — visible to all enemies">👁</span>');
        if (unit.status.has(STATUS.MARKED))     icons.push('<span class="si si-mark" title="Marked — −1 save">🎯</span>');
        if (unit.status.has(STATUS.SUPPRESSED)) icons.push('<span class="si si-s" title="Suppressed">S</span>');
        if (unit.status.has(STATUS.PINNED))     icons.push('<span class="si si-p" title="Pinned">P</span>');
        if (unit.status.has(STATUS.FORTIFIED))  icons.push('<span class="si si-f" title="Fortified">F</span>');
        if (unit.status.has(STATUS.OVERWATCH))  icons.push('<span class="si si-o" title="Overwatch">OW</span>');
        if (unit.status.has(STATUS.FLANKING))   icons.push('<span class="si si-fl" title="Flanking">FL</span>');
        if (unit.status.has(STATUS.UNSUPPLIED)) icons.push('<span class="si si-u" title="Unsupplied">⚠</span>');
        if (unit.status.has(STATUS.EW_SUPPRESSED)) icons.push('<span class="si si-ew" title="EW Jammed">EW</span>');
        return icons.join('');
    }

    renderAllUnits(gameState) {
        if (!this._map) return;
        // Remove all existing markers and re-render cleanly
        this.unitMarkers.forEach(marker => this._map.removeLayer(marker));
        this.unitMarkers.clear();
        gameState.units.forEach(unit => {
            if (unit.hp > 0) this.renderUnit(unit, gameState);
        });
    }

    showRange(moveHexIds, attackHexIds) {
        if (this.rangeLayer) this._map.removeLayer(this.rangeLayer);
        const features = [];
        moveHexIds.forEach(hid => {
            const hex = this.hexes.get(hid);
            if (hex) features.push({ ...hex.feature, properties: { _type: 'move' } });
        });
        attackHexIds.forEach(hid => {
            const hex = this.hexes.get(hid);
            if (hex) features.push({ ...hex.feature, properties: { _type: 'attack' } });
        });
        if (features.length === 0) return;
        this.rangeLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            interactive: false, // never intercept hex clicks
            style: f => f.properties._type === 'move'
                ? { fillColor: '#4af', fillOpacity: 0.30, color: '#4af', weight: 2 }
                : { fillColor: '#f44', fillOpacity: 0.25, color: '#f44', weight: 2 }
        }).addTo(this._map);
    }

    clearRange() {
        if (this.rangeLayer) { this._map.removeLayer(this.rangeLayer); this.rangeLayer = null; }
    }
}

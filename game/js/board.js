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

    // 25×20km battlefield. cellSide 1.5km → ~11×8 ≈ 88 hexes.
    generate(centerLat, centerLng) {
        this.centerLat = centerLat;
        this.centerLng = centerLng;
        this.cellSide = 1.5; // km — used by neighbour detection

        // 25km wide / 20km tall in degrees at ~49°N
        const dLng = (12.5 / (111.32 * Math.cos(centerLat * Math.PI / 180)));
        const dLat = 10.0 / 110.574;

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
        this._assignSpawnZones();
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

    // Spawn zones: rows closest to south/north edges
    _assignSpawnZones() {
        const hexList = [...this.hexes.values()];
        const lats = hexList.map(h => h.centroid[1]);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const latRange = maxLat - minLat;

        hexList.forEach(h => {
            const normLat = (h.centroid[1] - minLat) / latRange;
            if (normLat <= 0.22) {
                h.spawnZone = 'south';
            } else if (normLat >= 0.78) {
                h.spawnZone = 'north';
            }
        });
    }

    // Determine which hex ids are south / north spawn zones for each faction
    getSpawnHexIds(playerFaction) {
        // UA defends from south (historically pushes north), RU from north
        const playerZone = playerFaction === 'ua' ? 'south' : 'north';
        const aiZone = playerFaction === 'ua' ? 'north' : 'south';
        const playerHexes = [];
        const aiHexes = [];
        this.hexes.forEach((h, id) => {
            if (h.spawnZone === playerZone) playerHexes.push(id);
            if (h.spawnZone === aiZone) aiHexes.push(id);
        });
        return { playerHexes, aiHexes };
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
        return result;
    }

    _moveCost(hex, unitClass, gameState) {
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
        // Returns 'supplied' | 'low_supply' | 'unsupplied'
        const spawnIds = faction === gameState.playerFaction
            ? gameState.spawnHexIds.playerHexes
            : gameState.spawnHexIds.aiHexes;

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
                const enemyFaction = faction === gameState.playerFaction ? 'ai' : 'player';
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

        // Spawn zones tinted
        if (hex.spawnZone === 'south') { color = '#1a6fc4'; weight = 1.5; }
        if (hex.spawnZone === 'north') { color = '#b33a3a'; weight = 1.5; }

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

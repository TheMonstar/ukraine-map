class MapUMLEngine {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.map = dashboard.map;
        this.layerGroup = L.layerGroup().addTo(this.map);
        window.markerAdjuster = this;

        // Configuration
        this.colors = {
            attacker: '#d0021b',
            defender: '#4a90e2',
            advance: '#f5a623',
            settlement: '#ffffff',
            note: '#f8e71c',
            operation: 'rgba(255,255,255,0.1)'
        };
    }

    // Main API
    async renderScript(scriptText) {
        this.clear();
        await this._ensureDataLoaded();
        const ast = this.parse(scriptText);
        this.draw(ast);
    }

    async _ensureDataLoaded() {
        // Trigger positions loading if they are completely empty
        const needLoadUA = !this.dashboard.dailyLayerUA || Object.keys(this.dashboard.dailyLayerUA._layers || {}).length === 0;
        const needLoadRU = !this.dashboard.dailyLayerRU || Object.keys(this.dashboard.dailyLayerRU._layers || {}).length === 0;

        if (needLoadUA || needLoadRU) {
            if (typeof this.dashboard.updateDailyPositions === 'function') {
                await this.dashboard.updateDailyPositions(true); // force load parameter
            }
        }
    }

    clear() {
        this.layerGroup.clearLayers();
    }

    // ─── PARSER ──────────────────────────────────────────────
    parse(text) {
        const lines = text.split('\n');
        const ast = {
            title: '',
            regions: [],
            operations: [], // { name: '', bounds: [], advances: [], notes: [] }
            items: [] // Flat items at root level
        };

        let currentOperation = null;

        lines.forEach(rawLine => {
            const line = rawLine.trim();
            if (!line || line.startsWith('//')) return;

            // Title
            const titleMatch = line.match(/^title\s+(.+)$/i);
            if (titleMatch) {
                ast.title = titleMatch[1].trim();
                return;
            }

            // Regions
            const regionMatch = line.match(/^regions?\s+(.+)$/i);
            if (regionMatch) {
                ast.regions = regionMatch[1].split(',').map(r => r.trim());
                return;
            }

            // Operation grouping
            const opMatch = line.match(/^operation\s+["']?([^"']+)["']?\s*\{/i);
            if (opMatch) {
                currentOperation = {
                    name: opMatch[1].trim(),
                    advances: [],
                    notes: [],
                    bounds: [] // Populated during render
                };
                ast.operations.push(currentOperation);
                return;
            }

            if (line === '}') {
                currentOperation = null;
                return;
            }

            // Parse commands
            let cmdItem = this._parseLineCommand(line);
            if (cmdItem) {
                if (currentOperation) {
                    if (cmdItem.type === 'advance') currentOperation.advances.push(cmdItem);
                    else if (cmdItem.type === 'note') currentOperation.notes.push(cmdItem);
                    else ast.items.push(cmdItem); // Let units/settlements remain global for easier bounds
                } else {
                    ast.items.push(cmdItem);
                }
            }
        });

        return ast;
    }

    _parseLineCommand(line) {
        // attacker / defender / settlement [name]
        const entityMatch = line.match(/^(attacker|defender|settlement)\s+(.+)$/i);
        if (entityMatch) {
            return {
                type: entityMatch[1].toLowerCase(),
                name: entityMatch[2].trim()
            };
        }

        // advance A -> B -> C  or   ru advance A -> B
        const advanceMatch = line.match(/^(ru|ua)?\s*advance\s+(.+)$/i);
        if (advanceMatch) {
            const side = advanceMatch[1] ? advanceMatch[1].toLowerCase() : null;
            const pathParts = advanceMatch[2].split('->').map(p => p.trim());
            return {
                type: 'advance',
                side: side,
                path: pathParts
            };
        }

        // (ru|ua)? note "content" at [location]
        const noteMatch = line.match(/^(ru|ua)?\s*note\s+["'](.+)["']\s+at\s+(.+)$/i);
        if (noteMatch) {
            const side = noteMatch[1] ? noteMatch[1].toLowerCase() : null;
            let locName = noteMatch[3].trim();
            const rawLoc = locName;
            let manualCoords = null;
            const coordMatch = locName.match(/^\[(.*?):\s*([-\d.]+)\s*,\s*([-\d.]+)\]$/);
            if (coordMatch) {
                locName = coordMatch[1].trim();
                manualCoords = [parseFloat(coordMatch[2]), parseFloat(coordMatch[3])];
            }
            return {
                type: 'note',
                side: side,
                content: noteMatch[2].trim(),
                location: locName,
                rawLocation: rawLoc,
                manualCoords: manualCoords
            };
        }

        return null;
    }

    // ─── RESOLVER ────────────────────────────────────────────
    findCoordinates(name) {
        if (!name) return null;

        // Handle manual coordinates syntax: [Title:lat,lon]
        const manualMatch = name.trim().match(/^\[(.*?):\s*([-\d.]+)\s*,\s*([-\d.]+)\]$/i);
        if (manualMatch) {
            return {
                latlng: [parseFloat(manualMatch[2]), parseFloat(manualMatch[3])],
                type: 'manual',
                name: manualMatch[1].trim()
            };
        }

        const searchName = name.toLowerCase().trim();

        // 1. Check Directions
        const dirs = {
            'n': [0, 0.05], 's': [0, -0.05], 'e': [0.05, 0], 'w': [-0.05, 0],
            'ne': [0.05, 0.05], 'nw': [-0.05, 0.05], 'se': [0.05, -0.05], 'sw': [-0.05, -0.05]
        };
        if (dirs[searchName]) {
            return { isDirection: true, offset: dirs[searchName] };
        }

        // 2. Check Settlements
        if (this.dashboard.settlementsData && this.dashboard.settlementsData.features) {
            const settlement = this.dashboard.settlementsData.features.find(f => {
                const props = f.properties;
                const local = (props.name || '').toLowerCase();
                const en = (props["name:en"] || '').toLowerCase();

                let matchName = false;
                if (searchName.includes('*')) {
                    const escaped = searchName.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(escaped.replace(/\*/g, '.*'), 'i');
                    matchName = regex.test(local) || regex.test(en);
                } else if (searchName.includes('"')) {
                    const location = searchName.slice(1, -1); // Remove quotes
                    matchName = local === location || en === location;
                } else {
                    matchName = local === searchName || en === searchName || local.includes(searchName) || en.includes(searchName);
                }

                if (!matchName) return false;

                let activeRegions = [];
                if (this.currentAst && this.currentAst.regions && this.currentAst.regions.length > 0) {
                    activeRegions = this.currentAst.regions;
                } else if (this.dashboard.currentPredefinedRegion) {
                    activeRegions = [this.dashboard.currentPredefinedRegion];
                }

                if (activeRegions.length > 0) {
                    const coords = f.geometry.coordinates;
                    const inRegion = activeRegions.some(r => 
                        typeof this.dashboard.isSettlementInPredefinedRegion === 'function' &&
                        this.dashboard.isSettlementInPredefinedRegion(coords, r)
                    );
                    if (!inRegion) return false;
                }

                return true;
            });
            if (settlement) {
                return {
                    latlng: [settlement.geometry.coordinates[1], settlement.geometry.coordinates[0]],
                    type: 'settlement',
                    name: settlement.properties["name:en"] || settlement.properties.name
                };
            }
        }

        // 3. Check Units (Positions)
        let foundUnit = null;
        [this.dashboard.dailyLayerUA, this.dashboard.dailyLayerRU].forEach(layerGroup => {
            if (!layerGroup || foundUnit) return;
            layerGroup.eachLayer(layer => {
                if (foundUnit) return;
                const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
                const uName = String(props.Name || props.name || props.unit || props.designation || '').toLowerCase();
                
                let matchUnit = false;
                if (searchName.includes('*')) {
                    const escaped = searchName.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(escaped.replace(/\*/g, '.*'), 'i');
                    matchUnit = regex.test(uName);
                } else {
                    matchUnit = uName === searchName || uName.includes(searchName);
                }

                if (uName && matchUnit) {
                    let coords = null;
                    if (layer.getLatLng) {
                        const ll = layer.getLatLng();
                        coords = [ll.lat, ll.lng];
                    } else if (layer.feature && layer.feature.geometry && layer.feature.geometry.coordinates) {
                        const c = layer.feature.geometry.coordinates;
                        if (Array.isArray(c) && c.length >= 2) {
                            coords = [c[1], c[0]];
                        }
                    }
                    if (coords) {
                        foundUnit = {
                            latlng: coords,
                            type: 'unit',
                            name: name.replace(/\*/g, '').replace(/\s+/g, ' ').trim()
                        };
                    }
                }
            });
        });

        if (foundUnit) return foundUnit;

        return null; // Not found
    }

    // ─── RENDERER ────────────────────────────────────────────
    draw(ast) {
        this.currentAst = ast;
        
        let globalBounds = L.latLngBounds();
        let missingEntities = new Set();
        let errorsFound = false;

        const hideMarkers = this.dashboard.getEl('map-uml-hide-markers')?.checked;
        const editMode = this.dashboard.getEl('map-uml-edit-mode')?.checked;

        const handleMissing = (name) => {
            missingEntities.add(name);
            errorsFound = true;
        };

        const processEntity = (item) => {
            const loc = this.findCoordinates(item.name);
            if (!loc) {
                handleMissing(item.name);
                return;
            }
            if (loc.isDirection) return;

            globalBounds.extend(loc.latlng);

            let color = this.colors.settlement;
            if (item.type === 'attacker') color = this.colors.attacker;
            if (item.type === 'defender') color = this.colors.defender;

            const radius = item.type === 'settlement' ? 6 : 8;
            let markerOpts = {
                radius: radius,
                fillColor: color,
                color: '#222',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.8
            };

            const marker = L.circleMarker(loc.latlng, markerOpts).addTo(this.layerGroup);

            if (!hideMarkers) {
                marker.bindTooltip(`<b>${loc.name || item.name}</b><br/><small>${item.type}</small>`, {
                    permanent: true,
                    direction: 'top',
                    offset: [0, -radius],
                    className: 'map-uml-tooltip'
                });
            }
        };

        const processAdvance = (advance) => {
            let latlngs = [];
            let lastValidLoc = null;
            let lineColor = this.colors.advance;

            if (advance.side === 'ru') lineColor = this.colors.attacker;
            if (advance.side === 'ua') lineColor = this.colors.defender;

            for (let i = 0; i < advance.path.length; i++) {
                const nodeName = advance.path[i];
                const loc = this.findCoordinates(nodeName);

                if (loc) {
                    if (loc.isDirection && lastValidLoc) {
                        // Direction: move offset from last known location
                        const offsetLat = lastValidLoc[0] + loc.offset[1];
                        const offsetLng = lastValidLoc[1] + loc.offset[0];
                        latlngs.push([offsetLat, offsetLng]);
                        globalBounds.extend([offsetLat, offsetLng]);
                    } else if (!loc.isDirection) {
                        latlngs.push(loc.latlng);
                        lastValidLoc = loc.latlng;
                        globalBounds.extend(loc.latlng);
                    }
                } else {
                    handleMissing(nodeName);
                }
            }

            if (latlngs.length >= 2) {
                // Draw polyline
                L.polyline(latlngs, {
                    color: lineColor,
                    weight: 4,
                    dashArray: '8, 8'
                }).addTo(this.layerGroup);

                // Draw arrowhead at end
                const end = latlngs[latlngs.length - 1];
                const prev = latlngs[latlngs.length - 2];
                this.drawArrowhead(prev, end, lineColor);
            }
        };

        const processNote = (note) => {
            const loc = this.findCoordinates(note.location);
            if (loc && !loc.isDirection) {
                globalBounds.extend(loc.latlng);

                let extraClass = '';
                if (note.side === 'ru') extraClass = ' map-uml-note-ru';
                if (note.side === 'ua') extraClass = ' map-uml-note-ua';

                const icon = L.divIcon({
                    className: 'map-uml-note' + extraClass,
                    html: `<div>${note.content}</div>`,
                    iconSize: [120, 40],
                    iconAnchor: [-15, 20] // Placed to the right side of the node
                });

                const marker = L.marker(loc.latlng, { 
                    icon: icon,
                    draggable: editMode 
                }).addTo(this.layerGroup);

                if (editMode) {
                    marker.on('dragend', (e) => {
                        const newLatlng = e.target.getLatLng();
                        this.updateNoteLocation(note, newLatlng);
                    });
                }
            } else if (!loc) {
                handleMissing(note.location);
            }
        };

        // Draw Global items
        ast.items.filter(i => ['attacker', 'defender', 'settlement'].includes(i.type)).forEach(processEntity);
        ast.items.filter(i => i.type === 'advance').forEach(processAdvance);
        ast.items.filter(i => i.type === 'note').forEach(processNote);

        // Draw Operation groups
        ast.operations.forEach(op => {
            if (op.advances) op.advances.forEach(processAdvance);
            if (op.notes) op.notes.forEach(processNote);
        });

        if (errorsFound) {
            alert("The following entities could not be resolved. Please check spelling or use manual coordinates like [Title:lat,lon]:\n\n- " + Array.from(missingEntities).join('\n- '));
        }

        // Fit map
        if (globalBounds.isValid()) {
            this.map.fitBounds(globalBounds, { padding: [50, 50], maxZoom: 13 });
        }
    }

    updateNoteLocation(note, latlng) {
        const el = this.dashboard.getEl('map-uml-input');
        if (!el) return;
        
        let text = el.value;
        const matchContent = note.content.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const matchRawLoc = note.rawLocation.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        
        // Match exact note line: e.g. note "Failed assault" at Kryva Luka
        const regex = new RegExp(`^(\\s*note\\s+["']${matchContent}["']\\s+at\\s+)${matchRawLoc}\\s*$`, 'im');
        
        const newLocString = `[${note.location}: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}]`;
        
        if (regex.test(text)) {
            el.value = text.replace(regex, `$1${newLocString}`);
            note.rawLocation = newLocString; // update for subsequent drags
        } else {
            console.warn("Could not find exact note line to update script location.");
        }
    }

    pickSettlementLocation(lat, lon, localName, enName) {
        const editMode = this.dashboard.getEl('map-uml-edit-mode')?.checked;
        if (!editMode) return;

        const el = this.dashboard.getEl('map-uml-input');
        if (!el) return;

        const preferredName = enName || localName;
        const coordStr = `[${preferredName}:${lat.toFixed(4)},${lon.toFixed(4)}]`;

        // Replace name occurrences that are NOT already inside [...] brackets
        const replaceOutsideBrackets = (text, name) => {
            if (!name) return { text, replaced: false };
            const escaped = name.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
            let replaced = false;
            const result = text.replace(regex, (match, offset) => {
                const before = text.substring(0, offset);
                const lastOpen = before.lastIndexOf('[');
                const lastClose = before.lastIndexOf(']');
                if (lastOpen > lastClose) return match; // already inside [...]
                replaced = true;
                return coordStr;
            });
            return { text: result, replaced };
        };

        let text = el.value;
        let result = replaceOutsideBrackets(text, enName);
        if (!result.replaced) result = replaceOutsideBrackets(text, localName);

        if (result.replaced) {
            el.value = result.text;
            this.dashboard.map.closePopup();
            const btn = this.dashboard.getEl('btn-render-mapuml');
            if (btn) btn.click();
        } else {
            console.warn(`MapUML: could not find "${localName}" / "${enName}" in script`);
        }
    }

    drawArrowhead(p1, p2, color) {
        // Compute angle
        const dy = p2[0] - p1[0];
        const dx = (p2[1] - p1[1]) * Math.cos(p1[0] * Math.PI / 180); // rudimentary Mercator scaling
        const angle = Math.atan2(dy, dx);

        // Offset coords to draw an arrow shape
        const len = 0.008; // length in degrees approx
        const arrowAngle = Math.PI / 6; // 30 degrees

        const pt1 = [
            p2[0] - len * Math.sin(angle - arrowAngle),
            p2[1] - (len * Math.cos(angle - arrowAngle)) / Math.cos(p2[0] * Math.PI / 180)
        ];
        const pt2 = [
            p2[0] - len * Math.sin(angle + arrowAngle),
            p2[1] - (len * Math.cos(angle + arrowAngle)) / Math.cos(p2[0] * Math.PI / 180)
        ];

        L.polygon([p2, pt1, pt2], {
            color: color,
            fillColor: color,
            fillOpacity: 1,
            weight: 1
        }).addTo(this.layerGroup);
    }
}

window.MapUMLEngine = MapUMLEngine;

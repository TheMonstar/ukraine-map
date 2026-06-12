// Hide & seek drone game: a squad of soldiers hides among trees and buildings,
// periodically relocating; when the drone gets near an exposed soldier he runs
// to the nearest cover and freezes. The player tags soldiers with F at close
// range; the score is the count-up completion time.

import * as THREE from 'three';
import { buildHumanoid } from './player.js';
import { SCENE_HALF } from './terrain.js';

const PLAY_RADIUS = 1000;  // m around scene center the squad is confined to
const TAG_RADIUS = 25;     // m drone→soldier distance for an F-tag
const FLEE_RADIUS = 120;   // m — exposed soldiers run for cover inside this
const SAFE_RADIUS = 250;   // m — soldiers only relocate when the drone is farther
const WALK_SPEED = 3;      // m/s
const FLEE_SPEED = 6;      // m/s
const FLEE_COOLDOWN = 8;   // s of guaranteed hiding after reaching cover

function formatTime(seconds) {
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class HideSeekGame {
    constructor(scene, terrain, vegetation, buildings, drone) {
        this.scene = scene;
        this.terrain = terrain;
        this.vegetation = vegetation;
        this.buildings = buildings;
        this.drone = drone;
        this.running = false;
        this.soldiers = [];
        this.coverPoints = [];
        this.elapsed = 0;
        this.found = 0;
        this.onEnd = null; // assigned by main.js to reset the Start button
        this.hud = document.getElementById('game-hud');
        this.hint = document.getElementById('game-hint');
        this.overlay = document.getElementById('game-over');
        this._dronePos = null;
        this.droneBeacon = null;
        this._onKeyDown = e => { if (e.code === 'KeyT') this._tryTag(); }; // F is drone-descend
    }

    // Tall translucent light beam marking a position for the observer view
    // (any non-drone camera while the game runs).
    _makeBeacon(color) {
        // wide tapered beam — must stay visible from a multi-km overview camera
        const beam = new THREE.Mesh(
            new THREE.CylinderGeometry(7, 1.2, 150, 8, 1, true),
            new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.5,
                depthWrite: false, side: THREE.DoubleSide
            }));
        beam.position.y = 75;
        beam.visible = false;
        return beam;
    }

    // Cover points: tree positions and spots just outside building corners,
    // confined to the play radius (the full 6 km map would be hopeless).
    _buildCoverPoints() {
        const points = [];
        const inPlay = p => Math.hypot(p.x, p.z) <= PLAY_RADIUS &&
            Math.abs(p.x) < SCENE_HALF - 10 && Math.abs(p.z) < SCENE_HALF - 10;

        const trees = (this.vegetation.placements || []).filter(inPlay);
        for (let i = 0; i < 300 && trees.length; i++) {
            points.push(trees[Math.floor(Math.random() * trees.length)]);
        }

        const footprints = (this.buildings.footprints || []).filter(f => f.length && inPlay(f[0]));
        for (let i = 0; i < 100 && footprints.length; i++) {
            const ring = footprints[Math.floor(Math.random() * footprints.length)];
            const v = ring[Math.floor(Math.random() * ring.length)];
            let cx = 0, cz = 0;
            ring.forEach(p => { cx += p.x; cz += p.z; });
            cx /= ring.length; cz /= ring.length;
            const dx = v.x - cx, dz = v.z - cz;
            const len = Math.hypot(dx, dz) || 1;
            const p = { x: v.x + dx / len * 3, z: v.z + dz / len * 3 };
            if (inPlay(p)) points.push(p);
        }

        if (points.length < 20) { // barren center: fall back to open-field spots
            for (let i = 0; i < 50; i++) {
                const a = Math.random() * Math.PI * 2, r = Math.random() * PLAY_RADIUS;
                points.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
            }
        }
        return points;
    }

    _randomCover() {
        return this.coverPoints[Math.floor(Math.random() * this.coverPoints.length)];
    }

    _randomCoverNear(position, maxDist) {
        const near = this.coverPoints.filter(p =>
            Math.hypot(p.x - position.x, p.z - position.z) <= maxDist);
        return near.length ? near[Math.floor(Math.random() * near.length)] : this._randomCover();
    }

    _nearestCover(position) {
        let best = this.coverPoints[0], bestD = Infinity;
        this.coverPoints.forEach(p => {
            const d = Math.hypot(p.x - position.x, p.z - position.z);
            if (d > 1 && d < bestD) { best = p; bestD = d; }
        });
        return best;
    }

    start(count) {
        this.stop();
        this.coverPoints = this._buildCoverPoints();
        for (let i = 0; i < count; i++) {
            const { group, legL, legR, armL, armR } = buildHumanoid();
            const spot = this._randomCover();
            group.position.set(spot.x, this.terrain.sampleHeight(spot.x, spot.z), spot.z);
            group.rotation.y = Math.random() * Math.PI * 2;
            this.scene.add(group);
            const beacon = this._makeBeacon(0xff9500); // orange, green once tagged
            group.add(beacon);
            this.soldiers.push({
                mesh: group, legL, legR, armL, armR,
                state: 'hiding', target: null, walkPhase: 0,
                cooldown: 0,
                nextRelocate: 5 + Math.random() * 20,
                tagged: false, marker: null, beacon
            });
        }
        this.droneBeacon = this._makeBeacon(0x36c5f0); // cyan — follows the drone
        this.scene.add(this.droneBeacon);
        this.found = 0;
        this.elapsed = 0;
        this.running = true;
        window.addEventListener('keydown', this._onKeyDown);
        this.hud.classList.remove('hidden');
        this.overlay.classList.add('hidden');
        this._updateHud();
    }

    stop() {
        this.running = false;
        window.removeEventListener('keydown', this._onKeyDown);
        if (this.droneBeacon) {
            this.scene.remove(this.droneBeacon);
            this.droneBeacon.geometry.dispose();
            this.droneBeacon.material.dispose();
            this.droneBeacon = null;
        }
        this.soldiers.forEach(s => {
            this.scene.remove(s.mesh);
            s.mesh.traverse(o => {
                if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
            });
        });
        this.soldiers = [];
        this.hud.classList.add('hidden');
        this.hint.classList.add('hidden');
    }

    update(dt, dronePos) {
        if (!this.running) return;
        this.elapsed += dt;
        this._dronePos = dronePos;
        let anyInRange = false;

        // observer view (any non-drone camera): reveal drone + soldier positions
        const observer = !dronePos;
        this.droneBeacon.visible = observer;
        this.droneBeacon.position.copy(this.drone.mesh.position);
        this.droneBeacon.position.y += 75;

        this.soldiers.forEach(s => {
            s.beacon.visible = observer;
            if (s.tagged) {
                if (s.marker) s.marker.rotation.z += dt * 2;
                return;
            }
            const droneDist = dronePos ? dronePos.distanceTo(s.mesh.position) : Infinity;
            if (droneDist < TAG_RADIUS) anyInRange = true;

            if (s.state === 'hiding') {
                s.nextRelocate -= dt;
                s.cooldown -= dt;
                if (s.nextRelocate <= 0 && droneDist > SAFE_RADIUS) {
                    s.target = this._randomCoverNear(s.mesh.position, 150);
                    s.state = 'relocating';
                }
            } else {
                if (s.state === 'relocating' && droneDist < FLEE_RADIUS && s.cooldown <= 0) {
                    s.target = this._nearestCover(s.mesh.position);
                    s.state = 'fleeing';
                }
                const speed = s.state === 'fleeing' ? FLEE_SPEED : WALK_SPEED;
                const dx = s.target.x - s.mesh.position.x;
                const dz = s.target.z - s.mesh.position.z;
                const dist = Math.hypot(dx, dz);
                if (dist < 0.5) {
                    s.state = 'hiding';
                    s.cooldown = FLEE_COOLDOWN;
                    s.nextRelocate = 15 + Math.random() * 20;
                    this._setSwing(s, 0);
                } else {
                    const step = Math.min(dist, speed * dt);
                    s.mesh.position.x += dx / dist * step;
                    s.mesh.position.z += dz / dist * step;
                    s.mesh.rotation.y = Math.atan2(dx, dz);
                    s.walkPhase += dt * (s.state === 'fleeing' ? 12 : 7);
                    this._setSwing(s, Math.sin(s.walkPhase) * 0.6);
                }
            }
            s.mesh.position.y = this.terrain.sampleHeight(s.mesh.position.x, s.mesh.position.z);
        });

        this.hint.classList.toggle('hidden', !anyInRange);
        this._updateHud();
    }

    _setSwing(s, swing) {
        s.legL.rotation.x = swing;
        s.legR.rotation.x = -swing;
        s.armL.rotation.x = -swing * 0.8;
        s.armR.rotation.x = swing * 0.8;
    }

    _tryTag() {
        if (!this.running || !this._dronePos) return;
        let best = null, bestD = TAG_RADIUS;
        this.soldiers.forEach(s => {
            if (s.tagged) return;
            const d = this._dronePos.distanceTo(s.mesh.position);
            if (d < bestD) { best = s; bestD = d; }
        });
        if (!best) return;
        best.tagged = true;
        best.state = 'tagged';
        this._setSwing(best, 0);
        best.marker = new THREE.Mesh(
            new THREE.TorusGeometry(0.5, 0.08, 8, 20),
            new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
        best.marker.rotation.x = Math.PI / 2;
        best.marker.position.y = 2.4;
        best.mesh.add(best.marker);
        best.beacon.material.color.set(0x34c759); // observer beam turns green when tagged
        this.found++;
        this._updateHud();
        if (this.found === this.soldiers.length) this._finish();
    }

    // Round complete: freeze the game but leave the tagged squad visible until
    // the overlay is closed (which calls stop()).
    _finish() {
        this.running = false;
        window.removeEventListener('keydown', this._onKeyDown);
        this.hint.classList.add('hidden');
        this.droneBeacon.visible = false;
        this.soldiers.forEach(s => { s.beacon.visible = false; });
        document.getElementById('game-over-text').textContent =
            `All ${this.soldiers.length} soldiers found in ${formatTime(this.elapsed)}!`;
        this.overlay.classList.remove('hidden');
        if (this.onEnd) this.onEnd();
    }

    _updateHud() {
        this.hud.textContent = `Found ${this.found}/${this.soldiers.length} · ${formatTime(this.elapsed)}`;
    }
}

// Walkable player character: low-poly humanoid with a walk cycle,
// WASD/arrow movement, terrain-following, building collision.

import * as THREE from 'three';

const SPEED = 12; // m/s
const PLAYER_RADIUS = 0.4;

// Ray-casting point-in-polygon test against a {x,z} ring (footprint outer ring).
function pointInPolygon(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
        const intersect = ((zi > z) !== (zj > z)) &&
            (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// "Little green man" palette: olive camo fatigues, darker vest, green helmet,
// balaclava-covered face, gunmetal rifle.
const SKIN = 0xd9a878;
const JACKET = 0x55603a;
const VEST = 0x434f2c;
const PANTS = 0x49513a;
const BOOTS = 0x2b2620;
const HELMET = 0x4a5a32;
const BALACLAVA = 0x39432a;
const GUNMETAL = 0x22262a;
const WOOD = 0x5a3c28;

function part(geometry, color) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mesh.castShadow = true;
    return mesh;
}

// Limb with its pivot at the joint (hip/shoulder), extending downward.
// Capsule segment instead of a box/cylinder so it reads rounded.
function limb(radius, length, color, jointX, jointY, opts = {}) {
    const pivot = new THREE.Group();
    pivot.position.set(jointX, jointY, 0);
    const seg = part(new THREE.CapsuleGeometry(radius, Math.max(0.05, length - radius * 2), 4, 10), color);
    seg.position.y = -length / 2;
    pivot.add(seg);
    if (opts.boot) {
        const boot = part(new THREE.CapsuleGeometry(radius * 0.95, radius * 1.5, 4, 10), BOOTS);
        boot.rotation.x = Math.PI / 2;
        boot.position.set(0, -length - 0.03, radius * 0.8);
        pivot.add(boot);
    }
    if (opts.hand) {
        const hand = part(new THREE.SphereGeometry(radius * 0.9, 10, 8), SKIN);
        hand.position.y = -length - 0.01;
        pivot.add(hand);
    }
    return pivot;
}

// Kalashnikov-ish rifle held across the chest (static — attached to the torso).
function buildRifle() {
    const rifle = new THREE.Group();
    const receiver = part(new THREE.BoxGeometry(0.05, 0.08, 0.46), GUNMETAL);
    const handguard = part(new THREE.CylinderGeometry(0.028, 0.028, 0.2, 8), WOOD);
    handguard.rotation.x = Math.PI / 2;
    handguard.position.z = 0.3;
    const barrel = part(new THREE.CylinderGeometry(0.013, 0.013, 0.3, 8), GUNMETAL);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.5;
    const stock = part(new THREE.BoxGeometry(0.035, 0.09, 0.24), WOOD);
    stock.position.set(0, -0.015, -0.32);
    const mag = part(new THREE.BoxGeometry(0.04, 0.17, 0.06), GUNMETAL);
    mag.position.set(0, -0.11, 0.1);
    mag.rotation.x = 0.45;
    const grip = part(new THREE.CylinderGeometry(0.022, 0.026, 0.1, 6), WOOD);
    grip.position.set(0, -0.08, -0.08);
    grip.rotation.x = -0.3;
    rifle.add(receiver, handguard, barrel, stock, mag, grip);
    return rifle;
}

// Group origin at the feet (y=0), facing +z.
// Exported so the hide & seek game (game.js) can spawn the same soldier model.
export function buildHumanoid() {
    const group = new THREE.Group();

    const legL = limb(0.125, 0.84, PANTS, -0.14, 0.88, { boot: true });
    const legR = limb(0.125, 0.84, PANTS, 0.14, 0.88, { boot: true });

    const hips = part(new THREE.CapsuleGeometry(0.21, 0.08, 4, 12), PANTS);
    hips.position.y = 0.92;

    const torso = part(new THREE.CapsuleGeometry(0.26, 0.14, 4, 12), JACKET);
    torso.position.y = 1.18;

    const belt = part(new THREE.CylinderGeometry(0.235, 0.245, 0.07, 12), VEST);
    belt.position.y = 0.98;

    // vest: flattened cylinder over the chest + a row of pouches
    const vest = part(new THREE.CylinderGeometry(0.275, 0.285, 0.34, 12), VEST);
    vest.scale.z = 0.82;
    vest.position.y = 1.25;
    const pouches = new THREE.Group();
    [-0.13, 0, 0.13].forEach(x => {
        const pouch = part(new THREE.CapsuleGeometry(0.045, 0.07, 3, 8), VEST);
        pouch.position.set(x, 1.2, 0.235);
        pouches.add(pouch);
    });

    const shoulderL = part(new THREE.SphereGeometry(0.1, 10, 8), JACKET);
    shoulderL.position.set(-0.3, 1.47, 0);
    const shoulderR = part(new THREE.SphereGeometry(0.1, 10, 8), JACKET);
    shoulderR.position.set(0.3, 1.47, 0);

    const armL = limb(0.085, 0.62, JACKET, -0.34, 1.46, { hand: true });
    const armR = limb(0.085, 0.62, JACKET, 0.34, 1.46, { hand: true });

    // balaclava head with a small exposed face patch, under a helmet with a rim
    const neck = part(new THREE.CylinderGeometry(0.09, 0.11, 0.1, 10), BALACLAVA);
    neck.position.y = 1.57;
    const head = part(new THREE.SphereGeometry(0.155, 14, 12), BALACLAVA);
    head.position.y = 1.69;
    const face = part(new THREE.SphereGeometry(0.1, 12, 10), SKIN);
    face.scale.set(0.85, 1, 0.6);
    face.position.set(0, 1.7, 0.095);
    const helmet = part(new THREE.SphereGeometry(0.185, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), HELMET);
    helmet.position.y = 1.72;
    const rim = part(new THREE.CylinderGeometry(0.19, 0.195, 0.035, 14), HELMET);
    rim.position.y = 1.73;

    const rifle = buildRifle();
    rifle.position.set(0.04, 1.16, 0.3);
    rifle.rotation.set(0.12, -0.85, 0.08);

    group.add(legL, legR, hips, torso, belt, vest, pouches,
        shoulderL, shoulderR, armL, armR, neck, head, face, helmet, rim, rifle);
    return { group, legL, legR, armL, armR };
}

export class Player {
    constructor() {
        const { group, legL, legR, armL, armR } = buildHumanoid();
        this.mesh = group; // origin at the feet
        this.legL = legL; this.legR = legR;
        this.armL = armL; this.armR = armR;
        this.walkPhase = 0;
        this.speedScale = 1; // set by the move-speed slider
        this.keys = new Set();
        this._onKeyDown = e => this.keys.add(e.code);
        this._onKeyUp = e => this.keys.delete(e.code);
    }

    enable() {
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    disable() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.keys.clear();
    }

    setPosition(x, z, terrain) {
        this.mesh.position.set(x, terrain.sampleHeight(x, z), z);
    }

    // forward/right are normalized XZ vectors derived from the camera direction.
    update(dt, terrain, buildingFootprints, forward, right, sceneHalf) {
        let dx = 0, dz = 0;
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { dx += forward.x; dz += forward.z; }
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { dx -= forward.x; dz -= forward.z; }
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { dx -= right.x; dz -= right.z; }
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { dx += right.x; dz += right.z; }

        const len = Math.hypot(dx, dz);
        const moving = len > 1e-4;
        if (moving) {
            dx /= len; dz /= len;
            const speed = SPEED * this.speedScale;
            const nx = THREE.MathUtils.clamp(this.mesh.position.x + dx * speed * dt, -sceneHalf + PLAYER_RADIUS, sceneHalf - PLAYER_RADIUS);
            const nz = THREE.MathUtils.clamp(this.mesh.position.z + dz * speed * dt, -sceneHalf + PLAYER_RADIUS, sceneHalf - PLAYER_RADIUS);

            if (!this._collidesBuilding(nx, nz, buildingFootprints)) {
                this.mesh.position.x = nx;
                this.mesh.position.z = nz;
            }
            this.mesh.rotation.y = Math.atan2(dx, dz);
        }

        this._animate(dt, moving);
        this.mesh.position.y = terrain.sampleHeight(this.mesh.position.x, this.mesh.position.z);
    }

    // Sinusoidal walk cycle: legs swing in opposition, arms counter-swing.
    _animate(dt, moving) {
        if (moving) {
            this.walkPhase += dt * 9 * Math.min(this.speedScale, 2); // cap cadence so legs don't blur
            const swing = Math.sin(this.walkPhase) * 0.65;
            this.legL.rotation.x = swing;
            this.legR.rotation.x = -swing;
            this.armL.rotation.x = -swing * 0.8;
            this.armR.rotation.x = swing * 0.8;
        } else {
            const ease = Math.min(1, dt * 10);
            [this.legL, this.legR, this.armL, this.armR].forEach(l => {
                l.rotation.x += (0 - l.rotation.x) * ease;
            });
        }
    }

    _collidesBuilding(x, z, buildingFootprints) {
        for (const footprint of buildingFootprints) {
            if (pointInPolygon(x, z, footprint)) return true;
        }
        return false;
    }
}

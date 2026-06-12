// Flyable quadcopter drone: WASD/arrow horizontal movement (camera-relative),
// R/F for altitude, smoothed velocity, banking tilt, spinning rotors.
// Q/E camera rotation is handled by the render loop in main.js.

import * as THREE from 'three';

const H_SPEED = 28;        // m/s horizontal
const V_SPEED = 14;        // m/s vertical
const MIN_CLEARANCE = 1.5; // m above terrain
const MAX_ALTITUDE = 1200; // m absolute ceiling

const BODY_COLOR = 0x2e3338;
const ARM_COLOR = 0x44494f;
const ROTOR_COLOR = 0x1c1f22;

function part(geometry, color, opacity) {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    if (opacity !== undefined) {
        material.transparent = true;
        material.opacity = opacity;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    return mesh;
}

// Group origin at the body center, facing +z. Returns rotors for spin animation.
function buildQuadcopter() {
    const group = new THREE.Group();

    const body = part(new THREE.BoxGeometry(0.7, 0.22, 0.9), BODY_COLOR);
    group.add(body);
    const gimbal = part(new THREE.SphereGeometry(0.14, 10, 8), 0x111418);
    gimbal.position.set(0, -0.16, 0.38);
    group.add(gimbal);

    const rotors = [];
    [[-0.65, 0.65], [0.65, 0.65], [-0.65, -0.65], [0.65, -0.65]].forEach(([x, z]) => {
        const arm = part(new THREE.CylinderGeometry(0.045, 0.045, Math.hypot(x, z), 6), ARM_COLOR);
        arm.rotation.z = Math.PI / 2;
        arm.rotation.y = -Math.atan2(z, x);
        arm.position.set(x / 2, 0.02, z / 2);
        group.add(arm);

        const hub = part(new THREE.CylinderGeometry(0.07, 0.09, 0.14, 8), BODY_COLOR);
        hub.position.set(x, 0.09, z);
        group.add(hub);

        // spinning rotor: translucent disc reads as a blurred prop
        const rotor = part(new THREE.CylinderGeometry(0.45, 0.45, 0.02, 16), ROTOR_COLOR, 0.45);
        rotor.castShadow = false;
        rotor.position.set(x, 0.17, z);
        rotors.push(rotor);
        group.add(rotor);

        const blade = part(new THREE.BoxGeometry(0.85, 0.015, 0.07), ROTOR_COLOR);
        blade.position.y = 0.02;
        rotor.add(blade);
    });

    return { group, rotors };
}

export class Drone {
    constructor() {
        const { group, rotors } = buildQuadcopter();
        this.mesh = group;
        this.mesh.rotation.order = 'YXZ'; // yaw, then pitch into the direction of motion
        this.rotors = rotors;
        this.velocity = new THREE.Vector3();
        this.speedScale = 1; // set by the move-speed slider
        this._yaw = 0;
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
        this.velocity.set(0, 0, 0);
    }

    setPosition(x, z, terrain) {
        this.mesh.position.set(x, terrain.sampleHeight(x, z) + 30, z);
    }

    // forward/right are normalized XZ vectors derived from the camera direction.
    update(dt, terrain, forward, right, sceneHalf) {
        let dx = 0, dz = 0, dy = 0;
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { dx += forward.x; dz += forward.z; }
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { dx -= forward.x; dz -= forward.z; }
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { dx -= right.x; dz -= right.z; }
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { dx += right.x; dz += right.z; }
        if (this.keys.has('KeyR')) dy += 1;
        if (this.keys.has('KeyF')) dy -= 1;

        const len = Math.hypot(dx, dz);
        if (len > 1e-4) { dx /= len; dz /= len; }

        const target = new THREE.Vector3(dx * H_SPEED, dy * V_SPEED, dz * H_SPEED).multiplyScalar(this.speedScale);
        this.velocity.lerp(target, Math.min(1, dt * 4));

        const pos = this.mesh.position;
        pos.x = THREE.MathUtils.clamp(pos.x + this.velocity.x * dt, -sceneHalf, sceneHalf);
        pos.z = THREE.MathUtils.clamp(pos.z + this.velocity.z * dt, -sceneHalf, sceneHalf);
        pos.y = THREE.MathUtils.clamp(pos.y + this.velocity.y * dt,
            terrain.sampleHeight(pos.x, pos.z) + MIN_CLEARANCE, MAX_ALTITUDE);

        // face and bank into the direction of motion
        const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        if (hSpeed > 0.5) this._yaw = Math.atan2(this.velocity.x, this.velocity.z);
        this.mesh.rotation.y = this._yaw;
        this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, Math.min(0.35, hSpeed * 0.012), Math.min(1, dt * 6));

        const spin = (20 + hSpeed * 2 + Math.abs(this.velocity.y) * 2) * dt;
        this.rotors.forEach((r, i) => { r.rotation.y += (i % 2 ? spin : -spin); });
    }
}

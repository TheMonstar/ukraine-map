import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeProjection } from './geo.js';
import { TerrainBuilder, SCENE_SIZE, SCENE_HALF, setSceneSize } from './terrain.js';
import { fetchMapFeatures } from './data-sources.js';
import { RoadsFeature } from './features/roads.js';
import { WaterFeature } from './features/water.js';
import { DitchesFeature } from './features/ditches.js';
import { BuildingsFeature } from './features/buildings.js';
import { VegetationFeature } from './features/vegetation.js';
import { GrassFeature } from './features/grass.js';
import { SettlementsFeature } from './features/settlements.js';
import { DeepStateFeature } from './features/deepstate.js';
import { FortificationsFeature } from './features/fortifications.js';
import { WaterLabelsFeature } from './features/water-labels.js';
import { Player } from './player.js';
import { Drone } from './drone.js';
import { HideSeekGame } from './game.js';
import { Sandbox } from './sandbox/sandbox.js';

function showError(msg) {
    const banner = document.getElementById('error-banner');
    banner.textContent = msg;
    banner.classList.add('visible');
}

function setStep(name, state) {
    const el = document.querySelector(`#loading-steps .step[data-step="${name}"]`);
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    el.classList.add(state);
}

function hideLoadingOverlay() {
    document.getElementById('loading-overlay').classList.add('hidden');
}

async function init() {
    // Panel minimize toggle (works regardless of scene load state)
    const panel = document.querySelector('.panel');
    const panelToggle = document.getElementById('panel-toggle');
    panelToggle.addEventListener('click', () => {
        const collapsed = panel.classList.toggle('collapsed');
        panelToggle.innerHTML = collapsed ? '&plus;' : '&minus;';
        panelToggle.title = collapsed ? 'Expand panel' : 'Minimize panel';
    });

    const params = new URLSearchParams(location.search);
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    let size = parseFloat(params.get('size') || '5');
    if (!isFinite(size) || size <= 0) size = 5;
    size = Math.min(15, size); // cap coverage (DEM/Overpass load grows with area)
    const date = params.get('date') || new Date().toISOString().slice(0, 10);

    if (!isFinite(lat) || !isFinite(lng)) {
        showError('Missing or invalid lat/lng parameters.');
        hideLoadingOverlay();
        return;
    }

    setSceneSize(size); // must run before any SCENE_SIZE/SCENE_HALF reads below

    document.getElementById('info-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)} (${size} km)`;
    document.getElementById('info-date').textContent = date;

    // Area-size selector: reload the page with a new tile size.
    const areaSizeSelect = document.getElementById('area-size');
    if (![...areaSizeSelect.options].some(o => o.value === String(size))) {
        areaSizeSelect.add(new Option(`${size} km`, String(size)), 0);
    }
    areaSizeSelect.value = String(size);
    areaSizeSelect.addEventListener('change', () => {
        const p = new URLSearchParams(location.search);
        p.set('size', areaSizeSelect.value);
        location.search = p.toString();
    });

    const proj = makeProjection(lat, lng);

    // ── Renderer / scene / camera ──────────────────────────────────────────
    const canvas = document.getElementById('scene-canvas');
    // preserveDrawingBuffer: the sandbox screenshot export reads the canvas back with
    // toDataURL, which returns a blank image without it.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fc5e8);
    const fog = new THREE.Fog(0x9fc5e8, SCENE_SIZE * 0.6, SCENE_SIZE * 1.6);
    scene.fog = fog;

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, SCENE_SIZE * 10);
    camera.position.set(0, 2500, 3500);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = 0.49 * Math.PI;
    controls.minDistance = 200;
    controls.maxDistance = 12000;
    controls.target.set(0, 0, 0);

    // ── Lighting ────────────────────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556b2f, 0.7));
    const sun = new THREE.DirectionalLight(0xfff8e7, 1.2);
    sun.position.set(SCENE_SIZE * 0.3, SCENE_SIZE * 0.6, SCENE_SIZE * 0.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -SCENE_HALF;
    sun.shadow.camera.right = SCENE_HALF;
    sun.shadow.camera.top = SCENE_HALF;
    sun.shadow.camera.bottom = -SCENE_HALF;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = SCENE_SIZE * 2;
    sun.shadow.bias = -0.0015;
    scene.add(sun);
    scene.add(sun.target);

    // ── Sky + sun position (driven by time-of-day slider) ──────────────────
    const sky = new Sky();
    sky.scale.setScalar(SCENE_SIZE * 8);
    scene.add(sky);
    const skyUniforms = sky.material.uniforms;
    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 2;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;

    const sunDir = new THREE.Vector3();
    function updateSun(hours) {
        const elevationDeg = Math.max(1, 60 * Math.sin(Math.PI * (hours - 5) / 16));
        const azimuthDeg = 90 + 180 * (hours - 5) / 16;
        const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
        const theta = THREE.MathUtils.degToRad(azimuthDeg);
        sunDir.setFromSphericalCoords(1, phi, theta);
        skyUniforms['sunPosition'].value.copy(sunDir);

        sun.position.copy(sunDir).multiplyScalar(SCENE_SIZE);
        sun.target.position.set(0, 0, 0);

        const t = THREE.MathUtils.clamp(elevationDeg / 60, 0, 1);
        sun.intensity = 0.4 + t * 1.2;
        sun.color.setHSL(0.1 - t * 0.05, 0.5, 0.5 + t * 0.4);

        fog.color.setHSL(0.58, 0.4, 0.25 + t * 0.55);
        renderer.toneMappingExposure = 0.4 + t * 0.6;
    }
    updateSun(13);

    // ── Terrain ─────────────────────────────────────────────────────────────
    setStep('dem', 'active');
    const terrain = new TerrainBuilder(proj);
    try {
        await terrain.build();
        setStep('dem', 'done');
        setStep('mesh', 'done');
        terrain.mesh.castShadow = true;
        terrain.mesh.receiveShadow = true;
        scene.add(terrain.mesh);
    } catch (e) {
        console.error('Terrain build failed:', e);
        setStep('dem', 'error');
        setStep('mesh', 'error');
        showError('Failed to load terrain elevation data. Check console for details.');
        hideLoadingOverlay();
        return;
    }

    // ── Ground apron ────────────────────────────────────────────────────────
    // A large plane at the terrain's base level extending past the horizon, so the
    // tile sits on continuous ground instead of floating in the sky ("flying" look).
    // Fog fades its far edge into the sky; its height follows the exaggeration slider.
    let terrainMinH = Infinity;
    for (const h of terrain.heightmap) if (h < terrainMinH) terrainMinH = h;
    if (!isFinite(terrainMinH)) terrainMinH = 0;
    const apron = new THREE.Mesh(
        new THREE.PlaneGeometry(SCENE_SIZE * 12, SCENE_SIZE * 12),
        new THREE.MeshStandardMaterial({ color: 0x6a7250, roughness: 1, metalness: 0 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = terrainMinH * terrain.exaggeration - 4;
    apron.receiveShadow = true;
    scene.add(apron);

    setStep('satellite', 'active');
    try {
        const ok = await terrain.applySatellite();
        setStep('satellite', ok ? 'done' : 'error');
    } catch (e) {
        console.warn('Satellite imagery failed:', e);
        setStep('satellite', 'error');
    }

    // ── Vector features: roads, water, ditches ─────────────────────────────
    setStep('vectors', 'active');
    const bbox = proj.bbox(SCENE_HALF);
    const roads = new RoadsFeature();
    const water = new WaterFeature();
    const ditches = new DitchesFeature();
    const buildings = new BuildingsFeature();
    const vegetation = new VegetationFeature();
    const grass = new GrassFeature();
    const settlements = new SettlementsFeature();
    const deepstate = new DeepStateFeature();
    const waterLabels = new WaterLabelsFeature();
    const wireLayer = new FortificationsFeature('wire');
    const teethLayer = new FortificationsFeature('teeth');
    const features = [roads, water, ditches, buildings, vegetation, grass, settlements, deepstate, waterLabels, wireLayer, teethLayer];

    const [mapFeatures] = await Promise.all([
        fetchMapFeatures(bbox).catch(e => { console.warn('Overpass map features failed:', e); return null; }),
        roads.load(bbox).catch(e => { console.warn('Roads fetch failed:', e); }),
        ditches.load(bbox, date)
    ]);

    if (ditches.featureCollection?.features?.length) {
        terrain.carveTrenches(ditches.featureCollection, proj);
    }

    await Promise.all([
        water.load(bbox, mapFeatures),
        waterLabels.load(bbox, mapFeatures),
        buildings.load(bbox, mapFeatures),
        vegetation.load(bbox, mapFeatures),
        grass.load(bbox, mapFeatures),
        settlements.load(bbox),
        deepstate.load(date)
    ]);

    let hadError = mapFeatures === null;
    features.forEach(f => {
        try {
            f.build(terrain, proj);
            scene.add(f.group);
        } catch (e) {
            console.warn(`${f.group.name} build failed:`, e);
            hadError = true;
        }
    });
    setStep('vectors', hadError ? 'error' : 'done');

    document.getElementById('layer-roads').addEventListener('change', e => { roads.group.visible = e.target.checked; });
    document.getElementById('layer-water').addEventListener('change', e => { water.group.visible = e.target.checked; });
    document.getElementById('layer-ditches').addEventListener('change', e => { ditches.group.visible = e.target.checked; });
    document.getElementById('layer-buildings').addEventListener('change', e => { buildings.group.visible = e.target.checked; });
    document.getElementById('layer-vegetation').addEventListener('change', e => { vegetation.group.visible = e.target.checked; });
    document.getElementById('layer-grass').addEventListener('change', e => { grass.group.visible = e.target.checked; });
    document.getElementById('layer-settlements').addEventListener('change', e => { settlements.group.visible = e.target.checked; });
    document.getElementById('layer-river-names').addEventListener('change', e => { waterLabels.group.visible = e.target.checked; });
    document.getElementById('layer-deepstate').addEventListener('change', e => { deepstate.group.visible = e.target.checked; });
    // Wire and teeth are fetched lazily — the PlayFra source files are several MB,
    // so nothing is downloaded unless the layer is actually switched on.
    [[wireLayer, 'layer-wire'], [teethLayer, 'layer-teeth']].forEach(([layer, id]) => {
        const checkbox = document.getElementById(id);
        checkbox.addEventListener('change', async e => {
            if (!e.target.checked) { layer.group.visible = false; return; }
            const hint = document.getElementById('sandbox-hint');
            checkbox.disabled = true;
            hint.textContent = `Loading ${layer.type}…`;
            const status = await layer.ensure(terrain, proj, bbox);
            checkbox.disabled = false;
            layer.group.visible = checkbox.checked;
            // Report to the UI, not just the console: a belt is only ~1 px from the
            // overview camera, so "nothing happened" is otherwise indistinguishable
            // from "this sector has no obstacles mapped".
            hint.textContent = status;
        });
    });
    document.getElementById('layer-glow').addEventListener('change', e => { scene.fog = e.target.checked ? fog : null; });

    setStep('scene', 'active');

    // ── Tactical sandbox (draw / mark / destroy / fortify / export) ─────────
    const sandbox = new Sandbox({
        canvas, scene, camera, controls, renderer, terrain, proj, buildings, ditches, vegetation,
        info: {
            lat, lng, size,
            title: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
            subtitle: `${size} km sector · ${date} · Ukraine Frontline Map`
        }
    });
    scene.add(sandbox.group);

    // ── Exaggeration slider ────────────────────────────────────────────────
    const slider = document.getElementById('exaggeration-slider');
    const valueLabel = document.getElementById('exaggeration-value');
    slider.addEventListener('input', () => {
        const k = parseFloat(slider.value);
        valueLabel.textContent = k.toFixed(1);
        terrain.setExaggeration(k);
        features.forEach(f => f.reDrape(terrain));
        sandbox.reDrape(terrain);
        apron.position.y = terrainMinH * k - 4;
    });

    // ── Time of day slider ──────────────────────────────────────────────────
    const timeSlider = document.getElementById('time-slider');
    const timeValue = document.getElementById('time-value');
    timeSlider.addEventListener('input', () => {
        const h = parseFloat(timeSlider.value);
        const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        timeValue.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        updateSun(h);
    });

    // ── Shadow quality select ───────────────────────────────────────────────
    document.getElementById('shadow-quality').addEventListener('change', e => {
        const v = e.target.value;
        if (v === 'off') {
            renderer.shadowMap.enabled = false;
        } else {
            renderer.shadowMap.enabled = true;
            sun.shadow.mapSize.set(v === 'high' ? 4096 : 2048, v === 'high' ? 4096 : 2048);
            if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
        }
    });

    // ── Walk & drone modes (third-person follow) ────────────────────────────
    const player = new Player();
    const drone = new Drone();
    let walkMode = false, droneMode = false, freecamMode = false;
    const modeHint = document.getElementById('walk-hint');
    const walkCheckbox = document.getElementById('walk-mode');
    const droneCheckbox = document.getElementById('drone-mode');
    const freecamCheckbox = document.getElementById('freecam-mode');
    const overviewCamPos = camera.position.clone();
    const overviewMinDistance = controls.minDistance;
    const overviewMaxDistance = controls.maxDistance;

    // close third-person view on subject; targetLift aims above the subject origin
    function enterFollow(subject, targetLift, camBack, maxDistance) {
        controls.target.copy(subject.mesh.position);
        controls.target.y += targetLift;
        controls.minDistance = 3;
        controls.maxDistance = maxDistance;
        camera.position.set(
            subject.mesh.position.x,
            subject.mesh.position.y + targetLift + camBack * 0.5,
            subject.mesh.position.z + camBack
        );
    }

    function exitFollow() {
        controls.minDistance = overviewMinDistance;
        controls.maxDistance = overviewMaxDistance;
        camera.position.copy(overviewCamPos);
        controls.target.set(0, 0, 0);
    }

    const speedSlider = document.getElementById('speed-slider');
    const speedValue = document.getElementById('speed-value');
    let moveSpeedScale = 1;
    speedSlider.addEventListener('input', () => {
        const k = parseFloat(speedSlider.value);
        speedValue.textContent = k.toFixed(1);
        player.speedScale = k;
        drone.speedScale = k;
        moveSpeedScale = k;
    });

    // The sandbox owns the pointer only in overview; walk/drone/freecam take it back.
    function syncSandbox() {
        sandbox.setEnabled(!(walkMode || droneMode || freecamMode));
    }

    // walk / drone / free camera are mutually exclusive
    function uncheckOthers(self) {
        [walkCheckbox, droneCheckbox, freecamCheckbox].forEach(cb => {
            if (cb !== self && cb.checked) {
                cb.checked = false;
                cb.dispatchEvent(new Event('change'));
            }
        });
    }

    walkCheckbox.addEventListener('change', e => {
        if (e.target.checked) uncheckOthers(walkCheckbox);
        walkMode = e.target.checked;
        modeHint.classList.toggle('hidden', !walkMode);
        if (walkMode) {
            modeHint.textContent = 'WASD / Arrow keys to move · Q/E rotate · drag to look · scroll to zoom';
            player.setPosition(controls.target.x, controls.target.z, terrain);
            scene.add(player.mesh);
            player.enable();
            enterFollow(player, 1.5, 8, 60);
        } else {
            player.disable();
            scene.remove(player.mesh);
            exitFollow();
        }
        syncSandbox();
    });

    droneCheckbox.addEventListener('change', e => {
        if (e.target.checked) uncheckOthers(droneCheckbox);
        droneMode = e.target.checked;
        modeHint.classList.toggle('hidden', !droneMode);
        if (droneMode) {
            modeHint.textContent = 'WASD to fly · R/F up & down · Q/E rotate · drag to look';
            drone.setPosition(controls.target.x, controls.target.z, terrain);
            scene.add(drone.mesh);
            drone.enable();
            enterFollow(drone, 0, 14, 200);
        } else {
            drone.disable();
            scene.remove(drone.mesh);
            exitFollow();
        }
        syncSandbox();
    });

    // Free camera: fly the view itself with WASD + R/F; the camera keeps its
    // current position on entry. The orbit target is pulled right in front of
    // the camera so drag-to-look pivots the view in place (FPS look) rather than
    // orbiting the map center; camera and target then move by the same delta.
    const FREECAM_SPEED = 80; // m/s at 1× move speed
    const FREECAM_LOOK_DIST = 10; // m — orbit pivot just ahead of the camera
    const freecamKeys = new Set();
    const onFreecamKeyDown = e => freecamKeys.add(e.code);
    const onFreecamKeyUp = e => freecamKeys.delete(e.code);
    freecamCheckbox.addEventListener('change', e => {
        if (e.target.checked) uncheckOthers(freecamCheckbox);
        freecamMode = e.target.checked;
        modeHint.classList.toggle('hidden', !freecamMode);
        if (freecamMode) {
            modeHint.textContent = 'WASD to move · R/F up & down · Q/E rotate · drag to look';
            // Pull the orbit pivot to just ahead of the camera along the current
            // view direction, so drag-to-look turns in place. Preserve the exact
            // look direction so the view doesn't jump on entry.
            const forward = new THREE.Vector3().subVectors(controls.target, camera.position);
            if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
            forward.normalize();
            controls.target.copy(camera.position).addScaledVector(forward, FREECAM_LOOK_DIST);
            controls.minDistance = 1;
            controls.maxDistance = 1000;
            window.addEventListener('keydown', onFreecamKeyDown);
            window.addEventListener('keyup', onFreecamKeyUp);
        } else {
            window.removeEventListener('keydown', onFreecamKeyDown);
            window.removeEventListener('keyup', onFreecamKeyUp);
            freecamKeys.clear();
            exitFollow();
        }
        syncSandbox();
    });

    // ── Hide & seek game ────────────────────────────────────────────────────
    const game = new HideSeekGame(scene, terrain, vegetation, buildings, drone);
    const gameStartBtn = document.getElementById('game-start');
    const gameCount = document.getElementById('game-count');
    gameStartBtn.addEventListener('click', () => {
        if (game.running) {
            game.stop();
            gameStartBtn.textContent = 'Start';
        } else {
            if (!droneCheckbox.checked) {
                droneCheckbox.checked = true;
                droneCheckbox.dispatchEvent(new Event('change'));
            }
            game.start(parseInt(gameCount.value, 10));
            gameStartBtn.textContent = 'Stop';
        }
    });
    game.onEnd = () => { gameStartBtn.textContent = 'Start'; };
    document.getElementById('game-over-close').addEventListener('click', () => {
        document.getElementById('game-over').classList.add('hidden');
        game.stop(); // clears the tagged squad from the scene
    });

    // ── Resize ──────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    setStep('scene', 'done');
    hideLoadingOverlay();
    sandbox.restoreAutosave();

    // ── Render loop ─────────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    const YAW_SPEED = 1.8; // rad/s for Q/E camera rotation
    const UP = new THREE.Vector3(0, 1, 0);
    // Orbit the camera around the controls target; movement is camera-relative,
    // so this also turns the heading in walk/drone/freecam modes.
    function applyYaw(keys, dt) {
        let r = 0;
        if (keys.has('KeyQ')) r += 1;
        if (keys.has('KeyE')) r -= 1;
        if (!r) return;
        const offset = camera.position.clone().sub(controls.target);
        offset.applyAxisAngle(UP, r * YAW_SPEED * dt);
        camera.position.copy(controls.target).add(offset);
    }
    function animate() {
        requestAnimationFrame(animate);
        const dt = clock.getDelta();
        controls.update();
        water.update(clock.elapsedTime);
        game.update(dt, droneMode ? drone.mesh.position : null);
        sandbox.update();

        // Enlarge trees as the camera pulls back so the canopy stays readable and the
        // terrain feels 3D from far; ~1× up close, up to ~2.2× when fully zoomed out.
        const camDist = camera.position.distanceTo(controls.target);
        vegetation.setZoomScale(1 + THREE.MathUtils.clamp((camDist - 600) / 7400, 0, 1) * 1.2);

        if (walkMode || droneMode) {
            applyYaw((walkMode ? player : drone).keys, dt);
            const subject = walkMode ? player : drone;
            const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
            dir.y = 0;
            if (dir.lengthSq() > 1e-6) dir.normalize(); else dir.set(0, 0, -1);
            const right = new THREE.Vector3(-dir.z, 0, dir.x);

            const before = subject.mesh.position.clone();
            if (walkMode) player.update(dt, terrain, buildings.footprints, dir, right, SCENE_HALF);
            else drone.update(dt, terrain, dir, right, SCENE_HALF);
            const moved = subject.mesh.position.clone().sub(before);

            camera.position.add(moved);
            controls.target.add(moved);
            controls.target.y = subject.mesh.position.y + (walkMode ? 1.5 : 0);
        } else if (freecamMode) {
            applyYaw(freecamKeys, dt);
            const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
            dir.y = 0;
            if (dir.lengthSq() > 1e-6) dir.normalize(); else dir.set(0, 0, -1);
            const right = new THREE.Vector3(-dir.z, 0, dir.x);

            let dx = 0, dz = 0, dy = 0;
            if (freecamKeys.has('KeyW') || freecamKeys.has('ArrowUp')) { dx += dir.x; dz += dir.z; }
            if (freecamKeys.has('KeyS') || freecamKeys.has('ArrowDown')) { dx -= dir.x; dz -= dir.z; }
            if (freecamKeys.has('KeyA') || freecamKeys.has('ArrowLeft')) { dx -= right.x; dz -= right.z; }
            if (freecamKeys.has('KeyD') || freecamKeys.has('ArrowRight')) { dx += right.x; dz += right.z; }
            if (freecamKeys.has('KeyR')) dy += 1;
            if (freecamKeys.has('KeyF')) dy -= 1;

            const len = Math.hypot(dx, dz);
            if (len > 1e-4) { dx /= len; dz /= len; }
            if (len > 1e-4 || dy !== 0) {
                const s = FREECAM_SPEED * moveSpeedScale * dt;
                const next = camera.position.clone();
                next.x = THREE.MathUtils.clamp(next.x + dx * s, -SCENE_HALF, SCENE_HALF);
                next.z = THREE.MathUtils.clamp(next.z + dz * s, -SCENE_HALF, SCENE_HALF);
                next.y += dy * s;
                next.y = Math.max(next.y, terrain.sampleHeight(next.x, next.z) + 2);
                const moved = next.sub(camera.position);
                camera.position.add(moved);
                controls.target.add(moved);
            }
        }

        renderer.render(scene, camera);
    }
    animate();
}

init();

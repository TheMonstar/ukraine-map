// Capture Mala Tokmachka: the game page (mala-tokmachka.html). Builds the village on its fixed
// frame from the presaved field pack (heights, roads, buildings, woods and fields) plus live
// satellite imagery, then hands the scene to the game. The 3D viewer's terrain, imagery and
// scenery modules are reused as they are; nothing of the viewer page (panel, sandbox, walk and
// drone modes, water) is loaded.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeProjection } from '../geo.js';
import { TerrainBuilder, SCENE_SIZE, SCENE_HALF, setSceneSize } from '../terrain.js';
import { RoadsFeature } from '../features/roads.js';
import { BuildingsFeature } from '../features/buildings.js';
import { VegetationFeature } from '../features/vegetation.js';
import { GrassFeature } from '../features/grass.js';
import { MALA_TOKMACHKA as PRESET } from './mala-tokmachka.js';
import { loadFieldPack } from './field-pack.js';
import { CaptureGame } from './capture.js';

const status = document.getElementById('cap-loading-text');

function fail(text, err) {
    if (err) console.error(err);
    status.textContent = text;
    document.getElementById('cap-loading').classList.add('failed');
}

async function init() {
    const { lat, lng, size } = PRESET.frame;
    setSceneSize(size);                       // before any SCENE_SIZE / SCENE_HALF read
    const proj = makeProjection(lat, lng);
    const pack = await loadFieldPack({ lat, lng, size, sceneSize: SCENE_SIZE });
    if (!pack) return fail('Could not load the village. Check your connection and reload the page.');

    // ── renderer, scene, camera ──────────────────────────────────────────────
    const canvas = document.getElementById('cap-canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const fog = new THREE.Fog(0x9fc5e8, SCENE_SIZE * 0.6, SCENE_SIZE * 1.6);
    scene.fog = fog;

    // near 25 m: the game never zooms closer than 200 m, and a 1 m near plane leaves ~1 m of
    // depth precision at a few km, enough for the ground apron and road ribbons to flicker
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 25, SCENE_SIZE * 10);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = 0.49 * Math.PI;
    controls.minDistance = 200;
    controls.maxDistance = 12000;
    // left button / one finger pans the map, the right button turns it; clicks are the game's
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.screenSpacePanning = false;

    // ── light and sky: early afternoon, as the viewer opens ──────────────────
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556b2f, 0.7));
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(30), Math.PI);
    const sun = new THREE.DirectionalLight(0xfff8e7, 1.6);
    sun.color.setHSL(0.05, 0.5, 0.9);
    sun.position.copy(sunDir).multiplyScalar(SCENE_SIZE);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -SCENE_HALF, right: SCENE_HALF, top: SCENE_HALF, bottom: -SCENE_HALF, near: 1, far: SCENE_SIZE * 2 });
    sun.shadow.bias = -0.0015;
    scene.add(sun, sun.target);
    fog.color.setHSL(0.58, 0.4, 0.8);

    const sky = new Sky();
    sky.scale.setScalar(SCENE_SIZE * 8);
    const u = sky.material.uniforms;
    u.turbidity.value = 10;
    u.rayleigh.value = 2;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDir);
    scene.add(sky);

    // ── the village ──────────────────────────────────────────────────────────
    status.textContent = 'Building the village…';
    const terrain = new TerrainBuilder(proj);
    // the pack's heights stand in for the DEM download (scripts/capture-field.mjs saved this grid)
    if (pack.heights.length !== terrain.heightmap.length) return fail('The village data does not fit this terrain grid: rebuild it with scripts/capture-field.mjs.');
    terrain._buildHeightmap = async () => { terrain.heightmap.set(pack.heights); };
    try {
        await terrain.build();
    } catch (err) {
        return fail('Could not build the village. Reload the page to try again.', err);
    }
    terrain.mesh.castShadow = terrain.mesh.receiveShadow = true;
    scene.add(terrain.mesh);

    // ground past the edge of the field, so the village doesn't float in the sky
    let minH = Infinity;
    for (const h of terrain.heightmap) if (h < minH) minH = h;
    const apron = new THREE.Mesh(
        new THREE.PlaneGeometry(SCENE_SIZE * 12, SCENE_SIZE * 12),
        new THREE.MeshStandardMaterial({ color: 0x6a7250, roughness: 1, metalness: 0 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = (isFinite(minH) ? minH : 0) * terrain.exaggeration - 4;
    apron.receiveShadow = true;
    scene.add(apron);

    status.textContent = 'Loading satellite imagery…';
    await terrain.applySatellite().catch(err => console.warn('Satellite imagery failed:', err));

    status.textContent = 'Planting gardens…';
    const bbox = proj.bbox(SCENE_HALF);
    const roads = Object.assign(new RoadsFeature(), { featureCollection: pack.roads });
    const buildings = Object.assign(new BuildingsFeature(), { mapFeatures: pack.osm, mvtFeatures: null });
    const vegetation = new VegetationFeature();
    const grass = new GrassFeature();
    await Promise.all([vegetation.load(bbox, pack.osm), grass.load(bbox, pack.osm)]);
    for (const f of [roads, buildings, vegetation, grass]) {
        try {
            f.build(terrain, proj);
            scene.add(f.group);
        } catch (err) {
            console.warn(`${f.group.name} build failed:`, err);
        }
    }

    // ── the game ─────────────────────────────────────────────────────────────
    const game = new CaptureGame({ scene, camera, controls, canvas, terrain, proj });
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
    document.getElementById('cap-loading').remove();
    const join = location.hash.startsWith('#join=') ? decodeURIComponent(location.hash.slice(6)) : null;
    game.openSetup({ join });

    const clock = new THREE.Clock();
    (function animate() {
        requestAnimationFrame(animate);
        const dt = clock.getDelta();
        controls.update();
        game.update(dt);
        // trees grow as the camera pulls back, so the gardens stay readable from far
        const dist = camera.position.distanceTo(controls.target);
        vegetation.setZoomScale(1 + THREE.MathUtils.clamp((dist - 600) / 7400, 0, 1) * 1.2);
        renderer.render(scene, camera);
    })();
}

init().catch(err => fail('Something went wrong while loading the game. Reload the page to try again.', err));

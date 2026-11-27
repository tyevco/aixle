/**
 * A self-contained web page for orbiting the model: the GLB is embedded as
 * base64 so the file opens from disk with no server, and three.js comes from
 * a CDN, so it needs a network connection once. The GLB's own materials are
 * shown as they are, with the colour atlas and whichever normal,
 * metallic-roughness and emissive maps it carries (vertex colours stand in
 * only for a GLB without an atlas).
 *
 * Two ways to light it. The studio is the page's own: a grey backdrop, a
 * room environment for the metals to reflect, a hemisphere light and a white
 * key, for judging the maps. The scene is the program's: the GLB's own
 * lights (KHR_lights_punctual), or the beauty render's default key when the
 * program declares none, under the program's sky as a backdrop and as the
 * ambient light, on a floor of the sky's floor colour, with the program's
 * named cameras as viewpoints; it is what beauty.png shows, drawn from the
 * export (round 11: a night scene lit by a torch was shown in a daylight
 * studio, so the viewer could judge the maps but not the look).
 */
import type { Bounds } from "../sdf/types.js";
import type { Vec3 } from "../core/vec.js";

/** The program's scene, for the viewer's Scene mode. */
export interface ViewerScene {
  /** The sky's name, for the button. */
  environment: string;
  /** The sky's colours, 0..1 as the beauty render draws them. */
  sky: Vec3;
  horizon?: Vec3;
  ground: Vec3;
  floor: Vec3;
  /** The ambient light's strength as the beauty render takes it: its 0.42, times `set ambient`, times the sky's own. */
  ambient: number;
  /** The beauty render's one key light (a direction towards it, and lux), when the program declares no light: the default, or where `set light_azimuth` and `set light_elevation` put it. */
  key?: { direction: Vec3; intensity: number };
  /** The program's named cameras as the beauty render frames them: the eye, the point it looks at, the vertical field of view. */
  cameras: { name: string; eye: Vec3; target: Vec3; fov: number }[];
  /** Open in the scene rather than the studio: the program declares lights or a sky. */
  start: boolean;
  /** Open from this camera (`set camera`). */
  camera?: string;
}

export function viewerHtml(glb: Buffer, name: string, bounds: Bounds, triangles: number, animations: string[] = [], scene?: ViewerScene): string {
  const b64 = glb.toString("base64");
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const dims = size.map((v) => v.toFixed(2)).join(" × ");
  const floorY = Math.min(0, bounds.min[1]);
  const centre = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const radius = Math.max(0.5 * Math.hypot(size[0], size[1], size[2]), 0.01);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · aixle viewer</title>
<style>
  html, body { margin: 0; height: 100%; background: #e4e6ea; font: 13px/1.4 system-ui, sans-serif; color: #2a2a2e; }
  #bar { position: fixed; top: 0; left: 0; right: 0; display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #2a2a2e; color: #f4f2ee; z-index: 2; flex-wrap: wrap; }
  #bar b { font-size: 15px; margin-right: 8px; }
  #bar button { background: #f4f2ee; color: #2a2a2e; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  #bar button:hover { background: #fff; }
  #bar span { color: #b8b8c0; }
  #anim { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 10px; align-items: center; padding: 8px 12px; background: #2a2a2ee6; color: #f4f2ee; z-index: 2; flex-wrap: wrap; }
  #anim button, #anim select { background: #f4f2ee; color: #2a2a2e; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; font: inherit; }
  #bar button.on { background: #ffd27a; }
  #anim label { display: flex; gap: 4px; align-items: center; color: #b8b8c0; cursor: pointer; }
  #anim input[type=range] { flex: 1; min-width: 120px; accent-color: #ffd27a; }
  #anim #time { min-width: 90px; font-variant-numeric: tabular-nums; }
  canvas { display: block; }
  #err { position: fixed; inset: 60px 20px auto; color: #b0402a; display: none; }
</style>
</head>
<body>
<div id="bar"><b>${escapeHtml(name)}</b><span>${dims} units · ${triangles} triangles</span>
  <button data-view="persp">Perspective</button><button data-view="front">Front</button><button data-view="right">Right</button><button data-view="top">Top</button>${(scene?.cameras ?? []).map((c, i) => `<button data-cam="${i}">◎ ${escapeHtml(c.name)}</button>`).join("")}
  <button id="wire">Wireframe</button><button id="grid">Grid</button>${scene ? `<button id="studio">Studio</button><button id="scene">Scene: ${escapeHtml(scene.environment)}</button>` : ""}${animations.map((a, i) => `<button data-anim="${i}">▶ ${escapeHtml(a)}</button>`).join("")}<span>drag to orbit · wheel to zoom · right-drag to pan</span></div>
${animations.length ? `<div id="anim"><button id="all">▶ All</button><button id="pause">❚❚</button><label><input type="checkbox" id="loop" checked> loop</label><label>speed <select id="speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label><input type="range" id="scrub" min="0" max="1" step="0.001" value="0"><span id="time">no animation</span></div>` : ""}
<div id="err">three.js could not be loaded from the CDN; this page needs a network connection the first time.</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
const GLB = "${b64}";
const centre = ${JSON.stringify(centre)}, radius = ${radius}, floorY = ${floorY};
const SCENE = ${JSON.stringify(scene ?? null)};
let THREE, GLTFLoader, OrbitControls, RoomEnvironment;
try {
  THREE = await import("three");
  ({ GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"));
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
  ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
} catch (e) { document.getElementById("err").style.display = "block"; throw e; }
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const studioBackground = new THREE.Color(0xe4e6ea);
scene.background = studioBackground;
// A room for the metals to reflect: without one a metal shows only the key's highlight and reads black (measured on
// the lantern's bare iron), and a metallic-roughness map has nothing to vary. It lights everything a little, so the
// hemisphere light is lower than it was before the environment.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, radius * 0.01, radius * 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...centre);
const hemi = new THREE.HemisphereLight(0xdfe6f0, 0xd0cbc0, 0.45);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(centre[0] - radius * 2, centre[1] + radius * 3.5, centre[2] + radius * 2.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const s = radius * 2;
Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 12 });
key.target.position.set(...centre);
scene.add(key, key.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 40, radius * 40), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = floorY; floor.receiveShadow = true; scene.add(floor);
const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].find((v) => (radius * 4) / v <= 40) ?? 100;
const grid = new THREE.GridHelper(step * 40, 40, 0xbfbbb0, 0xd8d5cc);
grid.position.y = floorY + radius * 0.001; scene.add(grid);
const axes = new THREE.AxesHelper(radius * 0.5); axes.position.y = floorY; scene.add(axes);
const studioEnv = scene.environment;
// The program's scene, built when first asked for: its sky as the backdrop and, scaled to the ambient, as the light
// the surfaces get from all round; a floor of its floor colour; the beauty render's key when the GLB brings no light.
let sceneBits = null, glbLights = [], mode = "studio";
function skyColour(dy) {
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  if (dy < 0) return mix(SCENE.floor.map((v) => v * 0.95), SCENE.ground, 0.6);
  const k = Math.min(1, dy * 2.5);
  if (SCENE.horizon) return k < 0.3 ? mix(SCENE.ground, SCENE.horizon, k / 0.3) : mix(SCENE.horizon, SCENE.sky, (k - 0.3) / 0.7);
  return mix(SCENE.ground, SCENE.sky, k);
}
function skyTexture(scale) {
  const c = document.createElement("canvas"); c.width = 4; c.height = 256;
  const g = c.getContext("2d");
  for (let y = 0; y < 256; y++) {
    const col = skyColour(Math.cos((Math.PI * (y + 0.5)) / 256)).map((v) => Math.round(Math.min(1, Math.max(0, v * scale)) * 255));
    g.fillStyle = "rgb(" + col.join(",") + ")"; g.fillRect(0, y, 4, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
function buildScene() {
  const background = skyTexture(1);
  const environment = pmrem.fromEquirectangular(skyTexture(SCENE.ambient)).texture;
  const floorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...SCENE.floor, THREE.SRGBColorSpace), roughness: 0.95 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 40, radius * 40), floorMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = floorY - radius * 0.0005; ground.receiveShadow = true; ground.visible = false; scene.add(ground);
  let keyLight = null;
  if (SCENE.key) {
    keyLight = new THREE.DirectionalLight(0xffffff, SCENE.key.intensity);
    const d = SCENE.key.direction;
    keyLight.position.set(centre[0] + d[0] * radius * 3, centre[1] + d[1] * radius * 3, centre[2] + d[2] * radius * 3);
    keyLight.target.position.set(...centre);
    keyLight.castShadow = true; keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(keyLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 12 });
    keyLight.visible = false; scene.add(keyLight, keyLight.target);
  }
  return { background, environment, ground, keyLight };
}
function setMode(m) {
  if (!SCENE) m = "studio";
  mode = m;
  if (m === "scene" && !sceneBits) sceneBits = buildScene();
  const inScene = m === "scene";
  scene.background = inScene ? sceneBits.background : studioBackground;
  scene.environment = inScene ? sceneBits.environment : studioEnv;
  // The scene is the beauty render's: no grid or axes until asked for.
  hemi.visible = key.visible = floor.visible = !inScene;
  grid.visible = axes.visible = !inScene;
  if (sceneBits) { sceneBits.ground.visible = inScene; if (sceneBits.keyLight) sceneBits.keyLight.visible = inScene; }
  for (const l of glbLights) l.visible = inScene;
  for (const id of ["studio", "scene"]) el(id)?.classList.toggle("on", id === m);
}
function shot(i) {
  const c = SCENE?.cameras[i];
  if (!c) return;
  camera.fov = c.fov; camera.updateProjectionMatrix();
  camera.position.set(...c.eye); camera.up.set(0, 1, 0);
  controls.target.set(...c.target); controls.update();
}
const bytes = Uint8Array.from(atob(GLB), (c) => c.charCodeAt(0));
let model, mixer, clips = [], action, queue = [];
// The action's own flags conflate paused with finished (clampWhenFinished pauses it), so the page keeps its own.
let paused = false, done = false, once = false;
const clock = new THREE.Clock();
const el = (id) => document.getElementById(id);
const animBar = el("anim"), buttons = [...document.querySelectorAll("[data-anim]")];
new GLTFLoader().parse(bytes.buffer, "", (gltf) => {
  model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (!o.material.map) o.material.vertexColors = true; }
    // The GLB's own lights light the scene mode only; the studio has its own.
    if (o.isLight) {
      glbLights.push(o);
      o.castShadow = true;
      if (o.shadow) { o.shadow.mapSize.set(1024, 1024); o.shadow.bias = -0.0005; }
      if (o.isDirectionalLight) Object.assign(o.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 12 });
      o.visible = mode === "scene";
    }
  });
  scene.add(model);
  clips = gltf.animations || [];
  mixer = new THREE.AnimationMixer(model);
  mixer.timeScale = animBar ? Number(el("speed").value) : 1;
  // "All" plays each animation once in turn; the finished event only fires for a once-through action.
  mixer.addEventListener("finished", () => { if (queue.length) play(queue.shift(), true); else done = true; });
  document.body.dataset.ready = "1";
});
function looping() { return animBar && el("loop").checked && !once; }
function play(clip, inTurn = false) {
  if (!clip || !mixer) return;
  if (action) action.stop();
  once = inTurn;
  paused = false; done = false;
  action = mixer.clipAction(clip);
  clock.getDelta(); // drop the time since the last frame, so the clip starts at 0 rather than part way in
  action.setLoop(looping() ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = true;
  action.reset().play();
  if (animBar) { el("scrub").max = clip.duration; el("scrub").value = 0; }
  buttons.forEach((b) => b.classList.toggle("on", clips[Number(b.dataset.anim)] === clip));
}
function stop() { if (action) action.stop(); action = null; queue = []; buttons.forEach((b) => b.classList.remove("on")); }
buttons.forEach((b) => b.addEventListener("click", () => {
  const clip = clips[Number(b.dataset.anim)];
  if (action && action.getClip() === clip && !paused && !done) { stop(); return; }
  queue = [];
  play(clip);
}));
if (animBar) {
  el("all").addEventListener("click", () => { queue = clips.slice(1); play(clips[0], true); });
  el("pause").addEventListener("click", () => {
    if (!action) { if (clips.length) play(clips[0]); return; }
    if (done) { play(action.getClip(), once); return; }
    paused = !paused;
    action.paused = paused;
  });
  el("loop").addEventListener("change", () => { if (action) action.setLoop(looping() ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); });
  el("speed").addEventListener("change", () => { if (mixer) mixer.timeScale = Number(el("speed").value); });
  // Dragging the scrub bar pauses the animation at that moment; the play button resumes it from there.
  el("scrub").addEventListener("input", () => {
    if (!action) { if (clips.length) play(clips[0]); else return; }
    paused = true; done = false;
    action.paused = true;
    action.time = Number(el("scrub").value);
  });
}
function tick() {
  if (!animBar) return;
  if (!action) { el("time").textContent = "no animation"; el("pause").textContent = "▶"; return; }
  const clip = action.getClip();
  if (!paused && !done) el("scrub").value = action.time;
  el("time").textContent = clip.name + "  " + action.time.toFixed(2) + " / " + clip.duration.toFixed(2) + " s" + (done ? "  (done)" : paused ? "  (paused)" : "");
  el("pause").textContent = paused || done ? "▶" : "❚❚";
}
function view(name) {
  camera.fov = 30; camera.updateProjectionMatrix();
  const d = radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.1;
  const p = { persp: [Math.sin(0.61) * Math.cos(0.44), Math.sin(0.44), Math.cos(0.61) * Math.cos(0.44)], front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0.0001] }[name];
  camera.position.set(centre[0] + p[0] * d, centre[1] + p[1] * d, centre[2] + p[2] * d);
  camera.up.set(0, 1, 0);
  controls.update();
}
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => view(b.dataset.view)));
document.getElementById("wire").addEventListener("click", () => model?.traverse((o) => { if (o.isMesh) o.material.wireframe = !o.material.wireframe; }));
document.getElementById("grid").addEventListener("click", () => { grid.visible = !grid.visible; axes.visible = grid.visible; });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => shot(Number(b.dataset.cam))));
el("studio")?.addEventListener("click", () => setMode("studio"));
el("scene")?.addEventListener("click", () => setMode("scene"));
view("persp");
setMode(SCENE && SCENE.start ? "scene" : "studio");
if (SCENE && SCENE.camera) shot(SCENE.cameras.findIndex((c) => c.name === SCENE.camera));
// For scripts that drive the page (a headless screenshot): the scene, the camera and the two switches.
window.aixleViewer = { THREE, scene, camera, controls, renderer, setMode, shot, view };
renderer.setAnimationLoop(() => { controls.update(); if (mixer) mixer.update(clock.getDelta()); tick(); renderer.render(scene, camera); });
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

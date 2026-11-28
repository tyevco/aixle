/**
 * A self-contained web page for orbiting the model: the GLB is embedded as
 * base64 so the file opens from disk with no server, and three.js comes from
 * a CDN, pinned to one version, so it needs a network connection once. The
 * GLB's own materials are shown as they are, with the colour atlas and
 * whichever normal, metallic-roughness and emissive maps it carries (vertex
 * colours stand in only for a GLB without an atlas).
 *
 * Both ways of lighting it end on the beauty render's tone curve
 * (photometry.ts's TONEMAP_GLSL as three.js's CustomToneMapping), so a base
 * colour lit to unit light shows as itself and highlights roll off instead of
 * clipping, as in beauty.png.
 *
 * The studio is the page's own, for judging the maps: a grey backdrop,
 * three.js's room environment for the metals to reflect, a hemisphere light
 * and a white key, calibrated together so that a white face turned to the key
 * is about 1.0 in linear light and a plate of the non-metal presets shows
 * their base colours (STUDIO below). The scene is the program's, what
 * beauty.png shows drawn from the export (round 11: a night scene lit by a
 * torch was shown in a daylight studio): the beauty render's own sky as the
 * environment (environment.ts's map, through three.js's prefilter, at the
 * render's intensity E), lighting diffuse surfaces from the sky's spherical
 * harmonics as the beauty render does rather than from the map (whose
 * reflection cards would light them two or three times over); the GLB's own
 * lights (KHR_lights_punctual) or the beauty render's default key; a floor of
 * the albedo the beauty render solves for its open floor; the sky's backdrop;
 * and the program's named cameras and beauty.png's own framing as viewpoints.
 */
import type { Bounds } from "../sdf/types.js";
import type { Vec3 } from "../core/vec.js";
import { GLOW, TONEMAP_GLSL } from "../render/photometry.js";
import { GLB_RANGE_CUTOFF } from "./glb.js";

/** The three.js the page loads, pinned: 0.187 prefilters each level of the environment with a true GGX lobe, as the beauty render's maps are. */
export const THREE_VERSION = "0.187.0";

/** A camera as the page takes it: the eye, the point it looks at, the vertical field of view in degrees. */
export interface ViewerCamera {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

/** The program's scene, for the viewer's Scene mode. */
export interface ViewerScene {
  /** The sky's name, for the button. */
  environment: string;
  /** The backdrop's display colours (sRGB 0..1), as the beauty render draws its backdrop. */
  sky: Vec3;
  horizon?: Vec3;
  ground: Vec3;
  /** E: the sky's light on surfaces, diffuse and reflected, as the beauty render takes it (the palette's intensity times `set ambient`); three.js's environmentIntensity. */
  ambient: number;
  /**
   * The sky as light (environment.ts's environmentLatLong): a lat-long of linear radiance, width × height texels of
   * RGB, in three.js's equirectangular layout (written into the page as half floats), and the radiance of the sky's
   * diffuse light as nine SH coefficients per channel in three.js's order, which light diffuse surfaces in its place.
   */
  light: { width: number; height: number; data: Float32Array; sh: number[] };
  /** The floor's albedo, linear: what shows the palette's open floor near the model, as the beauty render solves it. */
  floorAlbedo: Vec3;
  /** The floor fades into the sky's horizon (linear radiance) from `reach` beyond the model's box to four times that, as in the beauty render. */
  floorFade: { min: Vec3; max: Vec3; reach: number; horizon: Vec3 };
  /** The beauty render's one key light (a direction towards it, and lux), when the program declares no light: the default, or where `set light_azimuth` and `set light_elevation` put it. */
  key?: { direction: Vec3; intensity: number };
  /** The program's named cameras as the beauty render frames them. */
  cameras: (ViewerCamera & { name: string })[];
  /** The camera beauty.png is drawn from, for setting the page beside it. */
  shot?: ViewerCamera;
  /** Open in the scene rather than the studio: the program declares lights or a sky. */
  start: boolean;
  /** Open from this camera (`set camera`). */
  camera?: string;
}

/**
 * The studio's lights, in three.js's units: the room environment's intensity, the hemisphere light's and the key's
 * (lux). Calibrated together in headless Chromium on a plate of the presets with every tile turned square to the key:
 * a white face turned to the key comes to 1.1 in linear light, its Fresnel included, a white face turned from it to
 * 0.37 and one facing up to 0.94; the 26 solid non-metal presets show their base colours to within 1.6 levels on
 * average in every channel (4.1 levels tile by tile, the darkest channels lowest, since a key brings no Fresnel lift
 * from all round as the furnace Neutral is built for does). The room alone carries the reflections, so it is the
 * larger share of the fill.
 */
export const STUDIO = { room: 0.4, hemi: 0.1, key: 1.2 };

const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
/** One number as an IEEE half float's bits, rounded to nearest even; past the largest half, the largest half. */
export function toHalf(v: number): number {
  F32[0] = v;
  const x = U32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  const m = x & 0x7fffff;
  if (e >= 31) return ((x >>> 23) & 0xff) === 0xff && m ? sign | 0x7e00 : sign | 0x7bff;
  if (e <= 0) {
    if (e < -10) return sign;
    const mm = m | 0x800000, shift = 14 - e;
    let h = mm >>> shift;
    const rest = mm & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rest > half || (rest === half && h & 1)) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (m >>> 13);
  const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++;
  return h;
}

/** Numbers as half floats, little-endian, in base64: how the page carries the sky's radiance. */
export function halfBase64(data: ArrayLike<number>): string {
  const b = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) b.writeUInt16LE(toHalf(data[i]), i * 2);
  return b.toString("base64");
}

export function viewerHtml(glb: Buffer, name: string, bounds: Bounds, triangles: number, animations: string[] = [], scene?: ViewerScene): string {
  const b64 = glb.toString("base64");
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const dims = size.map((v) => v.toFixed(2)).join(" × ");
  const floorY = Math.min(0, bounds.min[1]);
  const centre = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const radius = Math.max(0.5 * Math.hypot(size[0], size[1], size[2]), 0.01);
  // The sky's radiance goes in as half floats in base64: 128 × 64 texels is 64 KB of the page.
  const page = scene ? { ...scene, light: { ...scene.light, data: halfBase64(scene.light.data) } } : null;
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
  <button data-view="persp">Perspective</button><button data-view="front">Front</button><button data-view="right">Right</button><button data-view="top">Top</button>${scene?.shot && !scene.camera ? `<button id="beauty">◎ beauty.png</button>` : ""}${(scene?.cameras ?? []).map((c, i) => `<button data-cam="${i}">◎ ${escapeHtml(c.name)}</button>`).join("")}
  <button id="wire">Wireframe</button><button id="grid">Grid</button>${scene ? `<button id="studio">Studio</button><button id="scene">Scene: ${escapeHtml(scene.environment)}</button>` : ""}${animations.map((a, i) => `<button data-anim="${i}">▶ ${escapeHtml(a)}</button>`).join("")}<span>drag to orbit · wheel to zoom · right-drag to pan</span></div>
${animations.length ? `<div id="anim"><button id="all">▶ All</button><button id="pause">❚❚</button><label><input type="checkbox" id="loop" checked> loop</label><label>speed <select id="speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label><input type="range" id="scrub" min="0" max="1" step="0.001" value="0"><span id="time">no animation</span></div>` : ""}
<div id="err">three.js could not be loaded from the CDN; this page needs a network connection the first time.</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/"}}</script>
<script type="module">
const GLB = "${b64}";
const centre = ${JSON.stringify(centre)}, radius = ${radius}, floorY = ${floorY};
const SCENE = ${JSON.stringify(page).replace(/</g, "\\u003c")};
const STUDIO = ${JSON.stringify(STUDIO)};
// A glow of 1 shows its colour at this radiance in beauty.png; the GLB's emissive is the glow alone.
const GLOW = ${GLOW};
// The beauty render's tone curve (photometry.ts): three.js's Neutral below its shoulder, the shoulder per channel.
const TONEMAP = ${JSON.stringify(TONEMAP_GLSL)};
let THREE, GLTFLoader, OrbitControls, RoomEnvironment;
try {
  THREE = await import("three");
  ({ GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"));
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
  ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
} catch (e) { document.getElementById("err").style.display = "block"; throw e; }
const el = (id) => document.getElementById(id);
const CUSTOM = "vec3 CustomToneMapping( vec3 color ) { return color; }";
if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(CUSTOM)) THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(CUSTOM, "vec3 CustomToneMapping( vec3 color ) {\\n" + TONEMAP + "\\n}");
else console.warn("aixle viewer: this three.js has no CustomToneMapping stub; the picture is not on beauty.png's curve");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.CustomToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
// In the scene, every material the page draws is lit as the beauty render lights it, by two changes to three.js's
// shaders under one switch: diffuse light from the sky's spherical harmonics rather than from its map (whose cards
// would light it two or three times over), and a point light's strength range² / (range² + d²) of its candela over
// range², not inverse-square, its range read back from the GLB's cutoff. The studio's room lights from its own map.
const SH = { aixleSh: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) }, aixleScene: { value: 0 } };
const IBL_HEAD = "vec3 getIBLIrradiance( const in vec3 normal ) {";
const IBL = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(IBL_HEAD, [
  "vec3 aixleShIrradiance( const in vec3 n ) {",
  "  vec3 r = aixleSh[ 0 ] * 0.886227 + aixleSh[ 1 ] * ( 1.023328 * n.y ) + aixleSh[ 2 ] * ( 1.023328 * n.z ) + aixleSh[ 3 ] * ( 1.023328 * n.x );",
  "  r += aixleSh[ 4 ] * ( 0.858086 * n.x * n.y ) + aixleSh[ 5 ] * ( 0.858086 * n.y * n.z ) + aixleSh[ 6 ] * ( 0.743125 * n.z * n.z - 0.247708 );",
  "  return r + aixleSh[ 7 ] * ( 0.858086 * n.x * n.z ) + aixleSh[ 8 ] * ( 0.429043 * ( n.x * n.x - n.y * n.y ) );",
  "}",
  IBL_HEAD,
  "  if ( aixleScene > 0.5 ) return max( aixleShIrradiance( transformNormalByInverseViewMatrix( normal, viewMatrix ) ), vec3( 0.0 ) ) * envMapIntensity;",
].join("\\n"));
const FALLOFF_HEAD = "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {";
const FALLOFF = THREE.ShaderChunk.lights_pars_begin.replace(FALLOFF_HEAD, FALLOFF_HEAD + "\\n  if ( aixleScene > 0.5 && cutoffDistance > 0.0 ) { float r = cutoffDistance / ${GLB_RANGE_CUTOFF}.0; return 1.0 / ( lightDistance * lightDistance + r * r ); }");
if (IBL === THREE.ShaderChunk.envmap_physical_pars_fragment || FALLOFF === THREE.ShaderChunk.lights_pars_begin) console.warn("aixle viewer: this three.js's shaders have changed; the scene is not lit as beauty.png is");
function patchShader(shader) {
  Object.assign(shader.uniforms, SH);
  shader.fragmentShader = "uniform float aixleScene;\\nuniform vec3 aixleSh[ 9 ];\\n" + shader.fragmentShader
    .replace("#include <envmap_physical_pars_fragment>", IBL)
    .replace("#include <lights_pars_begin>", FALLOFF);
}
function litAsBeauty(m) {
  m.onBeforeCompile = patchShader;
  m.customProgramCacheKey = () => "aixle-scene";
}
const scene = new THREE.Scene();
const studioBackground = new THREE.Color(0xe4e6ea);
scene.background = studioBackground;
// A room for the metals to reflect: without one a metal shows only the key's highlight and reads black (measured on
// the lantern's bare iron), and a metallic-roughness map has nothing to vary.
const pmrem = new THREE.PMREMGenerator(renderer);
const studioEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = studioEnv;
scene.environmentIntensity = STUDIO.room;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, radius * 0.01, radius * 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...centre);
const hemi = new THREE.HemisphereLight(0xdfe6f0, 0xd0cbc0, STUDIO.hemi);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, STUDIO.key);
key.position.set(centre[0] - radius * 2, centre[1] + radius * 3.5, centre[2] + radius * 2.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
// A face square to the light lies at its own depth in the shadow map: pushed off along its normal by a fraction of a texel, it does not shade itself in a moiré.
const s = radius * 2, normalBias = (s * 2) / 2048;
key.shadow.normalBias = normalBias;
Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 12 });
key.target.position.set(...centre);
scene.add(key, key.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 40, radius * 40), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = floorY; floor.receiveShadow = true; scene.add(floor);
const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].find((v) => (radius * 4) / v <= 40) ?? 100;
const grid = new THREE.GridHelper(step * 40, 40, 0xbfbbb0, 0xd8d5cc);
grid.position.y = floorY + radius * 0.001; scene.add(grid);
const axes = new THREE.AxesHelper(radius * 0.5); axes.position.y = floorY; scene.add(axes);
// The program's scene, built when first asked for: its sky as the backdrop, and as the light the surfaces get from
// all round at the beauty render's intensity; the floor; the beauty render's key when the GLB brings no light.
// A glowing material and the GLB's own emissive strength, each once: the copies of a placed part share one material.
let sceneBits = null, glbLights = [], glows = new Map(), mode = "studio";
function skyColour(dy) {
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  // Below the horizon the floor reaches the horizon's colour before the backdrop shows, as in beauty.png.
  if (dy < 0) return SCENE.ground;
  const k = Math.min(1, dy * 2.5);
  if (SCENE.horizon) return k < 0.3 ? mix(SCENE.ground, SCENE.horizon, k / 0.3) : mix(SCENE.horizon, SCENE.sky, (k - 0.3) / 0.7);
  return mix(SCENE.ground, SCENE.sky, k);
}
// The backdrop: display colours, as beauty.png shows them (an sRGB background is not tone-mapped).
function skyTexture() {
  const c = document.createElement("canvas"); c.width = 4; c.height = 256;
  const g = c.getContext("2d");
  for (let y = 0; y < 256; y++) {
    const col = skyColour(Math.cos((Math.PI * (y + 0.5)) / 256)).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    g.fillStyle = "rgb(" + col.join(",") + ")"; g.fillRect(0, y, 4, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
// The sky as light: the beauty render's own map, linear radiance in half floats, through three.js's prefilter.
function skyLight() {
  const L = SCENE.light, n = L.width * L.height;
  const rgb = new Uint16Array(Uint8Array.from(atob(L.data), (c) => c.charCodeAt(0)).buffer);
  const rgba = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 0x3c00; }
  const t = new THREE.DataTexture(rgba, L.width, L.height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose();
  for (let k = 0; k < 9; k++) SH.aixleSh.value[k].set(L.sh[k * 3], L.sh[k * 3 + 1], L.sh[k * 3 + 2]);
  return env;
}
function buildScene() {
  const background = skyTexture();
  const environment = skyLight();
  // The floor shows what beauty.png's does near the model: the albedo it is solved to, lit diffusely, reflecting nothing.
  const floorMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(...SCENE.floorAlbedo, THREE.LinearSRGBColorSpace), roughness: 1, metalness: 0, specularIntensity: 0 });
  // Far off it fades into the sky at the horizon, measured from the model's box as the beauty render measures it.
  const F = SCENE.floorFade;
  floorMat.onBeforeCompile = (shader) => {
    patchShader(shader);
    Object.assign(shader.uniforms, { aixleBoxMin: { value: new THREE.Vector3(...F.min) }, aixleBoxMax: { value: new THREE.Vector3(...F.max) }, aixleReach: { value: F.reach }, aixleHorizon: { value: new THREE.Vector3(...F.horizon) } });
    shader.vertexShader = "varying vec3 aixleWorld;\\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\\naixleWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    shader.fragmentShader = "varying vec3 aixleWorld;\\nuniform vec3 aixleBoxMin, aixleBoxMax, aixleHorizon;\\nuniform float aixleReach;\\n" + shader.fragmentShader
      .replace("#include <opaque_fragment>", "vec3 aixleAway = max( max( aixleBoxMin - aixleWorld, aixleWorld - aixleBoxMax ), vec3( 0.0 ) );\\noutgoingLight = mix( outgoingLight, aixleHorizon, clamp( ( length( aixleAway ) - aixleReach ) / ( 3.0 * aixleReach ), 0.0, 1.0 ) );\\n#include <opaque_fragment>");
  };
  floorMat.customProgramCacheKey = () => "aixle-floor";
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 400, radius * 400), floorMat);
  ground.rotation.x = -Math.PI / 2; ground.position.set(centre[0], floorY - radius * 0.0005, centre[2]); ground.receiveShadow = true; ground.visible = false; scene.add(ground);
  let keyLight = null;
  if (SCENE.key) {
    keyLight = new THREE.DirectionalLight(0xffffff, SCENE.key.intensity);
    const d = SCENE.key.direction;
    keyLight.position.set(centre[0] + d[0] * radius * 3, centre[1] + d[1] * radius * 3, centre[2] + d[2] * radius * 3);
    keyLight.target.position.set(...centre);
    keyLight.castShadow = true; keyLight.shadow.mapSize.set(2048, 2048); keyLight.shadow.normalBias = normalBias;
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
  scene.environmentIntensity = inScene ? SCENE.ambient : STUDIO.room;
  SH.aixleScene.value = inScene ? 1 : 0;
  // The scene is the beauty render's: no grid or axes until asked for.
  hemi.visible = key.visible = floor.visible = !inScene;
  grid.visible = axes.visible = !inScene;
  if (sceneBits) { sceneBits.ground.visible = inScene; if (sceneBits.keyLight) sceneBits.keyLight.visible = inScene; }
  for (const l of glbLights) l.visible = inScene;
  showGlows();
  for (const id of ["studio", "scene"]) el(id)?.classList.toggle("on", id === m);
}
// A glow shows at beauty.png's strength in the scene, GLOW times the GLB's, and at the GLB's own in the studio.
function showGlows() { for (const [m, k] of glows) m.emissiveIntensity = mode === "scene" ? k * GLOW : k; }
function frameOn(c) {
  camera.fov = c.fov; camera.updateProjectionMatrix();
  camera.position.set(...c.eye); camera.up.set(0, 1, 0);
  controls.target.set(...c.target); controls.update();
}
function shot(i) { const c = SCENE?.cameras[i]; if (c) frameOn(c); }
const bytes = Uint8Array.from(atob(GLB), (c) => c.charCodeAt(0));
let model, mixer, clips = [], action, queue = [];
// The action's own flags conflate paused with finished (clampWhenFinished pauses it), so the page keeps its own.
let paused = false, done = false, once = false;
const timer = new THREE.Timer();
timer.connect(document);
const animBar = el("anim"), buttons = [...document.querySelectorAll("[data-anim]")];
new GLTFLoader().parse(bytes.buffer, "", (gltf) => {
  model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      for (const m of [].concat(o.material)) {
        if (!m.map) m.vertexColors = true;
        litAsBeauty(m);
        if (!glows.has(m) && m.emissive && (m.emissiveMap || m.emissive.r + m.emissive.g + m.emissive.b > 0)) glows.set(m, m.emissiveIntensity);
      }
    }
    // The GLB's own lights light the scene mode only; the studio has its own.
    if (o.isLight) {
      glbLights.push(o);
      o.castShadow = true;
      if (o.shadow) { o.shadow.mapSize.set(1024, 1024); o.shadow.bias = -0.0005; o.shadow.normalBias = normalBias * 2; }
      if (o.isDirectionalLight) Object.assign(o.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 12 });
      o.visible = mode === "scene";
    }
  });
  showGlows();
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
  timer.update(); // drop the time since the last frame, so the clip starts at 0 rather than part way in
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
  controls.target.set(...centre);
  controls.update();
}
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => view(b.dataset.view)));
el("wire").addEventListener("click", () => model?.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) m.wireframe = !m.wireframe; }));
el("grid").addEventListener("click", () => { grid.visible = !grid.visible; axes.visible = grid.visible; });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => shot(Number(b.dataset.cam))));
// beauty.png's own framing, to set the page beside it (a named camera's button is that when "set camera" names one).
const beautyShot = () => { if (SCENE?.shot) frameOn(SCENE.shot); };
el("beauty")?.addEventListener("click", beautyShot);
el("studio")?.addEventListener("click", () => setMode("studio"));
el("scene")?.addEventListener("click", () => setMode("scene"));
view("persp");
setMode(SCENE && SCENE.start ? "scene" : "studio");
if (SCENE && SCENE.camera) shot(SCENE.cameras.findIndex((c) => c.name === SCENE.camera));
// For scripts that drive the page (a headless screenshot): the scene, the camera and the switches.
window.aixleViewer = { THREE, scene, camera, controls, renderer, setMode, shot, view, beautyShot, studio: { hemi, key, floor, grid, axes }, play: (i) => play(clips[i]), get clips() { return clips; }, get mixer() { return mixer; } };
renderer.setAnimationLoop(() => { timer.update(); controls.update(); if (mixer) mixer.update(timer.getDelta()); tick(); renderer.render(scene, camera); });
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

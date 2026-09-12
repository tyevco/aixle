/**
 * A self-contained web page for orbiting the model: the GLB is embedded as
 * base64 so the file opens from disk with no server, and three.js comes from
 * a CDN, so it needs a network connection once. Vertex colours carry the
 * procedural materials.
 */
import type { Bounds } from "../sdf/types.js";

export function viewerHtml(glb: Buffer, name: string, bounds: Bounds, triangles: number): string {
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
  canvas { display: block; }
  #err { position: fixed; inset: 60px 20px auto; color: #b0402a; display: none; }
</style>
</head>
<body>
<div id="bar"><b>${escapeHtml(name)}</b><span>${dims} units · ${triangles} triangles</span>
  <button data-view="persp">Perspective</button><button data-view="front">Front</button><button data-view="right">Right</button><button data-view="top">Top</button>
  <button id="wire">Wireframe</button><button id="grid">Grid</button><span>drag to orbit · wheel to zoom · right-drag to pan</span></div>
<div id="err">three.js could not be loaded from the CDN; this page needs a network connection the first time.</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
const GLB = "${b64}";
const centre = ${JSON.stringify(centre)}, radius = ${radius}, floorY = ${floorY};
let THREE, GLTFLoader, OrbitControls;
try {
  THREE = await import("three");
  ({ GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"));
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
} catch (e) { document.getElementById("err").style.display = "block"; throw e; }
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe4e6ea);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, radius * 0.01, radius * 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...centre);
const hemi = new THREE.HemisphereLight(0xdfe6f0, 0xd0cbc0, 0.9);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.6);
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
const bytes = Uint8Array.from(atob(GLB), (c) => c.charCodeAt(0));
let model;
new GLTFLoader().parse(bytes.buffer, "", (gltf) => {
  model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (!o.material.map) o.material.vertexColors = true; } });
  scene.add(model);
});
function view(name) {
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
view("persp");
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

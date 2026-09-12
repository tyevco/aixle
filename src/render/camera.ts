/**
 * Cameras for the views. The world is right-handed and y-up. "Front" looks
 * at the model from +z, so a shape authored to face +z faces the viewer in
 * the front view; "right" looks from +x; "top" looks down with -z (the back
 * of the model) at the top of the image, the way a plan is drawn.
 */
import { cross, normalize, sub, type Vec3 } from "../core/vec.js";
import { boundsCenter, boundsSize, type Bounds } from "../sdf/types.js";

export interface Camera {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  /** Unit vector from the eye into the scene. */
  forward: Vec3;
  /** Perspective: vertical field of view in degrees. Orthographic: undefined. */
  fov?: number;
  /** Orthographic: world units per pixel. */
  unitsPerPixel?: number;
  width: number;
  height: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Depth along the view direction; larger is farther. */
  depth: number;
  /** 1 / depth for perspective-correct interpolation (1 for orthographic). */
  invW: number;
}

/** A point in camera space: x right, y up, z towards the viewer (negative in front). */
export function toView(cam: Camera, p: Vec3): Vec3 {
  const d = sub(p, cam.eye);
  return [
    d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2],
    d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2],
    -(d[0] * cam.forward[0] + d[1] * cam.forward[1] + d[2] * cam.forward[2]),
  ];
}

export function toViewDir(cam: Camera, v: Vec3): Vec3 {
  return [
    v[0] * cam.right[0] + v[1] * cam.right[1] + v[2] * cam.right[2],
    v[0] * cam.up[0] + v[1] * cam.up[1] + v[2] * cam.up[2],
    -(v[0] * cam.forward[0] + v[1] * cam.forward[1] + v[2] * cam.forward[2]),
  ];
}

/** Project a camera-space point; undefined when behind a perspective camera. */
export function project(cam: Camera, v: Vec3): Projected | undefined {
  const cx = cam.width / 2, cy = cam.height / 2;
  if (cam.fov !== undefined) {
    const depth = -v[2];
    if (depth <= 1e-4) return undefined;
    const f = cam.height / 2 / Math.tan((cam.fov * Math.PI) / 360);
    return { x: cx + (v[0] / depth) * f, y: cy - (v[1] / depth) * f, depth, invW: 1 / depth };
  }
  const upp = cam.unitsPerPixel ?? 1;
  return { x: cx + v[0] / upp, y: cy - v[1] / upp, depth: -v[2], invW: 1 };
}

function basis(eye: Vec3, target: Vec3, upHint: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward = normalize(sub(target, eye));
  let right = normalize(cross(forward, upHint));
  if (!Number.isFinite(right[0]) || (right[0] === 0 && right[1] === 0 && right[2] === 0)) right = [1, 0, 0];
  const up = normalize(cross(right, forward));
  return { right, up, forward };
}

/** A perspective camera looking at `bounds` from azimuth/elevation (degrees), framed to fit. */
export function perspective(bounds: Bounds, width: number, height: number, azimuth = 35, elevation = 25, fov = 30): Camera {
  const c = boundsCenter(bounds);
  const size = boundsSize(bounds);
  const radius = Math.max(0.5 * Math.hypot(size[0], size[1], size[2]), 1e-3);
  const aspect = width / height;
  const vfov = (fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08;
  const az = (azimuth * Math.PI) / 180, el = (elevation * Math.PI) / 180;
  const eye: Vec3 = [c[0] + dist * Math.cos(el) * Math.sin(az), c[1] + dist * Math.sin(el), c[2] + dist * Math.cos(el) * Math.cos(az)];
  return { eye, ...basis(eye, c, [0, 1, 0]), fov, width, height };
}

export type OrthoView = "front" | "right" | "top" | "back" | "left" | "bottom";

/** An orthographic camera on one axis, framed so the bounds fill ~80% of the frame. */
export function orthographic(bounds: Bounds, width: number, height: number, view: OrthoView): Camera {
  const c = boundsCenter(bounds);
  const size = boundsSize(bounds);
  const far = Math.max(size[0], size[1], size[2], 1e-3) * 4;
  let dir: Vec3, upHint: Vec3, spanX: number, spanY: number;
  switch (view) {
    case "front": dir = [0, 0, 1]; upHint = [0, 1, 0]; spanX = size[0]; spanY = size[1]; break;
    case "back": dir = [0, 0, -1]; upHint = [0, 1, 0]; spanX = size[0]; spanY = size[1]; break;
    case "right": dir = [1, 0, 0]; upHint = [0, 1, 0]; spanX = size[2]; spanY = size[1]; break;
    case "left": dir = [-1, 0, 0]; upHint = [0, 1, 0]; spanX = size[2]; spanY = size[1]; break;
    case "top": dir = [0, 1, 0]; upHint = [0, 0, -1]; spanX = size[0]; spanY = size[2]; break;
    case "bottom": dir = [0, -1, 0]; upHint = [0, 0, 1]; spanX = size[0]; spanY = size[2]; break;
  }
  const eye: Vec3 = [c[0] + dir[0] * far, c[1] + dir[1] * far, c[2] + dir[2] * far];
  const unitsPerPixel = Math.max(spanX / (width * 0.8), spanY / (height * 0.8), 1e-6);
  return { eye, ...basis(eye, c, upHint), unitsPerPixel, width, height };
}

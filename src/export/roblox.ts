/**
 * Roblox: the GLB arranged the way Studio's 3D Importer and the Accessory
 * Fitting Tool expect.
 *
 * A model unit is a stud. A Roblox character faces -Z, an Aixle model +z,
 * so the whole export is turned half a turn about y at its root: a hat's
 * brim built on +z lands over the character's face. A rigid accessory is
 * one mesh, so a single object is exported as a node named `Handle` (the
 * MeshPart an Accessory wraps); a scene keeps a node per object under one
 * root. Every anchor of the output whose name ends in `Attachment`
 * (`anchor(hat, "HatAttachment", 0, 0, 0)`) becomes an empty node named
 * with the importer's `_Att` suffix, at the anchor's point, so the Fitting
 * Tool has the attachment where the program put it.
 *
 * The limits come from Roblox's rigid accessory specifications (Normal
 * body scale, studs, centred on the attachment) and the 4k triangle budget;
 * they are reported, not enforced, since a place's furniture has neither.
 */
import { toGlbScene, type GlbAnimation } from "./glb.js";
import type { SceneHierarchy, SceneNode } from "./hierarchy.js";
import type { Vec3 } from "../core/vec.js";

/** Rigid accessory size limits at the Normal body scale, in studs, by the attachment the accessory uses. */
export const ROBLOX_LIMITS: Record<string, { size: [number, number, number]; kind: string }> = {
  HatAttachment: { size: [1.87, 2.5, 1.87], kind: "hat" },
  HairAttachment: { size: [1.87, 3.12, 2.18], kind: "hair" },
  FaceFrontAttachment: { size: [1.87, 1.25, 1.25], kind: "face" },
  FaceCenterAttachment: { size: [1.87, 1.25, 1.25], kind: "face" },
  NeckAttachment: { size: [2.95, 3.68, 2.16], kind: "neck" },
  LeftCollarAttachment: { size: [2.95, 3.68, 3.24], kind: "shoulder" },
  RightCollarAttachment: { size: [2.95, 3.68, 3.24], kind: "shoulder" },
  LeftShoulderAttachment: { size: [2.67, 4.4, 3.09], kind: "shoulder" },
  RightShoulderAttachment: { size: [2.67, 4.4, 3.09], kind: "shoulder" },
  BodyFrontAttachment: { size: [2.95, 3.68, 3.24], kind: "front" },
  BodyBackAttachment: { size: [9.86, 8.59, 4.87], kind: "back" },
  WaistFrontAttachment: { size: [3.94, 4.29, 7.57], kind: "waist" },
  WaistCenterAttachment: { size: [3.94, 4.29, 7.57], kind: "waist" },
  WaistBackAttachment: { size: [3.94, 4.29, 7.57], kind: "waist" },
};

/** Rigid accessories may have at most this many triangles; a place's MeshPart ten thousand. */
export const ACCESSORY_TRIANGLES = 4000;
export const MESHPART_TRIANGLES = 10000;

export interface RobloxOptions {
  /** The output's anchors in world space; those ending in Attachment become `_Att` nodes. */
  anchors: Record<string, Vec3>;
  /** The model's size, for the limits. */
  size: [number, number, number];
  animations?: GlbAnimation[];
  /** The triangle count before decimation, for the note. */
  before?: number;
}

export interface RobloxResult {
  glb: Buffer;
  /** The attachment nodes written, by name. */
  attachments: string[];
  /** Lines for the report and the warnings. */
  note: string;
  warnings: string[];
}

const fmt = (v: number): string => String(Number(v.toPrecision(3)));

export function toRoblox(h: SceneHierarchy, name: string, opts: RobloxOptions): RobloxResult {
  const attachmentNames = Object.keys(opts.anchors).filter((n) => /Attachment$/.test(n));
  const single = h.roots.length === 1;
  const attachments: SceneNode[] = attachmentNames.map((n) => ({
    name: `${n}_Att`,
    mesh: -1,
    translation: opts.anchors[n],
    yaw: 0,
    scale: 1,
    children: [],
    origin: opts.anchors[n],
  }));
  // One root, turned to face Roblox's -Z: the single mesh as Handle, or a Model over the objects.
  const inner = single ? { ...h.roots[0], name: "Handle" } : h.roots;
  const root: SceneNode = single
    ? { ...(inner as SceneNode), yaw: 180, children: [...(inner as SceneNode).children, ...attachments] }
    : { name: name.replace(/[^A-Za-z0-9_]/g, "_"), mesh: -1, translation: [0, 0, 0], yaw: 180, scale: 1, children: [...(inner as SceneNode[]), ...attachments], origin: [0, 0, 0] };
  const glb = toGlbScene({ ...h, roots: [root] }, name, opts.animations ?? []);

  const warnings: string[] = [];
  const parts: string[] = [];
  const decimated = opts.before !== undefined && opts.before > h.triangles ? `, decimated from ${opts.before}` : "";
  parts.push(single ? `${h.meshes.length === 1 ? "one mesh, Handle" : `Handle with ${h.meshes.length} meshes (one per joint)`}, ${h.triangles} triangles${decimated}` : `${h.roots.length} objects, ${h.triangles} triangles${decimated}`);
  if (attachmentNames.length) {
    parts.push(`attachment${attachmentNames.length === 1 ? "" : "s"} ${attachmentNames.map((n) => `${n} at (${opts.anchors[n].map(fmt).join(", ")})`).join(", ")}`);
    if (h.triangles > ACCESSORY_TRIANGLES) warnings.push(`roblox: ${h.triangles} triangles, more than a rigid accessory's ${ACCESSORY_TRIANGLES}; lower the grid (set grid ${Math.max(8, Math.floor(Math.sqrt(ACCESSORY_TRIANGLES / h.triangles) * 100) )} or so, since triangles grow with its square).`);
    if (!single) warnings.push(`roblox: an accessory is one mesh, but this is a scene of ${h.roots.length} objects; join them with + and show one shape.`);
    for (const n of attachmentNames) {
      const limit = ROBLOX_LIMITS[n];
      if (!limit) { warnings.push(`roblox: '${n}' is not a Roblox attachment name (HatAttachment, FaceFrontAttachment, BodyBackAttachment, ...); the node is written as ${n}_Att anyway.`); continue; }
      const over = [0, 1, 2].filter((k) => opts.size[k] > limit.size[k] + 1e-6);
      if (over.length) warnings.push(`roblox: a ${limit.kind} may be ${limit.size.join(" × ")} studs at the Normal scale; this is ${opts.size.map(fmt).join(" × ")}, over on ${over.map((k) => "xyz"[k]).join(", ")}.`);
      else parts.push(`fits the ${limit.kind} limit ${limit.size.join(" × ")}`);
    }
  } else {
    // A place's model is a MeshPart per mesh, each with its own ten thousand.
    const over = h.meshes.filter((m) => m.indices.length / 3 > MESHPART_TRIANGLES).length;
    if (over) warnings.push(`roblox: ${over} mesh${over === 1 ? " has" : "es have"} more than a MeshPart's ${MESHPART_TRIANGLES} triangles; lower the grid.`);
  }
  parts.push(`${opts.size.map(fmt).join(" × ")} studs, turned to face -Z`);
  return { glb, attachments: attachmentNames.map((n) => `${n}_Att`), note: parts.join("; "), warnings };
}

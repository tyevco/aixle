/**
 * Glass in the pbr kernel (pbr.ts): what a camera ray or a reflection sees where it meets a solid that lets light
 * through.
 *
 * Schlick's Fresnel at an index of 1.5 splits the light between a reflection and what is seen through the solid. The
 * reflection is traced while the depth budget lasts, else it is the sky as a mirror sees it. The refracted ray enters
 * the solid and the inside march (rays.insideMarch) carries it on the negated field to where it leaves, past the
 * zeros that two coincident faces only touch; there it refracts out by the field's normal and is traced, so the
 * drink, the far wall and the floor behind are what it shows. Where the exit is past the critical angle the ray
 * reflects inside and marches again, up to four times, and only then gives up on the sky behind, tinted: falling back
 * to the sky at the first such exit drew the white triangles in a tumbler's base. Every stretch inside absorbs by
 * Beer's law, σ = BEER(1 − c)/reach per channel (photometry.ts), the law the shadows through glass use too.
 *
 * A glass that does not let all its light through (transmit < 1) mixes with the surface shaded as a smooth
 * dielectric of its colour, as the old renderer did; a point light's highlight is analytic, with one occlusion ray,
 * and a directional light's is left to the reflection, which sees its softbox, traced or not.
 *
 * Glass seen through glass is shaded to a chain of two in full quality (the tumbler's drink, inside its glass, shows
 * no contour bands at two, so the chain is not cut to one) and one in draft; past it, the sky behind,
 * tinted by the glass's colour.
 */
import type { Material } from "../sdf/types.js";
import type { Rays } from "./rays.js";

/** Where a traced ray looks when it leaves the model: a reflection sees the sky as a mirror does, a refraction the backdrop the camera sees. */
export const SEE_MIRROR = 0, SEE_BACKDROP = 1;

/** Total internal reflections inside one solid before the ray is given up on. */
export const TIR_EVENTS = 4;
/** The index of refraction every glass has. */
export const IOR = 1.5;

/** What glass needs from the kernel's shading, which owns the scratch and the tracing. */
export interface GlassCore {
  /** Floats of radiance per depth: 3 per slot. */
  W: number;
  /** Radiance per depth of the recursion, W floats each. */
  COL: Float64Array;
  /** Depths the scratch holds. */
  MAXD: number;
  cell: number;
  rays: Rays;
  /** Reflections are traced while depth < maxDepth. */
  maxDepth: number;
  /** Follow a ray and put what it sees in COL at depth (the model shaded, the floor, or the sky seen as `see` says). */
  trace(depth: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, geometryOnly: boolean, see: number): boolean;
  /** The sky along a direction as `see` says (a mirror's, scaled by E with the lights' softboxes; or the backdrop) into out at o, W floats. */
  sky(dx: number, dy: number, dz: number, see: number, out: Float64Array, o: number): void;
  /** The field's unit normal at a point into out. */
  gradient(x: number, y: number, z: number, out: Float64Array): void;
  /** Shade the surface at depth as an opaque smooth dielectric of the glass's colour, without tracing, into COL at depth. */
  shadeOpaque(depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, rough: number, dx: number, dy: number, dz: number): void;
  /** Add each point light's GGX highlight on a smooth dielectric, times k, with one occlusion ray each, into COL at depth; a directional light's is the softbox the reflection sees. */
  highlights(depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, rough: number, k: number, reuse: boolean): void;
}

/** The glass shader over a kernel's core: shade(depth, hit point, the field's normal there, the material, the ray, its linear colour) into COL at depth. */
export function createGlass(core: GlassCore): (depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, m: Material, dx: number, dy: number, dz: number, cr: number, cg: number, cb: number) => void {
  const { W, COL, MAXD, cell, rays, maxDepth } = core;
  // Per depth: the reflection, what was seen through, the opaque shade.
  const GR = new Float64Array(MAXD * W), GT = new Float64Array(MAXD * W), GO = new Float64Array(MAXD * W);
  const G = new Float64Array(3);
  // The absorption along the refracted ray, per depth: the exit's trace can meet glass again (the chain), whose own
  // shade must not overwrite this one's (an amber slab seen in front of a clear pane lost its amber).
  const ABS = new Float64Array(MAXD * 3);

  return (depth, px, py, pz, nx, ny, nz, m, dx, dy, dz, cr, cg, cb) => {
    const o = depth * W, q = (depth + 1) * W;
    const cos = Math.max(0, -(nx * dx + ny * dy + nz * dz));
    const fres = 0.04 + 0.96 * Math.pow(1 - cos, 5);
    const tr = m.transmit;
    const deeper = depth + 1 < MAXD;
    // The reflection: traced within the budget, else the sky a mirror sees.
    const rdot = 2 * (dx * nx + dy * ny + dz * nz);
    let mx = dx - rdot * nx, my = dy - rdot * ny, mz = dz - rdot * nz;
    const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    const traced = depth < maxDepth && deeper;
    if (traced) {
      core.trace(depth + 1, px + nx * cell * 2, py + ny * cell * 2, pz + nz * cell * 2, mx, my, mz, false, SEE_MIRROR);
      for (let k = 0; k < W; k++) GR[o + k] = COL[q + k];
    } else core.sky(mx, my, mz, SEE_MIRROR, GR, o);
    // Refraction: into the solid, across it (reflecting inside where it cannot leave), and out.
    const a3 = depth * 3;
    ABS[a3] = 0; ABS[a3 + 1] = 0; ABS[a3 + 2] = 0;
    let seen = false;
    const eta = 1 / IOR;
    const k1 = 1 - eta * eta * (1 - cos * cos);
    let ix = dx, iy = dy, iz = dz;
    if (k1 >= 0 && deeper) {
      const a = eta * cos - Math.sqrt(k1);
      ix = eta * dx + a * nx; iy = eta * dy + a * ny; iz = eta * dz + a * nz;
      let il = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
      ix /= il; iy /= il; iz /= il;
      let ox = px - nx * cell, oy = py - ny * cell, oz = pz - nz * cell;
      for (let ev = 0; ev <= TIR_EVENTS; ev++) {
        const t = rays.insideMarch(ox, oy, oz, ix, iy, iz, m);
        if (t < 0) break;
        ABS[a3] += rays.abs[0]; ABS[a3 + 1] += rays.abs[1]; ABS[a3 + 2] += rays.abs[2];
        const qx = ox + ix * t, qy = oy + iy * t, qz = oz + iz * t;
        core.gradient(qx, qy, qz, G);
        const gx = G[0], gy = G[1], gz = G[2];
        // Out through the far face, whose outward normal is the gradient.
        const c2 = gx * ix + gy * iy + gz * iz;
        const k2 = 1 - IOR * IOR * (1 - c2 * c2);
        if (k2 >= 0) {
          const a2 = IOR * c2 - Math.sqrt(k2);
          let ex = IOR * ix - a2 * gx, ey = IOR * iy - a2 * gy, ez = IOR * iz - a2 * gz;
          const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
          ex /= el; ey /= el; ez /= el;
          core.trace(depth + 1, qx + gx * cell * 2, qy + gy * cell * 2, qz + gz * cell * 2, ex, ey, ez, false, SEE_BACKDROP);
          seen = true;
          break;
        }
        // Total internal reflection: off the far face, back inside, and on (after the last, the sky that way, tinted).
        ix -= 2 * c2 * gx; iy -= 2 * c2 * gy; iz -= 2 * c2 * gz;
        il = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
        ix /= il; iy /= il; iz /= il;
        ox = qx - gx * cell * 0.5; oy = qy - gy * cell * 0.5; oz = qz - gz * cell * 0.5;
      }
    }
    if (seen) for (let k = 0; k < W; k++) GT[o + k] = COL[q + k];
    else core.sky(ix, iy, iz, SEE_BACKDROP, GT, o);
    const ar = Math.exp(-ABS[a3]), ag = Math.exp(-ABS[a3 + 1]), ab = Math.exp(-ABS[a3 + 2]);
    for (let k = 0; k < W; k += 3) { GT[o + k] *= ar; GT[o + k + 1] *= ag; GT[o + k + 2] *= ab; }
    // The glass's own surface for the light it does not let through, as a smooth dielectric of its colour.
    if (tr < 1) {
      core.shadeOpaque(depth, px, py, pz, nx, ny, nz, cr, cg, cb, m.rough, dx, dy, dz);
      for (let k = 0; k < W; k++) GO[o + k] = COL[o + k];
    } else for (let k = 0; k < W; k++) GO[o + k] = 0;
    for (let k = 0; k < W; k++) COL[o + k] = (GT[o + k] * (1 - fres) + GR[o + k] * fres) * tr + GO[o + k] * (1 - tr);
    // The lights' highlights on the glass, which the mix above scaled by its transmission.
    core.highlights(depth, px, py, pz, nx, ny, nz, dx, dy, dz, m.rough, tr, tr < 1);
  };
}

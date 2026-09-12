/** An RGBA pixel buffer with the few drawing primitives the sheets need. */
import { encodePng } from "./png.js";

/** Packed 0xRRGGBB. */
export type Color = number;

export const rgb = (r: number, g: number, b: number): Color => (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b);
export const rgbf = (r: number, g: number, b: number): Color => rgb(r * 255, g * 255, b * 255);
const clamp8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export function mixColor(a: Color, b: Color, t: number): Color {
  const l = (x: number, y: number) => x + (y - x) * t;
  return rgb(l((a >> 16) & 255, (b >> 16) & 255), l((a >> 8) & 255, (b >> 8) & 255), l(a & 255, b & 255));
}

export class Canvas {
  readonly data: Uint8Array;

  constructor(readonly width: number, readonly height: number, fill?: Color) {
    this.data = new Uint8Array(width * height * 4);
    if (fill !== undefined) this.fill(0, 0, width, height, fill);
    else for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
  }

  set(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = (color >> 16) & 255;
    this.data[i + 1] = (color >> 8) & 255;
    this.data[i + 2] = color & 255;
    this.data[i + 3] = 255;
  }

  get(x: number, y: number): Color {
    const i = (y * this.width + x) * 4;
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }

  /** Blend `color` over the pixel with opacity `a` in 0..1. */
  blend(x: number, y: number, color: Color, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] += ((((color >> 16) & 255) - this.data[i]) * a) | 0;
    this.data[i + 1] += ((((color >> 8) & 255) - this.data[i + 1]) * a) | 0;
    this.data[i + 2] += (((color & 255) - this.data[i + 2]) * a) | 0;
    this.data[i + 3] = 255;
  }

  fill(x: number, y: number, w: number, h: number, color: Color): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w), y1 = Math.min(this.height, y + h);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this.set(i, j, color);
  }

  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.fill(x, y, w, 1, color);
    this.fill(x, y + h - 1, w, 1, color);
    this.fill(x, y, 1, h, color);
    this.fill(x + w - 1, y, 1, h, color);
  }

  /** Bresenham line with optional opacity. */
  line(x0: number, y0: number, x1: number, y1: number, color: Color, alpha = 1): void {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 100000; guard++) {
      if (alpha >= 1) this.set(x0, y0, color);
      else this.blend(x0, y0, color, alpha);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Copy `src` onto this canvas with its top-left at (x, y). */
  blit(src: Canvas, x: number, y: number): void {
    for (let j = 0; j < src.height; j++) {
      const ty = y + j;
      if (ty < 0 || ty >= this.height) continue;
      for (let i = 0; i < src.width; i++) {
        const tx = x + i;
        if (tx < 0 || tx >= this.width) continue;
        const si = (j * src.width + i) * 4, ti = (ty * this.width + tx) * 4;
        this.data[ti] = src.data[si];
        this.data[ti + 1] = src.data[si + 1];
        this.data[ti + 2] = src.data[si + 2];
        this.data[ti + 3] = 255;
      }
    }
  }

  /** Nearest-neighbour downscale by an integer factor (for thumbnails); averages the block. */
  downscale(factor: number): Canvas {
    const out = new Canvas(Math.floor(this.width / factor), Math.floor(this.height / factor));
    const n = factor * factor;
    for (let y = 0; y < out.height; y++)
      for (let x = 0; x < out.width; x++) {
        let r = 0, g = 0, b = 0;
        for (let j = 0; j < factor; j++)
          for (let i = 0; i < factor; i++) {
            const k = ((y * factor + j) * this.width + x * factor + i) * 4;
            r += this.data[k]; g += this.data[k + 1]; b += this.data[k + 2];
          }
        out.set(x, y, rgb(r / n, g / n, b / n));
      }
    return out;
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

/**
 * Draws examples/assets/label.png, the picture the tin example wraps and
 * sticks on: a cream label with a red border, the word AIXLE in the tool's
 * own stroke font, a row of dots, and a transparent margin so the decal's
 * edge is the label's edge, not the region's. Run with `npx tsx tools/assets/label.ts`.
 */
import { writeFileSync } from "node:fs";
import { Canvas, rgb } from "../../src/render/canvas.js";
import { drawText, textWidth } from "../../src/render/font.js";
import { encodePng } from "../../src/render/png.js";

const W = 160, H = 96;
const c = new Canvas(W, H, rgb(0, 0, 0));
// Everything starts transparent.
for (let i = 3; i < c.data.length; i += 4) c.data[i] = 0;
const cream = rgb(240, 230, 200), red = rgb(190, 50, 40), ink = rgb(40, 40, 46);
const set = (x: number, y: number, col: number) => { c.set(x, y, col); c.data[(y * W + x) * 4 + 3] = 255; };
// The label: an inset rounded rectangle with a border two pixels wide.
const m = 8, r = 10;
for (let y = m; y < H - m; y++)
  for (let x = m; x < W - m; x++) {
    const dx = Math.max(m + r - x, x - (W - m - 1 - r), 0), dy = Math.max(m + r - y, y - (H - m - 1 - r), 0);
    const inside = dx * dx + dy * dy <= r * r;
    if (!inside) continue;
    const edge = Math.max(m + r - x, x - (W - m - 1 - r), 0) ** 2 + Math.max(m + r - y, y - (H - m - 1 - r), 0) ** 2 > (r - 2.5) * (r - 2.5) || x < m + 2 || x >= W - m - 2 || y < m + 2 || y >= H - m - 2;
    set(x, y, edge ? red : cream);
  }
// The word, centred, at 3x, and a row of dots under it.
const word = "AIXLE";
const tw = textWidth(word, 3);
const before = new Uint8Array(c.data);
drawText(c, Math.round((W - tw) / 2), 26, word, ink, 3);
for (let i = 0; i < c.data.length; i += 4) if (c.data[i] !== before[i] || c.data[i + 1] !== before[i + 1] || c.data[i + 2] !== before[i + 2]) c.data[i + 3] = 255;
for (let i = 0; i < 7; i++) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) set(44 + i * 12 + dx, 66 + dy, red);
writeFileSync("examples/assets/label.png", encodePng(W, H, c.data));
console.log("wrote examples/assets/label.png");

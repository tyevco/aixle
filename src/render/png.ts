/**
 * Minimal PNG encoder: 8-bit RGBA, no interlace, one IDAT. Node has zlib
 * built in, so there is no dependency and the output is reproducible.
 */
import { deflateSync, inflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode row-major RGBA pixels (4 bytes per pixel) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes, got ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A decoded PNG: 8-bit RGBA, row-major. */
export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Decode a PNG file: greyscale, greyscale with alpha, RGB, RGBA and palette images at 1 to 16 bits, not interlaced,
 * with the five row filters. Anything else says what it is. Sixteen-bit samples keep their high byte.
 */
/**
 * An animated PNG of same-sized RGBA frames, each shown for `delayMs`, looping: an acTL after the header, an fcTL
 * before each frame, the first frame's data in IDAT and the others' in fdAT. A browser shows it as a picture that
 * moves; a viewer that knows no APNG shows the first frame.
 */
export function encodeApng(width: number, height: number, frames: Uint8Array[], delayMs = 80): Buffer {
  if (!frames.length) throw new Error("an animated PNG needs at least one frame");
  for (const f of frames) if (f.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes per frame, got ${f.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4);
  const stride = width * 4;
  const filtered = (rgba: Uint8Array): Buffer => {
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
    return deflateSync(raw, { level: 9 });
  };
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("acTL", actl)];
  let seq = 0;
  frames.forEach((f, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(Math.max(1, Math.round(delayMs)), 20);
    fctl.writeUInt16BE(1000, 22);
    fctl[24] = 0; fctl[25] = 0;
    parts.push(chunk("fcTL", fctl));
    const data = filtered(f);
    if (i === 0) parts.push(chunk("IDAT", data));
    else {
      const fdat = Buffer.alloc(4 + data.length);
      fdat.writeUInt32BE(seq++, 0);
      data.copy(fdat, 4);
      parts.push(chunk("fdAT", fdat));
    }
  });
  parts.push(chunk("IEND", new Uint8Array(0)));
  return Buffer.concat(parts);
}

export function decodePng(data: Uint8Array): DecodedPng {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 8 || sig.some((b, i) => data[i] !== b)) throw new Error("not a PNG file");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
  let palette: Uint8Array | undefined, trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= data.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
      depth = data[pos + 16]; colorType = data[pos + 17]; interlace = data[pos + 20];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error("PNG has no IHDR");
  if (interlace) throw new Error("interlaced PNGs are not supported; save it without interlace");
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`PNG colour type ${colorType} is not supported`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of idat) { joined.set(c, at); at += c.length; }
  const raw = inflateSync(joined);
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is truncated");
  // Unfilter, row by row.
  const rows = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`PNG row filter ${filter} is not valid`);
      row[i] = v & 255;
    }
    prev = row;
  }
  // Samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];
    const bit = index * depth, byte = row[bit >> 3], shift = 8 - depth - (bit & 7);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const i = sample(row, x);
        if (!palette || i * 3 + 2 >= palette.length) throw new Error("PNG palette entry is missing");
        rgba[o] = palette[i * 3]; rgba[o + 1] = palette[i * 3 + 1]; rgba[o + 2] = palette[i * 3 + 2];
        rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(row, x * channels);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sample(row, x * channels + 1) : 255;
      } else {
        rgba[o] = sample(row, x * channels); rgba[o + 1] = sample(row, x * channels + 1); rgba[o + 2] = sample(row, x * channels + 2);
        rgba[o + 3] = colorType === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

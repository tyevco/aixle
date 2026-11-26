/**
 * A zip archive, the container a 3MF file is: each entry stored or
 * deflated with Node's zlib, a local header before its data, a central
 * directory after them all, and the end record. No zip64, so an archive
 * stays under 4 GB, which a model's mesh is far from. Every entry carries
 * the same fixed date (1980-01-01, the format's first), so the file is
 * reproducible byte for byte.
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../render/png.js";

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Deflate the entry (method 8); stored as it is otherwise (method 0). */
  deflate?: boolean;
}

/** DOS time and date fields for 1980-01-01 00:00:00. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const body = e.deflate ? deflateRawSync(e.data, { level: 6 }) : e.data;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, for deflate
    local.writeUInt16LE(0x0800, 6); // flags: the name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by: 2.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attributes, external attributes: all zero
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const dirSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** The entries of an archive this writer made (or any plain zip with stored or deflated entries): for tests. */
export function unzip(buf: Buffer, inflate: (b: Buffer) => Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip: no end record");
  const count = buf.readUInt16LE(e + 10);
  let o = buf.readUInt32LE(e + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(o + 10);
    const crc = buf.readUInt32LE(o + 16);
    const size = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32);
    const local = buf.readUInt32LE(o + 42);
    const name = buf.toString("utf8", o + 46, o + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26), lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtra;
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? inflate(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.set(name, data);
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

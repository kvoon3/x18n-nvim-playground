import { readFile, readlink, lstat, rename, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { sha256Bytes } from './lib.mjs';

const BLOCK = 512;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * A gzip member with a fixed header, including the OS byte, so macOS and Linux
 * produce the same bytes. Node's gzipSync leaves the OS byte to the platform zlib.
 */
export function gzipDeterministic(data) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
  const body = deflateRawSync(data, { level: 9 });
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(crc32(data), 0);
  footer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, body, footer]);
}

function octal(value, width) {
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error(`tar field overflow: ${value}`);
  return `${text.padStart(width - 1, '0')}\0`;
}

function header({ name, mode, size, typeflag, linkname }) {
  let prefix = '';
  let shortName = name;
  if (Buffer.byteLength(name) > 100) {
    let split = -1;
    for (let i = name.length - 1; i > 0; i--) {
      if (name[i] !== '/') continue;
      const candidate = name.slice(0, i);
      if (Buffer.byteLength(candidate) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
        split = i;
        break;
      }
    }
    if (split === -1) throw new Error(`tar path too long for ustar: ${name}`);
    prefix = name.slice(0, split);
    shortName = name.slice(split + 1);
  }
  if (Buffer.byteLength(shortName) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`tar path too long for ustar: ${name}`);
  }
  if (Buffer.byteLength(linkname) > 100) throw new Error(`tar symlink target too long: ${linkname}`);

  const block = Buffer.alloc(BLOCK);
  block.write(shortName, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'latin1');
  block.write(octal(0, 8), 108, 8, 'latin1');
  block.write(octal(0, 8), 116, 8, 'latin1');
  block.write(octal(size, 12), 124, 12, 'latin1');
  block.write(octal(0, 12), 136, 12, 'latin1');
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, 1, 'latin1');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(octal(0, 8), 329, 8, 'latin1');
  block.write(octal(0, 8), 337, 8, 'latin1');
  block.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

function pad(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/**
 * Write a canonical .tar.gz: sorted members, mtime 0, uid/gid 0, empty
 * uname/gname, owner mode normalised to 0644/0755, and a fixed gzip header.
 * Symlinks stay symlinks and keep their target.
 */
export async function createTarGz({ cwd, entries, outFile }) {
  const sorted = [...entries].sort();
  const chunks = [];
  for (const entry of sorted) {
    const abs = join(cwd, entry);
    const info = await lstat(abs);
    if (info.isDirectory()) throw new Error(`tar entry is a directory: ${entry}`);
    if (info.isSymbolicLink()) {
      const target = await readlink(abs);
      chunks.push(header({ name: entry, mode: 0o755, size: 0, typeflag: '2', linkname: target }));
      continue;
    }
    if (!info.isFile()) throw new Error(`tar entry is not a regular file or symlink: ${entry}`);
    const data = await readFile(abs);
    const mode = info.mode & 0o111 ? 0o755 : 0o644;
    chunks.push(header({ name: entry, mode, size: data.length, typeflag: '0', linkname: '' }));
    chunks.push(data);
    const padding = pad(data.length);
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const tar = Buffer.concat(chunks);
  const gz = gzipDeterministic(tar);
  const tmp = `${outFile}.tmp-${process.pid}`;
  await writeFile(tmp, gz);
  await rename(tmp, outFile);
  return {
    bytes: gz.length,
    sha256: await sha256Bytes(gz),
    entries: sorted.length,
    members: sorted,
  };
}

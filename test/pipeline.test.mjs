import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  cleanCompressed,
  computeAssetDigest,
  loadPins,
  pathExists,
  readPackages,
  readRootLspVersion,
  runCapture,
  sha256File,
  walkFiles,
} from '../scripts/lib.mjs';
import { createTarGz } from '../scripts/tar.mjs';
import { tarballsFor } from '../scripts/build-assets.mjs';

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AARCH64_TARBALLS = tarballsFor('aarch64');

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'x18n-demo-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function digestInput(overrides = {}) {
  return {
    lspVersion: '0.1.13',
    alpine: {
      release: 'v3.24',
      arch: 'aarch64',
      mirrors: ['https://dl-cdn.alpinelinux.org/alpine'],
    },
    packages: ['ada-libs-4.0.0-r0.apk', 'nodejs-24.22.3-r0.apk'],
    tarballs: [AARCH64_TARBALLS.nodejs, AARCH64_TARBALLS.rest, AARCH64_TARBALLS.lsp],
    ...overrides,
  };
}

test('asset digest is stable across package order and sensitive to every input', () => {
  const base = digestInput();
  const digest = computeAssetDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    digest,
    computeAssetDigest({ ...base, packages: [...base.packages].reverse() }),
    'a reordered package list must not change the digest',
  );
  assert.notEqual(digest, computeAssetDigest({ ...base, lspVersion: '0.1.14' }));
  assert.notEqual(digest, computeAssetDigest({ ...base, alpine: { ...base.alpine, release: 'v3.25' } }));
  assert.notEqual(
    digest,
    computeAssetDigest({ ...base, alpine: { ...base.alpine, mirrors: ['https://mirror.example/alpine'] } }),
  );
  assert.notEqual(
    digest,
    computeAssetDigest({ ...base, tarballs: [AARCH64_TARBALLS.nodejs, AARCH64_TARBALLS.rest, { ...AARCH64_TARBALLS.lsp, fileName: 'x.tar.gz' }] }),
  );
});

test('cleanCompressed removes br, zst, and non-tar gz files only', async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'nested'));
  for (const name of ['a.js', 'a.js.br', 'a.js.gz', 'a.js.zst', 'x.tar.gz', 'nested/y.gz']) {
    await writeFile(join(dir, name), 'data');
  }
  const removed = await cleanCompressed(dir);
  assert.deepEqual(removed, ['a.js.br', 'a.js.gz', 'a.js.zst', 'nested/y.gz']);
  assert.deepEqual(await walkFiles(dir), ['a.js', 'x.tar.gz']);
});

function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const text = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12), 8);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      mode: text(100, 8),
      uid: text(108, 8),
      gid: text(116, 8),
      mtime: text(136, 12),
      type: String.fromCharCode(block[156]),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('the tar writer is deterministic and normalizes metadata', async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'tree');
  const longDir = join(root, 'node_modules', 'x'.repeat(80));
  await mkdir(longDir, { recursive: true });
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'index.js'), 'console.log("x")\n');
  await writeFile(join(longDir, 'file.js'), 'export {};\n');
  await chmod(join(root, 'index.js'), 0o755);
  await symlink('../../index.js', join(root, 'node_modules', '.bin', 'pkg'));

  const entries = await walkFiles(root);
  const first = join(dir, 'first.tar.gz');
  const second = join(dir, 'second.tar.gz');
  const result = await createTarGz({ cwd: root, entries, outFile: first });
  const repeat = await createTarGz({ cwd: root, entries, outFile: second });
  assert.equal(result.sha256, repeat.sha256);
  assert.equal(await sha256File(first), await sha256File(second));

  const gz = await readFile(first);
  assert.equal(gz[4], 0, 'gzip mtime byte 0');
  assert.equal(gz[9], 0xff, 'gzip OS byte is the platform-neutral unknown value');
  const members = parseTar(gunzipSync(gz));
  const names = members.map((entry) => entry.name);
  assert.ok(names.includes(`node_modules/${'x'.repeat(80)}/file.js`));
  assert.ok(names.includes('node_modules/.bin/pkg'));
  for (const entry of members) {
    assert.equal(entry.uid, '0000000');
    assert.equal(entry.gid, '0000000');
    assert.equal(entry.mtime, '00000000000');
  }
  assert.equal(members.find((entry) => entry.name === 'index.js').mode, '0000755');
  assert.equal(members.find((entry) => entry.name === 'node_modules/.bin/pkg').type, '2');

  const listed = await runCapture('tar', ['-tzf', first]);
  assert.equal(listed.code, 0);
  assert.ok(listed.stdout.includes(`node_modules/${'x'.repeat(80)}/file.js`));
});

test('the pinned LSP version must be exact', async (t) => {
  const lock = JSON.parse(await readFile(join(DEMO_ROOT, 'asset-lock.json'), 'utf8'));
  assert.match(lock.lspVersion, /^\d+\.\d+\.\d+$/);
  const dir = await tempDir(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@x18n/lsp': '^0.1.13' } }));
  await assert.rejects(readRootLspVersion(dir), /must be an exact version/);
});

test('the committed pins and package list are complete', async () => {
  const pins = await loadPins(DEMO_ROOT);
  assert.match(pins.plugin.repo, /^[^/]+\/[^/]+$/);
  assert.match(pins.plugin.commit, /^[0-9a-f]{40}$/);
  assert.match(pins.unkernel.commit, /^[0-9a-f]{40}$/);
  assert.match(pins.kernel.sha256, /^[0-9a-f]{64}$/);
  const packages = await readPackages(DEMO_ROOT);
  assert.equal(packages.length, 35);
  assert.equal(packages.filter((name) => name.startsWith('nodejs-')).length, 1);
});

test('asset-lock.json matches the current inputs when it exists', async (t) => {
  const lockFile = join(DEMO_ROOT, 'asset-lock.json');
  if (!(await pathExists(lockFile))) {
    t.skip('asset-lock.json is not generated yet; run the asset build');
    return;
  }
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  const pins = await loadPins(DEMO_ROOT);
  const packages = await readPackages(DEMO_ROOT);
  const tarballs = tarballsFor(pins.alpine.arch);
  assert.equal(
    lock.inputsSha256,
    computeAssetDigest({
      lspVersion: lock.lspVersion,
      alpine: pins.alpine,
      packages,
      tarballs: [tarballs.nodejs, tarballs.rest, tarballs.lsp],
    }),
  );
  assert.equal(lock.tarballs.length, 3);
  assert.deepEqual(
    lock.tarballs.map((entry) => [entry.kind, entry.fileName, entry.guestName]),
    [
      ['apk-nodejs', 'nodejs-apk.tar.gz', 'nodejs-apk.tar.gz'],
      ['apk-rest', 'apk-repo-rest.tar.gz', 'apk-repo-rest.tar.gz'],
      ['lsp', 'x18n-lsp-aarch64-musl.tar.gz', 'x18n-lsp.tar.gz'],
    ],
  );
  for (const entry of lock.tarballs) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});

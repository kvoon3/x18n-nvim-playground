import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  computeAssetDigest,
  ensureDir,
  fileExists,
  formatBytes,
  loadPins,
  log,
  npmCpuFor,
  pathExists,
  readJson,
  readPackages,
  readRootLspVersion,
  removePath,
  run,
  runCapture,
  sha256Bytes,
  sha256File,
  walkFiles,
  warn,
  writeFileAtomic,
  writeJsonAtomic,
} from './lib.mjs';
import { lspClosurePackage, oxcPackage } from './refresh-lsp-lock.mjs';
import { createTarGz } from './tar.mjs';

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DEMO_ROOT, '..', '..');

const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export function tarballsFor(arch) {
  return Object.freeze({
    nodejs: {
      kind: 'apk-nodejs',
      fileName: 'nodejs-apk.tar.gz',
      guestName: 'nodejs-apk.tar.gz',
    },
    rest: {
      kind: 'apk-rest',
      fileName: 'apk-repo-rest.tar.gz',
      guestName: 'apk-repo-rest.tar.gz',
    },
    lsp: {
      kind: 'lsp',
      fileName: `x18n-lsp-${arch}-musl.tar.gz`,
      guestName: 'x18n-lsp.tar.gz',
    },
  });
}

export function lspRequiredPaths(arch) {
  return Object.freeze([
    'node_modules/@x18n/lsp/bin.mjs',
    'node_modules/@x18n/lsp/package.json',
    `node_modules/${oxcPackage(arch)}`,
  ]);
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function assertLockShape(lock, { lspVersion, pins, packages, tarballs, requiredPaths }) {
  const bad = (message) => {
    throw new Error(`[demo-assets] asset-lock.json ${message}; run make demo-refresh`);
  };
  if (lock?.schemaVersion !== 1) bad(`has schemaVersion ${JSON.stringify(lock?.schemaVersion)}`);
  if (lock.lspVersion !== lspVersion) {
    bad(`records @x18n/lsp ${lock.lspVersion}, but the root package.json pins ${lspVersion}`);
  }
  if (lock.alpine?.release !== pins.alpine.release || lock.alpine?.arch !== pins.alpine.arch) {
    bad(
      `records alpine ${lock.alpine?.release}/${lock.alpine?.arch}, ` +
        `but pins.json says ${pins.alpine.release}/${pins.alpine.arch}`,
    );
  }
  const locked = (lock.alpine?.packages ?? []).map((entry) => entry.fileName);
  if (JSON.stringify(locked) !== JSON.stringify(packages)) {
    const missing = packages.filter((name) => !locked.includes(name));
    const extra = locked.filter((name) => !packages.includes(name));
    bad(`package set differs from packages.txt (missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'})`);
  }
  for (const entry of lock.alpine.packages) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      bad(`package ${entry.fileName} has no byte count and sha256`);
    }
    if (entry.repo !== 'main' && entry.repo !== 'community') bad(`package ${entry.fileName} has no repo`);
  }
  for (const [index, key] of ['nodejs', 'rest', 'lsp'].entries()) {
    const expected = tarballs[key];
    const actual = lock.tarballs?.[index];
    if (!actual || actual.kind !== expected.kind || actual.fileName !== expected.fileName || actual.guestName !== expected.guestName) {
      bad(`tarball ${index} must be ${expected.kind} ${expected.fileName}/${expected.guestName}`);
    }
    if (!Number.isSafeInteger(actual.bytes) || actual.bytes <= 0) bad(`tarball ${expected.fileName} has no byte count`);
    if (!/^[0-9a-f]{64}$/.test(actual.sha256 ?? '')) bad(`tarball ${expected.fileName} has no sha256`);
  }
  const lsp = lock.tarballs[2];
  if (JSON.stringify(lsp.requiredPaths) !== JSON.stringify(requiredPaths)) {
    bad('lsp.requiredPaths is not the expected list');
  }
}

async function tarballCacheReasons(lock, assetsDir) {
  const reasons = [];
  for (const entry of lock.tarballs) {
    const file = join(assetsDir, entry.fileName);
    try {
      const info = await stat(file);
      if (info.size !== entry.bytes) {
        reasons.push(`${entry.fileName}: ${info.size} bytes, lock says ${entry.bytes}`);
        continue;
      }
      if ((await sha256File(file)) !== entry.sha256) {
        reasons.push(`${entry.fileName}: sha256 differs from the lock`);
      }
    } catch {
      reasons.push(`${entry.fileName}: missing`);
    }
  }
  return reasons;
}

async function verifyMembers(file, members) {
  const { code, stdout, stderr } = await runCapture('tar', ['-tzf', file]);
  if (code !== 0) throw new Error(`[demo-assets] tar -tzf ${file} failed: ${stderr.trim()}`);
  const listed = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const expected = [...members].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !listed.includes(name));
    const extra = listed.filter((name) => !expected.includes(name));
    throw new Error(
      `[demo-assets] ${file} members differ (missing ${missing.slice(0, 5).join(', ') || 'none'}; ` +
        `extra ${extra.slice(0, 5).join(', ') || 'none'})`,
    );
  }
}

async function downloadApk({ fileName, mirrors, release, arch }) {
  const attempts = [];
  const repos = ['main', 'community'];
  for (const mirror of mirrors) {
    for (const repo of repos) {
      const url = `${mirror}/${release}/${repo}/${arch}/${fileName}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        let status;
        try {
          const response = await fetch(url, {
            headers: { 'user-agent': 'x18n-demo-build' },
            redirect: 'follow',
            signal: AbortSignal.timeout(120_000),
          });
          status = response.status;
          if (status === 404) {
            attempts.push(`${url} (404)`);
            break;
          }
          if (response.ok) {
            const data = Buffer.from(await response.arrayBuffer());
            if (data.length < 2 || !data.subarray(0, 2).equals(GZIP_MAGIC)) {
              attempts.push(`${url} (200, not a gzip file)`);
              break;
            }
            return { data, repo, url, bytes: data.length, sha256: await sha256Bytes(data), attempts };
          }
          attempts.push(`${url} (${status})`);
          if (status < 500) break;
        } catch (error) {
          status = 'network error';
          attempts.push(`${url} (${error.message})`);
        }
        if (attempt === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
    }
  }
  throw new Error(
    `[demo-assets] missing Alpine package ${fileName}\n  tried:\n    ${attempts.join('\n    ')}\n` +
      `  fix: update packages.txt from the ${release} ${arch} indexes, or bump pins.alpine.release; then run make demo-refresh`,
  );
}

async function ensureLspClosure({ demoRoot, workDir, version, arch }) {
  const lspDir = join(workDir, 'lsp');
  const lockFile = join(demoRoot, 'lsp-lock', 'package-lock.json');
  const npmCpu = npmCpuFor(arch);
  const requiredPaths = lspRequiredPaths(arch);
  if (!(await fileExists(lockFile))) {
    throw new Error(`[demo-assets] ${lockFile} is missing; run make demo-refresh`);
  }
  await removePath(lspDir);
  await ensureDir(lspDir);
  await writeFileAtomic(join(lspDir, 'package-lock.json'), await readFile(lockFile));
  await writeJsonAtomic(join(lspDir, 'package.json'), lspClosurePackage(version));

  log('assets', `installing @x18n/lsp@${version} for linux/${arch}/musl`);
  await run(
    'npm',
    [
      'ci',
      '--os=linux',
      `--cpu=${npmCpu}`,
      '--libc=musl',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ],
    { cwd: lspDir, logFile: join(workDir, 'logs', 'assets-npm.log'), timeoutMs: 10 * 60 * 1000 },
  );

  const installed = JSON.parse(await readFile(join(lspDir, 'node_modules', '@x18n', 'lsp', 'package.json'), 'utf8'));
  if (installed.version !== version) {
    throw new Error(`[demo-assets] npm installed @x18n/lsp ${installed.version}, expected ${version}`);
  }
  for (const required of requiredPaths) {
    if (!(await pathExists(join(lspDir, required)))) {
      throw new Error(
        `[demo-assets] the installed LSP closure is missing ${required}; ` +
          `the ${arch}/musl optional dependency did not resolve`,
      );
    }
  }
  return lspDir;
}

async function buildTarball({ tarballs, key, cwd, entries, assetsDir, logLine }) {
  const spec = tarballs[key];
  const outFile = join(assetsDir, spec.fileName);
  const result = await createTarGz({ cwd, entries, outFile });
  if (result.bytes > MAX_ASSET_BYTES) {
    throw new Error(
      `[demo-assets] ${spec.fileName} is ${formatBytes(result.bytes)}, over the 25 MiB Workers Assets limit`,
    );
  }
  logLine(`built ${spec.fileName} (${result.bytes} bytes, sha256 ${result.sha256.slice(0, 12)}...)`);
  return result;
}

export async function buildAssets({
  demoRoot = DEMO_ROOT,
  repoRoot = REPO_ROOT,
  workDir = join(DEMO_ROOT, 'build'),
  update = false,
  verifyOnly = false,
  force = false,
} = {}) {
  const pins = await loadPins(demoRoot);
  const arch = pins.alpine.arch;
  const tarballs = tarballsFor(arch);
  const requiredPaths = lspRequiredPaths(arch);
  const packages = await readPackages(demoRoot);
  const lspVersion = await readRootLspVersion(repoRoot);
  const assetsDir = join(workDir, 'assets');
  const lockFile = join(demoRoot, 'asset-lock.json');
  const mirrorOverride = process.env.DEMO_ALPINE_MIRROR?.replace(/\/$/, '');
  const mirrors = mirrorOverride
    ? [mirrorOverride, ...pins.alpine.mirrors.filter((mirror) => mirror !== mirrorOverride)]
    : pins.alpine.mirrors;

  const inputsSha256 = computeAssetDigest({
    lspVersion,
    alpine: { ...pins.alpine, mirrors },
    packages,
    tarballs: [tarballs.nodejs, tarballs.rest, tarballs.lsp],
  });
  log('assets', `inputs sha256:${inputsSha256.slice(0, 12)}...`);

  let previous;
  if (await fileExists(lockFile)) {
    previous = await readJson(lockFile);
    if (!update) {
      assertLockShape(previous, { lspVersion, pins, packages, tarballs, requiredPaths });
      if (previous.inputsSha256 && previous.inputsSha256 !== inputsSha256) {
        throw new Error(
          '[demo-assets] the asset inputs changed (LSP version, Alpine release, mirror, package list, ' +
            'or tarball names); run make demo-refresh',
        );
      }
    }
  } else if (!update) {
    throw new Error(`[demo-assets] ${lockFile} is missing; run make demo-refresh`);
  }

  if (previous && !force && !update) {
    const reasons = await tarballCacheReasons(previous, assetsDir);
    if (reasons.length === 0) {
      const bytes = previous.tarballs.reduce((sum, entry) => sum + entry.bytes, 0);
      log('assets', `cached ${previous.tarballs.length} tarballs (${formatBytes(bytes)}); asset-lock.json verified`);
      return { lock: previous, changed: false, cached: true };
    }
    if (verifyOnly) {
      throw new Error(`[demo-assets] the asset cache is invalid: ${reasons.join('; ')}; run make demo-assets`);
    }
    log('assets', `rebuilding assets: ${reasons.join('; ')}`);
  }

  const apkDir = join(workDir, 'apk');
  await ensureDir(apkDir);
  await ensureDir(assetsDir);
  await ensureDir(join(workDir, 'logs'));

  const previousPackages = new Map((previous?.alpine?.packages ?? []).map((entry) => [entry.fileName, entry]));
  const packageEntries = [];
  let downloaded = 0;
  for (const fileName of packages) {
    const expected = previousPackages.get(fileName);
    const file = join(apkDir, fileName);
    if (!update && expected && !force && (await fileExists(file))) {
      const info = await stat(file);
      if (info.size === expected.bytes && (await sha256File(file)) === expected.sha256) {
        packageEntries.push(expected);
        continue;
      }
    }

    const result = await downloadApk({
      fileName,
      mirrors,
      release: pins.alpine.release,
      arch: pins.alpine.arch,
    });
    if (!update) {
      if (!expected) {
        throw new Error(`[demo-assets] asset-lock.json has no entry for ${fileName}; run make demo-refresh`);
      }
      if (result.sha256 !== expected.sha256 || result.bytes !== expected.bytes) {
        throw new Error(
          `[demo-assets] ${fileName} from ${result.url} is ${result.bytes} bytes sha256 ${result.sha256}, ` +
            `but the lock says ${expected.bytes} bytes sha256 ${expected.sha256}; ` +
            'the mirror changed. Inspect it, then run make demo-refresh',
        );
      }
      if (result.repo !== expected.repo) {
        warn('assets', `${fileName} is now served from ${result.repo}, the lock recorded ${expected.repo}`);
      }
      packageEntries.push(expected);
    } else {
      packageEntries.push({
        fileName,
        repo: result.repo,
        bytes: result.bytes,
        sha256: result.sha256,
      });
    }
    await writeFileAtomic(file, result.data);
    downloaded += 1;
  }
  log(
    'assets',
    `${packages.length} packages (${downloaded} downloaded, ${packages.length - downloaded} from build/apk)`,
  );

  const lspDir = await ensureLspClosure({ demoRoot, workDir, version: lspVersion, arch });
  const lspEntries = (await walkFiles(join(lspDir, 'node_modules'))).map((rel) => `node_modules/${rel}`);

  const nodejsNames = packages.filter((name) => name.startsWith('nodejs-'));
  const restNames = packages.filter((name) => !name.startsWith('nodejs-'));
  assert(nodejsNames.length === 1, '[demo-assets] packages.txt must contain exactly one nodejs package');

  const built = {
    nodejs: await buildTarball({
      tarballs,
      key: 'nodejs',
      cwd: apkDir,
      entries: nodejsNames,
      assetsDir,
      logLine: (message) => log('assets', message),
    }),
    rest: await buildTarball({
      tarballs,
      key: 'rest',
      cwd: apkDir,
      entries: restNames,
      assetsDir,
      logLine: (message) => log('assets', message),
    }),
    lsp: await buildTarball({
      tarballs,
      key: 'lsp',
      cwd: lspDir,
      entries: lspEntries,
      assetsDir,
      logLine: (message) => log('assets', message),
    }),
  };

  const lockTarballs = [
    {
      kind: tarballs.nodejs.kind,
      fileName: tarballs.nodejs.fileName,
      guestName: tarballs.nodejs.guestName,
      bytes: built.nodejs.bytes,
      sha256: built.nodejs.sha256,
      members: built.nodejs.members,
    },
    {
      kind: tarballs.rest.kind,
      fileName: tarballs.rest.fileName,
      guestName: tarballs.rest.guestName,
      bytes: built.rest.bytes,
      sha256: built.rest.sha256,
      members: built.rest.members,
    },
    {
      kind: tarballs.lsp.kind,
      fileName: tarballs.lsp.fileName,
      guestName: tarballs.lsp.guestName,
      bytes: built.lsp.bytes,
      sha256: built.lsp.sha256,
      entries: built.lsp.entries,
      requiredPaths: [...requiredPaths],
    },
  ];

  const lock = {
    schemaVersion: 1,
    inputsSha256,
    lspVersion,
    alpine: {
      release: pins.alpine.release,
      arch: pins.alpine.arch,
      packages: packageEntries,
    },
    tarballs: lockTarballs,
  };

  if (!update) {
    for (const [index, key] of ['nodejs', 'rest', 'lsp'].entries()) {
      const expected = previous.tarballs[index];
      const actual = lockTarballs[index];
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(
          `[demo-assets] rebuilt ${actual.fileName} is ${actual.bytes} bytes sha256 ${actual.sha256}, ` +
            `but the lock says ${expected.bytes} bytes sha256 ${expected.sha256}; ` +
            'the inputs are not reproducing. Check the Node/npm versions, then run make demo-refresh and review the diff',
        );
      }
    }
    log('assets', 'rebuilt tarballs match asset-lock.json');
  }

  await verifyMembers(join(assetsDir, tarballs.nodejs.fileName), built.nodejs.members);
  await verifyMembers(join(assetsDir, tarballs.rest.fileName), built.rest.members);
  const lspList = await runCapture('tar', ['-tzf', join(assetsDir, tarballs.lsp.fileName)]);
  if (lspList.code !== 0) throw new Error(`[demo-assets] tar -tzf on the LSP tarball failed: ${lspList.stderr}`);
  for (const required of built.lsp.members.filter((name) => requiredPaths.includes(name))) {
    if (!lspList.stdout.split('\n').includes(required)) {
      throw new Error(`[demo-assets] the LSP tarball does not contain ${required}`);
    }
  }
  if (lspList.stdout.split('\n').filter(Boolean).length !== built.lsp.entries) {
    throw new Error('[demo-assets] the LSP tarball member count changed between writing and listing');
  }

  if (update) {
    await writeJsonAtomic(lockFile, lock);
    log('assets', `wrote ${lockFile}`);
  }

  const total = lockTarballs.reduce((sum, entry) => sum + entry.bytes, 0);
  log('assets', `3 tarballs, ${formatBytes(total)} total; asset-lock.json ${update ? 'written' : 'verified'}`);
  return { lock, changed: update, cached: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildAssets({
      update: process.argv.includes('--update'),
      verifyOnly: process.argv.includes('--verify-only'),
      force: process.argv.includes('--force'),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

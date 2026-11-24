import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLORS ? `\u001b[2m${s}\u001b[0m` : s);

export function log(scope, message) {
  console.log(`${dim(`[demo-${scope}]`)} ${message}`);
}

export function warn(scope, message) {
  console.error(`${dim(`[demo-${scope}]`)} warning: ${message}`);
}

export function fail(scope, message) {
  throw new Error(`[demo-${scope}] ${message}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFileAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function copyFileAtomic(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
}

export async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function removePath(path) {
  await rm(path, { recursive: true, force: true });
}

export async function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Sorted relative paths of regular files and symlinks below root. */
export async function walkFiles(root, { skip } = {}) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (skip?.(entry.name, rel)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
    else await copyFile(from, to);
  }
}

/** Rename a directory, copying and removing when the platforms are on different filesystems. */
export async function moveDir(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyDir(src, dest);
    await removePath(src);
  }
}

let resolvedPnpm;

/** The repo-pinned pnpm, even when mise is not activated in the shell. */
export async function pnpmCommand() {
  if (resolvedPnpm) return resolvedPnpm;
  if (process.env.PNPM_BIN) {
    resolvedPnpm = process.env.PNPM_BIN;
    return resolvedPnpm;
  }
  try {
    const { code, stdout } = await runCapture('mise', ['which', 'pnpm']);
    if (code === 0 && stdout.trim()) {
      resolvedPnpm = stdout.trim();
      return resolvedPnpm;
    }
  } catch {}
  resolvedPnpm = 'pnpm';
  return resolvedPnpm;
}

export async function runCapture(cmd, args, { cwd, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export async function gitOutput(cwd, args) {
  const { code, stdout, stderr } = await runCapture('git', args, { cwd });
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim()}`);
  return stdout.replace(/\n$/, '');
}

/**
 * Run a command, teeing stdout and stderr to the console and to one log file.
 * Returns the bounded combined output; throws on a non-zero exit unless allowFailure.
 */
export async function run(cmd, args, opts = {}) {
  const {
    cwd,
    env = {},
    logFile,
    timeoutMs = 0,
    allowFailure = false,
    quiet = false,
    tailBytes = 16 * 1024,
  } = opts;
  if (logFile) {
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, `$ ${cmd} ${args.join(' ')}\n`);
  }
  const logStream = logFile ? createWriteStream(logFile, { flags: 'a' }) : undefined;
  const childEnv = { ...process.env, ...env };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key];
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk, toStdout) => {
      output = (output + chunk).slice(-tailBytes);
      logStream?.write(chunk);
      if (!quiet) (toStdout ? process.stdout : process.stderr).write(chunk);
    };
    child.stdout.on('data', (chunk) => onData(chunk, true));
    child.stderr.on('data', (chunk) => onData(chunk, false));
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${timeoutMs} ms${logFile ? `; see ${logFile}` : ''}`));
      }, timeoutMs);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      logStream?.end();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      logStream?.end();
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `${cmd} ${args.join(' ')} exited ${code}${logFile ? `; see ${logFile}` : ''}\n${output.trim()}`,
          ),
        );
        return;
      }
      resolvePromise({ code, output });
    });
  });
}

export function isExactVersion(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/** Remove Nitro's compressed siblings, keeping .tar.gz. Returns the removed relative paths. */
export async function cleanCompressed(dir) {
  const removed = [];
  for (const rel of await walkFiles(dir)) {
    if (rel.endsWith('.tar.gz')) continue;
    if (rel.endsWith('.br') || rel.endsWith('.zst') || rel.endsWith('.gz')) {
      await rm(join(dir, rel));
      removed.push(rel);
    }
  }
  return removed;
}

export const NPM_CPU = Object.freeze({ aarch64: 'arm64', riscv64: 'riscv64' });
const SUPPORTED_ARCHES = Object.keys(NPM_CPU);

export function npmCpuFor(arch) {
  const cpu = NPM_CPU[arch];
  if (!cpu) fail('preflight', `unsupported Alpine architecture ${JSON.stringify(arch)}; use ${SUPPORTED_ARCHES.join(' or ')}`);
  return cpu;
}

export async function loadPins(demoRoot) {
  const file = join(demoRoot, 'pins.json');
  const pins = await readJson(file);
  const bad = (message) => fail('preflight', `${file}: ${message}`);
  if (pins.schemaVersion !== 1) bad(`unsupported schemaVersion ${JSON.stringify(pins.schemaVersion)}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pins.unkernel?.repo ?? '')) {
    bad('unkernel.repo must be owner/repo');
  }
  if (!/^[0-9a-f]{40}$/.test(pins.unkernel?.commit ?? '')) bad('unkernel.commit must be 40 lowercase hex');
  if (!isExactVersion(pins.unkernel?.pnpm ?? '')) bad('unkernel.pnpm must be an exact version');
  if (typeof pins.kernel?.release !== 'string' || pins.kernel.release === '') bad('kernel.release is empty');
  if (!/^[0-9a-f]{64}$/.test(pins.kernel?.sha256 ?? '')) bad('kernel.sha256 must be 64 lowercase hex');
  if (!Array.isArray(pins.alpine?.mirrors) || pins.alpine.mirrors.length === 0) {
    bad('alpine.mirrors must be a non-empty array');
  }
  for (const mirror of pins.alpine.mirrors) {
    if (!/^https:\/\/[^/]+\/.+$/.test(mirror) || mirror.endsWith('/')) {
      bad(`alpine mirror must be https with no trailing slash: ${mirror}`);
    }
  }
  if (!/^v\d+\.\d+$/.test(pins.alpine?.release ?? '')) bad('alpine.release must look like v3.24');
  if (!SUPPORTED_ARCHES.includes(pins.alpine?.arch)) {
    bad(`alpine.arch must be ${SUPPORTED_ARCHES.join(' or ')}`);
  }
  return pins;
}

export async function readRootLspVersion(repoRoot) {
  const file = join(repoRoot, 'package.json');
  const pkg = await readJson(file);
  const version = pkg.devDependencies?.['@x18n/lsp'];
  if (typeof version !== 'string' || !isExactVersion(version)) {
    fail('preflight', `${file}: devDependencies["@x18n/lsp"] must be an exact version, got ${JSON.stringify(version)}`);
  }
  return version;
}

/** The canonical digest of everything that decides the built asset bytes. */
export function computeAssetDigest({ lspVersion, alpine, packages, tarballs }) {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    lspVersion,
    alpine: {
      release: alpine.release,
      arch: alpine.arch,
      mirrors: [...alpine.mirrors],
    },
    packages: [...packages].sort(),
    tarballs: tarballs.map((entry) => ({ fileName: entry.fileName, guestName: entry.guestName })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function readPackages(demoRoot) {
  const file = join(demoRoot, 'packages.txt');
  const lines = (await readFile(file, 'utf8')).split('\n');
  const packages = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*\.apk$/.test(line)) {
      fail('assets', `${file}:${index + 1}: invalid package name ${JSON.stringify(line)}`);
    }
    if (line.includes('/') || line.includes('..')) {
      fail('assets', `${file}:${index + 1}: package name must not contain a path`);
    }
    packages.push(line);
  }
  if (new Set(packages).size !== packages.length) fail('assets', `${file} contains duplicate package names`);
  packages.sort();
  const nodejs = packages.filter((name) => name.startsWith('nodejs-'));
  if (nodejs.length !== 1) {
    fail('assets', `${file} must contain exactly one nodejs-*.apk (found ${nodejs.length})`);
  }
  for (const required of ['neovim-', 'icu-data-en-']) {
    if (!packages.some((name) => name.startsWith(required))) {
      fail('assets', `${file} must contain a ${required}*.apk (the offline install fails without it)`);
    }
  }
  return packages;
}

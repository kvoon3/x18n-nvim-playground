// SPDX-License-Identifier: MIT
// Copyright (C) 2026 kvoon3
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, loadPins, log, writeFileAtomic } from './lib.mjs';

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOS = ['main', 'community'];
const ROOTS = ['neovim', 'nodejs'];

function text(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

function tarMember(tgz, wanted) {
  const tar = gunzipSync(tgz);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8);
    const member = prefix ? `${prefix}/${name}` : name;
    if (member === wanted) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`APKINDEX.tar.gz has no ${wanted} member`);
}

function baseToken(token) {
  const match = /^[^<>=~]+/.exec(token);
  return match ? match[0] : token;
}

function parseIndex(content, repo) {
  const records = [];
  for (const block of content.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const fields = new Map();
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
    }
    const name = fields.get('P');
    const version = fields.get('V');
    const size = Number.parseInt(fields.get('I') ?? '', 10);
    if (!name || !version || !Number.isSafeInteger(size)) continue;
    records.push({
      name,
      version,
      size,
      repo,
      deps: (fields.get('D') ?? '').split(' ').filter(Boolean),
      provides: (fields.get('p') ?? '').split(' ').filter(Boolean),
    });
  }
  return records;
}

async function fetchIndex({ mirrors, release, repo, arch }) {
  const attempts = [];
  for (const mirror of mirrors) {
    const url = `${mirror}/${release}/${repo}/${arch}/APKINDEX.tar.gz`;
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'x18n-demo-packages' },
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        attempts.push(`${url} (${response.status})`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFileAtomic(join(DEMO_ROOT, 'build/apk-index', repo, 'APKINDEX.tar.gz'), bytes);
      return parseIndex(tarMember(bytes, 'APKINDEX').toString('utf8'), repo);
    } catch (error) {
      attempts.push(`${url} (${error.message})`);
    }
  }
  throw new Error(`[demo-packages] could not download the ${repo} index\n  tried:\n    ${attempts.join('\n    ')}`);
}

function resolveClosure(records) {
  const byName = new Map();
  const providers = new Map();
  for (const record of records) {
    if (!byName.has(record.name)) byName.set(record.name, record);
    for (const raw of record.provides) {
      const token = baseToken(raw);
      const list = providers.get(token) ?? [];
      list.push(record);
      providers.set(token, list);
    }
  }

  const provider = (token) => {
    const list = providers.get(token);
    if (!list?.length) fail('packages', `cannot resolve dependency ${JSON.stringify(token)}`);
    return list.reduce((best, record) => (record.size < best.size ? record : best));
  };

  const chosen = new Map();
  const queue = [...ROOTS];
  while (queue.length > 0) {
    const raw = queue.pop();
    if (raw.startsWith('!') || raw.startsWith('/')) continue;
    const token = baseToken(raw);
    if (!token) continue;
    const record = token.includes(':') ? provider(token) : byName.get(token) ?? provider(token);
    if (chosen.has(record.name)) continue;
    chosen.set(record.name, record);
    for (const dep of record.deps) queue.push(dep);
  }
  if (chosen.size === 0) fail('packages', 'the package closure is empty');
  return [...chosen.values()];
}

async function refreshPackages() {
  const pins = await loadPins(DEMO_ROOT);
  const { release, arch, mirrors } = pins.alpine;
  const records = [];
  for (const repo of REPOS) {
    records.push(...(await fetchIndex({ mirrors, release, repo, arch })));
  }
  const resolved = resolveClosure(records);
  const packages = resolved.map((record) => `${record.name}-${record.version}.apk`).sort();
  await writeFileAtomic(join(DEMO_ROOT, 'packages.txt'), `${packages.join('\n')}\n`);
  log('packages', `resolved ${packages.length} packages for ${release}/${arch}`);
  return packages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await refreshPackages();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
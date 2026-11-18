// SPDX-License-Identifier: MIT
// Copyright (C) 2026 kvoon3
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, gitOutput, loadPins, log, removePath, run } from './lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export async function checkoutPlugin() {
  const pins = await loadPins(ROOT);
  const repo = pins.plugin?.repo;
  const commit = pins.plugin?.commit;
  if (!REPO.test(repo ?? '')) throw new Error('pins.json: plugin.repo must be owner/repo');
  if (!COMMIT.test(commit ?? '')) throw new Error('pins.json: plugin.commit must be 40 lowercase hex');

  const dir = join(ROOT, 'build/plugin');
  const logDir = join(ROOT, 'build/logs');
  const logFile = join(logDir, 'git.log');
  await ensureDir(logDir);
  await removePath(dir);
  await ensureDir(dirname(dir));

  log('plugin', `checking out ${repo}@${commit.slice(0, 7)}`);
  await run('git', ['init', '-q', dir], { logFile });
  const opts = { cwd: dir, logFile };
  await run('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], opts);

  let fetched = await run('git', ['fetch', '--depth=1', '--no-tags', 'origin', commit], {
    ...opts,
    allowFailure: true,
    timeoutMs: 10 * 60 * 1000,
  });
  if (fetched.code !== 0) {
    log('plugin', 'shallow fetch failed; retrying a full fetch');
    fetched = await run('git', ['fetch', '--no-tags', 'origin', commit], {
      ...opts,
      allowFailure: true,
      timeoutMs: 10 * 60 * 1000,
    });
  }
  if (fetched.code !== 0) {
    throw new Error(`[plugin] git fetch ${commit} from ${repo} failed; see ${logFile}`);
  }

  await run('git', ['checkout', '--detach', 'FETCH_HEAD'], opts);
  const head = await gitOutput(dir, ['rev-parse', 'HEAD']);
  if (head !== commit) throw new Error(`[plugin] checkout HEAD is ${head}, expected ${commit}`);
  return dir;
}

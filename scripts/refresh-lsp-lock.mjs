import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  log,
  readJson,
  readRootLspVersion,
  removePath,
  run,
  writeFileAtomic,
  writeJsonAtomic,
} from './lib.mjs';

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DEMO_ROOT, '..', '..');

const LSP_PACKAGE = '@x18n/lsp';
const OXC_PACKAGE = '@oxc-parser/binding-linux-riscv64-musl';

export function lspClosurePackage(version) {
  return {
    name: 'x18n-lsp-closure',
    private: true,
    dependencies: { [LSP_PACKAGE]: version },
  };
}

export async function refreshLspLock({ demoRoot = DEMO_ROOT, repoRoot = REPO_ROOT } = {}) {
  const version = await readRootLspVersion(repoRoot);
  const workDir = join(demoRoot, 'build', 'lsp-refresh');
  const lockFile = join(demoRoot, 'lsp-lock', 'package-lock.json');

  await removePath(workDir);
  await ensureDir(workDir);
  await writeJsonAtomic(join(workDir, 'package.json'), lspClosurePackage(version));

  log('refresh', `resolving ${LSP_PACKAGE}@${version} for linux/riscv64/musl`);
  await run(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--os=linux',
      '--cpu=riscv64',
      '--libc=musl',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ],
    { cwd: workDir, logFile: join(demoRoot, 'build', 'logs', 'refresh.log') },
  );

  const lock = await readJson(join(workDir, 'package-lock.json'));
  const installed = lock.packages?.[`node_modules/${LSP_PACKAGE}`]?.version;
  if (installed !== version) {
    throw new Error(`the generated lock resolves ${LSP_PACKAGE} ${installed}, expected ${version}`);
  }
  if (!lock.packages?.[`node_modules/${OXC_PACKAGE}`]) {
    throw new Error(
      `the generated lock has no ${OXC_PACKAGE}; npm did not record the riscv64/musl optional dependency`,
    );
  }

  await writeFileAtomic(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  log('refresh', `wrote ${lockFile} (${Object.keys(lock.packages).length} packages)`);
  return { version, lockFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await refreshLspLock();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

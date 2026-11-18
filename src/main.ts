// SPDX-License-Identifier: MIT
// Copyright (C) 2026 kvoon3
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { checkSupport, createKernel, type KernelHandle } from 'unkernel/web';
import { INSTALL, SITE } from './demo.generated';
import './style.css';

const status = document.querySelector<HTMLElement>('#status')!;
const terminalEl = document.querySelector<HTMLElement>('#terminal')!;

document.querySelector('#reset')?.addEventListener('click', () => location.reload());

const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
  fontSize: 14,
  theme: { background: '#0b0e14', foreground: '#d5d9e0' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminalEl);
fit.fit();
addEventListener('resize', () => fit.fit());

const started = performance.now();
const timings: Record<string, number> = {};
const mark = (name: string) => {
  if (timings[name] !== undefined) return;
  timings[name] = Math.round(performance.now() - started);
  console.info(`[timing] ${name} ${timings[name]}ms`);
};
mark('start');
(globalThis as unknown as { __timings: Record<string, number> }).__timings = timings;

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchChecked(asset: { url: string; sha256: string }): Promise<Uint8Array> {
  status.textContent = `downloading ${asset.url}…`;
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.url} returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await digest(bytes)) !== asset.sha256) throw new Error(`${asset.url}: SHA-256 mismatch`);
  return bytes;
}

const PUSH_SH = `set -e
cd ~
case "$1" in */*) mkdir -p "\${1%/*}";; esac
cat > "$1.part"
size=$(stat -c %s "$1.part")
if [ "$size" != "$2" ]; then rm -f "$1.part"; echo "got $size of $2 bytes" >&2; exit 1; fi
mv "$1.part" "$1"`;

async function push(vm: KernelHandle, path: string, bytes: Uint8Array): Promise<void> {
  const result = await vm.exec('/bin/sh', ['-c', PUSH_SH, 'sh', path, String(bytes.length)], { input: bytes });
  if (result.exitCode !== 0) {
    throw new Error(`writing ${path} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`);
  }
}

async function run(): Promise<void> {
  if (!crossOriginIsolated) throw new Error('crossOriginIsolated is false; COOP/COEP headers are missing');

  const support = await checkSupport();
  if (!support.jspi) throw new Error(support.problems.join('; ') || 'JSPI is unavailable');

  status.textContent = 'booting kernel…';
  term.writeln('\x1b[90m[host] booting unkernel…\x1b[0m');
  const vm = await createKernel({ log: (msg) => term.writeln(`\x1b[90m${msg}\x1b[0m`) });
  (globalThis as unknown as { __x18n: { term: Terminal; vm: KernelHandle } }).__x18n = { term, vm };
  mark('kernel');
  term.writeln('\x1b[90m[host] kernel ready\x1b[0m');

  const assets = [SITE, ...INSTALL];
  for (const [index, asset] of assets.entries()) {
    status.textContent = `downloading ${index + 1}/${assets.length}…`;
    const bytes = await fetchChecked(asset);
    mark(`fetch-${index}`);
    await push(vm, asset.path, bytes);
    mark(`push-${index}`);
  }
  mark('assets');

  status.textContent = 'unpacking…';
  const unpack = await vm.exec('/bin/sh', [
    '-lc',
    'mkdir -p ~/demos/x18n && tar -xzf ~/demos/x18n/site.tar.gz -C ~/demos/x18n',
  ]);
  if (unpack.exitCode !== 0) throw new Error(`unpack failed: ${(unpack.stderr || unpack.stdout).trim()}`);
  mark('unpack');

  status.textContent = 'starting nvim…';
  const pty = await vm.spawn('/bin/sh', ['-lc', 'cd ~/demos/x18n && exec ./run.sh'], {
    cols: term.cols,
    rows: term.rows,
  });
  mark('spawn');
  status.textContent = 'running';

  const decoder = new TextDecoder();
  let scan = '';
  const markers: Array<[string, string]> = [
    ['__X18N_NVIM__', 'nvim'],
    ['playground/vue-vite/src/App.vue', 'file'],
    ['x18n LSP attached', 'lsp'],
    ['Playground', 'translated'],
  ];
  void pty.output
    .pipeTo(
      new WritableStream({
        write(chunk) {
          term.write(chunk);
          if (timings.translated !== undefined) return;
          scan += decoder.decode(chunk, { stream: true });
          for (const [needle, name] of markers) {
            if (timings[name] === undefined && scan.includes(needle)) mark(name);
          }
          if (scan.length > 32768) scan = scan.slice(-16384);
        },
      }),
    )
    .catch((error: unknown) => term.writeln(`\r\n\x1b[31m[host] ${String(error)}\x1b[0m`));
  term.onData((data) => {
    void pty.write(data);
  });
  term.onResize(({ cols, rows }) => pty.resize(cols, rows));

  const end = await pty.ended;
  status.textContent = `session ended (${end.type})`;
  term.writeln(`\r\n\x1b[90m[host] session ended: ${JSON.stringify(end)}\x1b[0m`);
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = 'error';
  term.writeln(`\x1b[31m[host] ${message}\x1b[0m`);
  console.error(error);
});

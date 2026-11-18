# x18n playground

A minimal unkernel site for the x18n.nvim demo. It imports the `unkernel`
npm SDK, boots the bundled Alpine kernel, pushes four tarballs, and runs
Neovim on a pty in xterm.js.

## Run

```sh
npm install
npm run dev
```

`npm run dev` checks out `x18n.nvim` at the commit in `pins.json` into
`build/plugin`, builds the three install tarballs into `build/assets`, and
stages the playground, plugin, and guest config into `site.bin`. Set
`X18N_NVIM` to use a local plugin checkout, or `DEMO_ASSETS` to reuse
prebuilt install tarballs.

`npm run check` runs the asset and pin tests without a network.

## Assets

`pins.json` pins the plugin commit, the Alpine release, and the unkernel
checkout. `packages.txt` lists the 37 Alpine packages; `lsp-lock` pins the
`@x18n/lsp` production closure; `asset-lock.json` records every tarball's
bytes and SHA-256. A normal build verifies the rebuilt tarballs against the
lock.

## Deploy

```sh
npm run deploy
```

The Worker is `x18n-nvim-play` in `void.config.ts`.

## License

MIT

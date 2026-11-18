// SPDX-License-Identifier: MIT
// Copyright (C) 2026 kvoon3
import { defineConfig } from 'void/config';

export default defineConfig({
  inference: {
    appType: 'static',
    outputDir: 'dist',
  },
  cloudflare: {
    name: 'x18n-nvim-play',
    account_id: '28a23c2ec9aeeb01a95276f1d9ca42df',
  },
  routing: {
    headers: {
      '/*': [
        'Cross-Origin-Opener-Policy: same-origin',
        'Cross-Origin-Embedder-Policy: require-corp',
      ],
    },
  },
});

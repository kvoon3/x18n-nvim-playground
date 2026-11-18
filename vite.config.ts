// SPDX-License-Identifier: MIT
// Copyright (C) 2026 kvoon3
import { defineConfig } from 'vite';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['unkernel'] },
  build: { target: 'es2022' },
});

import { defineConfig } from 'vite';

// Tauri expects a fixed port and doesn't want Vite clearing its output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});

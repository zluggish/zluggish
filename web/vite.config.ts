import { defineConfig } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { z } from 'zod';

const catalogSchema = z.record(z.string(), z.string());

function sourceFiles(directory: URL): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);

    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, directory));
    }

    return /\.(ts|svelte)$/.test(entry.name) && !/\.(spec|d)\.ts$/.test(entry.name) ? [fileURLToPath(path)] : [];
  });
}

function usedMessages(directories: Array<string>): Set<string> {
  const used = new Set<string>();

  for (const directory of directories) {
    for (const file of sourceFiles(new URL(`${directory}/`, import.meta.url))) {
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
        used.add(match[1]);
      }
    }
  }

  return used;
}

export default defineConfig(({ mode, isSsrBuild }) => {
  const game = mode === 'game';

  return {
    plugins: [
      {
        name: 'translation-catalog',
        enforce: 'pre',
        apply: 'build',
        // Source rendering and the server read this flat JSON catalog directly.
        resolveId(id) {
          if (id === '@zluggish/i18n/en.json') {
            return '\0translation-catalog';
          }
        },
        load(id) {
          if (id !== '\0translation-catalog') {
            return;
          }
          const file = fileURLToPath(new URL('../i18n/en.json', import.meta.url));
          this.addWatchFile(file);
          const catalog = catalogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
          const directories = game
            ? ['src/game', 'src/components', 'src/lib']
            : ['src/app', 'src/components', 'src/lib'];
          const used = usedMessages(directories);
          const scoped = Object.fromEntries(Object.entries(catalog).filter(([key]) => used.has(key)));
          return `export default ${JSON.stringify(scoped)};`;
        },
      },
      svelte(),
    ],
    base: game ? '/static/launcher-ui/' : '/',
    ssr: { noExternal: true },
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': 'http://127.0.0.1:8080',
        '/health': 'http://127.0.0.1:8080',
      },
    },
    build: {
      target: 'es2022',
      cssTarget: 'chrome100',
      outDir: game ? (isSsrBuild ? 'dist/game/server' : 'dist/game/client') : 'dist/app',
      manifest: !isSsrBuild,
      rollupOptions: {
        input: game ? (isSsrBuild ? 'src/game/server.ts' : 'src/game/client.ts') : 'index.html',
        output: isSsrBuild ? { entryFileNames: 'entry.js' } : undefined,
      },
    },
  };
});

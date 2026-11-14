import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const directory = new URL('../src/protocol/generated/', import.meta.url);

for (const name of readdirSync(directory)) {
  if (!name.endsWith('.ts')) continue;
  const path = new URL(name, directory);
  const source = readFileSync(path, 'utf8');

  writeFileSync(path, source.replace(/[\t ]+$/gm, '').trimEnd() + '\n');
}

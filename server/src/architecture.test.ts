import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);

    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') && !file.endsWith('.test.ts') ? file : [];
  });
}

for (const layer of ['http', 'services', 'repositories']) {
  await test(`${layer} respects application dependency boundaries`, () => {
    const root = new URL(`${layer}/`, import.meta.url).pathname;

    for (const file of sources(root)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const module = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;

        const typeOnly =
          clause?.isTypeOnly ||
          (bindings && ts.isNamedImports(bindings) && bindings.elements.every((binding) => binding.isTypeOnly));

        if (typeOnly) continue;

        if (layer === 'http') {
          assert.ok(!module.startsWith('#src/repositories/'), `${file} must use services for ${module}`);
        } else {
          assert.ok(!module.startsWith('#src/http/') && !module.startsWith('hono'), `${file} depends on HTTP`);
          assert.ok(!module.startsWith('#src/services/'), `${file} must not call another service`);
        }

        if (layer !== 'repositories') {
          assert.ok(!/^node:(fs(?:\/promises)?|sqlite)$/.test(module), `${file} performs low-level I/O`);
        }
      }
    }
  });
}

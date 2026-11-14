import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);

    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') && !file.endsWith('.spec.ts') ? file : [];
  });
}

for (const layer of ['http', 'services', 'repositories']) {
  await test(`${layer} respects application dependency boundaries`, () => {
    const root = fileURLToPath(new URL(`${layer}/`, import.meta.url));

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
          assert.ok(
            !module.startsWith('#src/repositories/') ||
              ['#src/repositories/crypto.repository', '#src/repositories/logging.repository'].includes(module),
            `${file} must use services for ${module}`,
          );
        } else {
          assert.ok(!module.startsWith('#src/http/') && !module.startsWith('hono'), `${file} depends on HTTP`);

          if (layer === 'repositories') {
            assert.ok(!module.startsWith('#src/services/'), `${file} must not depend on services`);
            assert.ok(!module.startsWith('#src/world/'), `${file} must not orchestrate world behavior`);
          }
        }

        if (layer !== 'repositories') {
          assert.ok(!/^node:(fs(?:\/promises)?|sqlite)$/.test(module), `${file} performs low-level I/O`);
        }
      }
    }
  });
}

await test('cryptography is centralized in the crypto repository', () => {
  for (const file of sources(fileURLToPath(new URL('./', import.meta.url)))) {
    if (file === fileURLToPath(new URL('repositories/crypto.repository.ts', import.meta.url))) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    for (const statement of source.statements) {
      if (
        (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      assert.ok(
        !['node:crypto', 'crypto', 'argon2'].includes(statement.moduleSpecifier.text),
        `${file} must use the crypto repository`,
      );
    }
  }
});

await test('services and repositories expose operations through classes', () => {
  for (const layer of ['services', 'repositories'])
    for (const file of sources(fileURLToPath(new URL(`${layer}/`, import.meta.url)))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

      for (const statement of source.statements) {
        const exported =
          ts.canHaveModifiers(statement) &&
          ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

        if (!exported) continue;
        assert.ok(!ts.isFunctionDeclaration(statement), `${file} exports a standalone operation`);

        if (layer === 'services' && ts.isClassDeclaration(statement) && statement.name?.text !== 'BaseService')
          assert.ok(
            statement.heritageClauses?.some(
              (clause) =>
                clause.token === ts.SyntaxKind.ExtendsKeyword &&
                clause.types.some((type) => type.expression.getText(source) === 'BaseService'),
            ),
            `${file} must extend BaseService`,
          );
      }
    }
});

await test('DTOs do not depend on application implementation layers', () => {
  for (const file of sources(fileURLToPath(new URL('dtos/', import.meta.url)))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      assert.ok(
        !/^#src\/(http|services|repositories)(\/|$)/.test(statement.moduleSpecifier.text),
        `${file} must not depend on ${statement.moduleSpecifier.text}`,
      );
    }
  }
});

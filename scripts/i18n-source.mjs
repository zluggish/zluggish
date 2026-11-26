import fs from 'node:fs';
import path from 'node:path';
import ts from '../server/node_modules/typescript/lib/typescript.js';
import svelte from '../server/node_modules/svelte/compiler/index.js';

export function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => /\.(ts|svelte)$/.test(f) && !/\.(spec|d)\.ts$|\/generated\/|\/i18n\//.test(f));
}
const labels =
  /^(label|title|description|placeholder|confirmation|help|hint|message|detail|text|empty|heading|summary|name|caption|submitLabel|successMessage)$/;
const ignoredCalls =
  /(?:^|\.)(?:log|debug|info|warn|error|span|fn|Service|execute|query|sql|prepare|resolve|join|startsWith|endsWith|includes|replace|match|test|setHeader|header|querySelector|querySelectorAll|matchMedia|selectFrom|innerJoin|leftJoin|where|on|select|orderBy|groupBy|get|set|indexOf)$/;
export function candidates(source, file) {
  const found = [];
  function scanTs(code, offset = 0) {
    const ast = ts.createSourceFile(file + '.ts', code, ts.ScriptTarget.Latest, true);
    function walk(n) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
      if (ts.isCallExpression(n) && n.expression.getText(ast) === 't') {
        n.arguments.slice(1).forEach(walk);
        return;
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const p = n.parent;
        if ((ts.isPropertyAssignment(p) && p.name === n) || ts.isElementAccessExpression(p) || ts.isLiteralTypeNode(p))
          return;
        if (
          ts.isBinaryExpression(p) &&
          [
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(p.operatorToken.kind) &&
          !p.left.getText(ast).endsWith('.message')
        )
          return;
        let ancestor = p;
        while (ancestor && !ts.isStatement(ancestor)) {
          if (
            ts.isCallExpression(ancestor) &&
            ignoredCalls.test(ancestor.expression.getText(ast)) &&
            ancestor.arguments.includes(n) &&
            !(file.includes('/cli/') && ancestor.expression.getText(ast).startsWith('console.'))
          )
            return;
          ancestor = ancestor.parent;
        }
        if (ts.isTaggedTemplateExpression(p)) return;
        const args = [];
        let value;
        if (ts.isTemplateExpression(n)) {
          value = n.head.text;
          for (const span of n.templateSpans) {
            const name = `value${args.length + 1}`;
            args.push([name, span.expression.getText(ast)]);
            value += `{${name}}` + span.literal.text;
          }
        } else value = n.text;
        if (/^(?:\/|https?:\/\/)[^\s]*$/.test(value)) return;
        const property = ts.isPropertyAssignment(p) ? p.name.getText(ast).replace(/['"]/g, '') : '';
        const prose = value.replace(/\{value\d+\}/g, '');
        const human =
          /[A-Za-z]{2,} [A-Za-z]/.test(prose) ||
          /\{value\d+\} (?:km|km\/h|m|W|bpm|kcal|min|h)\b/.test(value) ||
          /^[A-Z][a-z]+ \{value\d+\}/.test(value) ||
          /[A-Za-z][a-z]+[ ,!?][ A-Za-z]|[A-Za-z][a-z]+: [A-Za-z{]/.test(prose) ||
          /^[A-Z][a-z]+(?:[.!?…]|$)/.test(prose);
        const uiLabel = labels.test(property) && /[a-zA-Z]/.test(value);
        const callLabel =
          ts.isCallExpression(p) &&
          /^(field|checkbox|form|model)$/.test(p.expression.getText(ast)) &&
          p.arguments.indexOf(n) === { field: 1, checkbox: 1, form: 3, model: 2 }[p.expression.getText(ast)];
        if (/^(?:sameSite|method|type|encoding|algorithm)$/.test(property)) return;
        if (!(human || uiLabel || callLabel) || !value.trim()) {
          if (ts.isTemplateExpression(n)) n.templateSpans.forEach((span) => walk(span.expression));
          return;
        }
        if (
          /^(?:SELECT |INSERT INTO |UPDATE \w+ SET |DELETE FROM |CREATE (?:TABLE|INDEX|TRIGGER)|ALTER TABLE |PRAGMA |WITH \w+ AS|DROP (?:TABLE|INDEX))/.test(
            value.trim(),
          ) ||
          /(?:=>|\bimport\b.*\bfrom\b|\bexport\b|\bfunction\b|<\/?[a-z]|\{\s*")/.test(value) ||
          (/^[\w./@-]+$/.test(value) && !/^[A-Z][a-z]/.test(value) && !uiLabel && !callLabel)
        )
          return;
        found.push({ start: offset + n.getStart(ast), end: offset + n.end, value, args, kind: 'ts' });
        return;
      }
      ts.forEachChild(n, walk);
    }
    walk(ast);
  }
  if (!file.endsWith('.svelte')) {
    scanTs(source);
    return found;
  }
  const ast = svelte.parse(source, { modern: true });
  for (const script of [ast.instance, ast.module])
    if (script) scanTs(source.slice(script.content.start, script.content.end), script.content.start);
  function markup(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Fragment') {
      let i = 0;
      while (i < n.nodes.length) {
        let j = i;
        while (j < n.nodes.length && ['Text', 'ExpressionTag'].includes(n.nodes[j].type)) j++;
        const run = n.nodes.slice(i, j);
        if (run.some((x) => x.type === 'Text' && /[a-zA-Z]/.test(x.data))) {
          const args = [];
          const raw = run
            .map((x) => {
              if (x.type === 'Text') return x.data;
              const name = `value${args.length + 1}`;
              args.push([name, source.slice(x.expression.start, x.expression.end)]);
              return `{${name}}`;
            })
            .join('')
            .replace(/\s+/g, ' ');
          const leading = raw.startsWith(' ') ? ' ' : '';
          const trailing = raw.endsWith(' ') ? ' ' : '';
          found.push({
            start: run[0].start,
            end: run.at(-1).end,
            value: raw.trim(),
            args,
            kind: 'markup',
            leading,
            trailing,
          });
        } else
          for (const x of run)
            if (x.type === 'ExpressionTag')
              scanTs(source.slice(x.expression.start, x.expression.end), x.expression.start);
        if (j === i) {
          markup(n.nodes[i]);
          i++;
        } else i = j;
      }
      return;
    }
    if (n.type === 'Attribute') {
      if (
        /^(title|alt|placeholder|aria-label|label)$/.test(n.name) &&
        Array.isArray(n.value) &&
        n.value.every((x) => x.type === 'Text')
      ) {
        const value = n.value.map((x) => x.data).join('');
        if (/[A-Za-z]/.test(value))
          found.push({ start: n.start, end: n.end, value, args: [], kind: 'attribute', name: n.name });
      } else if (Array.isArray(n.value))
        for (const x of n.value)
          if (x.type === 'ExpressionTag')
            scanTs(source.slice(x.expression.start, x.expression.end), x.expression.start);
      return;
    }
    for (const [key, v] of Object.entries(n))
      if (!['loc', 'expression', 'test', 'context', 'index', 'key', 'start', 'end'].includes(key)) {
        if (Array.isArray(v)) v.forEach(markup);
        else if (v && typeof v === 'object') markup(v);
      }
  }
  markup(ast.fragment);
  return found;
}

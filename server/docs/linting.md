# Lint configuration

The shared lint tools live in `cli/` and check both the server and CLI. Run commands from the repository root:

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
pnpm --dir cli lint
pnpm --dir cli format
```

Alternatively, run `mise run check` from `cli/`. The mise configuration also lives there.

`cli/eslint.config.mjs` adapts [Immich's server ESLint configuration](https://github.com/immich-app/immich/blob/dc737de38d6015b9a0b8c80807629ca7956b96a2/server/eslint.config.mjs), retrieved on 2026-11-12. It keeps their recommended ESLint, TypeScript, Unicorn, and import-x presets, rule overrides, promise checks, and ban on relative imports. ESLint runs with zero warnings allowed. Prettier uses Immich's single quotes, trailing commas, semicolons, and 120-column width; eslint-config-prettier disables conflicting lint rules.

Project adaptations are Node globals and ES2023 syntax, both TypeScript projects, package import resolution, and exclusions for generated protobuf codecs, vendored tools, assets, and operator configuration examples. Server imports use `#src/`; CLI imports use `#cli/` and the server package exports. Development commands select source exports with `--conditions=development`; compiled commands use `dist/` exports.

The existing anti-slop Oxlint rules remain enabled alongside ESLint. Their vendored source and attribution are in `cli/tools/oxlint/anti-slop/`.

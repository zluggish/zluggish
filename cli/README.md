# CLI and development tools

Run these commands from the repository root with Node 24 and pnpm 10:

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
pnpm --dir cli cli --help
node cli/dist/src/bin.js --help
```

The CLI imports configuration, account, and persistence operations from the server package. Build the server before typechecking the CLI; `pnpm --dir cli build` builds both in order. The server image does not include the CLI or lint dependencies.

Shared ESLint, Oxlint, Prettier, and mise configuration live in this folder. Run `mise run check` here to build, lint, typecheck, test, and check formatting for both packages. See [lint configuration](../server/docs/linting.md) for provenance and package commands.

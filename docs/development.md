---
sidebar_position: 7
description: Run Zluggish from source, find the code you need and reproduce CI checks locally.
---

# Development

## Run locally

Install [mise](https://mise.jdx.dev/getting-started.html). Run the setup commands from the repository root. The project uses Node.js 26.13 or later in the 26.x series and pnpm 12.18.0.

```sh
mise install
mise run install
mise run dev
```

Open [http://localhost:5173](http://localhost:5173). Copy the setup key from the backend logs and create a local administrator. The development config uses `storage/dev/` and listens on loopback. Vite reloads the management UI and proxies `/api` and `/health` to the backend on port 8080. The backend restarts when its source changes. Rerun `mise run dev:assets` after changing launcher assets.

For a game client on another device, use the [server and client setup guides](install/server.md). Check the [default game ports](reference/ports.md) before testing with a client. The local development config uses alternate ports for the game HTTPS listener (8787) and CDN (8788).

## How the pieces fit together

| Component                                                                        | Role                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Server](https://github.com/zluggish/zluggish/tree/main/server/src)              | The Node.js process starts the game HTTPS API and launcher, the management HTTP API, the game CDN and the TCP and UDP ride listeners. Hono handles HTTP. The ride listeners feed player updates into the world simulation. |
| [Game launcher](https://github.com/zluggish/zluggish/tree/main/web/src/game)     | Svelte pages served inside the desktop Zwift client. The backend renders the launcher. Riders sign in and choose a world before starting the game.                                                                         |
| [Management web app](https://github.com/zluggish/zluggish/tree/main/web/src/app) | A Svelte app for browsers. It calls the management API to show activities, manage accounts and publish patched Android apps. In a production build, the backend serves the app files as well.                              |
| [Admin CLI](https://github.com/zluggish/zluggish/tree/main/server/src/cli)       | Reads and writes configuration and storage directly. See the [CLI reference](reference/cli/index.md) for commands that need the server stopped.                                                                            |
| [Public sites](https://github.com/zluggish/zluggish/tree/main/sites)             | Docusaurus builds this documentation from `docs/`. Vite builds the landing site. Both are deployed separately through Cloudflare Workers Builds.                                                                           |

The web and game APIs share Effect services under `server/src/services/`. The services use repositories under `server/src/repositories/` to read and write SQLite and files in the storage directory. For example, [ride completion](https://github.com/zluggish/zluggish/blob/main/server/src/services/ride-completion.service.ts) saves the activity, which the management UI reads through its own API. Optional upload integrations deliver the saved activity to external services.

For backend changes, start with `server/src/http/app.ts` for the game API, `server/src/http/web-app.ts` for the management API or `server/src/node/network/` for ride traffic. Effect layers are wired in `server/src/layers.ts` and scoped in `server/src/runtime.ts`. Database transactions are synchronous. See the [database notes](https://github.com/zluggish/zluggish/blob/main/server/src/db/README.md).

## Run CI checks

GitHub starts the [test workflow](https://github.com/zluggish/zluggish/blob/main/.github/workflows/tests.yml) when you open or push to a pull request and on pushes to `main`. Check the **Checks** tab of the pull request for results. The server job runs on Linux, Windows and macOS. The lint, translation, container and browser jobs run on Linux. The PR title has its own check. The public-site workflows run when their inputs change.

Run the main checks from the repository root.

```sh
mise run check
```

This builds the server and web app, runs server and CLI tests, lints the source, typechecks the server and web app, checks formatting and validates translations. Use the table to rerun a specific check.

| Command                                      | What it does                                                   |
| -------------------------------------------- | -------------------------------------------------------------- |
| `mise run test`                              | Build and run the unit and medium suites.                      |
| `mise exec -- pnpm --dir server test:unit`   | Run only the unit suite.                                       |
| `mise exec -- pnpm --dir server test:medium` | Build the web app and run the medium suite.                    |
| `mise run lint` / `mise run lint:fix`        | Check or fix lint issues.                                      |
| `mise run typecheck`                         | Typecheck the server, CLI and web app.                         |
| `mise run format` / `mise run format-fix`    | Check or fix formatting.                                       |
| `mise run i18n:check` / `mise run i18n:test` | Validate the message catalog and test the translation tooling. |

### Protocol files and launcher

If you change `server/proto/`, run the generator and commit the updated files in `server/src/protocol/generated/`. CI reruns it and checks for changes.

```sh
mise run server-codegen
git status --short --untracked-files=all -- server/src/protocol/generated
```

On Linux, install Chromium and its system dependencies before running the launcher tests.

```sh
mise exec -- pnpm --dir server exec playwright install --with-deps chromium
mise exec -- pnpm --dir server test:browser
```

On macOS or Windows, omit `--with-deps`. To regenerate the project screenshots with fictional riders, run `mise exec -- pnpm --dir server screenshots` after installing Chromium.

### Container smoke tests

Run these commands from the root with Docker Buildx. They test the image for your machine's architecture. CI tests both `linux/amd64` and `linux/arm64`.

```sh
docker buildx build -f server/Dockerfile --target server --load -t zluggish:test .
docker run --rm -i --read-only --tmpfs /tmp --tmpfs /usr/src/app/zluggish/storage --entrypoint node zluggish:test --input-type=module < server/scripts/smoke-container.mjs
docker run --rm -i --read-only --tmpfs /tmp --entrypoint node zluggish:test --input-type=module < server/scripts/smoke-storage.mjs
```

### Documentation and landing site

After installing dependencies, start a local docs preview from the repository root.

```sh
mise exec -- pnpm --filter @zluggish/docs start
```

Stop the preview before running the GitHub Actions build and packaging checks locally.

```sh
mise exec -- pnpm --filter @zluggish/docs typecheck
mise exec -- pnpm --filter @zluggish/docs deploy:dry-run
mise exec -- pnpm --filter @zluggish/landing deploy:dry-run
```

The dry runs build the sites and validate their Cloudflare packages without deploying.

## Edit interface text

English messages live in `i18n/en.json`. Reuse a key when its meaning and wording match. For new messages, add a flat `snake_case` key and use the existing `t()` helper. Keep full sentences together and supply values for any placeholders. For example, `t('key', { value1: count })` fills `{value1}` in the catalog.

Run `mise run i18n:check` to catch missing or unused keys, mismatched placeholders and hardcoded UI text. Keep protocol values, SQL and script syntax literal. When the checker flags a literal that must stay, record the exact value, file and reason in `scripts/i18n-exemptions.json`.

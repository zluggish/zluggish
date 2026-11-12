# Zluggish

A self-hosted Zwift server using TypeScript, Hono and Node 24. Server source, codecs, assets, tests and packaging live in `server/`. The management CLI and shared lint/mise tooling live in `cli/`. Rider data remains in root `storage/`.

## Docker

Set `ZLUGGISH_ADVERTISED_IP` to the server's LAN address, then build and start:

```sh
ZLUGGISH_ADVERTISED_IP=192.168.1.10 docker compose up --build -d
```

Compose now runs the Node server. It exposes HTTPS 443, CDN HTTP 80, TCP 3025, UDP 3024 and optional DNS UDP 53. DNS is disabled by default. The first-run setup URL appears in container logs. Existing installations should follow the [cutover runbook](server/docs/cutover.md) before starting against their storage.

The server and all integrations, including Garmin Connect, run in TypeScript. No Python installation or alternate image is required.

## Source installation

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
pnpm --dir cli cli config validate
pnpm --dir server start
```

Edit `server/zluggish.config.ts` for listener addresses, ports, TLS and operator settings. The checked-in source config uses HTTP on loopback port 8787 for development. Docker uses the bundled container config instead. Configuration changes require restart; rider and live group preferences persist in SQLite.

See the [server guide](server/README.md) for config migration, accounts, integrations and development commands. Existing client redirects and certificates are preserved.

## Verification status

Automated tests cover protocol vectors, real loopback sockets, account/data handling and integration contracts. Supported-client long rides, live third-party accounts, cross-platform runtime tests and measured comparison with Python still require verification. Route registration coverage alone does not prove parity. See [compatibility status](server/docs/compatibility.md).

The Python source and utilities have been removed. Historical implementations remain available through Git history and prior release images for comparison or rollback; use separate storage snapshots.

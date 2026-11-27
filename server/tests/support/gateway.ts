import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';

export const GATEWAY_SECRET = 'medium-test-gateway-secret-0123456789abcdef';

/** A secret file for `network.api.cloudflareGateway`, removed after the test. */
export function gatewaySecretFile(t: TestContext, secret = GATEWAY_SECRET) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-gateway-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = resolve(root, 'gateway-secret.txt');
  writeFileSync(path, `${secret}\n`);

  return path;
}

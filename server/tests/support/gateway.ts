import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { Repositories } from '#src/repositories';

export const GATEWAY_SECRET = 'medium-test-gateway-secret-0123456789abcdef';

/** Store `secret` as the Gateway secret, as Manage > Launcher access does, but with a value the test knows. */
export function storeGatewaySecret(f: { accounts: { repositories: Repositories } }, secret = GATEWAY_SECRET) {
  f.accounts.repositories.accessGroupsRepository.updateGateway({
    secret_digest: new CryptoRepository().sha256(secret),
    secret_created_at: Date.now(),
  });
}

/** A small CA certificate standing in for Cloudflare Gateway's inspection root. Its key was discarded. */
export const GATEWAY_CA = `-----BEGIN CERTIFICATE-----
MIIBijCCAS+gAwIBAgIUfB8rJDT5kAMpLFDZL819NmhwxcswCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPVGVzdCBHYXRld2F5IENBMB4XDTI2MTEyNzE0MDczNFoXDTM2
MTEyNDE0MDczNFowGjEYMBYGA1UEAwwPVGVzdCBHYXRld2F5IENBMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAE2GC9WdRGr3m1R/N3By6DW9Q+E8rDnM91n+vMnlMB
JGqWm9lLjsbABA0DV522qdsMimSJFLuVhlVipmlqHc3yKqNTMFEwHQYDVR0OBBYE
FEHW2deC0H3D6yYrs1q8//zjkpIoMB8GA1UdIwQYMBaAFEHW2deC0H3D6yYrs1q8
//zjkpIoMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhALM+BRhG
5pu2axa0AED28DDwsqqKCe7QU09ELZJbaZSBAiEAoqgCK9ra04ketCnZJhu+T+M2
l58SCJZFJQd3+2vMjg4=
-----END CERTIFICATE-----
`;

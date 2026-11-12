import { scrypt, createHmac, timingSafeEqual } from 'node:crypto';

function derive(password: string, salt: string, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    scrypt(password, salt, 64, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (error, result) => {
      if (error) fail(error);
      else done(result);
    });
  });
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash || !password) return false;
  const [method, salt, digest, extra] = hash.split('$', 4);

  if (!method || salt === undefined || !digest || extra !== undefined || !/^[a-f0-9]+$/.test(digest)) return false;
  let actual: Buffer;

  if (method === 'sha256') actual = createHmac('sha256', salt).update(password).digest();
  else {
    const match = /^scrypt:(\d+):(\d+):(\d+)$/.exec(method);

    if (!match) return false;
    const n = Number(match[1]);
    const r = Number(match[2]);
    const p = Number(match[3]);

    if (n < 2 || n > 131_072 || (n & (n - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 16) return false;

    try {
      actual = await derive(password, salt, n, r, p);
    } catch {
      return false;
    }
  }

  const expected = Buffer.from(digest, 'hex');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signIdentity(identity: string, secret: Uint8Array) {
  return `${identity}|${createHmac('sha512', secret).update(identity).digest('hex')}`;
}

export function verifyIdentity(cookie: string, secret: Uint8Array): string | null {
  const index = cookie.lastIndexOf('|');

  if (index === -1) return null;
  const identity = cookie.slice(0, index);
  const supplied = Buffer.from(cookie.slice(index + 1), 'utf8');

  const expected = Buffer.from(signIdentity(identity, secret).slice(index + 1), 'utf8');

  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? identity : null;
}

export async function hashPassword(password: string) {
  const { randomBytes } = await import('node:crypto');
  const salt = randomBytes(12).toString('hex');
  const digest = await derive(password, salt, 32_768, 8, 1);

  return `scrypt:32768:8:1$${salt}$${digest.toString('hex')}`;
}

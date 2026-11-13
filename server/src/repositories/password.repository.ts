import * as argon2 from 'argon2';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Passwords use Argon2id PHC strings; the library owns salts and verification.
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash?.startsWith('$argon2id$') || !password) return false;

  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
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
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
}

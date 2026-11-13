import * as argon2 from 'argon2';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

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

export function encryptCredentials(key: Uint8Array, credentials: readonly [string, string], iv = randomBytes(16)) {
  if (key.length !== 32 || iv.length !== 16) throw new Error('Invalid credential key/IV');
  const cipher = createCipheriv('aes-256-cfb8', key, iv);

  return Buffer.concat([iv, cipher.update(credentials.join('\n'), 'utf8'), cipher.final()]);
}

export function decryptCredentials(key: Uint8Array, bytes: Uint8Array): readonly [string, string] {
  if (key.length !== 32 || bytes.length < 16) throw new Error('Invalid credentials');
  const decipher = createDecipheriv('aes-256-cfb8', key, bytes.subarray(0, 16));

  const text = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');

  const lines = text.split(/\r?\n/);
  const first = lines[0];
  const second = lines[1];

  if (first === undefined || second === undefined) throw new Error('Invalid credentials');

  return [first, second];
}

export function sha1(data: Uint8Array | string) {
  return createHash('sha1').update(data).digest();
}

export function signToken(data: string) {
  return createHmac('sha256', 'nosecret').update(data).digest('base64url');
}

function packetAlgorithm(key: Uint8Array) {
  switch (key.length) {
    case 16: {
      return 'aes-128-gcm';
    }

    case 24: {
      return 'aes-192-gcm';
    }

    case 32: {
      return 'aes-256-gcm';
    }

    default: {
      throw new Error('Invalid AES key length');
    }
  }
}

export function encryptPacketPayload(payload: Uint8Array, key: Uint8Array, nonce: Uint8Array, header: Uint8Array) {
  const cipher = createCipheriv(packetAlgorithm(key), key, nonce, { authTagLength: 4 });
  cipher.setAAD(header);

  return Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}

/** Legacy packets decrypt the trailer too and do not authenticate incoming data. */
export function decryptLegacyPacketPayload(payload: Uint8Array, key: Uint8Array, nonce: Uint8Array) {
  const decipher = createDecipheriv(packetAlgorithm(key), key, nonce, { authTagLength: 4 });

  // Preserve Python compatibility: do not call final() on unauthenticated GCM data.
  return decipher.update(payload);
}

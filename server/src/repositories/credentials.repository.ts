import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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

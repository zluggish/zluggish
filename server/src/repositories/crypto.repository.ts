import { t } from '#src/i18n/index';
import { UnreadableCredentialsError } from '#src/errors';
import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPair,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { promisify } from 'node:util';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';

const generateKeyPairAsync = promisify(generateKeyPair);

export interface CertificateFacts {
  readonly fingerprint256: string;
  readonly thumbprint: string;
  readonly subject: string;
  readonly serialNumber: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly hosts: ReadonlyArray<string>;
  /** The key algorithm and size, such as `ECDSA P-256` or `RSA 2048-bit`. */
  readonly key: string;
}

const curves = new Map([
  ['prime256v1', 'P-256'],
  ['secp384r1', 'P-384'],
  ['secp521r1', 'P-521'],
]);

function describeKey(type: string | undefined, details: { modulusLength?: number; namedCurve?: string } | undefined) {
  if (type === 'ec') {
    return `ECDSA ${curves.get(details?.namedCurve ?? '') ?? details?.namedCurve ?? ''}`.trim();
  }

  if (type === 'rsa' || type === 'rsa-pss') {
    return `RSA ${details?.modulusLength ?? ''}-bit`;
  }

  return (type ?? 'unknown').toUpperCase();
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
      throw new Error(t('invalid_aes_key_length'));
    }
  }
}

export class CryptoRepository {
  randomBytes = randomBytes;

  randomInt = randomInt;

  randomUUID = randomUUID;

  timingSafeEqual = timingSafeEqual;

  async verifyPassword(hash: string | null, password: string): Promise<boolean> {
    if (!hash?.startsWith('$argon2id$') || !password) {
      return false;
    }

    try {
      return await argon2Verify(hash, password);
    } catch {
      return false;
    }
  }

  signIdentity(identity: string, secret: Uint8Array) {
    return `${identity}|${createHmac('sha512', secret).update(identity).digest('hex')}`;
  }

  verifyIdentity(cookie: string, secret: Uint8Array): string | null {
    const index = cookie.lastIndexOf('|');

    if (index === -1) {
      return null;
    }
    const identity = cookie.slice(0, index);
    const supplied = Buffer.from(cookie.slice(index + 1), 'utf8');

    const expected = Buffer.from(this.signIdentity(identity, secret).slice(index + 1), 'utf8');

    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? identity : null;
  }

  async hashPassword(password: string) {
    return argon2Hash(password, { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  }

  encryptCredentials(key: Uint8Array, credentials: readonly [string, string], iv = randomBytes(16)) {
    if (key.length !== 32 || iv.length !== 16) {
      throw new Error(t('invalid_credential_key_iv'));
    }
    const cipher = createCipheriv('aes-256-cfb8', key, iv);

    return Buffer.concat([iv, cipher.update(credentials.join('\n'), 'utf8'), cipher.final()]);
  }

  decryptCredentials(key: Uint8Array, bytes: Uint8Array): readonly [string, string] {
    if (key.length !== 32) {
      throw new Error(t('invalid_credentials_key'));
    }

    if (bytes.length < 16) {
      throw new UnreadableCredentialsError({ message: t('crypto_credentials_truncated') });
    }
    const decipher = createDecipheriv('aes-256-cfb8', key, bytes.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]);
    let text: string;

    // CFB8 has no integrity check: a wrong key yields bytes that are almost never valid UTF-8.
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } catch (error) {
      throw new UnreadableCredentialsError({
        message: t('crypto_credentials_decryption_failed'),
        cause: error,
      });
    }

    const lines = text.split(/\r?\n/);
    const first = lines[0];
    const second = lines[1];

    if (first === undefined || second === undefined) {
      throw new UnreadableCredentialsError({
        message: t('crypto_credentials_decryption_failed'),
      });
    }

    return [first, second];
  }

  /** AES-256-GCM: 12-byte IV, 16-byte tag, ciphertext. Tampering fails decryption. */
  encryptSecret(key: Uint8Array, data: Uint8Array) {
    if (key.length !== 32) {
      throw new Error(t('invalid_secret_key'));
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);

    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  decryptSecret(key: Uint8Array, bytes: Uint8Array) {
    if (key.length !== 32 || bytes.length < 28) {
      throw new Error(t('invalid_secret'));
    }
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));

    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }

  sha256(data: Uint8Array | string) {
    return createHash('sha256').update(data).digest('hex');
  }

  sha256File(path: string) {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const file = openSync(path, 'r');

    try {
      let bytes = readSync(file, buffer);

      while (bytes > 0) {
        hash.update(buffer.subarray(0, bytes));
        bytes = readSync(file, buffer);
      }

      return hash.digest('hex');
    } finally {
      closeSync(file);
    }
  }

  async sha256FileAsync(path: string) {
    const hash = createHash('sha256');

    const chunks: AsyncIterable<Buffer> = createReadStream(path);

    for await (const chunk of chunks) {
      hash.update(chunk);
    }

    return hash.digest('hex');
  }

  sha256Bytes(...parts: Array<Uint8Array>) {
    const hash = createHash('sha256');

    for (const part of parts) {
      hash.update(part);
    }

    return hash.digest();
  }

  certificatePublicKey(pem: string) {
    return new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  }

  sha1(data: Uint8Array | string) {
    return createHash('sha1').update(data).digest();
  }

  /** A new ECDSA P-256 key pair: the public key as DER SubjectPublicKeyInfo, the private key as PKCS #8 PEM. */
  async generateEcKeyPair() {
    const { publicKey, privateKey } = await generateKeyPairAsync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    return { publicKey, privateKey };
  }

  /** A DER-encoded ECDSA signature over SHA-256, as ecdsa-with-SHA256 certificates carry. */
  signEcdsaSha256(data: Uint8Array, privateKeyPem: string) {
    return sign('sha256', data, createPrivateKey(privateKeyPem));
  }

  certificateFacts(pem: string): CertificateFacts {
    const certificate = new X509Certificate(pem);
    const details = certificate.publicKey.asymmetricKeyDetails;

    return {
      fingerprint256: certificate.fingerprint256,
      thumbprint: certificate.fingerprint.replaceAll(':', ''),
      subject: certificate.subject.replaceAll('\n', ', '),
      serialNumber: certificate.serialNumber,
      notBefore: certificate.validFromDate,
      notAfter: certificate.validToDate,
      hosts: (certificate.subjectAltName ?? '')
        .split(', ')
        .filter((entry) => entry.startsWith('DNS:'))
        .map((entry) => entry.slice(4)),
      key: describeKey(certificate.publicKey.asymmetricKeyType, details),
    };
  }

  certificateMatchesKey(certificatePem: string, privateKeyPem: string) {
    return new X509Certificate(certificatePem).checkPrivateKey(createPrivateKey(privateKeyPem));
  }

  signToken(data: string) {
    return createHmac('sha256', 'nosecret').update(data).digest('base64url');
  }

  encryptPacketPayload(payload: Uint8Array, key: Uint8Array, nonce: Uint8Array, header: Uint8Array) {
    const cipher = createCipheriv(packetAlgorithm(key), key, nonce, { authTagLength: 4 });
    cipher.setAAD(header);

    return Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  }

  /** Reject unauthenticated packets before exposing plaintext to callers. */
  decryptPacketPayload(payload: Uint8Array, key: Uint8Array, nonce: Uint8Array, header: Uint8Array) {
    if (payload.length < 4) {
      throw new Error(t('missing_packet_authentication_tag'));
    }
    const decipher = createDecipheriv(packetAlgorithm(key), key, nonce, { authTagLength: 4 });
    decipher.setAAD(header);
    decipher.setAuthTag(payload.subarray(-4));

    return Buffer.concat([decipher.update(payload.subarray(0, -4)), decipher.final()]);
  }
}

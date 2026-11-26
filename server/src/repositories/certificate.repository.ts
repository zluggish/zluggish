import { t } from '#src/i18n/index';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { existsSync, readFileSync } from 'node:fs';

/** The Zwift host names that the client reaches over HTTPS. */
export const zwiftHosts = ['*.zwift.com', 'zwift.com'] as const;

export interface CertificateMaterial {
  readonly cert: string;
  readonly key: string;
}

export interface CertificateRequest {
  /** Names this server in the subject, so a client setup script can find the certificates it installed before. */
  readonly serverId: string;
  readonly years: number;
  readonly now: Date;
}

// DER encoding of the few ASN.1 types an X.509 certificate needs.

function length(size: number) {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes: Array<number> = [];

  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function element(tag: number, ...parts: Array<Uint8Array>) {
  const body = Buffer.concat(parts);

  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Array<Uint8Array>) => element(0x30, ...parts);
const set = (...parts: Array<Uint8Array>) => element(0x31, ...parts);
const octets = (bytes: Uint8Array) => element(0x04, bytes);
const utf8 = (text: string) => element(0x0c, Buffer.from(text, 'utf8'));
const critical = element(0x01, Buffer.from([0xff]));
const explicit = (index: number, inner: Uint8Array) => element(0xa0 | index, inner);
const bits = (bytes: Uint8Array, unused = 0) => element(0x03, Buffer.from([unused]), bytes);

function integer(bytes: Uint8Array) {
  let start = 0;

  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  const trimmed = bytes.subarray(start);

  return element(0x02, (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string) {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];

  for (const arc of rest) {
    const groups = [arc % 128];

    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      groups.unshift(0x80 | value % 128);
    }
    bytes.push(...groups);
  }

  return element(0x06, Buffer.from(bytes));
}

/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date) {
  const iso = date.toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);

  return date.getUTCFullYear() < 2050
    ? element(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : element(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

const extension = (id: string, value: Uint8Array, isCritical = false) =>
  sequence(oid(id), ...(isCritical ? [critical] : []), octets(value));

const attribute = (id: string, value: string) => set(sequence(oid(id), utf8(value)));

function bounds(der: Uint8Array, at: number) {
  const first = der[at + 1] ?? 0;
  const lengthBytes = first < 0x80 ? 0 : first & 0x7f;
  let size = first < 0x80 ? first : 0;

  for (let index = 0; index < lengthBytes; index++) {
    size = size * 256 + (der[at + 2 + index] ?? 0);
  }
  const start = at + 2 + lengthBytes;

  return { start, end: start + size };
}

/** The key bits of a DER SubjectPublicKeyInfo, which the key identifier hashes (RFC 5280, 4.2.1.2). */
function subjectPublicKey(spki: Uint8Array) {
  const info = bounds(spki, 0);
  const algorithm = bounds(spki, info.start);
  const key = bounds(spki, algorithm.end);

  // The first content byte of the BIT STRING counts its unused bits.
  return spki.subarray(key.start + 1, key.end);
}

const certificatePem = (der: Uint8Array) =>
  t('begin_certificate_end_certificate', {
    value1: (
      Buffer.from(der)
        .toString('base64')
        .match(/.{1,64}/g) ?? []
    ).join('\n'),
  });

export class CertificateRepository {
  constructor(
    private readonly crypto = new CryptoRepository(),
    private readonly files = new AssetFiles(),
  ) {}

  /** A new ECDSA P-256 key and a self-signed certificate for the Zwift host names.

  The certificate is an end-entity certificate: its key usage cannot sign other certificates, and its extended
  key usage is TLS server authentication only. A client that trusts it trusts nothing else.
  */
  async create(request: CertificateRequest): Promise<CertificateMaterial> {
    const { publicKey, privateKey } = await this.crypto.generateEcKeyPair();
    const keyId = this.crypto.sha1(subjectPublicKey(publicKey));
    const serial = this.crypto.randomBytes(16);
    serial[0] = (serial[0] ?? 0) & 0x7f;
    // A few minutes of slack for clients whose clock runs behind the server's.
    const notBefore = new Date(Math.floor(request.now.getTime() / 1000) * 1000 - 5 * 60_000);
    const notAfter = new Date(request.now);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + request.years);
    // ecdsa-with-SHA256 takes no parameters (RFC 5758, 3.2).
    const signature = sequence(oid('1.2.840.10045.4.3.2'));

    const name = sequence(
      attribute('2.5.4.10', 'Zluggish'),
      attribute('2.5.4.11', `Zluggish server ${request.serverId}`),
      attribute('2.5.4.3', zwiftHosts[0]),
    );

    const tbs = sequence(
      explicit(0, integer(Buffer.from([2]))),
      integer(serial),
      signature,
      name,
      sequence(time(notBefore), time(notAfter)),
      name,
      publicKey,
      explicit(
        3,
        sequence(
          // digitalSignature only: never keyCertSign.
          extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true),
          extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))),
          extension('2.5.29.17', sequence(...zwiftHosts.map((host) => element(0x82, Buffer.from(host, 'ascii'))))),
          extension('2.5.29.14', octets(keyId)),
          extension('2.5.29.35', sequence(element(0x80, keyId))),
        ),
      ),
    );

    const certificate = sequence(tbs, signature, bits(this.crypto.signEcdsaSha256(tbs, privateKey)));

    return { cert: certificatePem(certificate), key: privateKey };
  }

  /** A new ECDSA P-256 key and a self-signed certificate that signs the server's rebuilt Android apps.

  Android checks only that every later version is signed by the same certificate, never its dates or issuer.
  */
  async createApkSigner(request: CertificateRequest): Promise<CertificateMaterial> {
    const { publicKey, privateKey } = await this.crypto.generateEcKeyPair();
    const keyId = this.crypto.sha1(subjectPublicKey(publicKey));
    const serial = this.crypto.randomBytes(16);
    serial[0] = (serial[0] ?? 0) & 0x7f;
    const notAfter = new Date(request.now);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + request.years);
    const signature = sequence(oid('1.2.840.10045.4.3.2'));

    const name = sequence(
      attribute('2.5.4.10', 'Zluggish'),
      attribute('2.5.4.11', `Zluggish server ${request.serverId}`),
      attribute('2.5.4.3', 'Zwift Companion signer'),
    );

    const tbs = sequence(
      explicit(0, integer(Buffer.from([2]))),
      integer(serial),
      signature,
      name,
      sequence(time(request.now), time(notAfter)),
      name,
      publicKey,
      explicit(
        3,
        sequence(extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true), extension('2.5.29.14', octets(keyId))),
      ),
    );

    const certificate = sequence(tbs, signature, bits(this.crypto.signEcdsaSha256(tbs, privateKey)));

    return { cert: certificatePem(certificate), key: privateKey };
  }

  /** The stored key and certificate, or null when the server has none yet. Throws on a damaged file. */
  read(path: string): CertificateMaterial | null {
    if (!existsSync(path)) {
      return null;
    }
    const text = readFileSync(path, 'utf8');
    const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/.exec(text)?.[0];
    const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/.exec(text)?.[0];

    if (!key || !cert || !this.crypto.certificateMatchesKey(cert, key)) {
      throw new Error(t('certificate_key_pair_mismatch', { value1: path }));
    }

    return { cert, key };
  }

  /** Replace the stored key and certificate in one atomic write, readable by the server's user only. */
  async write(path: string, material: CertificateMaterial) {
    await this.files.writeDurableAsync(path, material.key + material.cert, true);
  }

  readFiles(certFile: string, keyFile: string): CertificateMaterial {
    return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
  }
}

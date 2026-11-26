import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { CertificateMaterial } from '#src/repositories/certificate.repository';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { Context, Effect, Layer } from 'effect';
import { resolve } from 'node:path';

/** How the API listener serves TLS.

- `managed`: the server generated its own key, kept in storage.
- `legacy`: a configured or stored copy of the old shared Zwift certificate. Its private key is public.
- `custom`: the files named by `tls.certFile` and `tls.keyFile`.
*/
export type TlsMode = 'managed' | 'legacy' | 'custom';

interface TlsState {
  readonly source: Exclude<TlsMode, 'legacy'>;
  readonly material: CertificateMaterial | null;
}

/** The certificate facts the web app shows. Dates are ISO strings. */
export interface CertificateStatus {
  readonly fingerprint256: string;
  readonly thumbprint: string;
  readonly subject: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly hosts: ReadonlyArray<string>;
  /** The key algorithm and size, such as `ECDSA P-256`. */
  readonly key: string;
}

export interface TlsStatus {
  readonly mode: TlsMode;
  readonly canRotate: boolean;
  readonly certificate: CertificateStatus | null;
  /** The address a client's hosts file points the Zwift names at, unless the rider picks another. */
  readonly serverAddress: string;
  readonly lifetimeYears: number;
}

/** Identifies the old shared Zwift certificate, whose private key is public. */
export const legacyCertificateThumbprint = '9FF8BF63AAB8B21B6A45BAEC612A6DB6531CDE88';

const expiryWarningMs = 90 * 86_400_000;

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const { config } = context;
  const log = context.world.lifecycle.log;
  const certificates = new CertificateRepository();
  const crypto = new CryptoRepository();
  const path = resolve(config.storageDir, 'tls', 'zwift-server.pem');
  const listeners = new Set<(material: CertificateMaterial) => void>();

  function initial(): TlsState {
    if (config.tls.certFile) {
      return { source: 'custom', material: certificates.readFiles(config.tls.certFile, config.tls.keyFile) };
    }

    return { source: 'managed', material: certificates.read(path) };
  }

  const { source, material: stored } = initial();
  let material = stored;
  let rotating: Promise<void> | null = null;
  let lastOperation: string | null = null;

  const facts = () => (material ? crypto.certificateFacts(material.cert) : null);
  let legacy = facts()?.thumbprint === legacyCertificateThumbprint;
  const mode = (): TlsMode => (legacy ? 'legacy' : source);

  /** The subject's server ID of the current managed certificate, so rotation keeps it. */
  function serverId() {
    const current = mode() === 'managed' ? /OU=Zluggish server ([\da-f]+)/.exec(facts()?.subject ?? '')?.[1] : null;

    return current ?? crypto.randomBytes(6).toString('hex');
  }

  async function generate() {
    const created = await certificates.create({
      serverId: serverId(),
      years: config.tls.lifetimeYears,
      now: new Date(),
    });

    await certificates.write(path, created);
    const previous = mode() === 'managed' ? facts()?.fingerprint256 : undefined;
    legacy = false;
    material = created;

    for (const listener of listeners) {
      listener(created);
    }

    return { previous, fingerprint: crypto.certificateFacts(created.cert).fingerprint256 };
  }

  function status(): TlsStatus {
    const current = facts();

    return {
      mode: mode(),
      canRotate: source === 'managed',
      certificate: current && {
        fingerprint256: current.fingerprint256,
        thumbprint: current.thumbprint,
        subject: current.subject,
        notBefore: current.notBefore.toISOString(),
        notAfter: current.notAfter.toISOString(),
        hosts: current.hosts,
        key: current.key,
      },
      serverAddress: config.server.advertisedIp,
      lifetimeYears: config.tls.lifetimeYears,
    };
  }

  function warnLegacy() {
    log.warn(
      'tls.legacy_certificate',
      'The Zwift API uses the shared zwift.com certificate. Its private key is public, so anyone on the network can read and change Zwift traffic, passwords included. Replace it with a new certificate, then install the replacement on every client.',
    );
  }

  function checkExpiry() {
    const current = facts();

    if (!current) {
      return;
    }
    const left = current.notAfter.getTime() - Date.now();
    const fields = { mode: mode(), notAfter: current.notAfter.toISOString(), fingerprint: current.fingerprint256 };

    if (left <= 0) {
      log.error('tls.certificate_expired', 'The Zwift API certificate has expired', fields);
    } else if (left < expiryWarningMs) {
      log.warn(
        'tls.certificate_expiring',
        'The Zwift API certificate expires soon. Rotate it and reinstall it on every client.',
        fields,
      );
    }
  }

  return {
    /** The current key and certificate, or null before first-start generation completes. */
    material: () => material,
    mode,
    status: Effect.fn('TlsService.status')(function* () {
      return status();
    }),
    subscribe: (listener: (material: CertificateMaterial) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    /** Generate the managed certificate on first start, including after a storage migration. */
    start: Effect.fn('TlsService.start')(function* () {
      if (source === 'managed' && !material) {
        const { fingerprint } = yield* Effect.promise(generate);
        log.info('tls.generated', 'Generated a server certificate for the Zwift API', { fingerprint, path });
      }

      if (legacy) {
        warnLegacy();
      }
      checkExpiry();
    }),
    /** Replace the key and certificate managed by this server. */
    rotate: Effect.fn('TlsService.rotate')(function* (operation: string) {
      if (source !== 'managed') {
        throw new ApplicationError({
          status: 409,
          message: t('tls_configured_certificate_notice'),
        });
      }

      // A retried request, or a second click while the key is generated, rotates once.
      if (operation !== lastOperation) {
        rotating ??= generate()
          .then(({ previous, fingerprint }) => {
            log.info(
              'tls.rotated',
              'Rotated the Zwift API certificate. Install it again on every client.',
              previous ? { fingerprint, previous } : { fingerprint },
            );
          })
          .finally(() => {
            rotating = null;
          });
        const pending = rotating;
        yield* Effect.promise(() => pending);
        lastOperation = operation;
      }

      return status();
    }),
  };
});

export class TlsService extends Context.Service<TlsService, Effect.Success<typeof make>>()('zluggish/TlsService') {
  static readonly layer = Layer.effect(TlsService, make);
}

---
sidebar_position: 3
description: Manage the certificate that Zwift uses to connect to Zluggish.
---

# Server certificate

Zluggish generates a self-signed certificate for `*.zwift.com` on first start. The Zwift API and launcher use it on HTTPS port 443 by default. The management web app listens separately on HTTP. To give that app HTTPS, follow the [remote access guide](remote-access.md#web-app).

Administrators can see the certificate fingerprint and expiry under **Manage → Server → Zwift certificate**. The managed certificate and key are stored together in `storage/tls/zwift-server.pem` and included in [server backups](../maintenance/backup-and-restore.md). The default lifetime is five years. Set `tls.lifetimeYears` to change the lifetime of the next generated certificate.

## Rotate the certificate

Select **Rotate certificate** when the certificate is close to expiry or the key may have been exposed. The new certificate takes effect immediately for new connections.

- On desktop, download and run a new setup script from **Apps**.
- On Android, wait for the server to update the published app, then install the new download from **Apps**. If the app still shows the old certificate, rebuild it from **Manage → Android apps**.

## Use your own certificate

Set `tls.certFile` and `tls.keyFile` to your PEM files in `zluggish.config.ts`. To replace them, update the files and restart Zluggish.

If you have a shared certificate from zwift-offline, replace it first. Zluggish warns about that certificate and blocks new client setup because its private key is public.

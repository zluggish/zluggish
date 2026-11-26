import { GarminRepository } from '#src/repositories/garmin.repository';
import { RiderDocuments } from '#src/repositories/rider-document.repository';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const oauth2 = {
  scope: 'CONNECT_READ CONNECT_WRITE',
  jti: 'jti',
  token_type: 'Bearer',
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  refresh_token_expires_in: 7200,
  expires_at: 1_800_000_000,
  refresh_token_expires_at: 1_800_003_600,
};

/** Rider documents that serve fixed texts; the store under test only reads. */
class FixedDocuments extends RiderDocuments {
  constructor(private readonly files: Record<string, string>) {
    super(new DatabaseSync(':memory:'), tmpdir());
  }

  override text(_player: number, name: string) {
    return this.files[name] ?? null;
  }
}

function documents(files: Record<string, string>) {
  return new FixedDocuments(files);
}

void test('loads garth tokens whose optional fields are null, as Python garth writes them', async () => {
  const store = new GarminRepository().tokenStore(
    documents({
      'garth/oauth1_token.json': JSON.stringify({
        oauth_token: 'token',
        oauth_token_secret: 'secret',
        mfa_token: null,
        mfa_expiration_timestamp: null,
        domain: null,
      }),
      'garth/oauth2_token.json': JSON.stringify(oauth2),
    }),
    1,
  );

  const tokens = await store.load();

  assert.deepEqual(tokens?.oauth1, { oauth_token: 'token', oauth_token_secret: 'secret' });
});

void test('keeps the optional garth fields that are present', async () => {
  const store = new GarminRepository().tokenStore(
    documents({
      'garth/oauth1_token.json': JSON.stringify({
        oauth_token: 'token',
        oauth_token_secret: 'secret',
        mfa_token: 'mfa',
        domain: 'garmin.com',
      }),
      'garth/oauth2_token.json': JSON.stringify(oauth2),
    }),
    1,
  );

  const tokens = await store.load();

  assert.deepEqual(tokens?.oauth1, {
    oauth_token: 'token',
    oauth_token_secret: 'secret',
    mfa_token: 'mfa',
    domain: 'garmin.com',
  });
});

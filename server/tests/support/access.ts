/** The Zluggish web app address the Access sign-in tests use. */
export const ACCESS_PUBLIC_URL = 'https://zluggish.example.com';

export const ACCESS_TEAM = 'berg.cloudflareaccess.com';

export const ACCESS_AUDIENCE = 'a'.repeat(64);

/** `network.web` settings that turn the launcher's Cloudflare Access sign-in on. */
export const ACCESS_WEB = { cloudflareAccess: { teamDomain: ACCESS_TEAM, audience: ACCESS_AUDIENCE } };

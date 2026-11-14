const agent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

export interface SessionRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}

/** A small cookie-carrying client; cookies are only sent to the site's own domain. */
export class CookieSession {
  private readonly cookies = new Map<string, string>();

  constructor(
    readonly domain: string,
    initial: Readonly<Record<string, string>> = {},
  ) {
    for (const [name, value] of Object.entries(initial)) this.cookies.set(name, value);
  }

  private inDomain(url: URL) {
    return url.hostname === this.domain || url.hostname.endsWith(`.${this.domain}`);
  }

  // Each response updates the jar before following a bounded redirect; 307/308 retain the request body.
  async request(url: string, init: SessionRequest = {}, redirects = 10): Promise<Response> {
    const target = new URL(url);
    const headers = new Headers({ 'User-Agent': agent, ...init.headers });

    if (this.inDomain(target) && this.cookies.size > 0)
      headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));

    const request: RequestInit = {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    };

    if (init.body !== undefined) request.body = init.body;
    const response = await fetch(target, request);

    if (this.inDomain(target))
      for (const line of response.headers.getSetCookie()) {
        const [pair = ''] = line.split(';', 1);
        const split = pair.indexOf('=');

        if (split > 0) this.cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
      }

    const location = response.headers.get('Location');

    if (response.status >= 300 && response.status < 400 && location) {
      if (redirects <= 0) throw new Error('Too many redirects');
      const next = new URL(location, target).href;

      if (response.status === 307 || response.status === 308) return this.request(next, init, redirects - 1);

      return this.request(next, init.headers ? { headers: init.headers } : {}, redirects - 1);
    }

    return response;
  }
}

export class SessionRepository {
  unescapeHtml(text: string) {
    return text.replaceAll(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();

      if (lower === 'amp') return '&';

      if (lower === 'lt') return '<';

      if (lower === 'gt') return '>';

      if (lower === 'quot') return '"';

      if (lower === 'apos') return "'";

      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Math.trunc(Number(lower.slice(1)));

      return Number.isSafeInteger(code) && code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : match;
    });
  }

  binaryBlob = (bytes: Uint8Array) => new Blob([Uint8Array.from(bytes)]);
}

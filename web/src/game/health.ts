const videoHost = 'loveturtle.zwift.com';
// A public route thumbnail on the same host and version as the video manifest.
const videoThumbnail = `https://${videoHost}/1.0.2/tenerife/teide/2587597096`;

function checkVideo(signal: AbortSignal): Promise<boolean> {
  // The video CDN does not allow reading its responses through cross-origin fetch.
  return new Promise((resolve) => {
    const image = new Image();

    function finish(ok: boolean) {
      signal.removeEventListener('abort', abort);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
      resolve(ok);
    }

    function abort() {
      finish(false);
    }

    signal.addEventListener('abort', abort, { once: true });
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.referrerPolicy = 'no-referrer';
    image.src = `${videoThumbnail}?zluggish-check=${Date.now()}`;
  });
}

export async function checkLauncherHosts(hosts: Array<string>, signal: AbortSignal): Promise<Array<string>> {
  const checks = hosts.map(async (host) => {
    try {
      const response = await fetch(`https://${host}/health/launcher`, {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      });

      return response.ok && (await response.text()) === 'zluggish launcher';
    } catch {
      return false;
    }
  });

  const results = await Promise.all([...checks, checkVideo(signal)]);
  return [...hosts, videoHost].filter((_, index) => !results[index]);
}

import type { Runtime } from '#src/http/runtime';
import { startHttp } from '#src/node/network/http';
import { fetchCdn } from '#src/node/network/proxy';
import { ZwiftUpdatesService } from '#src/services/zwift-updates.service';
import { WorkoutsService } from '#src/services/workout.service';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

const updateRoot = '/gameassets/Zwift_Updates_Root/';
const updateVersionFile = /^(Zwift(?:Mac)?|Launcher(?:Mac)?)_ver_cur(?:\.(\d+))?\.xml$/;

const contentTypes = new Map([
  ['.xml', 'text/xml'],
  ['.json', 'application/json'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.zwo', 'application/xml'],
]);

export function createCdn(runtime: Runtime) {
  const app = new Hono();
  const root = resolve(runtime.assets, 'cdn');
  app.get('/tp-workouts/intervalsicu/:id', (c) => {
    const file = runtime.effects.runSync(
      WorkoutsService.use((workouts) => workouts.file(c.req.param('id').replace(/\.zwo$/, ''))),
    );

    return file && existsSync(file)
      ? c.body(readFileSync(file), 200, { 'Content-Type': 'application/xml' })
      : c.notFound();
  });
  app.get('*', async (c) => {
    const path = c.req.path;

    const overrides =
      path === '/gameassets/MapSchedule_v2.xml'
        ? runtime.world.mapOverrides
        : path === '/gameassets/PortalRoadSchedule_v1.xml'
          ? runtime.world.climbOverrides
          : null;

    const ip = overrides ? (getConnInfo(c).remote.address ?? '') : '';
    const selected = overrides?.get(ip);

    if (selected) {
      overrides?.delete(ip);
      const value = selected.replaceAll(/[^0-9A-Za-z_-]/g, '');
      const start = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

      const xml = path.includes('MapSchedule')
        ? `<MapSchedule><appointments><appointment map="${value}" start="${start}T00:01-04"/></appointments><VERSION>1</VERSION></MapSchedule>`
        : `<PortalRoads><PortalRoadSchedule><appointments><appointment road="${value}" portal="0" start="${start}T00:01-04"/></appointments></PortalRoadSchedule></PortalRoads>`;

      return c.body(xml, 200, { 'Content-Type': 'text/xml' });
    }

    const file = resolve(root, `.${decodeURIComponent(path)}`);
    const localPath = relative(root, file);

    if (localPath.startsWith('..')) {
      return c.notFound();
    }

    const normalized = `/${localPath.replaceAll(sep, '/')}`;
    const updatePath = normalized.toLowerCase();

    const isUpdate =
      updatePath.startsWith(updateRoot.toLowerCase()) ||
      updatePath.startsWith('/app/macupdate/') ||
      updatePath.startsWith('/static/web/launcher/app/');

    if (isUpdate) {
      c.header('Cache-Control', 'no-store');

      if (
        runtime.config.proxy.mode !== 'disabled' &&
        runtime.effects.runSync(ZwiftUpdatesService.use((updates) => updates.allowed()))
      ) {
        try {
          const response = await fetchCdn(`${path}${new URL(c.req.url).search}`, c.req.header('Range'));
          response.headers.set('Cache-Control', 'no-store');

          return response;
        } catch (error) {
          if (runtime.config.proxy.mode === 'enabled') {
            throw error;
          }
        }
      }

      // Serve local version metadata so installed clients can complete their update check.
      const versionFile = updateVersionFile.exec(normalized.slice(updateRoot.length));

      if (!normalized.startsWith(updateRoot) || !versionFile) {
        return c.notFound();
      }
      const [, platform, build] = versionFile;
      const bundled = resolve(root, `.${updateRoot}${platform}_ver_cur.xml`);

      if (existsSync(file) && statSync(file).isFile()) {
        return c.body(readFileSync(file), 200, { 'Content-Type': 'text/xml' });
      }

      if (build && existsSync(bundled)) {
        const xml = readFileSync(bundled, 'utf8');

        if (/\bversion="1\.0\.(\d+)"/.exec(xml)?.[1] === build) {
          return c.text(xml, 200, { 'Content-Type': 'text/xml' });
        }
      }

      return c.notFound();
    }

    if (existsSync(file) && statSync(file).isFile()) {
      return c.body(readFileSync(file), 200, {
        'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
      });
    }

    if (runtime.config.proxy.mode !== 'disabled' && path.startsWith('/gameassets/') && !path.endsWith('_ver_cur.xml')) {
      try {
        return await fetchCdn(path);
      } catch (error) {
        if (runtime.config.proxy.mode === 'enabled') {
          throw error;
        }
      }
    }

    return c.notFound();
  });

  return app;
}

export function startCdn(runtime: Runtime) {
  return startHttp(createCdn(runtime), {
    host: runtime.config.network.cdn.host ?? runtime.config.network.host,
    port: runtime.config.network.cdn.port,
  });
}

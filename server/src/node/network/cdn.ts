import { fetchCdn } from '#src/node/network/proxy';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { startHttp } from '#src/node/network/http';
import type { Runtime } from '#src/http/runtime';
import { Workouts } from '#src/domain/workouts/planned';

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
    const file = new Workouts(runtime).file(c.req.param('id').replace(/\.zwo$/, ''));

    return file && existsSync(file)
      ? c.body(readFileSync(file), 200, { 'Content-Type': 'application/xml' })
      : c.notFound();
  });
  app.get('*', async (c) => {
    const ip = getConnInfo(c).remote.address ?? '';
    const path = c.req.path;

    const overrides =
      path === '/gameassets/MapSchedule_v2.xml'
        ? runtime.world.mapOverrides
        : path === '/gameassets/PortalRoadSchedule_v1.xml'
          ? runtime.world.climbOverrides
          : null;

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

    if (relative(root, file).startsWith('..')) return c.notFound();

    if (existsSync(file) && statSync(file).isFile())
      return c.body(readFileSync(file), 200, {
        'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
      });

    if (runtime.config.proxy.mode !== 'disabled' && path.startsWith('/gameassets/') && !path.endsWith('_ver_cur.xml')) {
      try {
        return await fetchCdn(path);
      } catch (error) {
        if (runtime.config.proxy.mode === 'enabled') throw error;
      }
    }

    return c.notFound();
  });

  return app;
}

export function startCdn(runtime: Runtime) {
  return startHttp(createCdn(runtime), {
    host: runtime.config.network.cdn.host ?? (runtime.config.network.host || '127.0.0.1'),
    port: runtime.config.network.cdn.port,
  });
}

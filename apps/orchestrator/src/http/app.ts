import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context.js';
import { registerErrorHandler } from './errors.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSettingsRoutes } from './routes/settings.js';
import type { ProjectRouteOptions } from './routes/projects.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMaintenanceRoutes } from './routes/maintenance.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerWebSocket } from './ws.js';

const DASHBOARD_DIST = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url));

export async function buildApp(
  ctx: AppContext,
  options: { projectRoutes?: ProjectRouteOptions } = {},
): Promise<FastifyInstance> {
  // pino-Logger als Basis-Logger casten: Fastify würde sonst den konkreten
  // pino-Typ inferieren und mit den Plugin-Typen (@fastify/cors, -static, -websocket) kollidieren.
  const app = Fastify({ loggerInstance: ctx.logger as unknown as FastifyBaseLogger });

  registerErrorHandler(app);

  if (ctx.config.nodeEnv !== 'production') {
    await app.register(cors, { origin: true });
  }

  app.get('/api/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    runningJobs: ctx.queue.runningJobIds().length,
    linearConfigured: Boolean(ctx.config.linear.apiKey),
  }));

  registerProjectRoutes(app, ctx, options.projectRoutes);
  registerSettingsRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerMaintenanceRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  await registerWebSocket(app, ctx);

  // Produktions-Serving des gebauten Dashboards (Single-Prozess-Deploy).
  if (fs.existsSync(DASHBOARD_DIST)) {
    await app.register(fastifyStatic, { root: DASHBOARD_DIST, wildcard: false });
    // SPA-Fallback: unbekannte GET-Routen außerhalb von /api liefern index.html.
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        !request.url.startsWith('/ws')
      ) {
        return reply.sendFile('index.html');
      }
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `Nicht gefunden: ${request.url}` } });
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `Nicht gefunden: ${request.url}` } });
    });
  }

  return app;
}

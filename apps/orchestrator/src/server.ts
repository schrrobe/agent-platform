import type { FastifyInstance } from 'fastify';
import { openDatabase, migrate } from '@agent/database';
import { loadConfig, loadEnvFile, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createContext, type AppContext, type ContextOverrides } from './context.js';
import { runRecovery } from './recovery.js';
import { buildApp } from './http/app.js';
import type { ProjectRouteOptions } from './http/routes/projects.js';

export interface RunningServer {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

/** Baut Datenbank, Kontext und Fastify — ohne zu lauschen (für Tests nutzbar). */
export async function bootstrap(overrides?: {
  config?: AppConfig;
  logger?: Logger;
  context?: ContextOverrides;
  projectRoutes?: ProjectRouteOptions;
}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = overrides?.config ?? loadConfig();
  const logger = overrides?.logger ?? createLogger(config);

  const db = openDatabase(config.databasePath);
  const applied = migrate(db);
  if (applied.applied.length > 0) {
    logger.info({ migrations: applied.applied }, 'Migrationen angewendet');
  }

  const ctx = createContext(config, logger, db, overrides?.context);
  await runRecovery(ctx);

  const app = await buildApp(ctx, { projectRoutes: overrides?.projectRoutes });
  return { app, ctx };
}

/** Startet den Server und registriert Graceful-Shutdown-Handler. */
export async function startServer(): Promise<RunningServer> {
  loadEnvFile();
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nKonfigurationsfehler:\n${message}\n\n`);
    process.exit(1);
  }

  const logger = createLogger(config);
  const { app, ctx } = await bootstrap({ config, logger });

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, dataDir: config.dataDir },
    `Orchestrator läuft auf http://${config.host}:${config.port}`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('Fahre herunter …');
    ctx.queue.abortAll('Server-Shutdown');
    try {
      await app.close();
    } finally {
      ctx.db.close();
    }
    logger.info('Beendet.');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }

  return { app, ctx, close };
}

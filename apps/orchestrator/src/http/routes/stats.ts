import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';

/** Statistik-Endpunkte (schreibend nichts) — reine Aggregation der Repositories. */
export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/stats/tokens', async () => ctx.repos.agentRuns.tokenStats());
}

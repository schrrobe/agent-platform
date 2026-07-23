import type { FastifyInstance } from 'fastify';
import { worktreeRemoveSchema } from '@agent/shared';
import type { AppContext } from '../../context.js';
import { parseBody } from '../errors.js';

export function registerMaintenanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/maintenance/worktrees', async () => ({
    worktrees: await ctx.maintenance.listWorktrees(),
  }));

  app.delete('/api/maintenance/worktrees', async (request, reply) => {
    const input = parseBody(worktreeRemoveSchema, request.body);
    if (input.jobId) {
      await ctx.jobs.removeWorktree(input.jobId);
    } else {
      await ctx.maintenance.removeOrphan(input.projectId, input.path);
    }
    reply.code(204);
    return null;
  });
}

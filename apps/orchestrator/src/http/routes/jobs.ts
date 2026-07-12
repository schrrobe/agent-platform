import type { FastifyInstance } from 'fastify';
import {
  importRequestSchema,
  logsQuerySchema,
  planApprovalSchema,
  statePatchSchema,
} from '@agent/shared';
import type { AppContext } from '../../context.js';
import { ApiError, parseBody } from '../errors.js';

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/jobs', async () => ({ jobs: ctx.jobs.listSummaries() }));

  app.get('/api/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { job: ctx.jobs.getDetail(id) };
  });

  app.post('/api/jobs/import', async (request, reply) => {
    const input = parseBody(importRequestSchema, request.body);
    const job = await ctx.jobs.importTicket(input.identifier, input.projectId);
    reply.code(201);
    return { job };
  });

  app.post('/api/jobs/:id/start', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await ctx.jobs.start(id) };
  });

  app.post('/api/jobs/:id/pause', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await ctx.jobs.pause(id) };
  });

  app.post('/api/jobs/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await ctx.jobs.retry(id) };
  });

  app.post('/api/jobs/:id/approve-plan', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(planApprovalSchema, request.body ?? {});
    return { job: await ctx.jobs.approvePlan(id, input.note) };
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await ctx.jobs.cancel(id) };
  });

  app.patch('/api/jobs/:id/state', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(statePatchSchema, request.body);
    return { job: await ctx.jobs.patchState(id, input.state) };
  });

  app.get('/api/jobs/:id/logs', async (request) => {
    const { id } = request.params as { id: string };
    if (!ctx.repos.jobs.get(id)) throw ApiError.notFound(`Job nicht gefunden: ${id}`);
    const query = parseBody(logsQuerySchema, request.query);
    return { logs: ctx.logStore.read(id, { afterSeq: query.afterSeq, limit: query.limit }) };
  });

  app.get('/api/jobs/:id/artifacts', async (request) => {
    const { id } = request.params as { id: string };
    if (!ctx.repos.jobs.get(id)) throw ApiError.notFound(`Job nicht gefunden: ${id}`);
    return { artifacts: ctx.repos.artifacts.listByJob(id) };
  });
}

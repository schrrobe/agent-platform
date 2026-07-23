import type { FastifyInstance } from 'fastify';
import {
  assignedIssuesQuerySchema,
  bulkImportRequestSchema,
  diffApprovalSchema,
  groupJobsSchema,
  importRequestSchema,
  jobCleanupSchema,
  jobPriorityPatchSchema,
  logsQuerySchema,
  planApprovalSchema,
  queuePositionPatchSchema,
  requestChangesSchema,
  retryBodySchema,
  statePatchSchema,
  teamStatesQuerySchema,
  ticketDescriptionUpdateSchema,
  ungroupSchema,
} from '@agent/shared';
import type { AppContext } from '../../context.js';
import { ApiError, parseBody } from '../errors.js';

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/jobs', async () => ({ jobs: ctx.jobs.listSummaries() }));

  app.get('/api/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { job: ctx.jobs.getDetail(id) };
  });

  app.get('/api/linear/assigned-issues', async (request) => {
    const { limit } = parseBody(assignedIssuesQuerySchema, request.query);
    return { issues: await ctx.jobs.listImportableTickets(limit) };
  });

  app.get('/api/linear/team-states', async (request) => {
    const { teamKey } = parseBody(teamStatesQuerySchema, request.query);
    return { states: await ctx.linear.listTeamStates(teamKey) };
  });

  app.post('/api/jobs/import', async (request, reply) => {
    const input = parseBody(importRequestSchema, request.body);
    const job = await ctx.jobs.importTicket(input.identifier, input.projectId);
    reply.code(201);
    return { job };
  });

  app.post('/api/jobs/import-bulk', async (request, reply) => {
    const input = parseBody(bulkImportRequestSchema, request.body);
    const result = await ctx.jobs.importTickets(input.identifiers, input.projectId);
    reply.code(201);
    return { result };
  });

  app.post('/api/jobs/group', async (request) => {
    const input = parseBody(groupJobsSchema, request.body);
    return { job: await ctx.jobs.groupJobs(input.jobIds) };
  });

  app.post('/api/jobs/:id/ungroup', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(ungroupSchema, request.body);
    return ctx.jobs.ungroupTicket(id, input.ticketId);
  });

  app.patch('/api/jobs/:id/ticket-description', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(ticketDescriptionUpdateSchema, request.body);
    return { job: await ctx.jobs.updateTicketDescription(id, input.description) };
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
    const input = parseBody(retryBodySchema, request.body ?? {});
    return { job: await ctx.jobs.retry(id, input.note) };
  });

  app.post('/api/jobs/:id/reset', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(jobCleanupSchema, request.body ?? {});
    return { job: await ctx.jobs.resetToInbox(id, input) };
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseBody(jobCleanupSchema, request.body ?? {});
    await ctx.jobs.delete(id, input);
    reply.code(204);
    return null;
  });

  app.post('/api/jobs/:id/approve-plan', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(planApprovalSchema, request.body ?? {});
    return { job: await ctx.jobs.approvePlan(id, input.note) };
  });

  app.post('/api/jobs/:id/approve-diff', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(diffApprovalSchema, request.body ?? {});
    return { job: await ctx.jobs.approveDiff(id, input.note) };
  });

  app.post('/api/jobs/:id/request-changes', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(requestChangesSchema, request.body);
    return { job: await ctx.jobs.requestChanges(id, input.note) };
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await ctx.jobs.cancel(id) };
  });

  app.post('/api/jobs/:id/github-review', async (request) => {
    const { id } = request.params as { id: string };
    const result = await ctx.githubReviews.run(id);
    return { job: ctx.jobs.getSummary(id), result };
  });

  app.patch('/api/jobs/:id/priority', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(jobPriorityPatchSchema, request.body);
    return { job: await ctx.jobs.setPriority(id, input.priority) };
  });

  app.patch('/api/jobs/:id/queue-position', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(queuePositionPatchSchema, request.body);
    return { job: await ctx.jobs.reorder(id, input.afterJobId) };
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

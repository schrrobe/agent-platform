import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { projectCreateSchema, projectUpdateSchema } from '@agent/shared';
import type { AppContext } from '../../context.js';
import { ApiError, parseBody } from '../errors.js';

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects', async () => ({ projects: ctx.repos.projects.list() }));

  app.post('/api/projects', async (request, reply) => {
    const input = parseBody(projectCreateSchema, request.body);
    const base = ctx.config.dataDir;
    const repositoryPath = resolvePath(base, input.repositoryPath);
    const worktreeRoot = resolvePath(base, input.worktreeRoot);
    if (!fs.existsSync(repositoryPath)) {
      throw ApiError.validation(`Repository-Pfad existiert nicht: ${repositoryPath}`);
    }
    const project = ctx.repos.projects.insert({
      name: input.name,
      repositoryPath,
      baseBranch: input.baseBranch,
      worktreeRoot,
      commands: input.commands,
      autonomyMode: input.autonomyMode,
      testExecutionMode: input.testExecutionMode,
      baselineChecks: input.baselineChecks,
      maxChangedFiles: input.maxChangedFiles,
      maxDiffBytes: input.maxDiffBytes,
      blockedPaths: input.blockedPaths,
      active: input.active,
    });
    reply.code(201);
    return { project };
  });

  app.patch('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = ctx.repos.projects.get(id);
    if (!existing) throw ApiError.notFound(`Projekt nicht gefunden: ${id}`);
    const input = parseBody(projectUpdateSchema, request.body);
    const patch: Record<string, unknown> = { ...input };
    if (input.repositoryPath) {
      const resolved = resolvePath(ctx.config.dataDir, input.repositoryPath);
      if (!fs.existsSync(resolved)) {
        throw ApiError.validation(`Repository-Pfad existiert nicht: ${resolved}`);
      }
      patch.repositoryPath = resolved;
    }
    if (input.worktreeRoot) {
      patch.worktreeRoot = resolvePath(ctx.config.dataDir, input.worktreeRoot);
    }
    const project = ctx.repos.projects.update(id, patch);
    return { project };
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.repos.projects.get(id)) throw ApiError.notFound(`Projekt nicht gefunden: ${id}`);
    try {
      ctx.repos.projects.delete(id);
    } catch {
      throw ApiError.conflict('Projekt hat noch Tickets/Jobs und kann nicht gelöscht werden');
    }
    reply.code(204);
    return null;
  });
}

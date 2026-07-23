import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectCreateSchema, projectUpdateSchema } from '@agent/shared';
import type { AppContext } from '../../context.js';
import { ApiError, parseBody } from '../errors.js';
import {
  DirectoryPickerUnavailableError,
  pickDirectory,
  type DirectoryPickerKind,
} from '../../services/directory-picker.js';

const directoryPickerSchema = z.object({
  kind: z.enum(['repository', 'worktree']),
});

export interface ProjectRouteOptions {
  pickDirectory?: (kind: DirectoryPickerKind) => Promise<string | null>;
}

interface RepositoryOption {
  name: string;
  path: string;
}

async function discoverRepositories(ctx: AppContext): Promise<RepositoryOption[]> {
  const root = ctx.config.defaults.repoRoot;
  if (!root) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    throw ApiError.validation(`Repository-Wurzel ist nicht erreichbar: ${root}`);
  }

  const repositories: RepositoryOption[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const repositoryPath = path.join(root, entry.name);
    if (!fs.existsSync(path.join(repositoryPath, '.git'))) continue;
    if (await ctx.git.isGitRepo(repositoryPath)) {
      repositories.push({ name: entry.name, path: repositoryPath });
    }
  }
  return repositories;
}

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

export function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: ProjectRouteOptions = {},
): void {
  const chooseDirectory = options.pickDirectory ?? pickDirectory;

  app.get('/api/projects', async () => ({ projects: ctx.repos.projects.list() }));

  app.get('/api/repositories', async () => ({
    root: ctx.config.defaults.repoRoot || null,
    repositories: await discoverRepositories(ctx),
  }));

  app.post('/api/pick-directory', async (request) => {
    const { kind } = parseBody(directoryPickerSchema, request.body);
    try {
      const directory = await chooseDirectory(kind);
      return { path: directory, cancelled: directory === null };
    } catch (error) {
      if (error instanceof DirectoryPickerUnavailableError) {
        throw new ApiError('INTERNAL', 501, error.message);
      }
      throw new ApiError('INTERNAL', 500, 'Ordnerauswahl konnte nicht geöffnet werden.');
    }
  });

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
      linearStateSync: input.linearStateSync,
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

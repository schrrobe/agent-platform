import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parseBody } from '../errors.js';

const updateSettingsSchema = z
  .object({
    implementationAgent: z.enum(['codex', 'claude']).optional(),
    maxConcurrentJobs: z.number().int().min(1).max(16).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Mindestens ein Feld muss angegeben werden',
  });

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const currentSettings = () => ({
    implementationAgent: ctx.pipeline.implementationAgent,
    maxConcurrentJobs: ctx.config.limits.maxConcurrentJobs,
  });

  app.get('/api/settings', async () => currentSettings());

  app.patch('/api/settings', async (request) => {
    const input = parseBody(updateSettingsSchema, request.body);
    if (input.implementationAgent) {
      ctx.repos.settings.set('implementation_agent', input.implementationAgent);
      ctx.pipeline.setImplementer(
        input.implementationAgent === 'claude' ? ctx.claudeAgent : ctx.codexAgent,
      );
    }
    if (input.maxConcurrentJobs !== undefined) {
      ctx.repos.settings.set('max_concurrent_jobs', String(input.maxConcurrentJobs));
      ctx.queue.setMaxConcurrent(input.maxConcurrentJobs);
    }
    return currentSettings();
  });
}

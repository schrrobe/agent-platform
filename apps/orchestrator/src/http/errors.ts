import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import type { ApiErrorCode } from '@agent/shared';
import { InvalidTransitionError } from '@agent/workflow';
import { JobServiceError } from '../services/job-service.js';
import { LinearError } from '@agent/linear';
import { GitConflictError } from '@agent/git';
import { GithubReviewServiceError } from '../services/github-review.js';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(message: string): ApiError {
    return new ApiError('NOT_FOUND', 404, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', 409, message);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError('VALIDATION_ERROR', 400, message, details);
  }
}

const JOB_SERVICE_STATUS: Record<JobServiceError['code'], number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LINEAR_ERROR: 502,
};

const GITHUB_REVIEW_STATUS: Record<GithubReviewServiceError['code'], number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  EXTERNAL: 502,
  AGENT_ERROR: 422,
};

/** Parst und validiert eine Payload mit Zod; wirft strukturierte ApiError. */
export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw ApiError.validation('Ungültige Anfragedaten', result.error.flatten());
  }
  return result.data;
}

export function registerErrorHandler(app: {
  setErrorHandler: (
    handler: (error: unknown, request: FastifyRequest, reply: FastifyReply) => void,
  ) => void;
  log: { error: (obj: unknown, msg?: string) => void };
}): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validierung fehlgeschlagen',
          details: error.flatten(),
        },
      });
      return;
    }
    if (error instanceof JobServiceError) {
      reply
        .code(JOB_SERVICE_STATUS[error.code])
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof GithubReviewServiceError) {
      reply.code(GITHUB_REVIEW_STATUS[error.code]).send({
        error: {
          code:
            error.code === 'EXTERNAL'
              ? 'GITHUB_ERROR'
              : error.code === 'AGENT_ERROR'
                ? 'AGENT_ERROR'
                : error.code,
          message: error.message,
        },
      });
      return;
    }
    if (error instanceof GitConflictError) {
      reply.code(409).send({ error: { code: 'CONFLICT', message: error.message } });
      return;
    }
    if (error instanceof InvalidTransitionError) {
      reply.code(409).send({ error: { code: 'INVALID_TRANSITION', message: error.message } });
      return;
    }
    if (error instanceof LinearError) {
      reply.code(502).send({ error: { code: 'LINEAR_ERROR', message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : 'Interner Fehler';
    app.log.error(error, 'Unbehandelter Fehler');
    reply.code(500).send({ error: { code: 'INTERNAL', message } });
  });
}

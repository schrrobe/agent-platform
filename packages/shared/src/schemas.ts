import { z } from 'zod';
import { AUTONOMY_MODES, COMMAND_KEYS, TEST_EXECUTION_MODES } from './types.js';
import { JOB_STATES } from './states.js';

/** Linear-Identifier wie `APP-123`; wird auch für Branch-/Pfadnamen genutzt. */
export const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Shell-Metazeichen sind in Projektbefehlen verboten — Befehle laufen ohne Shell
 * (ADR-014); der Tokenizer unterstützt lediglich Quotes für Argumente mit Leerzeichen.
 */
// eslint-disable-next-line no-control-regex
export const SHELL_METACHAR_RE = /[;|&<>$`\\\n\r\x00]/;

export const identifierSchema = z
  .string()
  .trim()
  .regex(IDENTIFIER_RE, { error: 'Erwartet ein Linear-Identifier-Format wie APP-123' });

export const commandStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !SHELL_METACHAR_RE.test(value), {
    error: 'Shell-Metazeichen (;|&<>$`\\) sind in Befehlen nicht erlaubt',
  });

export const projectCommandsSchema = z
  .object(
    Object.fromEntries(COMMAND_KEYS.map((key) => [key, commandStringSchema.optional()])) as Record<
      (typeof COMMAND_KEYS)[number],
      z.ZodOptional<typeof commandStringSchema>
    >,
  )
  .strict();

export const blockedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => value !== '.' && !value.startsWith('/') && !value.split('/').includes('..'), {
    error: 'Gesperrte Pfade müssen relative Repository-Pfade ohne .. sein',
  });

const projectPolicyShape = {
  autonomyMode: z.enum(AUTONOMY_MODES).default('approve_plan'),
  testExecutionMode: z.enum(TEST_EXECUTION_MODES).default('sandboxed'),
  baselineChecks: z.boolean().default(true),
  maxChangedFiles: z.number().int().min(1).max(10_000).default(100),
  maxDiffBytes: z
    .number()
    .int()
    .min(1_024)
    .max(100 * 1024 * 1024)
    .default(1024 * 1024),
  blockedPaths: z.array(blockedPathSchema).max(200).default([]),
} as const;

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    repositoryPath: z.string().trim().min(1).max(1024),
    baseBranch: z.string().trim().min(1).max(200).default('main'),
    worktreeRoot: z.string().trim().min(1).max(1024),
    commands: projectCommandsSchema.default({}),
    ...projectPolicyShape,
    active: z.boolean().default(true),
  })
  .strict();

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    repositoryPath: z.string().trim().min(1).max(1024).optional(),
    baseBranch: z.string().trim().min(1).max(200).optional(),
    worktreeRoot: z.string().trim().min(1).max(1024).optional(),
    commands: projectCommandsSchema.optional(),
    autonomyMode: z.enum(AUTONOMY_MODES).optional(),
    testExecutionMode: z.enum(TEST_EXECUTION_MODES).optional(),
    baselineChecks: z.boolean().optional(),
    maxChangedFiles: z.number().int().min(1).max(10_000).optional(),
    maxDiffBytes: z
      .number()
      .int()
      .min(1_024)
      .max(100 * 1024 * 1024)
      .optional(),
    blockedPaths: z.array(blockedPathSchema).max(200).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const importRequestSchema = z
  .object({
    identifier: identifierSchema,
    projectId: z.uuid(),
  })
  .strict();

export const bulkImportRequestSchema = z
  .object({
    identifiers: z.array(identifierSchema).min(1).max(100),
    projectId: z.uuid(),
  })
  .strict();

export const ticketDescriptionUpdateSchema = z
  .object({
    description: z.string().max(100_000),
  })
  .strict();

export const statePatchSchema = z
  .object({
    state: z.enum(JOB_STATES),
  })
  .strict();

export const planApprovalSchema = z
  .object({
    note: z.string().trim().max(20_000).optional().default(''),
  })
  .strict();

export const jobCleanupSchema = z
  .object({
    removeWorktree: z.boolean().default(false),
  })
  .strict();

export const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  afterSeq: z.coerce.number().int().min(0).optional(),
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ImportRequestInput = z.infer<typeof importRequestSchema>;
export type BulkImportRequestInput = z.infer<typeof bulkImportRequestSchema>;
export type TicketDescriptionUpdateInput = z.infer<typeof ticketDescriptionUpdateSchema>;
export type StatePatchInput = z.infer<typeof statePatchSchema>;
export type PlanApprovalInput = z.infer<typeof planApprovalSchema>;
export type JobCleanupInput = z.infer<typeof jobCleanupSchema>;

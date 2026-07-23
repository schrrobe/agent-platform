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

export const linearStateSyncSchema = z
  .object({
    teamKey: z.string().trim().min(1).max(50),
    onStart: z.string().trim().min(1).max(100).nullable().default(null),
    onReadyForHuman: z.string().trim().min(1).max(100).nullable().default(null),
    onDone: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .strict();
export type LinearStateSyncInput = z.infer<typeof linearStateSyncSchema>;

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
    linearStateSync: linearStateSyncSchema.nullable().default(null),
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
    linearStateSync: linearStateSyncSchema.nullable().optional(),
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

export const groupJobsSchema = z
  .object({
    /** Zu einem Vorgang zusammenzuführende Jobs (≥2). */
    jobIds: z.array(z.uuid()).min(2).max(20),
  })
  .strict();

export const ungroupSchema = z
  .object({
    /** Sekundäres Ticket, das wieder als eigener Job herausgelöst wird. */
    ticketId: z.uuid(),
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

export const diffApprovalSchema = z
  .object({
    note: z.string().trim().max(20_000).optional().default(''),
  })
  .strict();

export const requestChangesSchema = z
  .object({
    note: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const retryBodySchema = z
  .object({
    note: z.string().trim().max(20_000).optional().default(''),
  })
  .strict();

export const jobPriorityPatchSchema = z
  .object({
    priority: z.number().int().min(-1).max(1),
  })
  .strict();

export const queuePositionPatchSchema = z
  .object({
    /** Job, hinter dem eingeordnet wird; null = an den Anfang. */
    afterJobId: z.string().min(1).nullable(),
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

export const assignedIssuesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const teamStatesQuerySchema = z.object({
  teamKey: z.string().trim().min(1).max(50),
});

export const worktreeRemoveSchema = z
  .object({
    projectId: z.string().min(1),
    path: z.string().min(1),
    jobId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type WorktreeRemoveInput = z.infer<typeof worktreeRemoveSchema>;

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ImportRequestInput = z.infer<typeof importRequestSchema>;
export type BulkImportRequestInput = z.infer<typeof bulkImportRequestSchema>;
export type TicketDescriptionUpdateInput = z.infer<typeof ticketDescriptionUpdateSchema>;
export type StatePatchInput = z.infer<typeof statePatchSchema>;
export type PlanApprovalInput = z.infer<typeof planApprovalSchema>;
export type DiffApprovalInput = z.infer<typeof diffApprovalSchema>;
export type RequestChangesInput = z.infer<typeof requestChangesSchema>;
export type RetryBodyInput = z.infer<typeof retryBodySchema>;
export type JobPriorityPatchInput = z.infer<typeof jobPriorityPatchSchema>;
export type QueuePositionPatchInput = z.infer<typeof queuePositionPatchSchema>;
export type JobCleanupInput = z.infer<typeof jobCleanupSchema>;

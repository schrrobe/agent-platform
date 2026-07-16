import { z } from 'zod';

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

const nonEmptyList = z.array(z.string().trim().min(1).max(2_000)).max(200);

export const planResultSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().trim().min(1).max(10_000),
    acceptanceCriteria: nonEmptyList.min(1),
    relevantFiles: nonEmptyList,
    steps: nonEmptyList.min(1),
    testStrategy: nonEmptyList.min(1),
    risks: nonEmptyList,
    riskLevel: riskLevelSchema,
    assumptions: nonEmptyList,
    nonGoals: nonEmptyList,
    questions: nonEmptyList,
  })
  .strict();
export type PlanResult = z.infer<typeof planResultSchema>;

export const implementationResultSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().trim().min(1).max(10_000),
    changedFiles: nonEmptyList,
    planDeviations: nonEmptyList,
    testsRun: nonEmptyList,
  })
  .strict();
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const githubReviewResultSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().trim().min(1).max(10_000),
    addressedThreadIds: z.array(z.string().trim().min(1).max(500)).max(200),
    unaddressed: z
      .array(
        z
          .object({
            threadId: z.string().trim().min(1).max(500),
            reason: z.string().trim().min(1).max(5_000),
          })
          .strict(),
      )
      .max(200),
    changedFiles: nonEmptyList,
    testsRun: nonEmptyList,
  })
  .strict();
export type GithubReviewResult = z.infer<typeof githubReviewResultSchema>;

export const reviewFindingSchema = z
  .object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    file: z.string().trim().max(2_000).nullable(),
    location: z.string().trim().max(2_000).nullable(),
    observation: z.string().trim().min(1).max(10_000),
    requiredFix: z.string().trim().min(1).max(10_000),
    verification: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const reviewResultSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(['PASS', 'FAIL']),
    summary: z.string().trim().min(1).max(10_000),
    findings: z.array(reviewFindingSchema).max(200),
    openAcceptanceCriteria: nonEmptyList,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.verdict === 'PASS' &&
      (value.findings.length > 0 || value.openAcceptanceCriteria.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'PASS darf keine Findings oder offenen Akzeptanzkriterien enthalten',
      });
    }
    if (
      value.verdict === 'FAIL' &&
      value.findings.length === 0 &&
      value.openAcceptanceCriteria.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'FAIL benötigt mindestens ein Finding oder offenes Akzeptanzkriterium',
      });
    }
  });
export type ReviewResult = z.infer<typeof reviewResultSchema>;

const stringArrayJsonSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
} as const;

export const PLAN_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'goal',
    'acceptanceCriteria',
    'relevantFiles',
    'steps',
    'testStrategy',
    'risks',
    'riskLevel',
    'assumptions',
    'nonGoals',
    'questions',
  ],
  properties: {
    version: { const: 1 },
    goal: { type: 'string', minLength: 1 },
    acceptanceCriteria: { ...stringArrayJsonSchema, minItems: 1 },
    relevantFiles: stringArrayJsonSchema,
    steps: { ...stringArrayJsonSchema, minItems: 1 },
    testStrategy: { ...stringArrayJsonSchema, minItems: 1 },
    risks: stringArrayJsonSchema,
    riskLevel: { enum: ['low', 'medium', 'high'] },
    assumptions: stringArrayJsonSchema,
    nonGoals: stringArrayJsonSchema,
    questions: stringArrayJsonSchema,
  },
} as const;

export const REVIEW_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'verdict', 'summary', 'findings', 'openAcceptanceCriteria'],
  properties: {
    version: { const: 1 },
    verdict: { enum: ['PASS', 'FAIL'] },
    summary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'location', 'observation', 'requiredFix', 'verification'],
        properties: {
          severity: { enum: ['low', 'medium', 'high', 'critical'] },
          file: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          observation: { type: 'string', minLength: 1 },
          requiredFix: { type: 'string', minLength: 1 },
          verification: { type: 'string', minLength: 1 },
        },
      },
    },
    openAcceptanceCriteria: stringArrayJsonSchema,
  },
} as const;

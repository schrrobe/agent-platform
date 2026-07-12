import type { AppDatabase } from './db.js';
import { ProjectsRepository } from './repositories/projects.js';
import { TicketsRepository } from './repositories/tickets.js';
import { JobsRepository } from './repositories/jobs.js';
import { JobEventsRepository } from './repositories/job-events.js';
import { AgentRunsRepository } from './repositories/agent-runs.js';
import { ArtifactsRepository } from './repositories/artifacts.js';
import { ReviewIterationsRepository } from './repositories/review-iterations.js';
import { TestRunsRepository } from './repositories/test-runs.js';
import { SettingsRepository } from './repositories/settings.js';

export * from './db.js';
export * from './migrate.js';
export * from './repositories/projects.js';
export * from './repositories/tickets.js';
export * from './repositories/jobs.js';
export * from './repositories/job-events.js';
export * from './repositories/agent-runs.js';
export * from './repositories/artifacts.js';
export * from './repositories/review-iterations.js';
export * from './repositories/test-runs.js';
export * from './repositories/settings.js';

export interface Repositories {
  projects: ProjectsRepository;
  tickets: TicketsRepository;
  jobs: JobsRepository;
  jobEvents: JobEventsRepository;
  agentRuns: AgentRunsRepository;
  artifacts: ArtifactsRepository;
  reviewIterations: ReviewIterationsRepository;
  testRuns: TestRunsRepository;
  settings: SettingsRepository;
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    projects: new ProjectsRepository(db),
    tickets: new TicketsRepository(db),
    jobs: new JobsRepository(db),
    jobEvents: new JobEventsRepository(db),
    agentRuns: new AgentRunsRepository(db),
    artifacts: new ArtifactsRepository(db),
    reviewIterations: new ReviewIterationsRepository(db),
    testRuns: new TestRunsRepository(db),
    settings: new SettingsRepository(db),
  };
}

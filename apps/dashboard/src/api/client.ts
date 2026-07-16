import type {
  Artifact,
  ImportRequestInput,
  JobDetail,
  GithubReviewActionResult,
  JobState,
  JobSummary,
  LogLine,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '@agent/shared';
import { isApiErrorBody } from '@agent/shared';

/** Fehler mit strukturiertem Backend-Code für gezielte UI-Behandlung. */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new ApiClientError('NETWORK', `Netzwerkfehler: ${(error as Error).message}`, 0);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(
        body.error.code,
        body.error.message,
        response.status,
        body.error.details,
      );
    }
    throw new ApiClientError('INTERNAL', `HTTP ${response.status}`, response.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),

  listProjects: () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects),
  createProject: (input: ProjectCreateInput) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.project),
  updateProject: (id: string, input: ProjectUpdateInput) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.project),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listJobs: () => request<{ jobs: JobSummary[] }>('/api/jobs').then((r) => r.jobs),
  getJob: (id: string) => request<{ job: JobDetail }>(`/api/jobs/${id}`).then((r) => r.job),
  importTicket: (input: ImportRequestInput) =>
    request<{ job: JobSummary }>('/api/jobs/import', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.job),
  startJob: (id: string) =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/start`, { method: 'POST' }).then((r) => r.job),
  pauseJob: (id: string) =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/pause`, { method: 'POST' }).then((r) => r.job),
  retryJob: (id: string) =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/retry`, { method: 'POST' }).then((r) => r.job),
  approvePlan: (id: string, note = '') =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/approve-plan`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }).then((r) => r.job),
  cancelJob: (id: string) =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/cancel`, { method: 'POST' }).then((r) => r.job),
  runGithubReview: (id: string) =>
    request<{ job: JobSummary; result: GithubReviewActionResult }>(
      `/api/jobs/${id}/github-review`,
      { method: 'POST' },
    ),
  patchState: (id: string, state: JobState) =>
    request<{ job: JobSummary }>(`/api/jobs/${id}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    }).then((r) => r.job),
  getLogs: (id: string, afterSeq?: number) =>
    request<{ logs: LogLine[] }>(
      `/api/jobs/${id}/logs${afterSeq ? `?afterSeq=${afterSeq}` : ''}`,
    ).then((r) => r.logs),
  getArtifacts: (id: string) =>
    request<{ artifacts: Artifact[] }>(`/api/jobs/${id}/artifacts`).then((r) => r.artifacts),
};

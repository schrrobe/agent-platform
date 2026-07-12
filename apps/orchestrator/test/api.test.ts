import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { LinearClientLike } from '@agent/linear';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function fakeLinear(): LinearClientLike {
  return {
    issue: vi.fn(async (id: string) => ({
      id: `uuid-${id}`,
      identifier: id,
      title: `Titel ${id}`,
      description: 'Beschreibung',
      url: `https://linear.app/x/${id}`,
      priority: 2,
      priorityLabel: 'High',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-02T00:00:00Z'),
      team: Promise.resolve({ key: 'APP', name: 'App' }),
      state: Promise.resolve({ name: 'Todo' }),
      labels: async () => ({ nodes: [{ name: 'bug' }] }),
    })),
  };
}

describe('REST API', () => {
  it('GET /api/health liefert ok', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('validiert Projekt-Anlage und lehnt Shell-Metazeichen in Befehlen ab', async () => {
    harness = await createHarness();
    const bad = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'X',
        repositoryPath: harness.repoDir,
        worktreeRoot: harness.worktreeRoot,
        commands: { test: 'pnpm test; rm -rf /' },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');

    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'X',
        repositoryPath: harness.repoDir,
        worktreeRoot: harness.worktreeRoot,
        commands: { test: 'pnpm test' },
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().project.id).toBeTruthy();
    expect(ok.json().project.autonomyMode).toBe('approve_plan');
    expect(ok.json().project.testExecutionMode).toBe('sandboxed');
  });

  it('lehnt Projekt mit nicht existierendem Repository-Pfad ab', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'X',
        repositoryPath: '/nicht/vorhanden/xyz',
        worktreeRoot: harness.worktreeRoot,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('importiert ein Linear-Ticket und legt einen inbox-Job an', async () => {
    harness = await createHarness({ linearClient: fakeLinear() });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/import',
      payload: { identifier: 'APP-42', projectId: harness.projectId },
    });
    expect(res.statusCode).toBe(201);
    const job = res.json().job;
    expect(job.ticket.identifier).toBe('APP-42');
    expect(job.state).toBe('inbox');

    const list = await harness.app.inject({ method: 'GET', url: '/api/jobs' });
    expect(list.json().jobs).toHaveLength(1);
  });

  it('lehnt Import mit ungültigem Identifier ab (Zod)', async () => {
    harness = await createHarness({ linearClient: fakeLinear() });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/import',
      payload: { identifier: '../../etc', projectId: harness.projectId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('lehnt unerlaubte manuelle Zustandswechsel mit 409 ab', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-9');
    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/state`,
      payload: { state: 'done' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('erlaubt manuellen Start inbox → agent_ready per PATCH', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-10');
    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/state`,
      payload: { state: 'agent_ready' },
    });
    expect(res.statusCode).toBe(200);
    // Danach terminiert der Lauf (Fake-Agenten) — abwarten, um sauber aufzuräumen.
    await harness.waitForState(job.id);
  });

  it('wartet bei konfigurierter Planfreigabe und setzt nach Zustimmung am Checkpoint fort', async () => {
    harness = await createHarness();
    harness.ctx.repos.projects.update(harness.projectId, { autonomyMode: 'approve_plan' });
    const job = harness.seedJob('APP-510');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id, ['awaiting_plan_approval'])).toBe(
      'awaiting_plan_approval',
    );
    expect(JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')).codex).toBeUndefined();

    const approval = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve-plan`,
      payload: { note: 'Annahme bestätigt.' },
    });
    expect(approval.statusCode).toBe(200);
    const resumed = await harness.waitForState(job.id, [
      'ready_for_human',
      'failed',
      'needs_human',
    ]);
    expect(resumed, harness.ctx.repos.jobs.get(job.id)?.lastError ?? '').toBe('ready_for_human');
    const finished = harness.ctx.repos.jobs.get(job.id)!;
    expect(finished.planApprovedAt).not.toBeNull();
    expect(
      harness.ctx.repos.artifacts
        .listByJob(job.id)
        .some((artifact) => artifact.type === 'approval'),
    ).toBe(true);
  });

  it('trennt Agentenfertigstellung von menschlich bestätigtem done', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-511');
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['ready_for_human']);
    const done = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/state`,
      payload: { state: 'done' },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().job.state).toBe('done');
  });

  it('liefert 404 für unbekannte Jobs und 400 für ungültigen Ziel-Zustand', async () => {
    harness = await createHarness();
    expect((await harness.app.inject({ method: 'GET', url: '/api/jobs/nope' })).statusCode).toBe(
      404,
    );
    const job = harness.seedJob('APP-11');
    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/state`,
      payload: { state: 'not_a_state' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('gibt Logs und Artefakte eines Jobs zurück', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-12');
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['ready_for_human']);

    const logs = await harness.app.inject({ method: 'GET', url: `/api/jobs/${job.id}/logs` });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs.length).toBeGreaterThan(0);

    const artifacts = await harness.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/artifacts`,
    });
    expect(artifacts.json().artifacts.some((a: { type: string }) => a.type === 'plan')).toBe(true);

    const detail = await harness.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` });
    expect(detail.json().job.reviewIterations.at(-1).verdict).toBe('PASS');
  });
});

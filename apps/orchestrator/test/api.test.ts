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
    updateIssue: vi.fn(async () => ({ success: true })),
  };
}

describe('REST API', () => {
  it('GET /api/health liefert ok', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('listet Git-Repositories aus der konfigurierten Repository-Wurzel', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/api/repositories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      root: harness.tmp,
      repositories: [{ name: 'repo', path: harness.repoDir }],
    });
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

  it('liefert den über den nativen Dialog ausgewählten Ordner', async () => {
    harness = await createHarness({ directoryPicker: async () => harness!.repoDir });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/pick-directory',
      payload: { kind: 'repository' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: harness.repoDir, cancelled: false });
  });

  it('meldet einen abgebrochenen Ordnerdialog ohne Fehler', async () => {
    harness = await createHarness({ directoryPicker: async () => null });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/pick-directory',
      payload: { kind: 'worktree' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: null, cancelled: true });
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

  it('importiert mehrere Linear-Tickets in dasselbe Projekt', async () => {
    harness = await createHarness({ linearClient: fakeLinear() });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/import-bulk',
      payload: { identifiers: ['APP-41', 'APP-42', 'app-41'], projectId: harness.projectId },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().result.jobs).toHaveLength(2);
    expect(res.json().result.failures).toEqual([]);
    expect(
      res
        .json()
        .result.jobs.every((job: { projectId: string }) => job.projectId === harness!.projectId),
    ).toBe(true);
  });

  it('meldet Fehler beim Mehrfachimport einzeln und behält erfolgreiche Tickets', async () => {
    const client = fakeLinear();
    client.issue = vi.fn(async (id: string) => {
      if (id === 'APP-404') throw new Error('Entity not found');
      return {
        id: `uuid-${id}`,
        identifier: id,
        title: `Titel ${id}`,
        description: 'Beschreibung',
        url: `https://linear.app/x/${id}`,
      };
    });
    harness = await createHarness({ linearClient: client });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/import-bulk',
      payload: { identifiers: ['APP-1', 'APP-404'], projectId: harness.projectId },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().result.jobs).toHaveLength(1);
    expect(res.json().result.failures).toMatchObject([{ identifier: 'APP-404' }]);
  });

  it('aktualisiert eine Ticketbeschreibung lokal und in Linear', async () => {
    const updateIssue = vi.fn(async () => ({ success: true }));
    const client = { ...fakeLinear(), updateIssue };
    harness = await createHarness({ linearClient: client });
    const job = harness.seedJob('APP-44');

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/ticket-description`,
      payload: { description: 'Neue **Beschreibung**' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job.ticket.description).toBe('Neue **Beschreibung**');
    expect(updateIssue).toHaveBeenCalledWith('lin-APP-44', {
      description: 'Neue **Beschreibung**',
    });
  });

  it('gruppiert mehrere Inbox-Jobs zu einem Vorgang', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-1');
    const b = harness.seedJob('APP-2');
    const c = harness.seedJob('APP-3');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/group',
      payload: { jobIds: [a.id, b.id, c.id] },
    });

    expect(res.statusCode).toBe(200);
    const job = res.json().job;
    expect(job.additionalTickets).toHaveLength(2);

    // Aus drei Jobs wird einer.
    const list = await harness.app.inject({ method: 'GET', url: '/api/jobs' });
    expect(list.json().jobs).toHaveLength(1);
    expect(list.json().jobs[0].additionalTickets).toHaveLength(2);
  });

  it('lehnt Gruppierung ab, wenn ein Job nicht im Inbox ist', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-1');
    const b = harness.seedJob('APP-2');
    harness.ctx.repos.jobs.update(b.id, { state: 'planning' });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/group',
      payload: { jobIds: [a.id, b.id] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('lehnt Gruppierung mit weniger als zwei Jobs ab', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-1');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/group',
      payload: { jobIds: [a.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('löst ein Ticket wieder aus einem Vorgang und legt einen neuen Inbox-Job an', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-1');
    const b = harness.seedJob('APP-2');
    const grouped = await harness.app.inject({
      method: 'POST',
      url: '/api/jobs/group',
      payload: { jobIds: [a.id, b.id] },
    });
    const survivor = grouped.json().job;
    const secondaryTicketId = survivor.additionalTickets[0].id;

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${survivor.id}/ungroup`,
      payload: { ticketId: secondaryTicketId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job.additionalTickets).toHaveLength(0);
    expect(res.json().newJob.state).toBe('inbox');
    expect(res.json().newJob.ticket.id).toBe(secondaryTicketId);

    const list = await harness.app.inject({ method: 'GET', url: '/api/jobs' });
    expect(list.json().jobs).toHaveLength(2);
  });

  it('behält die lokale Beschreibung bei, wenn Linear das Update ablehnt', async () => {
    const client = {
      ...fakeLinear(),
      updateIssue: vi.fn(async () => ({ success: false })),
    };
    harness = await createHarness({ linearClient: client });
    const job = harness.seedJob('APP-45');

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${job.id}/ticket-description`,
      payload: { description: 'Nicht gespeichert' },
    });

    expect(res.statusCode).toBe(502);
    expect(harness.ctx.repos.tickets.get(job.ticket.id)?.description).toBe('Test');
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

  it('setzt einen inaktiven Job vollständig auf Inbox zurück', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-701');
    harness.ctx.repos.jobs.update(job.id, { state: 'failed', lastError: 'Testfehler' });
    harness.ctx.repos.agentRuns.insert({ jobId: job.id, phase: 'plan', agent: 'claude' });
    harness.ctx.repos.testRuns.insert({
      jobId: job.id,
      iteration: 1,
      commandKey: 'test',
      command: 'pnpm test',
    });
    harness.ctx.logStore.append(job.id, {
      ts: new Date().toISOString(),
      source: 'system',
      stream: 'stderr',
      text: 'alt',
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/reset`,
      payload: { removeWorktree: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.state).toBe('inbox');
    expect(harness.ctx.repos.agentRuns.listByJob(job.id)).toHaveLength(0);
    expect(harness.ctx.repos.testRuns.listByJob(job.id)).toHaveLength(0);
    expect(harness.ctx.logStore.read(job.id)).toHaveLength(1);
    expect(harness.ctx.logStore.read(job.id)[0]?.text).toContain('zurückgesetzt');
  });

  it('löscht einen inaktiven Job und dessen nicht mehr verwendetes Ticket', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-702');
    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${job.id}`,
      payload: { removeWorktree: false },
    });
    expect(res.statusCode).toBe(204);
    expect(harness.ctx.repos.jobs.get(job.id)).toBeUndefined();
    expect(harness.ctx.repos.tickets.get(job.ticket.id)).toBeUndefined();
    expect(harness.ctx.logStore.read(job.id)).toHaveLength(0);
  });

  it('verweigert Reset und Löschung eines aktiven Jobs', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-703');
    harness.ctx.repos.jobs.update(job.id, { state: 'planning', currentAgent: 'claude' });

    const reset = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/reset`,
      payload: { removeWorktree: false },
    });
    const deletion = await harness.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${job.id}`,
      payload: { removeWorktree: false },
    });
    expect(reset.statusCode).toBe(409);
    expect(deletion.statusCode).toBe(409);
    expect(harness.ctx.repos.jobs.get(job.id)).toBeDefined();
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

  it('hält im Modus approve_diff am Diff-Gate und setzt nach Freigabe fort', async () => {
    harness = await createHarness({ reviewSequence: 'PASS', autonomyMode: 'approve_diff' });
    const job = harness.seedJob('APP-520');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id, ['awaiting_diff_approval'])).toBe(
      'awaiting_diff_approval',
    );
    expect(
      harness.ctx.repos.artifacts.listByJob(job.id).some((a) => a.type === 'diff'),
    ).toBe(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve-diff`,
      payload: { note: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(await harness.waitForState(job.id, ['ready_for_human', 'failed', 'needs_human'])).toBe(
      'ready_for_human',
    );
  });

  it('schickt ready_for_human per request-changes mit Feedback zurück in die Nacharbeit', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-521');
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['ready_for_human']);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/request-changes`,
      payload: { note: 'Bitte Fehlerbehandlung ergänzen.' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      harness.ctx.repos.artifacts.listByJob(job.id).some((a) => a.type === 'human_feedback'),
    ).toBe(true);
    await harness.waitForState(job.id, ['ready_for_human', 'failed', 'needs_human']);
  });

  it('lehnt request-changes ohne Note (400) und approve-diff aus falschem Zustand (409) ab', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-522');
    harness.ctx.repos.jobs.update(job.id, { state: 'ready_for_human', finishedAt: new Date().toISOString() });

    const noNote = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/request-changes`,
      payload: { note: '' },
    });
    expect(noNote.statusCode).toBe(400);

    const wrongState = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve-diff`,
      payload: { note: '' },
    });
    expect(wrongState.statusCode).toBe(409);
  });

  it('akzeptiert Retry-Feedback nur aus needs_human', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-523');
    harness.ctx.repos.jobs.update(job.id, { state: 'failed', lastError: 'x' });
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/retry`,
      payload: { note: 'geht nicht' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('ordnet wartende Jobs manuell um (Drop an den Anfang)', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-530');
    const b = harness.seedJob('APP-531');

    const reorder = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${b.id}/queue-position`,
      payload: { afterJobId: null },
    });
    expect(reorder.statusCode).toBe(200);
    expect(harness.ctx.repos.jobs.listByStateOrdered('inbox').map((j) => j.id)).toEqual([
      b.id,
      a.id,
    ]);
  });

  it('priorisiert höhere Queue-Priorität vor der manuellen Reihenfolge', async () => {
    harness = await createHarness();
    const a = harness.seedJob('APP-532');
    const b = harness.seedJob('APP-533');
    const prio = await harness.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${b.id}/priority`,
      payload: { priority: 1 },
    });
    expect(prio.statusCode).toBe(200);
    // b hat höhere Priorität → trotz späterer Insert-Zeit zuerst.
    expect(harness.ctx.repos.jobs.listByStateOrdered('inbox').map((j) => j.id)).toEqual([
      b.id,
      a.id,
    ]);
  });

  it('setzt die Parallelität über die Settings-Route', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { maxConcurrentJobs: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxConcurrentJobs).toBe(3);
    expect(harness.ctx.config.limits.maxConcurrentJobs).toBe(3);
  });

  it('listet Worktrees für die Wartung', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/api/maintenance/worktrees' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().worktrees)).toBe(true);
  });
});

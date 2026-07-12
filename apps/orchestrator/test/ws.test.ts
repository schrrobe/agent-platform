import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { AnyWsEnvelope } from '@agent/shared';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function connect(harness: Harness): Promise<{ socket: WebSocket; events: AnyWsEnvelope[] }> {
  await harness.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = harness.app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: AnyWsEnvelope[] = [];
  socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return { socket, events };
}

describe('WebSocket-Hub', () => {
  it('sendet ein hello mit aktuellem Sequenzstand nach Connect', async () => {
    harness = await createHarness();
    const { socket, events } = await connect(harness);
    await new Promise((r) => setTimeout(r, 50));
    expect(events[0]?.type).toBe('hello');
    expect(typeof events[0]?.payload).toBe('object');
    socket.close();
  });

  it('streamt Job-Events live und vergibt monotone Sequenz-IDs', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const { socket, events } = await connect(harness);
    const job = harness.seedJob('APP-301');
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['done']);
    await new Promise((r) => setTimeout(r, 50));

    const types = events.map((e) => e.type);
    expect(types).toContain('job.state_changed');
    expect(types).toContain('agent.started');
    expect(types).toContain('review.passed');

    const seqs = events.filter((e) => e.seq !== null).map((e) => e.seq as number);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);

    const stateChange = events.find((e) => e.type === 'job.state_changed');
    expect(stateChange?.jobId).toBe(job.id);
    socket.close();
  });
});

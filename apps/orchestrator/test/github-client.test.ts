import { describe, expect, it } from 'vitest';
import type { ProcessHandle, ProcessResult, ProcessRunner, ProcessSpec } from '@agent/shared';
import { GithubCliClient } from '../src/services/github-client.js';

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    canceled: false,
    truncated: false,
    durationMs: 1,
    ...overrides,
  };
}

class QueueRunner implements ProcessRunner {
  readonly calls: ProcessSpec[] = [];

  constructor(private readonly results: ProcessResult[]) {}

  run(spec: ProcessSpec): ProcessHandle {
    this.calls.push(spec);
    const next = this.results.shift();
    if (!next) throw new Error(`Kein Fake-Ergebnis für ${spec.command} ${spec.args.join(' ')}`);
    return { pid: undefined, pgid: undefined, result: Promise.resolve(next), cancel() {} };
  }
}

describe('GithubCliClient', () => {
  it('liest Review-Threads und pusht ausschließlich auf den exakten Upstream', async () => {
    const branch = 'fix/app-42/abc';
    const runner = new QueueRunner([
      result({
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/acme/demo/pull/42',
          state: 'OPEN',
          headRefName: branch,
        }),
      }),
      result({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'THREAD_1',
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/a.ts',
                      line: 9,
                      comments: {
                        nodes: [
                          {
                            author: { login: 'reviewer' },
                            body: 'Bitte korrigieren.',
                            url: 'https://github.com/acme/demo/pull/42#discussion_r1',
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: 'COMMENT_CURSOR' },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      }),
      result({
        stdout: JSON.stringify({
          data: {
            node: {
              comments: {
                nodes: [
                  {
                    author: { login: 'author' },
                    body: 'Antwort nach Kommentar 100.',
                    url: 'https://github.com/acme/demo/pull/42#discussion_r101',
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      }),
      result({ stdout: JSON.stringify({ data: { resolveReviewThread: { thread: {} } } }) }),
      result({ stdout: `${branch}\n` }),
      result({ stdout: 'origin\n' }),
      result({ stdout: `refs/heads/${branch}\n` }),
      result(),
      result({ stdout: '0 1\n' }),
      result(),
      result({ stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' }),
      result({
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/fix/app-42/abc\n',
      }),
    ]);
    const client = new GithubCliClient(runner, { PATH: '/usr/bin' });

    const pr = await client.findPullRequest('/repo', branch);
    const threads = await client.listReviewThreads(pr, '/repo');
    await client.resolveReviewThread('THREAD_1', '/repo');
    await client.pushUpstream('/repo', branch);

    expect(pr).toMatchObject({ repository: 'acme/demo', number: 42, headRefName: branch });
    expect(threads).toEqual([
      {
        id: 'THREAD_1',
        isResolved: false,
        isOutdated: false,
        path: 'src/a.ts',
        line: 9,
        comments: [
          {
            author: 'reviewer',
            body: 'Bitte korrigieren.',
            url: 'https://github.com/acme/demo/pull/42#discussion_r1',
          },
          {
            author: 'author',
            body: 'Antwort nach Kommentar 100.',
            url: 'https://github.com/acme/demo/pull/42#discussion_r101',
          },
        ],
      },
    ]);
    expect(runner.calls.find((call) => call.args.includes('push'))?.args).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--porcelain',
      'origin',
      `HEAD:refs/heads/${branch}`,
    ]);
  });
});

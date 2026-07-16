import type { ProcessResult, ProcessRunner } from '@agent/shared';
import type { GithubReviewThreadData } from '@agent/agents';

export interface GithubPullRequest {
  repository: string;
  owner: string;
  name: string;
  number: number;
  url: string;
  headRefName: string;
}

export interface GithubReviewThread extends GithubReviewThreadData {
  isResolved: boolean;
}

export interface GithubClientLike {
  findPullRequest(cwd: string, branch: string, signal?: AbortSignal): Promise<GithubPullRequest>;
  listReviewThreads(
    pr: GithubPullRequest,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubReviewThread[]>;
  resolveReviewThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  /** Synchronisiert und verifiziert den Upstream; true, wenn tatsächlich gepusht wurde. */
  pushUpstream(cwd: string, branch: string, signal?: AbortSignal): Promise<boolean>;
}

export class GithubClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GithubClientError';
  }
}

const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { author { login } body url }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query ThreadComments($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        nodes { author { login } body url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GithubClientError(`Ungültige GitHub-Antwort: ${label}`);
  }
  return value as Record<string, unknown>;
}

export class GithubCliClient implements GithubClientLike {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly env: Record<string, string>,
    private readonly timeoutMs = 120_000,
  ) {}

  private async run(
    command: string,
    args: string[],
    cwd: string,
    allowFailure = false,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (signal?.aborted) throw new GithubClientError('GitHub-Aktion wurde abgebrochen');
    const handle = this.runner.run({
      command,
      args,
      cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const onAbort = () => handle.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    let result;
    try {
      result = await handle.result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw new GithubClientError('GitHub-Aktion wurde abgebrochen');
    if (!allowFailure && result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `Exit ${result.exitCode}`;
      throw new GithubClientError(`${command} fehlgeschlagen: ${detail.slice(-2_000)}`);
    }
    if (result.truncated) throw new GithubClientError(`${command}-Ausgabe wurde gekappt`);
    return result;
  }

  private async gh(args: string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
    const result = await this.run('gh', args, cwd, false, signal);
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new GithubClientError(
        `GitHub-Antwort ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async findPullRequest(
    cwd: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GithubPullRequest> {
    const prData = object(
      await this.gh(['pr', 'view', branch, '--json', 'number,url,state,headRefName'], cwd, signal),
      'Pull Request',
    );
    if (
      typeof prData.number !== 'number' ||
      typeof prData.url !== 'string' ||
      typeof prData.headRefName !== 'string' ||
      prData.state !== 'OPEN' ||
      prData.headRefName !== branch
    ) {
      throw new GithubClientError(`Kein offener Pull Request für Branch ${branch} gefunden`);
    }
    let owner: string;
    let name: string;
    try {
      const segments = new URL(prData.url).pathname.split('/').filter(Boolean);
      [owner, name] = segments;
      if (!owner || !name || segments[2] !== 'pull') throw new Error('unerwarteter PR-Pfad');
    } catch (error) {
      throw new GithubClientError(`Ungültige Pull-Request-URL: ${prData.url}`, { cause: error });
    }
    return {
      repository: `${owner}/${name}`,
      owner,
      name,
      number: prData.number,
      url: prData.url,
      headRefName: prData.headRefName,
    };
  }

  async listReviewThreads(
    pr: GithubPullRequest,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubReviewThread[]> {
    const threads: GithubReviewThread[] = [];
    let cursor: string | undefined;
    do {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${REVIEW_THREADS_QUERY}`,
        '-F',
        `owner=${pr.owner}`,
        '-F',
        `name=${pr.name}`,
        '-F',
        `number=${pr.number}`,
      ];
      if (cursor) args.push('-F', `cursor=${cursor}`);
      const root = object(await this.gh(args, cwd, signal), 'GraphQL');
      const data = object(root.data, 'data');
      const repository = object(data.repository, 'repository');
      const pullRequest = object(repository.pullRequest, 'pullRequest');
      const connection = object(pullRequest.reviewThreads, 'reviewThreads');
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
      for (const rawNode of nodes) {
        const node = object(rawNode, 'reviewThread');
        if (typeof node.id !== 'string') continue;
        const commentsConnection = object(node.comments, 'comments');
        const comments = this.parseComments(commentsConnection, pr.url);
        const commentsPageInfo = object(commentsConnection.pageInfo, 'comments.pageInfo');
        let commentsCursor =
          commentsPageInfo.hasNextPage === true && typeof commentsPageInfo.endCursor === 'string'
            ? commentsPageInfo.endCursor
            : undefined;
        while (commentsCursor) {
          const page = await this.fetchThreadComments(node.id, commentsCursor, pr.url, cwd, signal);
          comments.push(...page.comments);
          commentsCursor = page.cursor;
        }
        threads.push({
          id: node.id,
          isResolved: node.isResolved === true,
          isOutdated: node.isOutdated === true,
          path: typeof node.path === 'string' ? node.path : null,
          line: typeof node.line === 'number' ? node.line : null,
          comments,
        });
      }
      const pageInfo = object(connection.pageInfo, 'pageInfo');
      cursor =
        pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string'
          ? pageInfo.endCursor
          : undefined;
    } while (cursor);
    return threads;
  }

  private parseComments(
    connection: Record<string, unknown>,
    fallbackUrl: string,
  ): GithubReviewThread['comments'] {
    const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
    return nodes.map((rawComment) => {
      const comment = object(rawComment, 'comment');
      const author =
        typeof comment.author === 'object' && comment.author !== null
          ? (comment.author as Record<string, unknown>).login
          : null;
      return {
        author: typeof author === 'string' ? author : 'ghost',
        body: typeof comment.body === 'string' ? comment.body : '',
        url: typeof comment.url === 'string' ? comment.url : fallbackUrl,
      };
    });
  }

  private async fetchThreadComments(
    threadId: string,
    cursor: string,
    fallbackUrl: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ comments: GithubReviewThread['comments']; cursor: string | undefined }> {
    const root = object(
      await this.gh(
        [
          'api',
          'graphql',
          '-f',
          `query=${THREAD_COMMENTS_QUERY}`,
          '-F',
          `threadId=${threadId}`,
          '-F',
          `cursor=${cursor}`,
        ],
        cwd,
        signal,
      ),
      'GraphQL',
    );
    const data = object(root.data, 'data');
    const node = object(data.node, 'thread');
    const connection = object(node.comments, 'comments');
    const pageInfo = object(connection.pageInfo, 'comments.pageInfo');
    return {
      comments: this.parseComments(connection, fallbackUrl),
      cursor:
        pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string'
          ? pageInfo.endCursor
          : undefined,
    };
  }

  async resolveReviewThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    await this.gh(
      ['api', 'graphql', '-f', `query=${RESOLVE_THREAD_MUTATION}`, '-F', `threadId=${threadId}`],
      cwd,
      signal,
    );
  }

  async pushUpstream(cwd: string, branch: string, signal?: AbortSignal): Promise<boolean> {
    const actual = await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, false, signal);
    if (actual.stdout.trim() !== branch) {
      throw new GithubClientError(
        `Worktree steht auf Branch ${actual.stdout.trim() || '(unbekannt)'}, erwartet ${branch}`,
      );
    }
    const remote = await this.run(
      'git',
      ['config', '--get', `branch.${branch}.remote`],
      cwd,
      true,
      signal,
    );
    const merge = await this.run(
      'git',
      ['config', '--get', `branch.${branch}.merge`],
      cwd,
      true,
      signal,
    );
    const remoteName = remote.stdout.trim();
    const remoteRef = merge.stdout.trim();
    if (
      remote.exitCode !== 0 ||
      merge.exitCode !== 0 ||
      !remoteName ||
      remoteName === '.' ||
      !remoteRef
    ) {
      throw new GithubClientError(
        `Branch ${branch} besitzt keinen Upstream; vor der GitHub-Nacharbeit einmal mit -u pushen`,
      );
    }
    if (remoteRef !== `refs/heads/${branch}`) {
      throw new GithubClientError(
        `Upstream ${remoteName}/${remoteRef} zeigt nicht auf den aktuellen Branch ${branch}`,
      );
    }

    await this.run('git', ['fetch', '--no-tags', remoteName], cwd, false, signal);
    const divergence = await this.run(
      'git',
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      cwd,
      false,
      signal,
    );
    const [behindText, aheadText] = divergence.stdout.trim().split(/\s+/);
    const behind = Number(behindText);
    const ahead = Number(aheadText);
    if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
      throw new GithubClientError(
        `Git-Divergenz ist nicht auswertbar: ${divergence.stdout.trim()}`,
      );
    }
    if (behind > 0) {
      throw new GithubClientError(
        `Lokaler Branch liegt ${behind} Commit(s) hinter dem Upstream; kein automatischer Push`,
      );
    }
    if (ahead > 0) {
      await this.run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', remoteName, `HEAD:${remoteRef}`],
        cwd,
        false,
        signal,
      );
    }
    const [localHead, remoteHead] = await Promise.all([
      this.run('git', ['rev-parse', 'HEAD'], cwd, false, signal),
      this.run('git', ['ls-remote', '--heads', remoteName, remoteRef], cwd, false, signal),
    ]);
    const remoteSha = remoteHead.stdout.trim().split(/\s+/)[0];
    if (!remoteSha || remoteSha !== localHead.stdout.trim()) {
      throw new GithubClientError(
        'Upstream stimmt nach dem Push nicht mit dem lokalen HEAD überein',
      );
    }
    return ahead > 0;
  }
}

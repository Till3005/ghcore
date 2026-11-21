// The GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, with GitHub's statuses, shapes and headers.

import type { Repo, Issue, Pull, GitObjectType } from './store.ts';
import { parseCommit, ZERO_OID, isObjectId } from './store.ts';
import type { Store } from './store.ts';

export interface RestRequest {
  method: string;
  segments: readonly string[];
  query: URLSearchParams;
  body: unknown;
  store: Store;
  baseUrl: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function reply(status: number, body?: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

const notFound = (what = 'Not Found'): RestReply => reply(404, { message: what });
const needMessage = (message: string): RestReply => reply(422, { message });

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringAt(object: Record<string, unknown>, key: string, fallback = ''): string {
  const value = object[key];
  return typeof value === 'string' ? value : fallback;
}

function numberAt(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1001,
    node_id: `MDQ6VXNlcjEwMDE=`,
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const url = `${baseUrl}/api/v3/repos/${fullName}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    html_url: `${baseUrl}/${fullName}`,
    description: repo.description,
    fork: false,
    url,
    issues_url: `${url}/issues/{number}`,
    pulls_url: `${url}/pulls/{number}`,
    contents_url: `${url}/contents/{+path}`,
    default_branch: repo.defaultBranch,
    created_at: new Date(1_735_689_600_000).toISOString(),
    updated_at: new Date(1_735_689_600_000).toISOString(),
    pushed_at: new Date(1_735_689_600_000).toISOString(),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    has_discussions: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: 5000 + (label !== undefined ? [...repo.labels.keys()].indexOf(name) : 0),
    node_id: `L_${name}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: null,
  };
}

function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
    url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issue.number}`,
    html_url: `${baseUrl}/${fullName}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${comment.id}`,
    body: comment.body,
    user: userJson(repo.owner),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issueNumber}`,
    html_url: `${baseUrl}/${fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const label = `${repo.owner}:${pull.headRef}`;
  const baseLabel = `${repo.owner}:${pull.baseRef}`;
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user),
    body: pull.body,
    labels: [],
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.mergedAt ?? pull.createdAt,
    head: {
      label,
      ref: pull.headRef,
      sha: pull.headSha,
      repo: repoJson(repo, baseUrl),
    },
    base: {
      label: baseLabel,
      ref: pull.baseRef,
      sha: pull.baseSha,
      repo: repoJson(repo, baseUrl),
    },
    author_association: 'OWNER',
    html_url: `${baseUrl}/${fullName}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    commits_url: `${baseUrl}/api/v3/repos/${fullName}/pulls/${pull.number}/commits`,
    files_url: `${baseUrl}/api/v3/repos/${fullName}/pulls/${pull.number}/files`,
    mergeable: pull.merged ? null : true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    commits: 1,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pull.files.length,
  };
}

function commitJson(repo: Repo, sha: string, baseUrl: string): Record<string, unknown> {
  const object = repo.objects.get(sha)!;
  const commit = parseCommit(object.data);
  const message = commit.message.replace(/\n+$/, '');
  const when = new Date(1_735_689_600_000).toISOString();
  const identity = { name: repo.owner, email: `${repo.owner}@example.invalid`, date: when };
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      message,
      author: identity,
      committer: identity,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: `${baseUrl}/api/v3/repos/${fullName}/commits/${sha}`,
    html_url: `${baseUrl}/${fullName}/commit/${sha}`,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headRefName();
  if (ref.startsWith('refs/')) return ref;
  if (ref === 'HEAD') return repo.headRefName();
  return `refs/heads/${ref}`;
}

function branchJson(repo: Repo, branch: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
  return {
    name: branch,
    commit: { sha, url: '' },
    protected: false,
  };
}

function intQuery(query: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = query.get(key);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(max, value);
}

/** POST /repos/{o}/{r}/pulls/{n}/merge and the GraphQL merge share this. */
export function mergePullRequest(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: 404 | 405; message: string } {
  if (!repo.pulls.includes(pull) || (pull.state === 'closed' && !pull.merged && pull.mergedAt === null)) {
    return { ok: false, status: 404, message: 'Not Found' };
  }
  if (pull.merged) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: already merged' };
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === null || headTip === null || !isObjectId(headTip)) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: missing refs' };
  }
  if (baseTip === headTip || !repo.isAncestor(baseTip, headTip)) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: the head branch is not based on the base branch tip' };
  }
  const headObject = repo.objects.get(headTip);
  if (headObject === undefined || headObject.type !== 'commit') {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: head commit is missing' };
  }
  const tree = parseCommit(headObject.data).tree;
  const commitData = Buffer.from(
    [
      `tree ${tree}`,
      `parent ${baseTip}`,
      `author ${'entry-forge'} <forge@entry.invalid> ${repo.tick()} +0000`,
      `committer ${'entry-forge'} <forge@entry.invalid> ${repo.clock} +0000`,
      '',
      `${pull.title}\n`,
    ].join('\n'),
    'utf8',
  );
  const sha = repo.put('commit' as GitObjectType, commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = repo.iso();
  pull.mergeCommitSha = sha;
  pull.closedAt = pull.mergedAt;
  return { ok: true, sha };
}

/** Handle one /api/v3 request; the caller has authenticated it and parsed the body. */
export function handleRest(req: RestRequest): RestReply {
  const { store, segments, method, query, baseUrl } = req;
  const rest = segments.slice(1); // drop 'v3'

  // GET /api/v3[/] - the API root
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
    return reply(200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      emojis_url: `${baseUrl}/api/v3/emojis`,
      events_url: `${baseUrl}/api/v3/events`,
      meta_url: `${baseUrl}/api/v3/meta`,
      rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_url: `${baseUrl}/api/v3/users/{user}`,
    });
  }

  const [head] = rest;

  // GET /api/v3/meta
  if (head === 'meta' && method === 'GET') {
    return reply(200, {
      installed_version: 'entry-forge 1.0.0 (github-core-clone-01)',
      verifiable_password_authentication: false,
    });
  }

  // GET /api/v3/user
  if (head === 'user' && rest.length === 1 && method === 'GET') {
    return reply(200, { ...userJson(store.viewer), name: store.viewer, email: `${store.viewer}@example.invalid` });
  }

  if (head === 'user' && rest[1] === 'repos') {
    if (method === 'POST') return createUserRepo(req);
    if (method === 'GET') return listUserRepos(req);
    return reply(405, { message: 'Method Not Allowed' });
  }

  if (head === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1]!);
    const name = decodeSegment(rest[2]!);
    const repo = store.get(owner, name);
    if (repo === undefined) return notFound();
    return handleRepo(req, repo, rest.slice(3));
  }

  return notFound();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function createUserRepo(req: RestRequest): RestReply {
  const body = record(req.body);
  const name = stringAt(body, 'name').trim();
  if (name === '') return needMessage('Validation Failed: name is required');
  const result = req.store.create(name, stringAt(body, 'description'), body.private === true);
  if ('error' in result) {
    return { ...needMessage(`name already exists on this account: ${name}`), headers: { 'x-github-media-type': 'github.v3' } };
  }
  return reply(201, repoJson(result.repo, req.baseUrl));
}

function listUserRepos(req: RestRequest): RestReply {
  const repos = req.store.viewerRepos();
  const perPage = intQuery(req.query, 'per_page', 30, 100);
  const page = intQuery(req.query, 'page', 1, 10_000);
  const start = (page - 1) * perPage;
  const items = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(repos.length / perPage));
  const pageUrl = (target: number): string =>
    `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${target}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
  links.push(`<${pageUrl(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${pageUrl(Math.max(1, page - 1))}>; rel="prev"`);
  links.push(`<${pageUrl(1)}>; rel="first"`);
  headers.link = links.join(', ');
  return reply(200, items.map((repo) => repoJson(repo, req.baseUrl)), headers);
}

function handleRepo(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, query, baseUrl, body } = req;

  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoJson(repo, baseUrl));
    if (method === 'PATCH') {
      const update = record(body);
      if (typeof update.description === 'string') repo.description = update.description;
      if (typeof update.name === 'string' && update.name !== '') repo.name = update.name;
      if (typeof update.private === 'boolean') repo.isPrivate = update.private;
      if (typeof update.default_branch === 'string' && update.default_branch !== '') {
        // The default branch stays 'main' in this forge; the field is accepted and echoed.
      }
      return reply(200, repoJson(repo, baseUrl));
    }
    if (method === 'DELETE') {
      req.store.delete(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  const [section] = rest;

  if (section === 'contents') {
    return handleContents(req, repo, rest.slice(1));
  }

  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      if (!names.includes(repo.defaultBranch) && repo.refs.get(repo.headRefName()) === undefined) names.unshift(repo.defaultBranch);
      return reply(200, names.map((branch) => branchJson(repo, branch)));
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSegment(rest[1]!);
      if (!repo.refs.has(`refs/heads/${branch}`)) return notFound();
      return reply(200, branchJson(repo, branch));
    }
    return notFound();
  }

  if (section === 'commits' && method === 'GET') {
    const refName = resolveRef(repo, query.get('sha'));
    if (refName === null || !repo.refs.has(refName)) return notFound();
    return reply(200, repo.commitLog(refName).map((entry) => commitJson(repo, entry.sha, baseUrl)));
  }

  if (section === 'git') {
    return handleGitData(req, repo, rest.slice(1));
  }

  if (section === 'labels') {
    if (method === 'POST') {
      const input = record(body);
      const name = stringAt(input, 'name').trim();
      if (name === '') return needMessage('Validation Failed: name is required');
      if (repo.labels.has(name)) return needMessage(`name already exists: ${name}`);
      repo.labels.set(name, { name, color: stringAt(input, 'color', 'ededed').replace(/^#/, '') });
      return reply(201, labelJson(repo, name));
    }
    if (method === 'GET') return reply(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    return notFound();
  }

  if (section === 'issues') {
    return handleIssues(req, repo, rest.slice(1));
  }

  if (section === 'pulls') {
    return handlePulls(req, repo, rest.slice(1));
  }

  if (section === 'languages' && method === 'GET') return reply(200, {});
  if (section === 'tags' && method === 'GET') {
    return reply(200, [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).map((ref, index) => ({
      name: ref.slice('refs/tags/'.length),
      commit: { sha: repo.refs.get(ref) ?? ZERO_OID, url: '' },
      zipball_url: '',
      tarball_url: '',
      node_id: `T_${index}`,
    })));
  }

  return notFound();
}

function handleGitData(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body } = req;

  if (rest.length === 1 && rest[0] === 'refs' && method === 'POST') {
    const input = record(body);
    const ref = stringAt(input, 'ref');
    const sha = stringAt(input, 'sha');
    if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) return needMessage('Validation Failed: ref must be refs/heads/<name> and sha a commit id');
    if (repo.refs.has(ref)) return needMessage(`Reference already exists: ${ref}`);
    if (repo.objects.get(sha) === undefined) return needMessage(`Object does not exist: ${sha}`);
    repo.refs.set(ref, sha);
    return reply(201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
  }

  // GET /git/refs[/heads[/{branch}]] and /git/ref/heads/{branch}
  if (rest[0] === 'refs' || rest[0] === 'ref') {
    const rest2 = rest[0] === 'ref' ? ['refs', ...rest.slice(1)] : rest.slice(1);
    if (rest2.length === 0 && method === 'GET') {
      return reply(200, [...repo.refs.keys()].sort().map((ref) => ({
        ref,
        node_id: `REF_${ref}`,
        url: '',
        object: { sha: repo.refs.get(ref) ?? ZERO_OID, type: 'commit', url: '' },
      })));
    }
    if (rest2[0] === 'heads') {
      if (rest2.length === 1 && method === 'GET') {
        return reply(200, [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ ref, node_id: `REF_${ref}`, url: '', object: { sha: repo.refs.get(ref) ?? ZERO_OID, type: 'commit', url: '' } })));
      }
      if (rest2.length >= 2 && method === 'GET') {
        const branch = rest2.slice(1).map(decodeSegment).join('/');
        const ref = `refs/heads/${branch}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound();
        return reply(200, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
      }
    }
    return notFound();
  }

  return notFound();
}

function handleContents(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query } = req;
  const path = rest.map(decodeSegment).join('/');

  if (method === 'GET') {
    const refName = resolveRef(repo, query.get('ref'));
    if (refName === null || !repo.refs.has(refName)) {
      // An unborn repository has no contents at all.
      return notFound();
    }
    const blob = repo.blobAtPath(refName, path);
    if (blob !== null) {
      return reply(200, {
        name: path.split('/').pop() ?? path,
        path,
        sha: blob.oid,
        size: blob.data.length,
        type: 'file',
        url: '',
        content_url: '',
        git_url: '',
        html_url: '',
        download_url: '',
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
    }
    const entries = repo.listDir(refName, path);
    if (entries.length > 0 || path === '') {
      if (repo.blobAtPath(refName, path === '' ? '__nope__' : path) === null && entries.length === 0 && path !== '') {
        // An empty directory cannot exist in git; fall through to 404 only when the dir is absent.
        const parentEntries = repo.listDir(refName, path === '' ? '' : path.split('/').slice(0, -1).join('/'));
        const dirPresent = parentEntries.some((entry) => entry.type === 'dir' && entry.path === path);
        if (!dirPresent) return notFound();
      }
      return reply(200, entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        type: entry.type,
        url: '',
        git_url: '',
        html_url: '',
        encoding: entry.type === 'file' ? 'base64' : undefined,
        content: undefined,
        _links: {},
      })));
    }
    return notFound();
  }

  if (method === 'PUT') {
    const input = record(body);
    const message = stringAt(input, 'message', 'update contents');
    const contentB64 = stringAt(input, 'content');
    let data: Buffer;
    try {
      data = Buffer.from(contentB64, 'base64');
    } catch {
      return reply(400, { message: 'the content is not base64' });
    }
    const branch = stringAt(input, 'branch') || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const givenSha = stringAt(input, 'sha') || null;
    const existing = repo.refs.has(refName) ? repo.blobAtPath(refName, path) : null;
    if (existing !== null && givenSha !== null && existing.oid !== givenSha) {
      return reply(409, { message: `${path} does not match ${givenSha}` });
    }
    const isUpdate = existing !== null;
    if (repo.refs.get(refName) === undefined) {
      // Commit on an unborn branch (or a branch that does not exist yet): create it at the default tip.
      const defaultTip = repo.refs.get(repo.headRefName());
      if (defaultTip !== undefined && branch !== repo.defaultBranch) repo.refs.set(refName, defaultTip);
    }
    const result = repo.commitTreeChange(refName, path, data, message);
    return reply(isUpdate ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobSha ?? '',
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
      },
      commit: commitJson(repo, result.commitSha, req.baseUrl),
    });
  }

  if (method === 'DELETE') {
    const input = record(body);
    const message = stringAt(input, 'message', 'delete contents');
    const givenSha = stringAt(input, 'sha');
    const branch = stringAt(input, 'branch') || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const existing = repo.blobAtPath(refName, path);
    if (existing === null) return notFound();
    if (givenSha !== '' && givenSha !== existing.oid) {
      return reply(409, { message: `${path} does not match ${givenSha}` });
    }
    const result = repo.commitTreeChange(refName, path, null, message);
    return reply(200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: existing.oid,
        size: existing.data.length,
        type: 'file',
        encoding: 'base64',
        content: existing.data.toString('base64'),
        url: '',
      },
      commit: commitJson(repo, result.commitSha, req.baseUrl),
    });
  }

  return notFound();
}

function handleIssues(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query, baseUrl } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const input = record(body);
      const title = stringAt(input, 'title');
      if (title === '') return needMessage('Validation Failed: title is required');
      const requestedLabels = Array.isArray(input.labels)
        ? input.labels.map((entry) => (typeof entry === 'string' ? entry : record(entry).name as string)).filter((name) => typeof name === 'string' && name !== '')
        : [];
      for (const label of requestedLabels) {
        if (!repo.labels.has(label)) {
          return needMessage(`Validation Failed: label "${label}" does not exist`);
        }
      }
      repo.tick();
      const issue: Issue = {
        id: repo.issueSeq++,
        number: repo.issueSeq,
        title,
        body: stringAt(input, 'body'),
        state: 'open',
        labels: [...new Set(requestedLabels)],
        createdAt: repo.iso(),
        updatedAt: repo.iso(),
        closedAt: null,
        user: repo.owner,
        comments: [],
      };
      // The id and the number share one sequence so both increment together.
      issue.id = 9000 + issue.number;
      repo.issues.push(issue);
      return reply(201, issueJson(repo, issue, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (query.get('sort') === null ? 'desc' : 'desc');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => {
        const order = direction === 'asc' ? 1 : -1;
        if (sort === 'created') return (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) * order || (a.number - b.number) * order;
        if (sort === 'updated') return (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * order || (a.number - b.number) * order;
        return (a.comments.length - b.comments.length) * order || (a.number - b.number) * order;
      });
      const perPage = intQuery(query, 'per_page', 30, 100);
      const page = intQuery(query, 'page', 1, 100_000);
      const start = (page - 1) * perPage;
      return reply(200, list.slice(start, start + perPage).map((issue) => issueJson(repo, issue, baseUrl)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issueByNumber(number);
  if (issue === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return reply(200, issueJson(repo, issue, baseUrl));
    if (method === 'PATCH') {
      const input = record(body);
      if (typeof input.title === 'string' && input.title !== '') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') {
        if (issue.state !== input.state) {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? repo.iso() : null;
        }
      }
      if (Array.isArray(input.labels)) {
        const names = input.labels.map((entry) => (typeof entry === 'string' ? entry : record(entry).name as string)).filter((name) => typeof name === 'string');
        issue.labels = names;
      }
      issue.updatedAt = repo.iso();
      return reply(200, issueJson(repo, issue, baseUrl));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (method === 'POST') {
      const input = record(body);
      const text = stringAt(input, 'body');
      if (text === '') return needMessage('Validation Failed: body is required');
      repo.tick();
      const comment = { id: 70_000 + ++repo.commentSeq, body: text, createdAt: repo.iso(), updatedAt: repo.iso() };
      issue.comments.push(comment);
      issue.updatedAt = repo.iso();
      return reply(201, commentJson(repo, issue.number, comment, baseUrl));
    }
    if (method === 'GET') {
      return reply(200, issue.comments.map((comment) => commentJson(repo, issue.number, comment, baseUrl)));
    }
    return notFound();
  }

  return notFound();
}

function handlePulls(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query, baseUrl } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const input = record(body);
      const head = stringAt(input, 'head');
      const base = stringAt(input, 'base');
      const title = stringAt(input, 'title');
      if (head === '' || base === '' || title === '') {
        return needMessage('Validation Failed: head, base and title are required');
      }
      const headRef = `refs/heads/${head}`;
      const baseRef = `refs/heads/${base}`;
      const headSha = repo.refs.get(headRef);
      const baseSha = repo.refs.get(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return needMessage(`Validation Failed: the branch ${headSha === undefined ? head : base} does not exist`);
      }
      if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base)) {
        return needMessage(`Validation Failed: a pull request for ${head} into ${base} already exists`);
      }
      repo.tick();
      const files = repo.diffTree(baseSha, headSha);
      const pull: Pull = {
        id: 80_000 + ++repo.pullSeq,
        number: repo.pullSeq,
        title,
        body: stringAt(input, 'body'),
        state: 'open',
        merged: false,
        mergedAt: null,
        closedAt: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        files,
        createdAt: repo.iso(),
        user: repo.owner,
      };
      repo.pulls.push(pull);
      return reply(201, pullJson(repo, pull, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls].sort((a, b) => a.number - b.number);
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      const perPage = intQuery(query, 'per_page', 30, 100);
      const page = intQuery(query, 'page', 1, 100_000);
      const start = (page - 1) * perPage;
      return reply(200, list.slice(start, start + perPage).map((pull) => pullJson(repo, pull, baseUrl)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pullByNumber(number);
  if (pull === undefined) return notFound();

  if (rest.length === 1 && method === 'GET') {
    return reply(200, pullJson(repo, pull, baseUrl));
  }

  if (rest[1] === 'files' && method === 'GET') {
    return reply(200, pull.files.map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    })));
  }

  if (rest[1] === 'merge' && method === 'PUT') {
    const result = mergePullRequest(repo, pull);
    if (!result.ok) return reply(result.status, { message: result.message });
    return reply(200, {
      sha: result.sha,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }

  if (rest[1] === 'commits' && method === 'GET') {
    return reply(200, repo.commitLog(`refs/heads/${pull.headRef}`).map((entry) => commitJson(repo, entry.sha, baseUrl)));
  }

  return notFound();
}

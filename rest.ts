// GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, with GitHub's statuses, payload shapes and headers.

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

function makeReply(status: number, payload?: unknown, headers?: Record<string, string>): RestReply {
  return { status, body: payload, headers };
}

const missing = (description = 'Not Found'): RestReply => makeReply(404, { message: description });
const unprocessable = (description: string): RestReply => makeReply(422, { message: description });

function asRecord(candidate: unknown): Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function textField(source: Record<string, unknown>, field: string, otherwise = ''): string {
  const value = source[field];
  return typeof value === 'string' ? value : otherwise;
}

function intField(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function userPayload(login: string): Record<string, unknown> {
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

function repoPayload(repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const apiUrl = `${baseUrl}/api/v3/repos/${fullName}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userPayload(repo.owner),
    html_url: `${baseUrl}/${fullName}`,
    description: repo.description,
    fork: false,
    url: apiUrl,
    issues_url: `${apiUrl}/issues/{number}`,
    pulls_url: `${apiUrl}/pulls/{number}`,
    contents_url: `${apiUrl}/contents/{+path}`,
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
    open_issues_count: repo.issues.filter(issue => issue.state === 'open').length,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelPayload(repo: Repo, name: string): Record<string, unknown> {
  const stored = repo.labels.get(name);
  return {
    id: 5000 + (stored !== undefined ? [...repo.labels.keys()].indexOf(name) : 0),
    node_id: `L_${name}`,
    name,
    color: stored?.color ?? 'ededed',
    default: false,
    description: null,
  };
}

function issuePayload(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userPayload(issue.user),
    labels: issue.labels.map(name => labelPayload(repo, name)),
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

function commentPayload(
  repo: Repo,
  issueNumber: number,
  comment: { id: number; body: string; createdAt: string; updatedAt: string },
  baseUrl: string,
): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${comment.id}`,
    body: comment.body,
    user: userPayload(repo.owner),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issueNumber}`,
    html_url: `${baseUrl}/${fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullPayload(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const headLabel = `${repo.owner}:${pull.headRef}`;
  const baseLabel = `${repo.owner}:${pull.baseRef}`;
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userPayload(pull.user),
    body: pull.body,
    labels: [],
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.mergedAt ?? pull.createdAt,
    head: { label: headLabel, ref: pull.headRef, sha: pull.headSha, repo: repoPayload(repo, baseUrl) },
    base: { label: baseLabel, ref: pull.baseRef, sha: pull.baseSha, repo: repoPayload(repo, baseUrl) },
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

function commitPayload(repo: Repo, sha: string, baseUrl: string): Record<string, unknown> {
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
    parents: commit.parents.map(parent => ({ sha: parent, url: '', html_url: '' })),
  };
}

function canonicalRef(repo: Repo, requested: string | null): string | null {
  if (requested === null || requested === '') return repo.headRefName();
  if (requested.startsWith('refs/')) return requested;
  if (requested === 'HEAD') return repo.headRefName();
  return `refs/heads/${requested}`;
}

function branchPayload(repo: Repo, branch: string): Record<string, unknown> {
  return {
    name: branch,
    commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID, url: '' },
    protected: false,
  };
}

function queryInt(query: URLSearchParams, field: string, fallback: number, ceiling: number): number {
  const raw = query.get(field);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(ceiling, value);
}

function unescapeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Shared by POST /repos/{o}/{r}/pulls/{n}/merge and the GraphQL mutation. */
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
  const path = segments.slice(1);

  if (path.length === 0 || (path.length === 1 && path[0] === '')) {
    return makeReply(200, {
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

  const [top] = path;

  if (top === 'meta' && method === 'GET') {
    return makeReply(200, {
      installed_version: 'entry-forge 1.0.0 (github-core-clone-01)',
      verifiable_password_authentication: false,
    });
  }

  if (top === 'user' && path.length === 1 && method === 'GET') {
    return makeReply(200, { ...userPayload(store.viewer), name: store.viewer, email: `${store.viewer}@example.invalid` });
  }

  if (top === 'user' && path[1] === 'repos') {
    if (method === 'POST') return postUserRepo(req);
    if (method === 'GET') return getUserRepos(req);
    return makeReply(405, { message: 'Method Not Allowed' });
  }

  if (top === 'repos' && path.length >= 3) {
    const owner = unescapeSegment(path[1]!);
    const name = unescapeSegment(path[2]!);
    const repo = store.get(owner, name);
    if (repo === undefined) return missing();
    return routeRepo(req, repo, path.slice(3));
  }

  return missing();
}

function postUserRepo(req: RestRequest): RestReply {
  const input = asRecord(req.body);
  const name = textField(input, 'name').trim();
  if (name === '') return unprocessable('Validation Failed: name is required');
  const outcome = req.store.create(name, textField(input, 'description'), input.private === true);
  if ('error' in outcome) {
    return { ...unprocessable(`name already exists on this account: ${name}`), headers: { 'x-github-media-type': 'github.v3' } };
  }
  return makeReply(201, repoPayload(outcome.repo, req.baseUrl));
}

function getUserRepos(req: RestRequest): RestReply {
  const all = req.store.viewerRepos();
  const pageSize = queryInt(req.query, 'per_page', 30, 100);
  const pageNumber = queryInt(req.query, 'page', 1, 10_000);
  const from = (pageNumber - 1) * pageSize;
  const slice = all.slice(from, from + pageSize);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / pageSize));
  const linkTo = (target: number): string => `${req.baseUrl}/api/v3/user/repos?per_page=${pageSize}&page=${target}`;
  const links: string[] = [];
  if (pageNumber < lastPage) links.push(`<${linkTo(pageNumber + 1)}>; rel="next"`);
  links.push(`<${linkTo(lastPage)}>; rel="last"`);
  if (pageNumber > 1) links.push(`<${linkTo(Math.max(1, pageNumber - 1))}>; rel="prev"`);
  links.push(`<${linkTo(1)}>; rel="first"`);
  headers.link = links.join(', ');
  return makeReply(200, slice.map(repo => repoPayload(repo, req.baseUrl)), headers);
}

function routeRepo(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, query, baseUrl, body } = req;

  if (rest.length === 0) {
    if (method === 'GET') return makeReply(200, repoPayload(repo, baseUrl));
    if (method === 'PATCH') {
      const patch = asRecord(body);
      if (typeof patch.description === 'string') repo.description = patch.description;
      if (typeof patch.name === 'string' && patch.name !== '') repo.name = patch.name;
      if (typeof patch.private === 'boolean') repo.isPrivate = patch.private;
      // A requested default_branch is accepted but this forge keeps 'main'.
      return makeReply(200, repoPayload(repo, baseUrl));
    }
    if (method === 'DELETE') {
      req.store.delete(repo.owner, repo.name);
      return { status: 204 };
    }
    return missing();
  }

  const [section] = rest;

  if (section === 'contents') return routeContents(req, repo, rest.slice(1));

  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()]
        .filter(ref => ref.startsWith('refs/heads/'))
        .map(ref => ref.slice('refs/heads/'.length))
        .sort();
      if (!names.includes(repo.defaultBranch) && repo.refs.get(repo.headRefName()) === undefined) {
        names.unshift(repo.defaultBranch);
      }
      return makeReply(200, names.map(branch => branchPayload(repo, branch)));
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = unescapeSegment(rest[1]!);
      if (!repo.refs.has(`refs/heads/${branch}`)) return missing();
      return makeReply(200, branchPayload(repo, branch));
    }
    return missing();
  }

  if (section === 'commits' && method === 'GET') {
    const refName = canonicalRef(repo, query.get('sha'));
    if (refName === null || !repo.refs.has(refName)) return missing();
    return makeReply(200, repo.commitLog(refName).map(entry => commitPayload(repo, entry.sha, baseUrl)));
  }

  if (section === 'git') return routeGitData(req, repo, rest.slice(1));

  if (section === 'labels') {
    if (method === 'POST') {
      const input = asRecord(body);
      const name = textField(input, 'name').trim();
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (repo.labels.has(name)) return unprocessable(`name already exists: ${name}`);
      repo.labels.set(name, { name, color: textField(input, 'color', 'ededed').replace(/^#/, '') });
      return makeReply(201, labelPayload(repo, name));
    }
    if (method === 'GET') return makeReply(200, [...repo.labels.keys()].map(name => labelPayload(repo, name)));
    return missing();
  }

  if (section === 'issues') return routeIssues(req, repo, rest.slice(1));
  if (section === 'pulls') return routePulls(req, repo, rest.slice(1));

  if (section === 'languages' && method === 'GET') return makeReply(200, {});
  if (section === 'tags' && method === 'GET') {
    return makeReply(200, [...repo.refs.keys()].filter(ref => ref.startsWith('refs/tags/')).map((ref, index) => ({
      name: ref.slice('refs/tags/'.length),
      commit: { sha: repo.refs.get(ref) ?? ZERO_OID, url: '' },
      zipball_url: '',
      tarball_url: '',
      node_id: `T_${index}`,
    })));
  }

  return missing();
}

function routeGitData(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body } = req;

  if (rest.length === 1 && rest[0] === 'refs' && method === 'POST') {
    const input = asRecord(body);
    const ref = textField(input, 'ref');
    const sha = textField(input, 'sha');
    if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) {
      return unprocessable('Validation Failed: ref must be refs/heads/<name> and sha a commit id');
    }
    if (repo.refs.has(ref)) return unprocessable(`Reference already exists: ${ref}`);
    if (repo.objects.get(sha) === undefined) return unprocessable(`Object does not exist: ${sha}`);
    repo.refs.set(ref, sha);
    return makeReply(201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
  }

  if (rest[0] === 'refs' || rest[0] === 'ref') {
    const normalized = rest[0] === 'ref' ? ['refs', ...rest.slice(1)] : rest.slice(1);
    if (normalized.length === 0 && method === 'GET') {
      return makeReply(200, [...repo.refs.keys()].sort().map(ref => ({
        ref,
        node_id: `REF_${ref}`,
        url: '',
        object: { sha: repo.refs.get(ref) ?? ZERO_OID, type: 'commit', url: '' },
      })));
    }
    if (normalized[0] === 'heads') {
      if (normalized.length === 1 && method === 'GET') {
        return makeReply(200, [...repo.refs.keys()]
          .filter(ref => ref.startsWith('refs/heads/'))
          .sort()
          .map(ref => ({ ref, node_id: `REF_${ref}`, url: '', object: { sha: repo.refs.get(ref) ?? ZERO_OID, type: 'commit', url: '' } })));
      }
      if (normalized.length >= 2 && method === 'GET') {
        const branch = normalized.slice(1).map(unescapeSegment).join('/');
        const ref = `refs/heads/${branch}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return missing();
        return makeReply(200, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
      }
    }
    return missing();
  }

  return missing();
}

function routeContents(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query } = req;
  const path = rest.map(unescapeSegment).join('/');

  if (method === 'GET') {
    const refName = canonicalRef(repo, query.get('ref'));
    if (refName === null || !repo.refs.has(refName)) return missing();
    const blob = repo.blobAtPath(refName, path);
    if (blob !== null) {
      return makeReply(200, {
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
    const children = repo.listDir(refName, path);
    if (children.length > 0 || path === '') {
      if (path !== '' && children.length === 0) {
        const parentEntries = repo.listDir(refName, path.split('/').slice(0, -1).join('/'));
        if (!parentEntries.some(entry => entry.type === 'dir' && entry.path === path)) return missing();
      }
      return makeReply(200, children.map(entry => ({
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
    return missing();
  }

  if (method === 'PUT') {
    const input = asRecord(body);
    const message = textField(input, 'message', 'update contents');
    const contentB64 = textField(input, 'content');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64, 'base64');
    } catch {
      return makeReply(400, { message: 'the content is not base64' });
    }
    const branch = textField(input, 'branch') || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const proposedSha = textField(input, 'sha') || null;
    const current = repo.refs.has(refName) ? repo.blobAtPath(refName, path) : null;
    if (current !== null && proposedSha !== null && current.oid !== proposedSha) {
      return makeReply(409, { message: `${path} does not match ${proposedSha}` });
    }
    const updating = current !== null;
    if (repo.refs.get(refName) === undefined) {
      const defaultTip = repo.refs.get(repo.headRefName());
      if (defaultTip !== undefined && branch !== repo.defaultBranch) repo.refs.set(refName, defaultTip);
    }
    const changed = repo.commitTreeChange(refName, path, bytes, message);
    return makeReply(updating ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: changed.blobSha ?? '',
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
      },
      commit: commitPayload(repo, changed.commitSha, req.baseUrl),
    });
  }

  if (method === 'DELETE') {
    const input = asRecord(body);
    const message = textField(input, 'message', 'delete contents');
    const proposedSha = textField(input, 'sha');
    const branch = textField(input, 'branch') || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const current = repo.blobAtPath(refName, path);
    if (current === null) return missing();
    if (proposedSha !== '' && proposedSha !== current.oid) {
      return makeReply(409, { message: `${path} does not match ${proposedSha}` });
    }
    const changed = repo.commitTreeChange(refName, path, null, message);
    return makeReply(200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: current.oid,
        size: current.data.length,
        type: 'file',
        encoding: 'base64',
        content: current.data.toString('base64'),
        url: '',
      },
      commit: commitPayload(repo, changed.commitSha, req.baseUrl),
    });
  }

  return missing();
}

function routeIssues(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query, baseUrl } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const input = asRecord(body);
      const title = textField(input, 'title');
      if (title === '') return unprocessable('Validation Failed: title is required');
      const requestedLabels = Array.isArray(input.labels)
        ? input.labels.map(entry => typeof entry === 'string' ? entry : asRecord(entry).name as string)
          .filter(name => typeof name === 'string' && name !== '')
        : [];
      for (const label of requestedLabels) {
        if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label "${label}" does not exist`);
      }
      repo.tick();
      const issue: Issue = {
        id: repo.issueSeq++,
        number: repo.issueSeq,
        title,
        body: textField(input, 'body'),
        state: 'open',
        labels: [...new Set(requestedLabels)],
        createdAt: repo.iso(),
        updatedAt: repo.iso(),
        closedAt: null,
        user: repo.owner,
        comments: [],
      };
      issue.id = 9000 + issue.number;
      repo.issues.push(issue);
      return makeReply(201, issuePayload(repo, issue, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (query.get('sort') === null ? 'desc' : 'desc');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter(issue => issue.state === state);
      list.sort((a, b) => {
        const sign = direction === 'asc' ? 1 : -1;
        if (sort === 'created') {
          return (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) * sign || (a.number - b.number) * sign;
        }
        if (sort === 'updated') {
          return (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * sign || (a.number - b.number) * sign;
        }
        return (a.comments.length - b.comments.length) * sign || (a.number - b.number) * sign;
      });
      const perPage = queryInt(query, 'per_page', 30, 100);
      const pageNumber = queryInt(query, 'page', 1, 100_000);
      const from = (pageNumber - 1) * perPage;
      return makeReply(200, list.slice(from, from + perPage).map(issue => issuePayload(repo, issue, baseUrl)));
    }
    return missing();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return missing();
  const issue = repo.issueByNumber(number);
  if (issue === undefined) return missing();

  if (rest.length === 1) {
    if (method === 'GET') return makeReply(200, issuePayload(repo, issue, baseUrl));
    if (method === 'PATCH') {
      const patch = asRecord(body);
      if (typeof patch.title === 'string' && patch.title !== '') issue.title = patch.title;
      if (typeof patch.body === 'string') issue.body = patch.body;
      if (patch.state === 'open' || patch.state === 'closed') {
        if (issue.state !== patch.state) {
          issue.state = patch.state;
          issue.closedAt = patch.state === 'closed' ? repo.iso() : null;
        }
      }
      if (Array.isArray(patch.labels)) {
        issue.labels = patch.labels
          .map(entry => typeof entry === 'string' ? entry : asRecord(entry).name as string)
          .filter(name => typeof name === 'string');
      }
      issue.updatedAt = repo.iso();
      return makeReply(200, issuePayload(repo, issue, baseUrl));
    }
    return missing();
  }

  if (rest[1] === 'comments') {
    if (method === 'POST') {
      const input = asRecord(body);
      const text = textField(input, 'body');
      if (text === '') return unprocessable('Validation Failed: body is required');
      repo.tick();
      const comment = { id: 70_000 + ++repo.commentSeq, body: text, createdAt: repo.iso(), updatedAt: repo.iso() };
      issue.comments.push(comment);
      issue.updatedAt = repo.iso();
      return makeReply(201, commentPayload(repo, issue.number, comment, baseUrl));
    }
    if (method === 'GET') return makeReply(200, issue.comments.map(comment => commentPayload(repo, issue.number, comment, baseUrl)));
    return missing();
  }

  return missing();
}

function routePulls(req: RestRequest, repo: Repo, rest: readonly string[]): RestReply {
  const { method, body, query, baseUrl } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const input = asRecord(body);
      const head = textField(input, 'head');
      const base = textField(input, 'base');
      const title = textField(input, 'title');
      if (head === '' || base === '' || title === '') {
        return unprocessable('Validation Failed: head, base and title are required');
      }
      const headRef = `refs/heads/${head}`;
      const baseRef = `refs/heads/${base}`;
      const headSha = repo.refs.get(headRef);
      const baseSha = repo.refs.get(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return unprocessable(`Validation Failed: the branch ${headSha === undefined ? head : base} does not exist`);
      }
      if (repo.pulls.some(pull => pull.state === 'open' && pull.headRef === head && pull.baseRef === base)) {
        return unprocessable(`Validation Failed: a pull request for ${head} into ${base} already exists`);
      }
      repo.tick();
      const files = repo.diffTree(baseSha, headSha);
      const pull: Pull = {
        id: 80_000 + ++repo.pullSeq,
        number: repo.pullSeq,
        title,
        body: textField(input, 'body'),
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
      return makeReply(201, pullPayload(repo, pull, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls].sort((a, b) => a.number - b.number);
      if (state !== 'all') list = list.filter(pull => pull.state === state);
      const perPage = queryInt(query, 'per_page', 30, 100);
      const pageNumber = queryInt(query, 'page', 1, 100_000);
      const from = (pageNumber - 1) * perPage;
      return makeReply(200, list.slice(from, from + perPage).map(pull => pullPayload(repo, pull, baseUrl)));
    }
    return missing();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return missing();
  const pull = repo.pullByNumber(number);
  if (pull === undefined) return missing();

  if (rest.length === 1 && method === 'GET') return makeReply(200, pullPayload(repo, pull, baseUrl));

  if (rest[1] === 'files' && method === 'GET') {
    return makeReply(200, pull.files.map(file => ({
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
    const outcome = mergePullRequest(repo, pull);
    if (!outcome.ok) return makeReply(outcome.status, { message: outcome.message });
    return makeReply(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (rest[1] === 'commits' && method === 'GET') {
    return makeReply(200, repo.commitLog(`refs/heads/${pull.headRef}`).map(entry => commitPayload(repo, entry.sha, baseUrl)));
  }

  return missing();
}

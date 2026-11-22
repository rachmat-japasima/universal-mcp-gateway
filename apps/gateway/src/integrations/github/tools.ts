import { z } from 'zod';

import type { ToolDefinition } from '../../domain/tool.js';

/**
 * The six read-only GitHub tools (Phase 13, ADR-053).
 *
 * Everything here is pure: the schemas a client sees, and the normalizers
 * that turn untrusted GitHub JSON into a closed output shape. No fetch, no
 * clock, no credential — the connector composes these with the client.
 *
 * Normalization is defensive on purpose. GitHub responses are external data:
 * fields appear, disappear, and change type across API versions, so every
 * extraction coerces through a validator instead of trusting the wire shape.
 * What leaves this module is always the closed shape below — a client never
 * sees a raw GitHub response object.
 */

// -- Input schemas ----------------------------------------------------------

/** GitHub owner/repo names: ASCII word characters plus `.` and `-`. */
const NAME_PATTERN = '^[A-Za-z0-9_.-]+$';

const ownerProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: NAME_PATTERN,
  description: 'Repository owner (user or organization login).',
} as const;

const repoProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: NAME_PATTERN,
  description: 'Repository name (without the owner).',
} as const;

/** Bounded pagination, shared by every listing tool. */
const pageProperty = { type: 'integer', minimum: 1, maximum: 10_000, default: 1 } as const;
const perPageProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  default: 20,
  description: 'Items per page. Capped at 100 (the GitHub maximum).',
} as const;

const listRepositoriesInput = {
  type: 'object',
  properties: {
    page: pageProperty,
    per_page: perPageProperty,
    visibility: {
      type: 'string',
      enum: ['all', 'public', 'private'],
      description: 'Filter by visibility. Omitted: GitHub default (all). A fine-grained token only ever sees what it was granted.',
    },
    // No `default` keys below: when omitted, GitHub's own default applies, and
    // a schema that promised a different default would be lying.
    sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'] },
    direction: { type: 'string', enum: ['asc', 'desc'] },
  },
  additionalProperties: false,
} as const;

const getRepositoryInput = {
  type: 'object',
  properties: { owner: ownerProperty, repo: repoProperty },
  required: ['owner', 'repo'],
  additionalProperties: false,
} as const;

const listIssuesInput = {
  type: 'object',
  properties: {
    owner: ownerProperty,
    repo: repoProperty,
    // Omitted state: GitHub's default, `open`.
    state: { type: 'string', enum: ['open', 'closed', 'all'] },
    labels: {
      type: 'string',
      maxLength: 500,
      description: 'Comma-separated label names, e.g. "bug,help-wanted".',
    },
    page: pageProperty,
    per_page: perPageProperty,
  },
  required: ['owner', 'repo'],
  additionalProperties: false,
} as const;

const getIssueInput = {
  type: 'object',
  properties: {
    owner: ownerProperty,
    repo: repoProperty,
    issue_number: { type: 'integer', minimum: 1, description: 'Issue number (not the internal id).' },
  },
  required: ['owner', 'repo', 'issue_number'],
  additionalProperties: false,
} as const;

const listPullRequestsInput = {
  type: 'object',
  properties: {
    owner: ownerProperty,
    repo: repoProperty,
    // Omitted state: GitHub's default, `open`.
    state: { type: 'string', enum: ['open', 'closed', 'all'] },
    page: pageProperty,
    per_page: perPageProperty,
  },
  required: ['owner', 'repo'],
  additionalProperties: false,
} as const;

const getPullRequestInput = {
  type: 'object',
  properties: {
    owner: ownerProperty,
    repo: repoProperty,
    pull_number: { type: 'integer', minimum: 1, description: 'Pull request number.' },
  },
  required: ['owner', 'repo', 'pull_number'],
  additionalProperties: false,
} as const;

/** Read-only is a protocol fact, not a promise in prose: MCP annotations. */
const READ_ONLY = { readOnlyHint: true } as const;

/** The six tools, as the catalog will namespace them. */
export function githubToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_repositories',
      description:
        'List repositories the connection token can see. A fine-grained token only sees the repositories it was granted, so this is the token\'s real scope, not the whole account.',
      inputSchema: listRepositoriesInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_repository',
      description: 'Get one repository\'s metadata: owner, name, default branch, visibility, description, URLs.',
      inputSchema: getRepositoryInput,
      annotations: READ_ONLY,
    },
    {
      name: 'list_issues',
      description: 'List a repository\'s issues, newest first per GitHub\'s default order. Pull requests are excluded.',
      inputSchema: listIssuesInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_issue',
      description: 'Get one issue, including its body.',
      inputSchema: getIssueInput,
      annotations: READ_ONLY,
    },
    {
      name: 'list_pull_requests',
      description: 'List a repository\'s pull requests. No diff or patch content is fetched.',
      inputSchema: listPullRequestsInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_pull_request',
      description: 'Get one pull request, including its body, head/base branches, and mergeable state.',
      inputSchema: getPullRequestInput,
      annotations: READ_ONLY,
    },
  ];
}

// -- Output normalization ----------------------------------------------------

const repositorySummarySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    fullName: z.string().min(1),
    ownerLogin: z.string().min(1),
    visibility: z.enum(['public', 'private']),
    defaultBranch: z.string().nullable(),
    description: z.string().nullable(),
    htmlUrl: z.string().min(1),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

const issueSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    state: z.string().min(1),
    authorLogin: z.string().nullable(),
    labels: z.array(z.string()),
    htmlUrl: z.string().min(1),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type IssueSummary = z.infer<typeof issueSummarySchema>;

const issueDetailSchema = issueSummarySchema.extend({ body: z.string().nullable() }).strict();
export type IssueDetail = z.infer<typeof issueDetailSchema>;

const pullRequestSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    state: z.string().min(1),
    authorLogin: z.string().nullable(),
    headBranch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    draft: z.boolean(),
    htmlUrl: z.string().min(1),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

const pullRequestDetailSchema = pullRequestSummarySchema
  .extend({
    body: z.string().nullable(),
    /** `mergeable` is null while GitHub is still computing it. */
    mergeable: z.boolean().nullable(),
  })
  .strict();
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

/** Coerces one field of an untrusted GitHub object; `fallback` on any surprise. */
function field(source: unknown, key: string, ...kinds: Array<'string' | 'number' | 'boolean'>): unknown {
  const value = isRecord(source) ? source[key] : undefined;
  if (value === null || value === undefined) return null;
  if (kinds.includes(typeof value as 'string' | 'number' | 'boolean')) return value;
  return null;
}

function str(source: unknown, key: string): string | null {
  return field(source, key, 'string') as string | null;
}

function num(source: unknown, key: string): number | null {
  return field(source, key, 'number') as number | null;
}

function bool(source: unknown, key: string): boolean {
  return field(source, key, 'boolean') === true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Identity fields (id, name, htmlUrl…) carry no fallback: a GitHub object
 * missing them is a shape failure, and the normalizer answers `undefined`
 * rather than inventing an empty-but-"valid" record. Fallbacks apply only to
 * fields that are genuinely optional or legitimately null on the wire.
 */
/** `GET /user/repos`, `GET /repos/{owner}/{repo}` → the closed summary shape. */
export function normalizeRepository(source: unknown): RepositorySummary | undefined {
  const candidate = {
    id: num(source, 'id'),
    name: str(source, 'name'),
    fullName: str(source, 'full_name'),
    ownerLogin: str(isRecord(source) ? source['owner'] : undefined, 'login'),
    visibility: str(source, 'visibility') === 'private' ? 'private' : 'public',
    defaultBranch: str(source, 'default_branch'),
    description: str(source, 'description'),
    htmlUrl: str(source, 'html_url'),
    updatedAt: str(source, 'updated_at'),
  };
  return repositorySummarySchema.safeParse(candidate).success ? (candidate as RepositorySummary) : undefined;
}

/** A GitHub issues response mixes pull requests in; they are not issues. */
export function isPullRequestEntry(entry: unknown): boolean {
  return isRecord(entry) && 'pull_request' in entry;
}

/** One issue → the closed summary shape (no body: lists stay bounded). */
export function normalizeIssue(source: unknown): IssueSummary | undefined {
  const candidate = {
    number: num(source, 'number'),
    title: str(source, 'title'),
    state: str(source, 'state'),
    authorLogin: str(isRecord(source) ? source['user'] : undefined, 'login'),
    labels: Array.isArray(isRecord(source) ? source['labels'] : undefined)
      ? ((isRecord(source) ? source['labels'] : []) as unknown[])
          .map((label) => str(label, 'name'))
          .filter((name): name is string => name !== null)
      : [],
    htmlUrl: str(source, 'html_url'),
    createdAt: str(source, 'created_at'),
    updatedAt: str(source, 'updated_at'),
  };
  return issueSummarySchema.safeParse(candidate).success ? (candidate as IssueSummary) : undefined;
}

/** One issue with its body (the detail read is the deliberate disclosure). */
export function normalizeIssueDetail(source: unknown): IssueDetail | undefined {
  const summary = normalizeIssue(source);
  if (summary === undefined) return undefined;
  const detail = { ...summary, body: str(source, 'body') };
  return issueDetailSchema.safeParse(detail).success ? (detail as IssueDetail) : undefined;
}

/** One pull request → the closed summary shape (no body, no diff). */
export function normalizePullRequest(source: unknown): PullRequestSummary | undefined {
  const candidate = {
    number: num(source, 'number'),
    title: str(source, 'title'),
    state: str(source, 'state'),
    authorLogin: str(isRecord(source) ? source['user'] : undefined, 'login'),
    headBranch: str(isRecord(source) ? source['head'] : undefined, 'ref'),
    baseBranch: str(isRecord(source) ? source['base'] : undefined, 'ref'),
    draft: bool(source, 'draft'),
    htmlUrl: str(source, 'html_url'),
    createdAt: str(source, 'created_at'),
    updatedAt: str(source, 'updated_at'),
  };
  return pullRequestSummarySchema.safeParse(candidate).success ? (candidate as PullRequestSummary) : undefined;
}

/** One pull request with body and mergeable state. */
export function normalizePullRequestDetail(source: unknown): PullRequestDetail | undefined {
  const summary = normalizePullRequest(source);
  if (summary === undefined) return undefined;
  const detail = { ...summary, body: str(source, 'body'), mergeable: field(source, 'mergeable', 'boolean') as boolean | null };
  return pullRequestDetailSchema.safeParse(detail).success ? (detail as PullRequestDetail) : undefined;
}

/** Listing defaults. AJV validates but does not apply them; the connector does. */
export const PAGINATION_DEFAULTS = { page: 1, per_page: 20 } as const;

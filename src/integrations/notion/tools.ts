import { z } from 'zod';

import type { ToolDefinition } from '../../domain/tool.js';

/**
 * The six read-only Notion tools (Phase 16, ADR-055).
 *
 * Everything here is pure: the schemas a client sees, and the normalizers
 * that turn untrusted Notion JSON into a closed output shape. No fetch, no
 * clock, no credential — the connector composes these with the client.
 *
 * Normalization is defensive on purpose, with two Notion-specific rules from
 * the official docs: unknown response fields are ignored (never a hard
 * failure), and cursors are opaque strings passed back verbatim. What leaves
 * this module is always the closed shape below — a client never sees a raw
 * Notion response object.
 *
 * Notion content is data, never instructions. File/media URLs inside blocks
 * are surfaced as text at most and never dereferenced by the gateway.
 */

// -- Input schemas ----------------------------------------------------------

/**
 * Notion object ids: a UUID, dashed or not. The API accepts both; nothing
 * else is a legal id, so the pattern refuses free text on the way in.
 */
const ID_PATTERN = '^([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';

const idProperty = (description: string) =>
  ({ type: 'string', minLength: 32, maxLength: 36, pattern: ID_PATTERN, description } as const);

/**
 * The same pattern as a runtime guard: the connector re-checks ids before
 * placing them in a path, so a caller that bypasses the router's schema
 * validation cannot steer the URL anywhere else.
 */
export function isNotionId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(ID_PATTERN).test(value);
}

/**
 * Cursors are opaque by contract (official pagination docs): validate
 * bounds, never the format, and pass the value back verbatim.
 */
const startCursorProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 300,
  description: 'Cursor from a previous response (`next_cursor`). Opaque: pass it back unchanged.',
} as const;

/** No `default`: when omitted, Notion's own default (100) applies. */
const pageSizeProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description: 'Items per page. Capped at 100 (the Notion maximum).',
} as const;

const searchInput = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 256, description: 'Title text to search for. Omit to list everything the connection can see.' },
    object_filter: {
      type: 'string',
      enum: ['page', 'data_source'],
      description: 'Limit results to pages or to data sources.',
    },
    in_trash: { type: 'boolean', description: 'Search content in the trash instead.' },
    sort_direction: {
      type: 'string',
      enum: ['ascending', 'descending'],
      description: 'Sort by last-edited time. Omitted: Notion default (relevance).',
    },
    page_size: pageSizeProperty,
    start_cursor: startCursorProperty,
  },
  additionalProperties: false,
} as const;

const getPageInput = {
  type: 'object',
  properties: { page_id: idProperty('Page id (from search, or the URL of the page).') },
  required: ['page_id'],
  additionalProperties: false,
} as const;

const getBlockInput = {
  type: 'object',
  properties: { block_id: idProperty('Block id. A page id works too: a page is its top-level block.') },
  required: ['block_id'],
  additionalProperties: false,
} as const;

const listBlockChildrenInput = {
  type: 'object',
  properties: {
    block_id: idProperty('Page or block id whose direct children to list.'),
    page_size: pageSizeProperty,
    start_cursor: startCursorProperty,
  },
  required: ['block_id'],
  additionalProperties: false,
} as const;

const getDatabaseInput = {
  type: 'object',
  properties: { database_id: idProperty('Database id (from search, or the URL of the database).') },
  required: ['database_id'],
  additionalProperties: false,
} as const;

const queryDataSourceInput = {
  type: 'object',
  properties: {
    data_source_id: idProperty('Data source id (from get_database, or search).'),
    filter: {
      type: 'object',
      maxProperties: 50,
      additionalProperties: true,
      description:
        'Notion filter object, e.g. {"property": "Status", "status": {"equals": "Done"}}. The gateway bounds its size; Notion validates its internals.',
    },
    sorts: {
      type: 'array',
      maxItems: 10,
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              property: { type: 'string', minLength: 1, maxLength: 200 },
              direction: { type: 'string', enum: ['ascending', 'descending'] },
            },
            required: ['property', 'direction'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              timestamp: { type: 'string', enum: ['last_edited_time'] },
              direction: { type: 'string', enum: ['ascending', 'descending'] },
            },
            required: ['timestamp', 'direction'],
            additionalProperties: false,
          },
        ],
      },
      description: 'Sort criteria, e.g. [{"property": "Due", "direction": "ascending"}].',
    },
    page_size: pageSizeProperty,
    start_cursor: startCursorProperty,
  },
  required: ['data_source_id'],
  additionalProperties: false,
} as const;

/** Read-only is a protocol fact, not a promise in prose: MCP annotations. */
const READ_ONLY = { readOnlyHint: true } as const;

/** The six tools, as the catalog will namespace them. */
export function notionToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'search',
      description:
        'Search pages and data sources shared with this connection by title. One page at a time: pass next_cursor back as start_cursor to continue. The connection only sees content explicitly shared with it in Notion.',
      inputSchema: searchInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_page',
      description:
        "Get one page's metadata and properties, each property rendered as plain text where possible. To read the page's content, call list_block_children with the page id.",
      inputSchema: getPageInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_block',
      description:
        'Get one content block (paragraph, heading, list item, …). If hasChildren is true, call list_block_children with this block id to read the nested blocks.',
      inputSchema: getBlockInput,
      annotations: READ_ONLY,
    },
    {
      name: 'list_block_children',
      description:
        "List a page's or block's direct children, one page at a time: pass next_cursor back as start_cursor to continue. Deeply nested content needs recursive calls; blocks are never auto-fetched.",
      inputSchema: listBlockChildrenInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_database',
      description:
        'Get one database: title, description, and its data sources (the queryable views). Use a data source id from dataSources with query_data_source to read rows.',
      inputSchema: getDatabaseInput,
      annotations: READ_ONLY,
    },
    {
      name: 'query_data_source',
      description:
        'Query rows of one data source, with optional filter and sorts. One page at a time: pass next_cursor back as start_cursor to continue.',
      inputSchema: queryDataSourceInput,
      annotations: READ_ONLY,
    },
  ];
}

// -- Output normalization ----------------------------------------------------

const propertyValueSchema = z
  .object({
    /** Property name as configured in the data source. */
    name: z.string().min(1),
    /** The property type Notion reported. Always recorded, even for types the renderer cannot turn into text. */
    type: z.string().min(1),
    /** Best-effort plain-text rendering; `null` means "present but not rendered" — the type above says which. */
    text: z.string().nullable(),
  })
  .strict();
export type PropertyValue = z.infer<typeof propertyValueSchema>;

const parentRefSchema = z
  .object({ type: z.string().min(1), id: z.string().nullable() })
  .strict();

const blockSummarySchema = z
  .object({
    id: z.string().min(1),
    /** Notion's block type. Unknown/future types are recorded, not dropped. */
    type: z.string().min(1),
    text: z.string().nullable(),
    hasChildren: z.boolean(),
    inTrash: z.boolean(),
    createdTime: z.string().nullable(),
    lastEditedTime: z.string().nullable(),
  })
  .strict();
export type BlockSummary = z.infer<typeof blockSummarySchema>;

const pageDetailSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().nullable(),
    title: z.string().nullable(),
    archived: z.boolean(),
    inTrash: z.boolean(),
    parent: parentRefSchema,
    createdTime: z.string().nullable(),
    lastEditedTime: z.string().nullable(),
    properties: z.array(propertyValueSchema),
  })
  .strict();
export type PageDetail = z.infer<typeof pageDetailSchema>;

const searchResultSchema = z
  .object({
    objectType: z.enum(['page', 'data_source']),
    id: z.string().min(1),
    title: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();
export type SearchResult = z.infer<typeof searchResultSchema>;

const databaseDetailSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    description: z.string().nullable(),
    url: z.string().nullable(),
    isInline: z.boolean(),
    inTrash: z.boolean(),
    createdTime: z.string().nullable(),
    lastEditedTime: z.string().nullable(),
    dataSources: z.array(z.object({ id: z.string().min(1), name: z.string().nullable() }).strict()),
  })
  .strict();
export type DatabaseDetail = z.infer<typeof databaseDetailSchema>;

const dataRowSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().nullable(),
    createdTime: z.string().nullable(),
    lastEditedTime: z.string().nullable(),
    properties: z.array(propertyValueSchema),
  })
  .strict();
export type DataRow = z.infer<typeof dataRowSchema>;

/** A cursor-paginated Notion list envelope, defensively read. */
export interface ListEnvelope {
  results: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/** Joins a rich_text array into its plain text. `null` when the shape is not an array. */
function plainText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let text = '';
  for (const item of value) {
    if (isRecord(item) && typeof item.plain_text === 'string') text += item.plain_text;
  }
  return text;
}

/** One date object: `start`, or `start to end`. */
function dateText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const start = str(value, 'start');
  if (start === null) return null;
  const end = str(value, 'end');
  return end === null ? start : `${start} to ${end}`;
}

/**
 * Renders one page-property value to plain text. The property's `type` is
 * always reported alongside, so a `null` text is an honest "present but not
 * rendered" — never a silent drop. Relation/rollup arrays Notion truncates at
 * 25 entries in page responses are rendered with what the response carries.
 */
function propertyText(source: Record<string, unknown>): string | null {
  const type = str(source, 'type');
  if (type === null) return null;
  const value = source[type];

  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(value);
    case 'number':
      return num(source, type) === null ? null : String(value);
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof value === 'string' ? value : null;
    case 'checkbox':
      return typeof value === 'boolean' ? String(value) : null;
    case 'select':
    case 'status':
      return isRecord(value) ? str(value, 'name') : null;
    case 'multi_select': {
      if (!Array.isArray(value)) return null;
      return value
        .map((option) => (isRecord(option) ? str(option, 'name') : null))
        .filter((name): name is string => name !== null)
        .join(', ');
    }
    case 'date':
      return dateText(value);
    case 'people': {
      if (!Array.isArray(value)) return null;
      return value.map((user) => (isRecord(user) ? str(user, 'name') ?? str(user, 'id') : null))
        .filter((name): name is string => name !== null)
        .join(', ');
    }
    case 'relation': {
      if (!Array.isArray(value)) return null;
      return value.map((ref) => (isRecord(ref) ? str(ref, 'id') : null))
        .filter((id): id is string => id !== null)
        .join(', ');
    }
    case 'files': {
      if (!Array.isArray(value)) return null;
      return value.map((file) => (isRecord(file) ? str(file, 'name') : null))
        .filter((name): name is string => name !== null)
        .join(', ');
    }
    case 'created_by':
    case 'last_edited_by':
      return isRecord(value) ? str(value, 'name') ?? str(value, 'id') : null;
    case 'created_time':
    case 'last_edited_time':
      return str(source, type);
    case 'unique_id': {
      if (!isRecord(value)) return null;
      const number = num(value, 'number');
      if (number === null) return null;
      return `${str(value, 'prefix') ?? ''}${number}`;
    }
    case 'verification':
      return isRecord(value) ? str(value, 'state') : null;
    case 'formula': {
      if (!isRecord(value)) return null;
      const kind = str(value, 'type');
      if (kind === 'string' || kind === 'number' || kind === 'boolean') {
        const scalar = value[kind];
        return typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean'
          ? String(scalar)
          : null;
      }
      return kind === 'date' ? dateText(value.date) : null;
    }
    case 'rollup': {
      if (!isRecord(value)) return null;
      const kind = str(value, 'type');
      if (kind === 'number') return num(value, 'number') === null ? null : String(value.number);
      if (kind === 'string') return typeof value.string === 'string' ? value.string : null;
      return kind === 'date' ? dateText(value.date) : null;
    }
    default:
      // button, place, unsupported, and future property types.
      return null;
  }
}

function pageProperties(properties: unknown): PropertyValue[] {
  if (!isRecord(properties)) return [];
  const rendered: PropertyValue[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const type = str(value, 'type');
    if (type === null) continue;
    rendered.push({ name, type, text: propertyText(value) });
  }
  return rendered;
}

/** A page's title: the one `title`-type property, joined. */
function pageTitle(source: Record<string, unknown>): string | null {
  const properties = source.properties;
  if (!isRecord(properties)) return null;
  for (const value of Object.values(properties)) {
    if (isRecord(value) && str(value, 'type') === 'title') return plainText(value.title);
  }
  return null;
}

/** Parent refs share one shape: `{type, id}`, `workspace` carrying no id. */
function parentRef(parent: unknown): { type: string; id: string | null } {
  if (!isRecord(parent)) return { type: 'unknown', id: null };
  const type = str(parent, 'type') ?? 'unknown';
  const id =
    str(parent, 'page_id') ?? str(parent, 'database_id') ?? str(parent, 'data_source_id') ?? str(parent, 'block_id');
  return { type, id };
}

/**
 * One block's best-effort plain text. Media/embed URLs are rendered as text
 * and never fetched. Unknown/future block types return `null` — the block's
 * `type` is still recorded by the caller, so nothing is silently dropped.
 */
function blockText(source: Record<string, unknown>, type: string): string | null {
  const body = source[type];
  const rich = (): string | null => (isRecord(body) ? plainText(body.rich_text) : null);

  switch (type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
    case 'toggle':
    case 'template':
    case 'callout':
    case 'code':
      return rich();
    case 'to_do': {
      if (!isRecord(body)) return null;
      const text = plainText(body.rich_text);
      return text === null ? null : `${body.checked === true ? '[x]' : '[ ]'} ${text}`;
    }
    case 'child_page':
    case 'child_database':
      return isRecord(body) ? str(body, 'title') : null;
    case 'equation':
      return isRecord(body) ? str(body, 'expression') : null;
    case 'link_to_page':
      if (!isRecord(body)) return null;
      return str(body, 'page_id') ?? str(body, 'database_id') ?? str(body, 'comment_id');
    case 'embed':
    case 'bookmark':
    case 'link_preview':
      return isRecord(body) ? str(body, 'url') : null;
    case 'image':
    case 'video':
    case 'pdf':
    case 'audio':
    case 'file': {
      if (!isRecord(body)) return null;
      const caption = plainText(body.caption);
      if (caption !== null && caption !== '') return caption;
      return str(body, 'name');
    }
    case 'table_row': {
      if (!isRecord(body) || !Array.isArray(body.cells)) return null;
      return body.cells.map((cell) => plainText(cell) ?? '').join(' | ');
    }
    case 'unsupported': {
      const underlying = isRecord(body) ? str(body, 'block_type') : null;
      return underlying === null ? null : `[unsupported: ${underlying}]`;
    }
    default:
      // divider, breadcrumb, table_of_contents, tab, column_list, column,
      // table, synced_block, meeting_notes, and future block types.
      return null;
  }
}

/**
 * Identity fields carry no fallback: a Notion object without an id is a shape
 * failure and the entry is dropped — same policy as the GitHub normalizers.
 * The candidate is then enforced through the declared `.strict()` schema, so
 * a future edit that renames a field is a dropped entry, never a silent
 * shape change on the wire.
 */
export function normalizeBlockSummary(source: unknown): BlockSummary | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const type = str(source, 'type') ?? 'unknown';
  const candidate = {
    id,
    type,
    text: blockText(source, type),
    hasChildren: bool(source, 'has_children'),
    inTrash: bool(source, 'in_trash'),
    createdTime: str(source, 'created_time'),
    lastEditedTime: str(source, 'last_edited_time'),
  };
  return blockSummarySchema.safeParse(candidate).success ? (candidate as BlockSummary) : undefined;
}

export function normalizePageDetail(source: unknown): PageDetail | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const candidate = {
    id,
    url: str(source, 'url'),
    title: pageTitle(source),
    archived: bool(source, 'is_archived'),
    inTrash: bool(source, 'in_trash'),
    parent: parentRef(source.parent),
    createdTime: str(source, 'created_time'),
    lastEditedTime: str(source, 'last_edited_time'),
    properties: pageProperties(source.properties),
  };
  return pageDetailSchema.safeParse(candidate).success ? (candidate as PageDetail) : undefined;
}

export function normalizeDataRow(source: unknown): DataRow | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const candidate = {
    id,
    url: str(source, 'url'),
    createdTime: str(source, 'created_time'),
    lastEditedTime: str(source, 'last_edited_time'),
    properties: pageProperties(source.properties),
  };
  return dataRowSchema.safeParse(candidate).success ? (candidate as DataRow) : undefined;
}

/** Search returns pages and data sources; the closed set is those two. */
export function normalizeSearchEntry(source: unknown): SearchResult | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const candidate = (() => {
    switch (str(source, 'object')) {
      case 'page':
        return { objectType: 'page', id, title: pageTitle(source), url: str(source, 'url') };
      case 'data_source':
        return {
          objectType: 'data_source',
          id,
          // A data source's title is a rich_text array, like a database's.
          title: plainText(source.title),
          url: str(source, 'url'),
        };
      default:
        return undefined;
    }
  })();
  if (candidate === undefined) return undefined;
  return searchResultSchema.safeParse(candidate).success ? (candidate as SearchResult) : undefined;
}

export function normalizeDatabaseDetail(source: unknown): DatabaseDetail | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const dataSources = Array.isArray(source.data_sources)
    ? source.data_sources
        .map((entry) => (isRecord(entry) ? { id: str(entry, 'id'), name: str(entry, 'name') } : undefined))
        .filter((entry): entry is { id: string; name: string | null } => entry !== undefined && entry.id !== null)
    : [];
  const candidate = {
    id,
    title: plainText(source.title),
    description: plainText(source.description),
    url: str(source, 'url'),
    isInline: bool(source, 'is_inline'),
    inTrash: bool(source, 'in_trash'),
    createdTime: str(source, 'created_time'),
    lastEditedTime: str(source, 'last_edited_time'),
    dataSources,
  };
  return databaseDetailSchema.safeParse(candidate).success ? (candidate as DatabaseDetail) : undefined;
}

/** Reads a cursor-paginated envelope: `results`, `next_cursor`, `has_more`. */
export function notionListEnvelope(value: unknown): ListEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  return {
    results: Array.isArray(value.results) ? value.results : [],
    nextCursor: str(value, 'next_cursor'),
    hasMore: bool(value, 'has_more'),
  };
}

/**
 * Catalog fixtures: more than one backend, with deliberately overlapping tool
 * names.
 *
 *   node --import tsx tests/fixtures/catalog-fixture.ts a
 *   node --import tsx tests/fixtures/catalog-fixture.ts a2
 *   node --import tsx tests/fixtures/catalog-fixture.ts b
 *
 * Backend "a" and backend "b" both advertise `get_status`, which is the point:
 * the gateway must withhold both rather than route by discovery order.
 *
 * Built on the low-level `Server` rather than `McpServer` so the advertised
 * schemas are exact JSON — including a `$ref`/`$defs` pair that must survive
 * `tools/list` untouched, and one tool whose schema cannot be compiled.
 *
 * Test-only file. Nothing here is reachable from production configuration.
 */
import { Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'a';

/** Proves the gateway forwards remote JSON Schema verbatim. */
const searchSchema = {
  type: 'object',
  $defs: {
    Filter: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
      additionalProperties: false,
    },
  },
  properties: {
    filter: { $ref: '#/$defs/Filter' },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['filter'],
  additionalProperties: false,
  'x-fixture': 'preserved',
};

/** Unresolvable `$ref`: compiles in no validator, so the gateway must forward unvalidated. */
const brokenSchema = {
  type: 'object',
  properties: { value: { $ref: '#/$defs/missing' } },
};

const echo = (label: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ backend: label }) }],
});

const TOOLS: Record<string, Array<{ tool: Tool; handler: (args: Record<string, unknown>) => unknown }>> = {
  a: [
    {
      tool: { name: 'get_status', description: 'Status from backend A', inputSchema: { type: 'object', properties: {} } },
      handler: () => echo('a'),
    },
    {
      tool: { name: 'search_items', description: 'Search A', inputSchema: searchSchema as never },
      handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify({ backend: 'a', tool: 'search_items', args }) }] }),
    },
    {
      tool: {
        name: 'echo',
        description: 'Echo args',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify({ backend: 'a', args }) }] }),
    },
    {
      tool: { name: 'broken_schema', description: 'Uncompilable schema', inputSchema: brokenSchema as never },
      handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify({ backend: 'a', tool: 'broken_schema', args }) }] }),
    },
    {
      tool: {
        name: 'slow',
        description: 'Sleeps, then answers',
        inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
      },
      handler: async (args) => {
        const ms = typeof args['ms'] === 'number' ? args['ms'] : 5_000;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ backend: 'a', slept: ms }) }] };
      },
    },
  ],
  // Same backend, different catalog: exercises add/remove on refresh.
  a2: [
    {
      tool: { name: 'get_status', description: 'Status from backend A', inputSchema: { type: 'object', properties: {} } },
      handler: () => echo('a'),
    },
    {
      tool: {
        name: 'brand_new',
        description: 'Only in a2',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => echo('a2'),
    },
  ],
  b: [
    {
      tool: { name: 'get_status', description: 'Status from backend B', inputSchema: { type: 'object', properties: {} } },
      handler: () => echo('b'),
    },
    {
      tool: {
        name: 'create_item',
        description: 'Create an item',
        inputSchema: {
          type: 'object',
          properties: { kind: { enum: ['a', 'b'] }, name: { type: 'string' } },
          required: ['kind', 'name'],
        },
      },
      handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify({ backend: 'b', tool: 'create_item', args }) }] }),
    },
    {
      tool: { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
      handler: () => ({ content: [{ type: 'text', text: 'fixture: tool failure' }], isError: true }),
    },
  ],
  // Malformed metadata the SDK client will carry but the gateway must not
  // advertise. (`inputSchema` itself cannot be omitted here: the SDK's own
  // client rejects the whole list, which is why `toDefinition` is also unit
  // tested directly below.)
  bad: [
    { tool: { name: '', inputSchema: { type: 'object' } } as never, handler: () => echo('bad') },
    {
      tool: {
        name: 'still_good',
        description: 'Survives a bad neighbour',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => echo('bad'),
    },
  ],
  // Connects fine but cannot list: exercises the partial-failure path.
  listfail: [
    {
      tool: { name: 'unreachable_list', inputSchema: { type: 'object', properties: {} } },
      handler: () => echo('listfail'),
    },
  ],
  // Phase 14 interop shapes: schemas and results that stress what a real
  // client must round-trip. Test-only, like every other mode here.
  shapes: [
    {
      tool: {
        name: 'report_card',
        description: 'Nested, array, enum, and nullable inputs; structured output',
        inputSchema: {
          type: 'object',
          properties: {
            student: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                grade: { type: 'integer', minimum: 0, maximum: 100 },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'grade'],
              additionalProperties: false,
            },
            mood: { enum: ['calm', 'excited'] },
            note: { type: ['string', 'null'] },
          },
          required: ['student', 'mood'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            grade: { type: 'integer' },
          },
          required: ['summary', 'grade'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const student = args['student'] as { name?: unknown } | undefined;
        return {
          content: [{ type: 'text' as const, text: `card for ${String(student?.name ?? '?')}` }],
          structuredContent: {
            summary: `mood=${String(args['mood'])} note=${args['note'] === null ? 'null' : 'present'}`,
            grade: 88,
          },
        };
      },
    },
    {
      tool: {
        name: 'unicode_echo',
        description: 'Round-trips text most terminals and JSON parsers mangle',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      handler: (args) => ({
        content: [{ type: 'text' as const, text: `回显 “${String(args['text'])}” ✓ emoji: 🛠️` }],
      }),
    },
    {
      tool: {
        name: 'multi_block',
        description: 'Answers with several content blocks',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => ({
        content: [
          { type: 'text' as const, text: 'first block' },
          { type: 'text' as const, text: 'second block' },
        ],
      }),
    },
    {
      tool: {
        name: 'big_payload',
        description: 'A large but permitted response',
        inputSchema: {
          type: 'object',
          properties: { kilobytes: { type: 'integer', minimum: 1, maximum: 512 } },
          required: ['kilobytes'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const kilobytes = Number(args['kilobytes'] ?? 1);
        return { content: [{ type: 'text' as const, text: 'x'.repeat(kilobytes * 1024) }] };
      },
    },
    {
      tool: {
        name: 'explode',
        description: 'A tool-level failure: an isError result, never a protocol error',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => ({ content: [{ type: 'text' as const, text: 'fixture: tool failure' }], isError: true }),
    },
  ],
};

const entries = TOOLS[mode];
if (entries === undefined) {
  process.stderr.write(`fixture: unknown mode "${mode}"\n`);
  process.exit(2);
}

serveStdio(() => {
  const server = new Server({ name: `catalog-fixture-${mode}`, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', () => {
    if (mode === 'listfail') throw new Error('fixture: listing is broken');
    return { tools: entries.map((entry) => entry.tool) };
  });

  server.setRequestHandler('tools/call', async (request) => {
    const entry = entries.find((candidate) => candidate.tool.name === request.params.name);
    if (entry === undefined) throw new Error(`fixture: no tool "${request.params.name}"`);
    return (await entry.handler((request.params.arguments ?? {}) as Record<string, unknown>)) as never;
  });

  return server;
});

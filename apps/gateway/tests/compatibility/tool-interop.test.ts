import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './harness.js';

/**
 * Scenario E — tool interoperability, from a client's chair.
 *
 * Real clients pass real payloads: nested objects, arrays, enums, nullables,
 * unicode, big results, multi-block content, and structured output. The
 * `shapes` fixture mode answers with all of them, so every assertion below is
 * a full wire round-trip through the gateway and a stdio subprocess.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

let backendId: string;

beforeEach(async () => {
  backendId = await h.backend('shapes', 'shapes');
});

const name = (tool: string): string => `${backendId}__${tool}`;

describe('tool interoperability', () => {
  it('round-trips nested objects, arrays, enums, and nullable inputs', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const result = await client.callTool({
      name: name('report_card'),
      arguments: { student: { name: 'Ada', grade: 95, tags: ['math', 'art'] }, mood: 'calm', note: null },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'card for Ada' }]);
    expect(result.structuredContent).toEqual({ summary: 'mood=calm note=null', grade: 88 });
  });

  it('rejects an enum violation through the same InvalidParams the client expects', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    await expect(
      client.callTool({
        name: name('report_card'),
        arguments: { student: { name: 'Ada', grade: 95 }, mood: 'angry' },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('forwards the nested input schema and the output schema verbatim to the client', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const card = (await client.listTools()).tools.find((tool) => tool.name === name('report_card'))!;

    const input = card.inputSchema as Record<string, unknown>;
    const properties = input['properties'] as Record<string, unknown>;
    const student = properties['student'] as Record<string, unknown>;
    expect(student['required']).toEqual(['name', 'grade']);
    expect(student['additionalProperties']).toBe(false);

    const output = card.outputSchema as Record<string, unknown> | undefined;
    expect(output).toBeDefined();
    expect((output!['required'] as string[]).sort()).toEqual(['grade', 'summary']);
  });

  it('round-trips unicode text without loss', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const result = await client.callTool({ name: name('unicode_echo'), arguments: { text: '混合 テキスト 🎉' } });
    expect((result.content[0] as { text: string }).text).toContain('混合 テキスト 🎉');
    expect((result.content[0] as { text: string }).text).toContain('✓');
  });

  it('delivers multiple content blocks in order', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const result = await client.callTool({ name: name('multi_block'), arguments: {} });
    expect(result.content).toEqual([
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second block' },
    ]);
  });

  it('delivers a large response intact', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const kilobytes = 256;
    const result = await client.callTool({ name: name('big_payload'), arguments: { kilobytes } });
    expect(((result.content[0] as { text: string }).text ?? '').length).toBe(kilobytes * 1024);
  });

  it('surfaces a tool-level failure as an isError result, not a protocol error', async () => {
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const result = await client.callTool({ name: name('explode'), arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('fixture: tool failure');

    // The gateway is fine afterwards.
    const next = await client.callTool({ name: name('unicode_echo'), arguments: { text: 'still alive' } });
    expect(next.isError).toBeFalsy();
  });
});

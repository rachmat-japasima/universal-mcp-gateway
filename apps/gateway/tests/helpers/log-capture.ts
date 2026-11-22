import type { DestinationStream } from 'pino';

/**
 * In-memory pino capture. The production logger writes to stdout; assertions
 * need the serialized lines as parsed objects, so tests pass this as the
 * logger `destination`.
 */
export function captureLog(): { stream: DestinationStream; lines(): Record<string, unknown>[] } {
  const collected: Record<string, unknown>[] = [];

  return {
    stream: {
      write(line: string) {
        collected.push(JSON.parse(line));
      },
    },
    lines: () => collected,
  };
}

import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

const MARKER = 'fake-content-marker-for-logger-test';

function capture(): { lines: string[]; stream: { write: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

describe('createLogger', () => {
  it('writes the fields it is given', () => {
    const { lines, stream } = capture();
    createLogger('info', stream).info({ repo: 'octo/demo', files: 3 }, 'expanded repo');
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record['repo']).toBe('octo/demo');
    expect(record['files']).toBe(3);
    expect(record['msg']).toBe('expanded repo');
  });

  it('redacts content and token fields at the top level and one level down', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info({ content: MARKER, token: MARKER }, 'slip');
    logger.info({ file: { content: MARKER, text: MARKER } }, 'slip');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(MARKER);
      expect(line).toContain('[redacted]');
    }
  });

  it('respects the configured level', () => {
    const { lines, stream } = capture();
    createLogger('warn', stream).info('dropped');
    expect(lines).toHaveLength(0);
  });
});

import { destination as pinoDestination, pino, type DestinationStream, type Logger } from 'pino';
import type { Env } from './env.js';

/**
 * The collector logs counts, repo names, query ids and API status. It never
 * logs file content or any value read out of a file (rubric §4, C-1): call
 * sites pass only those fields. The redact paths are a backstop for the keys
 * most likely to carry content or a credential if a call site slips.
 */
export const REDACT_PATHS = [
  'content',
  '*.content',
  'text',
  '*.text',
  'token',
  '*.token',
  'headers.authorization',
  '*.headers.authorization',
  'err.request.headers.authorization',
  'err.response.data',
];

/**
 * Logs go to stderr by default, so stdout stays free for the CLI's own output.
 * Tests pass a destination to read what was written.
 */
export function createLogger(
  level: Env['LOG_LEVEL'],
  destination: DestinationStream = pinoDestination(2),
): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, destination);
}

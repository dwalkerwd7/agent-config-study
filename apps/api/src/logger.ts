import { pino, type Logger } from 'pino';
import { loadEnv } from './env.js';

const env = loadEnv();

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could carry a token out of a scanned config.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.access_token'],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});

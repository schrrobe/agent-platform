import pino, { type Logger } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Strukturiertes Logging (Pino). In der Entwicklung via pino-pretty lesbar,
 * in Produktion JSON auf stdout. Pro Job wird ein Child-Logger mit
 * Korrelations-ID (jobId) verwendet.
 */
export function createLogger(config: AppConfig): Logger {
  const pretty =
    config.nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {};
  return pino({ level: config.logLevel, ...pretty });
}

export type { Logger };

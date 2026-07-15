import winston from 'winston';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

if (!fs.existsSync(config.logsDir)) {
  fs.mkdirSync(config.logsDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, splat } = winston.format;

const fmt = printf(({ level, message, timestamp: ts, service }) => {
  const svc = service ? `[${service}] ` : '';
  return `${ts} ${level} ${svc}${message}`;
});

export const logger = winston.createLogger({
  level: 'info',
  format: combine(splat(), timestamp({ format: 'HH:mm:ss.SSS' }), fmt),
  transports: [
    new winston.transports.Console({
      format: combine(splat(), colorize(), timestamp({ format: 'HH:mm:ss.SSS' }), fmt),
    }),
    new winston.transports.File({
      filename: path.join(config.logsDir, 'bot.log'),
      level: 'debug',
    }),
    new winston.transports.File({
      filename: path.join(config.logsDir, 'error.log'),
      level: 'error',
    }),
  ],
});

export function service(name: string): winston.Logger {
  return logger.child({ service: name });
}

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
      maxsize: 20 * 1024 * 1024, // 20MB por arquivo
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(config.logsDir, 'error.log'),
      level: 'error',
      maxsize: 20 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export function service(name: string): winston.Logger {
  return logger.child({ service: name });
}

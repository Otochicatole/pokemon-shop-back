import pino from 'pino';
import { env } from '../config/env.js';

const loggerOptions: pino.LoggerOptions = {
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'secret', 'accessToken'],
};
if (env.NODE_ENV === 'development') loggerOptions.transport = { target: 'pino-pretty', options: { colorize: true } };
export const logger = pino(loggerOptions);

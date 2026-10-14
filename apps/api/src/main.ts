// reflect-metadata first: decorators record constructor parameter types through it
// while the modules below are evaluated.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const logger = new Logger('Main');

try {
  const config = loadConfig(process.env);
  const app = await createApp(config);
  try {
    await app.listen(config.http.port, config.http.host);
  } catch (error) {
    await app.close();
    throw error;
  }
  logger.log(`${config.instance} listening on ${config.http.host}:${config.http.port}`);
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

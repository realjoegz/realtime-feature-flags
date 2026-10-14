import { type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { type Config } from './config.js';

export interface CreateAppOptions {
  readonly logger?: LogLevel[] | false;
}

// Rejects, instead of exiting the process, when a provider fails: the pool factory
// refuses a privileged role and gives up on an unreachable database that way.
export async function createApp(
  config: Config,
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    abortOnError: false,
    // Without this, close() waits for idle keep-alive sockets (about 4 s) and for
    // open streams.
    forceCloseConnections: true,
    logger: options.logger ?? ['log', 'warn', 'error'],
  });
  // SIGTERM and SIGINT run the shutdown hooks: the HTTP server closes and the pool ends.
  app.enableShutdownHooks();
  return app;
}

import { type DynamicModule, Module } from '@nestjs/common';
import { type Config } from './config.js';
import { PoolCloser, poolProvider } from './database/database.providers.js';
import { TenantDatabase } from './database/tenant-database.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        poolProvider,
        PoolCloser,
        TenantDatabase,
        HealthService,
      ],
    };
  }
}

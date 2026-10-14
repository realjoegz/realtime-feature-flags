import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { AccessGuard } from './auth/access.guard.js';
import { RouteAccessCheck } from './auth/route-access-check.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { type Config } from './config.js';
import { PoolCloser, poolProvider } from './database/database.providers.js';
import { TenantDatabase } from './database/tenant-database.js';
import { FlagsController } from './flags/flags.controller.js';
import { FlagsService } from './flags/flags.service.js';
import { FLAGS_NOTIFIER, NoopNotifier } from './flags/notifier.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { MeController } from './me/me.controller.js';
import { MembersController } from './members/members.controller.js';
import { SdkKeysController } from './sdk-keys/sdk-keys.controller.js';
import { CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [DiscoveryModule],
      controllers: [
        HealthController,
        MeController,
        FlagsController,
        AuditController,
        MembersController,
        SdkKeysController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        poolProvider,
        PoolCloser,
        TenantDatabase,
        HealthService,
        TokenVerifier,
        // Every request passes the guard; RouteAccessCheck makes sure every route
        // tells it what to require.
        { provide: APP_GUARD, useClass: AccessGuard },
        RouteAccessCheck,
        FlagsService,
        { provide: FLAGS_NOTIFIER, useClass: NoopNotifier },
      ],
    };
  }
}

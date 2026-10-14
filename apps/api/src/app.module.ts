import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { AccessGuard } from './auth/access.guard.js';
import { RouteAccessCheck } from './auth/route-access-check.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { type Config } from './config.js';
import { PoolCloser, poolProvider } from './database/database.providers.js';
import { TenantDatabase } from './database/tenant-database.js';
import { FlagsCache } from './flags/flags-cache.js';
import { FlagsController } from './flags/flags.controller.js';
import { FlagsService } from './flags/flags.service.js';
import { FLAGS_NOTIFIER } from './flags/notifier.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { MeController } from './me/me.controller.js';
import { MembersController } from './members/members.controller.js';
import { SdkKeysController } from './sdk-keys/sdk-keys.controller.js';
import { RedisConnection } from './redis/redis-connection.js';
import { ChangeBus } from './stream/change-bus.js';
import { SafetyPoll } from './stream/safety-poll.js';
import { SnapshotReader } from './stream/snapshot-reader.js';
import { StreamController } from './stream/stream.controller.js';
import { StreamHub } from './stream/stream-hub.js';
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
        StreamController,
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
        RedisConnection,
        FlagsCache,
        SnapshotReader,
        StreamHub,
        ChangeBus,
        SafetyPoll,
        // After a flag write commits, the change bus tells every instance, this one
        // included, to bring its streams of that tenant up to date.
        { provide: FLAGS_NOTIFIER, useExisting: ChangeBus },
      ],
    };
  }
}

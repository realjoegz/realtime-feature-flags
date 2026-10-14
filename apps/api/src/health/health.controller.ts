import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { type Config } from '../config.js';
import { Access } from '../auth/access.js';
import { CONFIG } from '../tokens.js';
import { HealthService } from './health.service.js';

export interface HealthBody {
  readonly status: 'ok' | 'unavailable';
  readonly instance: string;
}

// Public. The compose healthcheck and scripts/demo.sh call it on each replica.
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get('health')
  @Access('public')
  async check(): Promise<HealthBody> {
    if (await this.health.databaseAnswers()) {
      return { status: 'ok', instance: this.config.instance };
    }
    throw new ServiceUnavailableException({
      status: 'unavailable',
      instance: this.config.instance,
    });
  }
}

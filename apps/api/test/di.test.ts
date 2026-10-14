import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { type Config } from '../src/config.js';
import { HealthController } from '../src/health/health.controller.js';
import { HealthService } from '../src/health/health.service.js';
import { CONFIG, PG_POOL } from '../src/tokens.js';

// Nest finds a constructor's dependencies in the design:paramtypes metadata that the
// compiler emits for decorated classes when emitDecoratorMetadata is on. These tests
// fail if the metadata goes missing, whichever transform compiles them.

const config = { instance: 'di-test' } as Config;
const answeringPool = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as pg.Pool;

describe('dependency injection under Vitest', () => {
  it('a provider with a constructor-injected class dependency resolves', async () => {
    expect(Reflect.getMetadata('design:paramtypes', HealthController)).toEqual([
      HealthService,
      Object,
    ]);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PG_POOL, useValue: answeringPool },
        { provide: CONFIG, useValue: config },
      ],
    }).compile();
    try {
      const controller = moduleRef.get(HealthController);
      expect(await controller.check()).toEqual({ status: 'ok', instance: 'di-test' });
    } finally {
      await moduleRef.close();
    }
  });

  it('control: a class without decorators has no parameter metadata and gets undefined', async () => {
    class Undecorated {
      constructor(readonly health: HealthService) {}
    }
    expect(Reflect.getMetadata('design:paramtypes', Undecorated)).toBeUndefined();
    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, Undecorated, { provide: PG_POOL, useValue: answeringPool }],
    }).compile();
    try {
      expect(moduleRef.get(Undecorated).health).toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });
});

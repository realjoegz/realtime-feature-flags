import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Config } from '../config.js';
import { CONFIG } from '../tokens.js';
import { StreamHub } from './stream-hub.js';

/**
 * Redis pub/sub delivers each notification at most once, so every RFF_SAFETY_POLL_MS
 * (5 s by default) the instance wakes each tenant it has open streams for. A
 * tenant whose clients are up to date costs one read of its version.
 */
@Injectable()
export class SafetyPoll implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** How many times the poll has run. */
  rounds = 0;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly hub: StreamHub,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.config.stream.safetyPollMs;
    if (intervalMs === null) return;
    this.timer = setInterval(() => {
      this.rounds += 1;
      this.hub.wakeAll('poll');
    }, intervalMs);
    // The HTTP server keeps the process alive; the poll alone should not.
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

import { Injectable } from '@nestjs/common';
import type { FlagsChange, FlagsNotifier } from '../flags/notifier.js';
import { StreamHub } from './stream-hub.js';

/**
 * Wakes this instance's stream fan-out for the tenant of each committed change. It
 * returns at once: the read and the sends run after the write has answered.
 */
@Injectable()
export class InProcessNotifier implements FlagsNotifier {
  constructor(private readonly hub: StreamHub) {}

  async flagsChanged(change: FlagsChange): Promise<void> {
    this.hub.wake(change.tenantId);
  }
}

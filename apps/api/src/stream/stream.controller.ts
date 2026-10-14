import { Controller, Headers, type MessageEvent, Query, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { Access } from '../auth/access.js';
import { CurrentSdkTenant, type SdkScope } from '../auth/request-auth.js';
import { invalid } from '../http/errors.js';
import { NO_CURSOR, StreamHub } from './stream-hub.js';

const VERSION = /^(0|[1-9][0-9]{0,15})$/;

/**
 * The version the client holds: Last-Event-ID when the request has one, else the
 * cursor query parameter, else none. Anything that is not a version gets 400.
 */
export function streamCursor(lastEventId: unknown, cursor: unknown): number {
  const raw = typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : cursor;
  if (raw === undefined || raw === '') return NO_CURSOR;
  if (typeof raw !== 'string' || !VERSION.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw invalid('cursor', [`cursor: must be a version, an integer from 0 to ${2 ** 53 - 1}`]);
  }
  return Number(raw);
}

@Controller('sdk')
export class StreamController {
  constructor(private readonly hub: StreamHub) {}

  /**
   * Server-sent events for the SDK key's tenant. When the tenant's version is above
   * the client's, the snapshot comes at once; after that, each change's snapshot.
   * Every data event has id = version, event = snapshot and the snapshot's JSON as
   * data. Heartbeats are comment frames with no id.
   */
  @Sse('stream')
  @Access('sdk-key')
  stream(
    @CurrentSdkTenant() sdk: SdkScope,
    @Headers('last-event-id') lastEventId: unknown,
    @Query('cursor') cursor: unknown,
  ): Observable<MessageEvent> {
    return this.hub.stream(sdk.tenantId, streamCursor(lastEventId, cursor));
  }
}

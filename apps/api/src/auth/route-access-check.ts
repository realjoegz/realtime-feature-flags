import { Injectable, type OnModuleInit } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { accessOf } from './access.js';

/** Start-up stops when a route handler has no @Access declaration. */
export class UndeclaredAccessError extends Error {
  constructor(readonly handlers: readonly string[]) {
    super(
      `refusing to start: route handlers without @Access: ${handlers.join(', ')}. ` +
        "Declare 'public', 'signed-in' or the minimum role on each.",
    );
    this.name = 'UndeclaredAccessError';
  }
}

// Nest calls onModuleInit during app.init() and app.listen(), after the routes are
// registered and before the server accepts a connection, and a throw here makes both
// reject. Every controller of every module is checked, not only AppModule's.
@Injectable()
export class RouteAccessCheck implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const undeclared = this.discovery.getControllers().flatMap((wrapper) => {
      const controller = wrapper.metatype as (abstract new () => object) | null | undefined;
      if (typeof controller !== 'function') return [];
      const prototype = controller.prototype as Record<string, unknown>;
      return this.scanner.getAllMethodNames(prototype).flatMap((name) => {
        const handler = prototype[name];
        if (typeof handler !== 'function') return [];
        const isRoute =
          Reflect.hasMetadata(PATH_METADATA, handler) &&
          Reflect.hasMetadata(METHOD_METADATA, handler);
        return isRoute && accessOf(handler) === undefined ? [`${controller.name}.${name}`] : [];
      });
    });
    if (undeclared.length > 0) throw new UndeclaredAccessError(undeclared.toSorted());
  }
}

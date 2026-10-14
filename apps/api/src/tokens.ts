// Injection tokens for values that are not classes.

/** The Config object from loadConfig(). */
export const CONFIG = Symbol('CONFIG');

/** The pg.Pool connected as the app role, created after the role check passed. */
export const PG_POOL = Symbol('PG_POOL');

/**
 * Lookups by a key that came from a file or an operation. An id such as `constructor` passes the id pattern, and a
 * plain object answers it from Object.prototype, so a lookup by such a key reads only what the object holds itself.
 */
export const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

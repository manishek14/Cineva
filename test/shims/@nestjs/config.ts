// Minimal shim for @nestjs/config - provides a ConfigService stub that
// reads from a record. Real tests don't use NestJS DI here; they pass
// their own ConfigService stub to constructors.

export class ConfigService {
  private store: Record<string, unknown>;
  constructor(store: Record<string, unknown> = {}) {
    this.store = store;
  }
  get<T = unknown>(key: string, fallback?: T): T {
    if (key in this.store) return this.store[key] as T;
    return fallback as T;
  }
}

import { Global, Module, DynamicModule, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { RedisService } from './redis.service';

export interface RedisModuleOptions {
  /**
   * If true, replaces RedisService with an in-memory mock suitable for tests.
   * Mock is backed by a Map and respects TTL via setTimeout. Real semantics
   * (atomic operations) are simulated with single-threaded JS.
   */
  useMock?: boolean;
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: IORedis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('RedisFactory');
        const host = config.get<string>('REDIS_HOST');
        const port = config.get<number>('REDIS_PORT');
        const password = config.get<string>('REDIS_PASSWORD') || undefined;
        const db = config.get<number>('REDIS_DB', 0);

        if (!host || !port) {
          throw new Error('REDIS_HOST and REDIS_PORT must be set');
        }

        const client = new IORedis({
          host,
          port,
          password,
          db,
          lazyConnect: false,
          enableReadyCheck: true,
          maxRetriesPerRequest: 3,
          retryStrategy: (times) => Math.min(times * 200, 2000),
          reconnectOnError: (err) => {
            const readOnlyErrors = ['READONLY', 'NOAUTH'];
            return readOnlyErrors.some((c) => err.message.includes(c));
          },
        });

        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
        client.on('connect', () => logger.log(`Redis connected at ${host}:${port}/${db}`));
        client.on('reconnecting', (delay: number) =>
          logger.warn(`Redis reconnecting in ${delay}ms`),
        );
        return client;
      },
    },
    RedisService,
  ],
  exports: [RedisService, IORedis],
})
export class RedisModule implements OnModuleDestroy {
  static forRoot(options: RedisModuleOptions = {}): DynamicModule {
    if (options.useMock) {
      // In tests we swap the IORedis client with an in-memory mock.
      return {
        module: RedisModule,
        providers: [
          {
            provide: IORedis,
            useFactory: async () => {
              const { default: IORedisMock } = await import('ioredis-mock');
              return new IORedisMock();
            },
          },
          RedisService,
        ],
        exports: [RedisService, IORedis],
        global: true,
      } as DynamicModule;
    }
    return { module: RedisModule };
  }

  constructor() {}

  async onModuleDestroy() {
    // Connection cleanup is handled by ioredis internally; nothing extra needed.
  }
}

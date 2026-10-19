import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RealtimeService } from './services/realtime.service';
import { RedisSubscriber } from './services/redis-subscriber.service';
import { SeatStatusGateway } from './gateways/seat-status.gateway';

/**
 * RealtimeModule - WebSocket + Redis Pub/Sub infrastructure.
 *
 * Exposes:
 *   - RealtimeService: producer (publish to Redis pub/sub)
 *   - SeatStatusGateway: WebSocket gateway (namespace /realtime)
 *   - RedisSubscriber: consumer (subscribe to Redis pub/sub, forward
 *     to SeatStatusGateway via EventEmitter2)
 *
 * Global so any module can inject RealtimeService without importing
 * RealtimeModule.
 *
 * Note: RedisSubscriber uses a DEDICATED ioredis connection in
 * subscriber mode. It cannot share the RedisModule's ioredis instance
 * because subscriber mode blocks the connection from running normal
 * commands (SET/EXPIRE/etc.).
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot({
      // Use wildcard to support 'realtime:message' style event names.
      wildcard: true,
      // Delimiter for wildcards.
      delimiter: ':',
      // Disable memory leak warning when many listeners exist.
      maxListeners: 50,
    }),
  ],
  providers: [
    RealtimeService,
    RedisSubscriber,
    SeatStatusGateway,
    {
      // Dedicated ioredis connection for the subscriber (in subscriber
      // mode). Built lazily via factory so tests can swap with a mock.
      provide: 'REDIS_SUBSCRIBER_CONNECTION',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST') ?? 'localhost';
        const port = config.get<number>('REDIS_PORT') ?? 6379;
        const password = config.get<string>('REDIS_PASSWORD') || undefined;
        const db = config.get<number>('REDIS_DB', 0);
        const keyPrefix = config.get<string>('REDIS_KEY_PREFIX', 'cineva:');
        return { host, port, password, db, keyPrefix };
      },
    },
  ],
  exports: [RealtimeService, SeatStatusGateway],
})
export class RealtimeModule {}

// Re-export nothing extra - the gateway imports from @nestjs/event-emitter
// directly which keeps the dependency explicit.

import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { REALTIME_CHANNELS } from '../realtime.constants';

/**
 * RedisSubscriber - consumer side.
 *
 * Opens a DEDICATED ioredis connection in subscriber mode and
 * subscribes to all `cineva:events:screening:*` and
 * `cineva:events:reservation:*` channels via psubscribe (pattern
 * matching).
 *
 * When a message arrives, it emits the message via NestJS
 * EventEmitter2 so the SeatStatusGateway can pick it up and forward
 * to the corresponding WebSocket room.
 *
 * Per the ioredis docs: a connection in subscriber mode cannot be
 * used for regular commands, so we open a SEPARATE connection from
 * the one used by RealtimeService for publishing. We can't reuse the
 * RedisModule's ioredis instance because that one is also used for
 * seat-hold SET/EXPIRE commands.
 *
 * For tests: the ioredis-mock supports pub/sub but doesn't support
 * psubscribe patterns out of the box. Use subscribe() with explicit
 * channel names in tests.
 */
@Injectable()
export class RedisSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriber.name);
  private subscriber!: Redis;

  constructor(
    @Inject('REDIS_SUBSCRIBER_CONNECTION')
    private readonly connectionConfig: { host: string; port: number; password?: string; db?: number; keyPrefix: string },
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.subscriber = new IORedis({
      host: this.connectionConfig.host,
      port: this.connectionConfig.port,
      password: this.connectionConfig.password,
      db: this.connectionConfig.db ?? 0,
      keyPrefix: this.connectionConfig.keyPrefix,
      // Subscribers don't need retry limits on commands because they
      // only call subscribe().
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.subscriber.on('error', (err) => {
      this.logger.error(`Redis subscriber error: ${err.message}`);
    });
    this.subscriber.on('connect', () => {
      this.logger.log(`Redis subscriber connected at ${this.connectionConfig.host}:${this.connectionConfig.port}`);
    });

    // Use psubscribe to listen to all screening + reservation channels
    // via glob pattern. New screenings/reservations don't require us
    // to re-subscribe - the pattern catches them automatically.
    this.subscriber.psubscribe(
      `${this.connectionConfig.keyPrefix}${REALTIME_CHANNELS.SCREENING}:*`,
      `${this.connectionConfig.keyPrefix}${REALTIME_CHANNELS.RESERVATION}:*`,
      `${this.connectionConfig.keyPrefix}${REALTIME_CHANNELS.PAYMENT}:*`,
      `${this.connectionConfig.keyPrefix}${REALTIME_CHANNELS.TICKET}:*`,
    ).catch((err: Error) => {
      this.logger.error(`psubscribe failed: ${err.message}`);
    });

    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as { event: string; payload: unknown };
        // Emit via EventEmitter2 so the WebSocket gateway can pick this
        // up and forward to its connected clients.
        this.events.emit('realtime:message', {
          channel,
          event: parsed.event,
          payload: parsed.payload,
        });
      } catch (err) {
        this.logger.warn(`Failed to parse pub/sub message on ${channel}: ${(err as Error).message}`);
      }
    });

    this.subscriber.on('subscribe', (channel: string, _count: number) => {
      this.logger.debug(`Subscribed to ${channel}`);
    });
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
  }

  /**
   * For tests: subscribe to a specific channel (not a pattern).
   * Lets tests verify the round-trip without depending on psubscribe
   * pattern support in ioredis-mock.
   */
  async subscribeChannel(channel: string): Promise<void> {
    if (!this.subscriber) return;
    await this.subscriber.subscribe(channel);
  }
}

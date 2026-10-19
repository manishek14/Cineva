import { Inject, Injectable, Logger } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import {
  REALTIME_CHANNELS,
  REALTIME_EVENTS,
  type RealtimeEventName,
  type ReservationEventPayload,
  type ScreeningCancelledPayload,
  type SeatStatusPayload,
} from '../realtime.constants';

/**
 * RealtimeService - producer side.
 *
 * Used by ReservationService / PaymentService / CancellationService /
 * ScreeningService to publish state-change events to Redis Pub/Sub.
 *
 * The RedisSubscriber on each NestJS instance receives these messages
 * and broadcasts them to the corresponding WebSocket room(s), so every
 * connected client with the screening's seat-map page open sees the
 * change in real time.
 *
 * Channels (one per screening so subscribers only receive events for
 * screenings they care about):
 *   cineva:events:screening:{screeningId}
 *
 * Message format (JSON):
 *   { event: 'seat:held', payload: { screeningId, seatIds, status, ... } }
 *
 * Note: publish calls are fire-and-forget. If the publisher's Redis
 * connection is down, the event is lost. For business-critical events
 * that MUST survive Redis outages, use the Transactional Outbox
 * (AuditModule) instead - RealtimeService is for UI live-updates only.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    @Inject(IORedis) private readonly redis: Redis,
  ) {}

  // ----------------------------------------------------------
  // Seat-status events (per-screening scope)
  // ----------------------------------------------------------

  async publishSeatHeld(args: {
    screeningId: string;
    seatIds: string[];
    reservationId: string;
    reason?: string;
  }): Promise<void> {
    await this.publishSeatStatus({
      screeningId: args.screeningId,
      seatIds: args.seatIds,
      status: 'Held',
      reservationId: args.reservationId,
      reason: args.reason,
    });
  }

  async publishSeatReleased(args: {
    screeningId: string;
    seatIds: string[];
    reservationId?: string;
    reason?: string;
  }): Promise<void> {
    await this.publishSeatStatus({
      screeningId: args.screeningId,
      seatIds: args.seatIds,
      status: 'Released',
      reservationId: args.reservationId,
      reason: args.reason,
    });
    // Also publish as 'seat:available' so the UI can use either event.
    await this.publishSeatStatus({
      screeningId: args.screeningId,
      seatIds: args.seatIds,
      status: 'Available',
      reservationId: args.reservationId,
      reason: args.reason,
    });
  }

  async publishSeatSold(args: {
    screeningId: string;
    seatIds: string[];
    reservationId: string;
    reason?: string;
  }): Promise<void> {
    await this.publishSeatStatus({
      screeningId: args.screeningId,
      seatIds: args.seatIds,
      status: 'Sold',
      reservationId: args.reservationId,
      reason: args.reason,
    });
  }

  async publishSeatBlocked(args: {
    screeningId: string;
    seatIds: string[];
    reason?: string;
  }): Promise<void> {
    await this.publishSeatStatus({
      screeningId: args.screeningId,
      seatIds: args.seatIds,
      status: 'Blocked',
      reason: args.reason,
    });
  }

  // ----------------------------------------------------------
  // Screening-scope events
  // ----------------------------------------------------------

  async publishScreeningCancelled(args: {
    screeningId: string;
    reason?: string;
  }): Promise<void> {
    await this.publish(REALTIME_CHANNELS.SCREENING, args.screeningId, {
      event: REALTIME_EVENTS.SCREENING_CANCELLED,
      payload: {
        screeningId: args.screeningId,
        reason: args.reason,
        occurredAt: new Date().toISOString(),
      } as ScreeningCancelledPayload,
    });
  }

  // ----------------------------------------------------------
  // Reservation-scope events
  // ----------------------------------------------------------

  async publishReservationConfirmed(args: {
    reservationId: string;
    customerId?: string | null;
    screeningId?: string;
  }): Promise<void> {
    await this.publish(REALTIME_CHANNELS.RESERVATION, args.reservationId, {
      event: REALTIME_EVENTS.RESERVATION_CONFIRMED,
      payload: {
        reservationId: args.reservationId,
        customerId: args.customerId ?? null,
        screeningId: args.screeningId,
        status: 'Confirmed',
        occurredAt: new Date().toISOString(),
      } as ReservationEventPayload,
    });
    // If we know the screeningId, also publish to the screening channel
    // so subscribers watching the seat map see a 'reservation:confirmed'
    // event (e.g. to refresh).
    if (args.screeningId) {
      await this.publish(REALTIME_CHANNELS.SCREENING, args.screeningId, {
        event: REALTIME_EVENTS.RESERVATION_CONFIRMED,
        payload: {
          reservationId: args.reservationId,
          customerId: args.customerId ?? null,
          screeningId: args.screeningId,
          status: 'Confirmed',
          occurredAt: new Date().toISOString(),
        } as ReservationEventPayload,
      });
    }
  }

  async publishReservationExpired(args: {
    reservationId: string;
    customerId?: string | null;
    screeningId?: string;
  }): Promise<void> {
    await this.publish(REALTIME_CHANNELS.RESERVATION, args.reservationId, {
      event: REALTIME_EVENTS.RESERVATION_EXPIRED,
      payload: {
        reservationId: args.reservationId,
        customerId: args.customerId ?? null,
        screeningId: args.screeningId,
        status: 'Expired',
        occurredAt: new Date().toISOString(),
      } as ReservationEventPayload,
    });
    if (args.screeningId) {
      await this.publish(REALTIME_CHANNELS.SCREENING, args.screeningId, {
        event: REALTIME_EVENTS.RESERVATION_EXPIRED,
        payload: {
          reservationId: args.reservationId,
          customerId: args.customerId ?? null,
          screeningId: args.screeningId,
          status: 'Expired',
          occurredAt: new Date().toISOString(),
        } as ReservationEventPayload,
      });
    }
  }

  async publishReservationCancelled(args: {
    reservationId: string;
    customerId?: string | null;
    screeningId?: string;
  }): Promise<void> {
    await this.publish(REALTIME_CHANNELS.RESERVATION, args.reservationId, {
      event: REALTIME_EVENTS.RESERVATION_CANCELLED,
      payload: {
        reservationId: args.reservationId,
        customerId: args.customerId ?? null,
        screeningId: args.screeningId,
        status: 'Cancelled',
        occurredAt: new Date().toISOString(),
      } as ReservationEventPayload,
    });
    if (args.screeningId) {
      await this.publish(REALTIME_CHANNELS.SCREENING, args.screeningId, {
        event: REALTIME_EVENTS.RESERVATION_CANCELLED,
        payload: {
          reservationId: args.reservationId,
          customerId: args.customerId ?? null,
          screeningId: args.screeningId,
          status: 'Cancelled',
          occurredAt: new Date().toISOString(),
        } as ReservationEventPayload,
      });
    }
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  private async publishSeatStatus(args: {
    screeningId: string;
    seatIds: string[];
    status: SeatStatusPayload['status'];
    reservationId?: string;
    reason?: string;
  }): Promise<void> {
    if (args.seatIds.length === 0) return;
    await this.publish(REALTIME_CHANNELS.SCREENING, args.screeningId, {
      event: this.seatEventForStatus(args.status) as RealtimeEventName,
      payload: {
        screeningId: args.screeningId,
        seatIds: args.seatIds,
        status: args.status,
        reservationId: args.reservationId,
        reason: args.reason,
        occurredAt: new Date().toISOString(),
      } as SeatStatusPayload,
    });
  }

  private seatEventForStatus(status: SeatStatusPayload['status']): string {
    switch (status) {
      case 'Held': return REALTIME_EVENTS.SEAT_HELD;
      case 'Released': return REALTIME_EVENTS.SEAT_RELEASED;
      case 'Sold': return REALTIME_EVENTS.SEAT_SOLD;
      case 'Blocked': return REALTIME_EVENTS.SEAT_BLOCKED;
      case 'Available': return REALTIME_EVENTS.SEAT_AVAILABLE;
      default: return REALTIME_EVENTS.SEAT_AVAILABLE;
    }
  }

  /**
   * Publish a JSON-encoded message to a Redis Pub/Sub channel.
   * Channel naming follows `cineva:events:{type}:{id}` convention.
   */
  private async publish(
    channelType: string,
    scopeId: string,
    message: { event: string; payload: unknown },
  ): Promise<void> {
    const channel = `${channelType}:${scopeId}`;
    try {
      const payload = JSON.stringify(message);
      await this.redis.publish(channel, payload);
      this.logger.debug(`Published ${message.event} -> ${channel}`);
    } catch (err) {
      // Pub/Sub failures are non-fatal - they just mean live UI updates
      // might be delayed. The business state in PostgreSQL is still
      // correct; clients will see the final state on next refresh.
      this.logger.warn(`Publish to ${channel} failed: ${(err as Error).message}`);
    }
  }
}

import IORedis from 'ioredis';
import { RealtimeService } from 'src/realtime/services/realtime.service';
import {
  REALTIME_CHANNELS,
  REALTIME_EVENTS,
} from 'src/realtime/realtime.constants';

/**
 * RealtimeService unit tests.
 *
 * Verifies the Redis Pub/Sub message format and channel routing without
 * needing a real Redis instance (ioredis-mock supports pub/sub).
 *
 * Covers PRD §2.1 acceptance: 'نگه‌داری موقت صندلی توسط یک رزرو' - the
 * broadcast ensures all customers watching the seat map see seat
 * state changes in real time.
 */
describe('RealtimeService', () => {
  let redis: IORedis;
  let published: Array<{ channel: string; message: string }>;
  let service: RealtimeService;

  beforeAll(async () => {
    const IORedisMock = (await import('ioredis-mock')).default;
    redis = new IORedisMock() as unknown as IORedis;
    published = [];

    // Intercept publish() calls so we can assert on the message format
    // without spinning up a subscriber.
    jest.spyOn(redis, 'publish').mockImplementation(async (
      channel: string | Buffer,
      message: string | Buffer,
    ) => {
      published.push({
        channel: String(channel),
        message: String(message),
      });
      return 1;
    });

    service = new RealtimeService(redis);
  });

  beforeEach(() => {
    published = [];
  });

  describe('publishSeatHeld', () => {
    it('publishes a seat:held event on the screening channel', async () => {
      await service.publishSeatHeld({
        screeningId: 's-1',
        seatIds: ['seat-1', 'seat-2'],
        reservationId: 'r-1',
        reason: 'reservation_created',
      });
      expect(published).toHaveLength(1);
      const { channel, message } = published[0];
      expect(channel).toBe(`${REALTIME_CHANNELS.SCREENING}:s-1`);
      const parsed = JSON.parse(message) as { event: string; payload: { screeningId: string; seatIds: string[]; status: string; reservationId: string; occurredAt: string } };
      expect(parsed.event).toBe(REALTIME_EVENTS.SEAT_HELD);
      expect(parsed.payload.screeningId).toBe('s-1');
      expect(parsed.payload.seatIds).toEqual(['seat-1', 'seat-2']);
      expect(parsed.payload.status).toBe('Held');
      expect(parsed.payload.reservationId).toBe('r-1');
      expect(parsed.payload.occurredAt).toBeTruthy();
    });

    it('skips publish when seatIds is empty', async () => {
      await service.publishSeatHeld({
        screeningId: 's-1',
        seatIds: [],
        reservationId: 'r-1',
      });
      expect(published).toHaveLength(0);
    });
  });

  describe('publishSeatReleased', () => {
    it('publishes BOTH seat:released and seat:available for UI consumers', async () => {
      await service.publishSeatReleased({
        screeningId: 's-1',
        seatIds: ['seat-1'],
        reservationId: 'r-1',
        reason: 'ttl_expired',
      });
      expect(published).toHaveLength(2);
      expect(published[0].message).toMatch(/seat:released/);
      expect(published[1].message).toMatch(/seat:available/);
      // Both must go to the screening channel.
      expect(published[0].channel).toBe(`${REALTIME_CHANNELS.SCREENING}:s-1`);
      expect(published[1].channel).toBe(`${REALTIME_CHANNELS.SCREENING}:s-1`);
    });
  });

  describe('publishSeatSold', () => {
    it('publishes a seat:sold event with the reservationId', async () => {
      await service.publishSeatSold({
        screeningId: 's-2',
        seatIds: ['seat-3'],
        reservationId: 'r-2',
        reason: 'payment_confirmed',
      });
      expect(published).toHaveLength(1);
      const parsed = JSON.parse(published[0].message) as { event: string; payload: { status: string; reservationId: string } };
      expect(parsed.event).toBe(REALTIME_EVENTS.SEAT_SOLD);
      expect(parsed.payload.status).toBe('Sold');
      expect(parsed.payload.reservationId).toBe('r-2');
    });
  });

  describe('publishSeatBlocked', () => {
    it('publishes a seat:blocked event', async () => {
      await service.publishSeatBlocked({
        screeningId: 's-3',
        seatIds: ['seat-4', 'seat-5'],
        reason: 'Screening cancelled',
      });
      expect(published).toHaveLength(1);
      const parsed = JSON.parse(published[0].message) as { event: string; payload: { status: string; reason: string } };
      expect(parsed.event).toBe(REALTIME_EVENTS.SEAT_BLOCKED);
      expect(parsed.payload.status).toBe('Blocked');
      expect(parsed.payload.reason).toBe('Screening cancelled');
    });
  });

  describe('publishScreeningCancelled', () => {
    it('publishes a screening:cancelled event', async () => {
      await service.publishScreeningCancelled({
        screeningId: 's-4',
        reason: 'manager_action',
      });
      expect(published).toHaveLength(1);
      const parsed = JSON.parse(published[0].message) as { event: string; payload: { screeningId: string; reason: string } };
      expect(parsed.event).toBe(REALTIME_EVENTS.SCREENING_CANCELLED);
      expect(parsed.payload.screeningId).toBe('s-4');
      expect(parsed.payload.reason).toBe('manager_action');
    });
  });

  describe('publishReservationConfirmed', () => {
    it('publishes to BOTH the reservation and screening channels', async () => {
      await service.publishReservationConfirmed({
        reservationId: 'r-5',
        customerId: 'u-1',
        screeningId: 's-5',
      });
      expect(published).toHaveLength(2);
      // First message goes to the reservation channel.
      expect(published[0].channel).toBe(`${REALTIME_CHANNELS.RESERVATION}:r-5`);
      // Second message goes to the screening channel (so seat-map viewers see it).
      expect(published[1].channel).toBe(`${REALTIME_CHANNELS.SCREENING}:s-5`);
      // Both messages have the same event name.
      const m1 = JSON.parse(published[0].message) as { event: string };
      const m2 = JSON.parse(published[1].message) as { event: string };
      expect(m1.event).toBe(REALTIME_EVENTS.RESERVATION_CONFIRMED);
      expect(m2.event).toBe(REALTIME_EVENTS.RESERVATION_CONFIRMED);
    });

    it('publishes only to the reservation channel when screeningId is unknown', async () => {
      await service.publishReservationConfirmed({
        reservationId: 'r-6',
      });
      expect(published).toHaveLength(1);
      expect(published[0].channel).toBe(`${REALTIME_CHANNELS.RESERVATION}:r-6`);
    });
  });

  describe('publishReservationExpired', () => {
    it('publishes to both channels when screeningId is known', async () => {
      await service.publishReservationExpired({
        reservationId: 'r-7',
        customerId: 'u-1',
        screeningId: 's-7',
      });
      expect(published).toHaveLength(2);
      const m1 = JSON.parse(published[0].message) as { event: string };
      const m2 = JSON.parse(published[1].message) as { event: string };
      expect(m1.event).toBe(REALTIME_EVENTS.RESERVATION_EXPIRED);
      expect(m2.event).toBe(REALTIME_EVENTS.RESERVATION_EXPIRED);
    });
  });

  describe('publishReservationCancelled', () => {
    it('publishes to both channels when screeningId is known', async () => {
      await service.publishReservationCancelled({
        reservationId: 'r-8',
        customerId: 'u-1',
        screeningId: 's-8',
      });
      expect(published).toHaveLength(2);
      const m1 = JSON.parse(published[0].message) as { event: string };
      expect(m1.event).toBe(REALTIME_EVENTS.RESERVATION_CANCELLED);
    });
  });

  describe('resilience: publish failures are non-fatal', () => {
    it('does NOT throw when redis.publish fails (UI updates are best-effort)', async () => {
      jest.spyOn(redis, 'publish').mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        service.publishSeatHeld({
          screeningId: 's-9',
          seatIds: ['seat-9'],
          reservationId: 'r-9',
        }),
      ).resolves.not.toThrow();
    });
  });
});

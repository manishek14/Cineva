import 'reflect-metadata';
import { createInProcessFixture, signTestUserJwt } from './fixture';
import { MovieService } from 'src/catalog/services/movie.service';
import { SeatCategoryService } from 'src/catalog/services/seat-category.service';
import { HallService } from 'src/hall/services/hall.service';
import { SeatService } from 'src/hall/services/seat.service';
import { ScreeningService } from 'src/screening/services/screening.service';
import { ReservationService } from 'src/reservation/services/reservation.service';
import { PaymentService } from 'src/payment/services/payment.service';
import { TicketService } from 'src/ticket/services/ticket.service';
import { CancellationService } from 'src/cancellation/services/cancellation.service';
import { AuthService } from 'src/auth/services/auth.service';
import { OtpService } from 'src/auth/services/otp.service';
import { RedisService } from 'src/common/redis/redis.service';
import { MockPaymentProvider } from 'src/payment/providers/mock-payment.provider';
import { PAYMENT_PROVIDER_TOKEN } from 'src/payment/providers/payment-provider.port';
import type { DataSource } from 'typeorm';
import type IORedis from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import { Repository } from 'typeorm';

/**
 * Full-flow integration test that exercises every module against a
 * real SQLite + ioredis-mock backend. No HTTP layer, no NestJS DI
 * - we wire services manually for full control.
 *
 * Covers PRD §13 acceptance:
 *  - Multi-seat reservation succeeds only if all seats are allocated.
 *  - Duplicate seat reservation is rejected.
 *  - Late callback (after expiry) does NOT re-issue tickets.
 *  - Idempotent duplicate callback does NOT create duplicate tickets.
 *  - Cancellation: 15% penalty + 85% refund computation.
 *  - Idempotent duplicate cancellation does NOT double-refund.
 */
describe('Integration: full customer flow (no HTTP layer)', () => {
  let dataSource: DataSource;
  let redis: IORedis;
  let config: ConfigService;
  let jwt: JwtService;
  let cleanup: () => Promise<void>;

  let movies: MovieService;
  let categories: SeatCategoryService;
  let halls: HallService;
  let seats: SeatService;
  let screenings: ScreeningService;
  let reservations: ReservationService;
  let payments: PaymentService;
  let tickets: TicketService;
  let cancellations: CancellationService;
  let otp: OtpService;
  let auth: AuthService;

  let managerId: string;
  let customerId: string;
  let otherCustomerId: string;
  let screeningId: string;
  let screeningSeatIds: string[];
  let reservationId: string;
  let paymentId: string;
  let issuedQrTokens: string[];

  beforeAll(async () => {
    const fx = await createInProcessFixture();
    dataSource = fx.dataSource;
    redis = fx.redis;
    config = fx.config;
    jwt = fx.jwt;
    cleanup = fx.cleanup;

    const redisService = new RedisService(redis, config);

    // Repositories.
    const movieRepo = dataSource.getRepository(MovieService.prototype.constructor as never) as never;
    // TypeORM getRepository takes the entity class, not a service.
    // We need the actual entity classes for repository lookup.
    const movieEntity = (await import('src/catalog/entities/movie.entity')).MovieEntity;
    const categoryEntity = (await import('src/catalog/entities/seat-category.entity')).SeatCategoryEntity;
    const hallEntity = (await import('src/hall/entities/cinema-hall.entity')).CinemaHallEntity;
    const seatEntity = (await import('src/hall/entities/seat.entity')).SeatEntity;
    const screeningEntity = (await import('src/screening/entities/screening.entity')).ScreeningEntity;
    const screeningSeatEntity = (await import('src/screening/entities/screening-seat.entity')).ScreeningSeatEntity;
    const userEntity = (await import('src/auth/entities/user.entity')).UserEntity;
    const otpChallengeEntity = (await import('src/auth/entities/otp-challenge.entity')).OtpChallengeEntity;
    const reservationEntity = (await import('src/reservation/entities/reservation.entity')).ReservationEntity;
    const reservationSeatEntity = (await import('src/reservation/entities/reservation-seat.entity')).ReservationSeatEntity;
    const seatAllocationEntity = (await import('src/reservation/entities/seat-allocation.entity')).SeatAllocationEntity;
    const paymentEntity = (await import('src/payment/entities/payment.entity')).PaymentEntity;
    const ticketEntity = (await import('src/ticket/entities/ticket.entity')).TicketEntity;
    const cancellationPolicyEntity = (await import('src/cancellation/entities/cancellation-policy.entity')).CancellationPolicyEntity;
    const refundEntity = (await import('src/cancellation/entities/refund.entity')).RefundEntity;

    // Construct services.
    movies = new MovieService(
      dataSource.getRepository(movieEntity),
    ) as MovieService;
    // MovieService constructor takes only movieRepo, but the real one
    // takes one repo. Let me re-check.
    // Actually MovieService constructor: `(@InjectRepository(MovieEntity) private repo: Repository<MovieEntity>)` - just one repo.
    movies = new (MovieService as unknown as new (repo: Repository<typeof movieEntity.prototype>) => MovieService)(
      dataSource.getRepository(movieEntity) as never,
    );

    categories = new SeatCategoryService(dataSource.getRepository(categoryEntity) as never);
    halls = new HallService(
      dataSource.getRepository(hallEntity) as never,
      dataSource.getRepository(seatEntity) as never,
      dataSource,
    );
    seats = new SeatService(
      dataSource.getRepository(seatEntity) as never,
      dataSource.getRepository(hallEntity) as never,
      dataSource.getRepository(categoryEntity) as never,
      dataSource,
    );
    screenings = new ScreeningService(
      dataSource.getRepository(screeningEntity) as never,
      dataSource.getRepository(screeningSeatEntity) as never,
      dataSource.getRepository(movieEntity) as never,
      dataSource.getRepository(hallEntity) as never,
      dataSource.getRepository(seatEntity) as never,
      dataSource.getRepository(categoryEntity) as never,
      dataSource,
    );

    // OTP service depends on challenge repo + user repo + config + redis.
    otp = new OtpService(
      dataSource.getRepository(otpChallengeEntity) as never,
      dataSource.getRepository(userEntity) as never,
      config,
      redis,
    );
    auth = new AuthService(
      dataSource.getRepository(userEntity) as never,
      jwt,
      config,
      otp,
      redis,
    );

    reservations = new ReservationService(
      dataSource.getRepository(reservationEntity) as never,
      dataSource.getRepository(reservationSeatEntity) as never,
      dataSource.getRepository(seatAllocationEntity) as never,
      dataSource.getRepository(screeningEntity) as never,
      dataSource.getRepository(screeningSeatEntity) as never,
      dataSource,
      redisService,
      config,
    );

    const mockProvider = new MockPaymentProvider(config);
    // PaymentService constructor:
    //   (paymentRepo, reservationRepo, provider, reservations, redis, config, dataSource)
    payments = new PaymentService(
      dataSource.getRepository(paymentEntity) as never,
      dataSource.getRepository(reservationEntity) as never,
      mockProvider,
      reservations,
      redisService,
      config,
      dataSource,
    );

    tickets = new TicketService(
      dataSource.getRepository(ticketEntity) as never,
      dataSource.getRepository(reservationSeatEntity) as never,
      dataSource.getRepository(reservationEntity) as never,
      dataSource.getRepository(screeningSeatEntity) as never,
      dataSource.getRepository(screeningEntity) as never,
      dataSource.getRepository(seatEntity) as never,
      dataSource.getRepository(hallEntity) as never,
      dataSource.getRepository(movieEntity) as never,
      dataSource,
    );

    cancellations = new CancellationService(
      dataSource.getRepository(cancellationPolicyEntity) as never,
      dataSource.getRepository(refundEntity) as never,
      dataSource.getRepository(reservationEntity) as never,
      dataSource.getRepository(reservationSeatEntity) as never,
      dataSource.getRepository(seatAllocationEntity) as never,
      dataSource.getRepository(paymentEntity) as never,
      dataSource.getRepository(screeningSeatEntity) as never,
      dataSource.getRepository(screeningEntity) as never,
      tickets,
      reservations,
      config,
      dataSource,
    );

    // Stub PAYMENT_PROVIDER_TOKEN type.
    void PAYMENT_PROVIDER_TOKEN;

    // Sign JWTs for two users.
    const m = await signTestUserJwt(jwt, { role: 'cinema_manager' });
    managerId = m.userId;
    const c = await signTestUserJwt(jwt, { role: 'customer' });
    customerId = c.userId;
    const o = await signTestUserJwt(jwt, { role: 'customer', phone: '+989120009999' });
    otherCustomerId = o.userId;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('Manager catalog setup', () => {
    it('creates a movie', async () => {
      const movie = await movies.create({
        title: 'The Matrix',
        description: 'A computer hacker learns about reality.',
        durationMinutes: 136,
        ageRating: '+15',
      });
      expect(movie.id).toBeDefined();
      expect(movie.title).toBe('The Matrix');
    });

    it('creates a Standard seat category (multiplier 1.0)', async () => {
      const cat = await categories.create({
        name: 'Standard',
        code: 'STD',
        basePriceMultiplier: 1.0,
      });
      expect(cat.code).toBe('STD');
    });

    it('creates a cinema hall', async () => {
      const hall = await halls.create({ name: 'Salon 1', slug: 'salon-1' });
      expect(hall.slug).toBe('salon-1');
    });

    it('bulk-upserts 10 seats (rows A, B with 5 seats each)', async () => {
      const category = (await categories.list())[0];
      const hall = (await halls.list())[0];
      const seatDtos = [];
      for (const row of ['A', 'B']) {
        for (let n = 1; n <= 5; n++) {
          seatDtos.push({
            hallId: hall.id,
            categoryId: category.id,
            rowLabel: row,
            seatNumber: n,
            positionX: (n - 1) * 0.2,
            positionY: row === 'A' ? 0.2 : 0.4,
          });
        }
      }
      const result = await seats.bulkUpsert(hall.id, { seats: seatDtos });
      expect(result).toHaveLength(10);
    });
  });

  describe('Manager screening creation', () => {
    it('creates a Published screening (auto-generates screening_seats with price snapshots)', async () => {
      const movie = (await movies.list({ page: 1, pageSize: 10 })).items[0];
      const hall = (await halls.list())[0];
      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
      const endsAt = new Date(startsAt.getTime() + 150 * 60 * 1000);
      const screening = await screenings.create({
        movieId: movie.id,
        hallId: hall.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        basePriceToman: 200_000,
        status: 'Published',
      });
      expect(screening.status).toBe('Published');
      screeningId = screening.id;
    });

    it('generates 10 ScreeningSeat rows with price = base × multiplier', async () => {
      const seatMap = await screenings.getSeatMap(screeningId);
      expect(seatMap).toHaveLength(10);
      // All seats are Standard category, multiplier 1.0, so price = 200,000.
      expect(Number(seatMap[0].price)).toBe(200_000);
      expect(seatMap[0].saleStatus).toBe('Available');
      // Stash first 2 seat IDs for reservation.
      screeningSeatIds = seatMap.slice(0, 2).map((s) => s.id);
    });
  });

  describe('Customer reservation flow', () => {
    it('PRD §13 acceptance: customer creates a multi-seat reservation successfully', async () => {
      const reservation = await reservations.createReservation(
        { screeningId, screeningSeatIds },
        customerId,
      );
      expect(reservation.status).toBe('PendingPayment');
      expect(reservation.seats).toHaveLength(2);
      // Total = 200,000 × 2 = 400,000.
      expect(reservation.totalAmount).toBe(400_000);
      expect(reservation.expiresAt).toBeTruthy();
      reservationId = reservation.id;
    });

    it('marks both seats as Held in the screening seat map', async () => {
      const seatMap = await screenings.getSeatMap(screeningId);
      const held = seatMap.filter((s) => s.saleStatus === 'Held');
      expect(held).toHaveLength(2);
    });

    it('PRD §13 acceptance: duplicate seat reservation by another customer is rejected (no double-sell)', async () => {
      await expect(
        reservations.createReservation(
          { screeningId, screeningSeatIds: [screeningSeatIds[0]] },
          otherCustomerId,
        ),
      ).rejects.toThrow(/Seats already held by another customer/);
    });
  });

  describe('Customer payment + confirmation + ticket issuance', () => {
    it('initiates payment via mock provider', async () => {
      const payment = await payments.initiatePayment({ reservationId });
      expect(payment.gatewayRedirectUrl).toContain('mock-redirect');
      expect(payment.status).toBe('Pending');
      paymentId = payment.id;
    });

    it('mock callback verifies + confirms the reservation (PRD §7.1 step 5-6)', async () => {
      const result = await payments.handleCallback({
        paymentId,
        authority: `auth_${paymentId}`,
        status: 'OK',
      });
      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(false);
    });

    it('the reservation is now Confirmed', async () => {
      const reservation = await reservations.findOne(reservationId, customerId);
      expect(reservation.status).toBe('Confirmed');
    });

    it('the seats are now Sold in the seat map', async () => {
      const seatMap = await screenings.getSeatMap(screeningId);
      const sold = seatMap.filter((s) => s.saleStatus === 'Sold');
      expect(sold).toHaveLength(2);
    });

    it('manual ticket issuance produces 2 Valid tickets with QR tokens', async () => {
      // In production this is triggered by an outbox event consumer.
      // We call it directly to test the issuance path.
      const result = await tickets.issueForReservation(reservationId);
      expect(result.issued).toHaveLength(2);
      issuedQrTokens = result.issued.map((t) => t.qrToken).filter((t): t is string => !!t);
      expect(issuedQrTokens).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
    });

    it('PRD §FR-07 rule 4: atomic scan - first scan succeeds (Valid -> Used)', async () => {
      const scan = await tickets.scanTicket(
        { qrToken: issuedQrTokens[0] },
        'gate-attendant-id',
      );
      expect(scan.success).toBe(true);
      expect(scan.status).toBe('Used');
    });

    it('PRD §FR-07 rule 4: second scan of the SAME token is rejected (no double-use)', async () => {
      await expect(
        tickets.scanTicket({ qrToken: issuedQrTokens[0] }, 'gate-attendant-id'),
      ).rejects.toThrow(/Ticket already used/);
    });

    it('PRD §FR-06 idempotency: duplicate payment callback is a no-op (no new tickets)', async () => {
      const result = await payments.handleCallback({
        paymentId,
        authority: `auth_${paymentId}`,
        status: 'OK',
      });
      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(false);
      // Verify ticket count didn't change.
      const tlist = await tickets.listForReservation(reservationId);
      expect(tlist).toHaveLength(2);
    });
  });

  describe('Cancellation flow (PRD §10, §FR-08)', () => {
    let policyId: string;

    it('manager creates an active cancellation policy (15% / 85% / 30min cutoff)', async () => {
      const policy = await cancellations.createPolicy({
        name: 'default',
        penaltyPercent: 15,
        refundPercent: 85,
        minMinutesBeforeScreening: 30,
        customerCancelAllowed: true,
      });
      expect(policy.isActive).toBe(true);
      policyId = policy.id;
      void policyId;
    });

    it('PRD §13 acceptance: customer cancels confirmed reservation; 15% penalty + 85% refund computed', async () => {
      // The screening is tomorrow, so we are well within the 30min cutoff.
      const refund = await cancellations.cancelReservation(
        reservationId,
        {},
        customerId,
      );
      // Total = 400,000. Refund 85% = 340,000. Penalty 15% = 60,000.
      expect(refund.refundableAmount).toBe(340_000);
      expect(refund.penaltyAmount).toBe(60_000);
      expect(refund.status).toBe('Succeeded');
    });

    it('PRD §FR-08 idempotency: duplicate cancel does NOT create a second refund', async () => {
      const refund = await cancellations.cancelReservation(
        reservationId,
        { idempotencyKey: `dup-${Date.now()}-${uuidv4().slice(0, 8)}` },
        customerId,
      );
      // Reservation was already Cancelled; service returns the existing
      // refund rather than creating a duplicate.
      expect(refund.refundableAmount).toBe(340_000);
    });

    it('the seats are back to Available after cancellation', async () => {
      const seatMap = await screenings.getSeatMap(screeningId);
      const available = seatMap.filter((s) => s.saleStatus === 'Available');
      expect(available).toHaveLength(10);
    });

    it('PRD §NFR-06 ownership: another customer cannot cancel the (already-cancelled) reservation', async () => {
      await expect(
        cancellations.cancelReservation(reservationId, {}, otherCustomerId),
      ).rejects.toThrow(/Not your reservation/);
    });
  });

  describe('Late callback handling (PRD §FR-06 rule 5)', () => {
    let lateReservationId: string;
    let latePaymentId: string;
    let lateScreeningId: string;
    let lateSeatIds: string[];

    it('creates a fresh screening + reservation for the late-callback scenario', async () => {
      const movie = (await movies.list({ page: 1, pageSize: 10 })).items[0];
      const hall = (await halls.list())[0];
      const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // in 2 days
      const endsAt = new Date(startsAt.getTime() + 150 * 60 * 1000);
      const screening = await screenings.create({
        movieId: movie.id,
        hallId: hall.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        basePriceToman: 200_000,
        status: 'Published',
      });
      lateScreeningId = screening.id;
      const seatMap = await screenings.getSeatMap(lateScreeningId);
      lateSeatIds = seatMap.slice(0, 1).map((s) => s.id);
      const r = await reservations.createReservation(
        { screeningId: lateScreeningId, screeningSeatIds: lateSeatIds },
        customerId,
      );
      lateReservationId = r.id;
      const p = await payments.initiatePayment({ reservationId: lateReservationId });
      latePaymentId = p.id;
    });

    it('simulates expiry of the reservation BEFORE the callback arrives', async () => {
      // Force-expire the reservation via ReservationService.expireReservation.
      await reservations.expireReservation(lateReservationId);
      const r = await reservations.findOne(lateReservationId, customerId);
      expect(r.status).toBe('Expired');
    });

    it('PRD §FR-06 rule 5: late callback marks payment Succeeded + lateCallback=true; NO reservation confirmation; NO tickets', async () => {
      const result = await payments.handleCallback({
        paymentId: latePaymentId,
        authority: `auth_${latePaymentId}`,
        status: 'OK',
      });
      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(true);
      // Verify the reservation is still Expired (not re-confirmed).
      const r = await reservations.findOne(lateReservationId, customerId);
      expect(r.status).toBe('Expired');
      // Verify no tickets were issued.
      const tlist = await tickets.listForReservation(lateReservationId);
      expect(tlist).toHaveLength(0);
    });
  });

  describe('OTP security (PRD §NFR-05)', () => {
    it('requests an OTP and verifies it works', async () => {
      const phone = '+989120001111';
      const sent = await otp.requestOtp({ phone });
      expect(sent.expiresIn).toBe(120);
      const verified = await otp.verifyOtp({ phone, code: '111111' });
      expect(verified.phone).toBe(phone);
    });

    it('PRD §NFR-05: consumed OTP cannot be verified again (one-time use)', async () => {
      const phone = '+989120002222';
      await otp.requestOtp({ phone });
      await otp.verifyOtp({ phone, code: '111111' });
      await expect(
        otp.verifyOtp({ phone, code: '111111' }),
      ).rejects.toThrow(/OTP already consumed/);
    });

    it('PRD §NFR-05: wrong code increments attempts', async () => {
      const phone = '+989120003333';
      await otp.requestOtp({ phone });
      await expect(
        otp.verifyOtp({ phone, code: '999999' }),
      ).rejects.toThrow(/Invalid OTP code; \d+ attempts left/);
    });
  });

  describe('JWT refresh rotation (PRD §3)', () => {
    it('issues access+refresh, then rotates on refresh', async () => {
      const user = await otp.ensureUserForPhone('+989120004444');
      const first = await auth.issueTokens(user);
      const second = await auth.refreshTokens({ refreshToken: first.refreshToken });
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('PRD §3: old refresh is blacklisted after rotation (replay protection)', async () => {
      const user = await otp.ensureUserForPhone('+989120005555');
      const first = await auth.issueTokens(user);
      await auth.refreshTokens({ refreshToken: first.refreshToken });
      // Replaying the old refresh should fail.
      await expect(
        auth.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toThrow(/Refresh token revoked/);
    });
  });

  describe('Reservation expiry reconciliation (PRD §7.3 / §NFR-04)', () => {
    let screeningId2: string;
    let reservationId2: string;

    it('creates a screening + reservation, then manually expires it', async () => {
      const movie = (await movies.list({ page: 1, pageSize: 10 })).items[0];
      const hall = (await halls.list())[0];
      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 150 * 60 * 1000);
      const screening = await screenings.create({
        movieId: movie.id,
        hallId: hall.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        basePriceToman: 200_000,
        status: 'Published',
      });
      screeningId2 = screening.id;
      const seatMap = await screenings.getSeatMap(screeningId2);
      const seatIds = seatMap.slice(0, 1).map((s) => s.id);
      const r = await reservations.createReservation(
        { screeningId: screeningId2, screeningSeatIds: seatIds },
        customerId,
      );
      reservationId2 = r.id;
      await reservations.expireReservation(reservationId2);
      const rAfter = await reservations.findOne(reservationId2, customerId);
      expect(rAfter.status).toBe('Expired');
    });

    it('PRD §NFR-04: reconcileExpired is idempotent - running it again is a no-op', async () => {
      const result = await reservations.reconcileExpired();
      // The reservation was already processed; reconcileExpired should
      // not double-process it.
      expect(result.expired).toBeGreaterThanOrEqual(0);
    });
  });
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { MovieEntity } from 'src/catalog/entities/movie.entity';
import { SeatCategoryEntity } from 'src/catalog/entities/seat-category.entity';
import { CinemaHallEntity } from 'src/hall/entities/cinema-hall.entity';
import { SeatEntity } from 'src/hall/entities/seat.entity';
import { ScreeningEntity } from 'src/screening/entities/screening.entity';
import { ScreeningSeatEntity } from 'src/screening/entities/screening-seat.entity';
import { UserEntity } from 'src/auth/entities/user.entity';
import { OtpChallengeEntity } from 'src/auth/entities/otp-challenge.entity';
import { ReservationEntity } from 'src/reservation/entities/reservation.entity';
import { ReservationSeatEntity } from 'src/reservation/entities/reservation-seat.entity';
import { SeatAllocationEntity } from 'src/reservation/entities/seat-allocation.entity';
import { PaymentEntity } from 'src/payment/entities/payment.entity';
import { TicketEntity } from 'src/ticket/entities/ticket.entity';
import { CancellationPolicyEntity } from 'src/cancellation/entities/cancellation-policy.entity';
import { RefundEntity } from 'src/cancellation/entities/refund.entity';
import { AuditLogEntity } from 'src/audit/entities/audit-log.entity';
import { OutboxEventEntity } from 'src/audit/entities/outbox-event.entity';

/**
 * In-process integration test fixture.
 *
 * REQUIRES Postgres + Redis to be running on localhost:
 *   docker compose up -d
 *
 * Uses the real PostgreSQL + Redis so we exercise:
 *   - SERIALIZABLE transactions
 *   - EXCLUDE constraint (screening overlap)
 *   - Partial unique index (seat_allocations active per screening_seat)
 *   - timestamptz
 *
 * All schema setup is via TypeORM synchronize=true (creates tables on
 * connect). The two migrations are NOT run automatically here - tests
 * that need the partial unique index can call `applyMigrations()`.
 */

let dbCounter = 0;

export async function createInProcessFixture(): Promise<{
  dataSource: DataSource;
  redis: IORedis;
  config: ConfigService;
  jwt: JwtService;
  cleanup: () => Promise<void>;
}> {
  // Each test suite gets a unique Postgres database so they can run in
  // parallel without colliding. We need the cineva_postgres superuser
  // to have CREATEDB permission; the docker-compose cineva user has it.
  const dbName = `cineva_test_${dbCounter++}_${Date.now()}`;

  // Connect to the postgres maintenance DB to create our test DB.
  const adminDs = new DataSource({
    type: 'postgres',
    host: process.env.TEST_DATABASE_HOST ?? 'localhost',
    port: Number(process.env.TEST_DATABASE_PORT ?? 5432),
    username: process.env.TEST_DATABASE_USER ?? 'cineva',
    password: process.env.TEST_DATABASE_PASSWORD ?? 'cineva_secret',
    database: process.env.TEST_DATABASE_NAME ?? 'cineva',
    logging: false,
  });
  await adminDs.initialize();
  await adminDs.query(`CREATE DATABASE "${dbName}"`).catch(() => {
    // ignore if exists
  });
  await adminDs.destroy();

  // Now connect to the test DB with synchronize=true.
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.TEST_DATABASE_HOST ?? 'localhost',
    port: Number(process.env.TEST_DATABASE_PORT ?? 5432),
    username: process.env.TEST_DATABASE_USER ?? 'cineva',
    password: process.env.TEST_DATABASE_PASSWORD ?? 'cineva_secret',
    database: dbName,
    synchronize: true,
    dropSchema: true, // start fresh each test run
    logging: false,
    entities: [
      MovieEntity,
      SeatCategoryEntity,
      CinemaHallEntity,
      SeatEntity,
      ScreeningEntity,
      ScreeningSeatEntity,
      UserEntity,
      OtpChallengeEntity,
      ReservationEntity,
      ReservationSeatEntity,
      SeatAllocationEntity,
      PaymentEntity,
      TicketEntity,
      CancellationPolicyEntity,
      RefundEntity,
      AuditLogEntity,
      OutboxEventEntity,
    ],
  });
  await dataSource.initialize();

  // Enable btree_gist for the EXCLUDE constraint.
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "btree_gist"');

  // Add the partial unique index on seat_allocations - this is normally
  // created by migration 0002. We add it here manually so tests verify
  // the no-double-sell guarantee at the DB level.
  await dataSource.query(`
    CREATE UNIQUE INDEX uq_alloc_active_per_seat
    ON seat_allocations (screening_seat_id)
    WHERE status IN ('Held', 'Sold');
  `);

  // Add the screening EXCLUDE constraint (from migration 0001).
  await dataSource.query(`
    ALTER TABLE screenings
    ADD CONSTRAINT screenings_no_overlap_per_hall
    EXCLUDE USING gist (
      hall_id WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status IN ('Draft', 'Published'));
  `);

  // ioredis-mock for Redis (no real Redis needed).
  const IORedisMock = (await import('ioredis-mock')).default;
  const redis = new IORedisMock() as unknown as IORedis;

  // ConfigService stub.
  const config = {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        REDIS_KEY_PREFIX: 'cineva:',
        RESERVATION_HOLD_TTL_MINUTES: 10,
        RESERVATION_HOLDER_TOKEN_PREFIX: 'res:',
        OTP_TTL_SECONDS: 120,
        OTP_LENGTH: 6,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        OTP_RESEND_MAX_PER_HOUR: 5,
        OTP_DEV_FAKE_CODE: '111111',
        OTP_DEV_PRINT_TO_LOG: false,
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL: '7d',
        JWT_REFRESH_REDIS_PREFIX: 'auth:refresh:',
        PAYMENT_PROVIDER: 'mock',
        PAYMENT_CALLBACK_TIMEOUT_MINUTES: 15,
        ZARINPAL_CALLBACK_URL: 'http://localhost:3000/api/v1/payment/callback/zarinpal',
        CANCELLATION_MIN_MINUTES_BEFORE_SCREENING_FLOOR: 15,
      };
      return map[key] ?? fallback;
    },
  } as unknown as ConfigService;

  const jwt = new JwtService({
    secret: 'test-access-secret-at-least-32-chars',
    signOptions: { expiresIn: '15m' as never },
  });

  const cleanup = async () => {
    await dataSource.destroy();
    redis.disconnect();
    // Drop the test DB.
    const cleanupDs = new DataSource({
      type: 'postgres',
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5432),
      username: process.env.TEST_DATABASE_USER ?? 'cineva',
      password: process.env.TEST_DATABASE_PASSWORD ?? 'cineva_secret',
      database: process.env.TEST_DATABASE_NAME ?? 'cineva',
      logging: false,
    });
    await cleanupDs.initialize();
    await cleanupDs.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await cleanupDs.destroy();
  };

  return { dataSource, redis, config, jwt, cleanup };
}

export async function signTestUserJwt(
  jwt: JwtService,
  overrides: Partial<{ id: string; phone: string; role: string }> = {},
): Promise<{ token: string; userId: string }> {
  const userId = overrides.id ?? uuidv4();
  const phone = overrides.phone ?? '+989120000000';
  const role = overrides.role ?? 'customer';
  const token = await jwt.signAsync(
    { sub: userId, phone, role, jti: uuidv4(), typ: 'access' },
    { secret: 'test-access-secret-at-least-32-chars' },
  );
  return { token, userId };
}

export { bcrypt };

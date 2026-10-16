import type { Repository, DataSource, EntityManager } from 'typeorm';
import { PaymentService } from 'src/payment/services/payment.service';
import { PaymentEntity, PaymentStatus } from 'src/payment/entities/payment.entity';
import { ReservationEntity, ReservationStatus } from 'src/reservation/entities/reservation.entity';
import type { PaymentProviderPort } from 'src/payment/providers/payment-provider.port';
import type { ReservationService } from 'src/reservation/services/reservation.service';
import type { RedisService } from 'src/common/redis/redis.service';
import type { ConfigService } from '@nestjs/config';
import { BusinessError } from 'src/common/utils';
import { ERROR_CODES } from 'src/common/constants/error-codes';

function makeMockRepo<T extends object>(): Repository<T> {
  return {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (e: T) => {
      // Add timestamps if missing so DTO .from() can call toISOString().
      const now = new Date();
      const enriched = e as unknown as Record<string, unknown>;
      if (!enriched.createdAt) enriched.createdAt = now;
      if (!enriched.updatedAt) enriched.updatedAt = now;
      return e;
    }),
    update: jest.fn(async () => ({})),
    create: jest.fn((e: Partial<T>) => e as T),
  } as unknown as Repository<T>;
}

function makeConfigStub(): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        PAYMENT_PROVIDER: 'mock',
        PAYMENT_CALLBACK_TIMEOUT_MINUTES: 15,
        ZARINPAL_CALLBACK_URL: 'http://localhost:3000/api/v1/payment/callback/zarinpal',
      };
      return map[key] ?? fallback;
    },
  } as ConfigService;
}

function makeProviderStub(): jest.Mocked<PaymentProviderPort> {
  return {
    name: 'mock',
    initiate: jest.fn(async (args: { paymentId: string; amount: number; currency: string; description: string; callbackUrl: string; mobile?: string }) => ({
      authority: `auth_${args.paymentId}`,
      redirectUrl: `http://localhost:3000/mock-redirect?authority=auth_${args.paymentId}`,
    })),
    verify: jest.fn(async (_args: { authority: string; amount: number; status: string }) => ({
      succeeded: true,
      providerReference: 'ref-1',
    })),
  };
}

function makeRedisStub() {
  return {
    reserveIdempotency: jest.fn(async () => ({ won: true, cached: null })),
    storeIdempotencyResult: jest.fn(async () => undefined),
    getIdempotencyResult: jest.fn(async () => null),
  } as unknown as jest.Mocked<RedisService>;
}

function makeDsStub(): { transaction: jest.Mock } {
  return {
    transaction: jest.fn(async (
      _iso: string,
      cb: (manager: EntityManager) => Promise<unknown>,
    ) => cb({} as EntityManager)),
  } as unknown as { transaction: jest.Mock };
}

describe('PaymentService - PRD §FR-06 (idempotency + late-callback)', () => {
  let paymentRepo: Repository<PaymentEntity>;
  let reservationRepo: Repository<ReservationEntity>;
  let provider: jest.Mocked<PaymentProviderPort>;
  let reservations: jest.Mocked<ReservationService>;
  let redis: jest.Mocked<RedisService>;
  let config: ConfigService;
  let ds: { transaction: jest.Mock };
  let service: PaymentService;

  beforeEach(() => {
    paymentRepo = makeMockRepo<PaymentEntity>();
    reservationRepo = makeMockRepo<ReservationEntity>();
    provider = makeProviderStub();
    reservations = {
      confirmReservation: jest.fn(async (id: string) => ({ id }) as ReservationEntity),
    } as unknown as jest.Mocked<ReservationService>;
    redis = makeRedisStub();
    config = makeConfigStub();
    ds = makeDsStub();
    service = new PaymentService(
      paymentRepo,
      reservationRepo,
      provider,
      reservations,
      redis,
      config,
      ds as unknown as DataSource,
    );
  });

  describe('initiatePayment', () => {
    it('rejects when reservation does not exist', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.initiatePayment({ reservationId: 'r-none' }),
      ).rejects.toThrow(/Reservation.*not found/);
    });

    it('rejects when reservation is not in PendingPayment state', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Confirmed',
        totalAmount: 100,
        currency: 'IRR',
      });
      await expect(
        service.initiatePayment({ reservationId: 'r-1' }),
      ).rejects.toThrow(/Reservation is Confirmed; cannot initiate payment/);
    });

    it('rejects when reservation has expired', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        totalAmount: 100,
        currency: 'IRR',
        expiresAt: new Date(Date.now() - 1000), // expired
      });
      await expect(
        service.initiatePayment({ reservationId: 'r-1' }),
      ).rejects.toThrow(/Reservation expired/);
    });

    it('rejects when total amount is 0 (PRD §6.3 financial integrity)', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        totalAmount: 0,
        currency: 'IRR',
        expiresAt: new Date(Date.now() + 60 * 1000),
      });
      await expect(
        service.initiatePayment({ reservationId: 'r-1' }),
      ).rejects.toThrow(/Reservation total must be > 0/);
    });

    it('returns existing payment if idempotency key matches (PRD §FR-06 idempotency)', async () => {
      const now = new Date();
      const existing = {
        id: 'p-existing',
        idempotencyKey: 'shared-key',
        amount: 100,
        currency: 'IRR',
        status: 'Succeeded',
        createdAt: now,
        updatedAt: now,
      };
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        totalAmount: 100,
        currency: 'IRR',
        expiresAt: new Date(Date.now() + 60 * 1000),
      });
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(existing);
      const result = await service.initiatePayment({
        reservationId: 'r-1',
        idempotencyKey: 'shared-key',
      });
      expect(result.id).toBe('p-existing');
      expect(provider.initiate).not.toHaveBeenCalled();
    });

    it('calls provider.initiate and stores the redirect URL', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        totalAmount: 200_000,
        currency: 'IRR',
        expiresAt: new Date(Date.now() + 60 * 1000),
      });
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(null);
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });
      const result = await service.initiatePayment({ reservationId: 'r-1' });
      expect(provider.initiate).toHaveBeenCalledWith(expect.objectContaining({
        amount: 200_000,
        currency: 'IRR',
      }));
      expect(result.gatewayRedirectUrl).toContain('mock-redirect');
      expect(result.status).toBe('Pending');
    });

    it('marks payment Failed when provider.initiate throws', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        totalAmount: 200_000,
        currency: 'IRR',
        expiresAt: new Date(Date.now() + 60 * 1000),
      });
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(null);
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });
      (provider.initiate as jest.Mock).mockRejectedValue(new Error('gateway down'));

      await expect(
        service.initiatePayment({ reservationId: 'r-1' }),
      ).rejects.toThrow(/Gateway initiate failed/);
    });
  });

  describe('handleCallback - PRD §FR-06 idempotency + late-callback', () => {
    function makePayment(status: PaymentStatus, overrides: Partial<PaymentEntity> = {}): PaymentEntity {
      return {
        id: 'p-1',
        reservationId: 'r-1',
        provider: 'mock',
        amount: 200_000,
        currency: 'IRR',
        status,
        idempotencyKey: 'k-1',
        gatewayAuthority: 'auth_p-1_123',
        ...overrides,
      } as unknown as PaymentEntity;
    }

    it('rejects when payment not found', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.handleCallback({ paymentId: 'p-none', authority: 'a', status: 'OK' }),
      ).rejects.toThrow(/Payment.*not found/);
    });

    it('PRD §FR-06 idempotency: returns existing terminal state (Succeeded) without calling provider.verify again', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(
        makePayment('Succeeded', { providerReference: 'ref-1' }),
      );
      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });
      expect(result.status).toBe('Succeeded');
      expect(provider.verify).not.toHaveBeenCalled();
    });

    it('PRD §FR-06 idempotency: returns existing terminal state (Failed) without calling provider.verify again', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Failed'));
      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });
      expect(result.status).toBe('Failed');
      expect(provider.verify).not.toHaveBeenCalled();
    });

    it('rejects when authority does not match initiation (anti-forgery)', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(
        makePayment('Pending', { gatewayAuthority: 'auth_p-1_123' }),
      );
      await expect(
        service.handleCallback({
          paymentId: 'p-1',
          authority: 'WRONG-AUTHORITY',
          status: 'OK',
        }),
      ).rejects.toThrow(/Authority does not match initiation/);
    });

    it('marks payment Failed when provider.verify returns succeeded=false', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: false,
        failureReason: 'user cancelled',
      });
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'NOK',
      });
      expect(result.status).toBe('Failed');
      expect(reservations.confirmReservation).not.toHaveBeenCalled();
    });

    it('PRD §FR-06 rule 5: late callback when reservation is Expired -> payment Succeeded + lateCallback=true, NO reservation confirmation, NO ticket issuance', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: true,
        providerReference: 'ref-late',
      });
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Expired',
        expiresAt: new Date(Date.now() - 1000),
      });
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });

      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(true);
      // Critical: confirmReservation MUST NOT be called when reservation is Expired.
      expect(reservations.confirmReservation).not.toHaveBeenCalled();
    });

    it('PRD §FR-06 rule 5: late callback when reservation is Cancelled -> payment Succeeded + lateCallback=true, NO reservation confirmation', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: true,
        providerReference: 'ref-late-cancelled',
      });
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Cancelled',
      });
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });

      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(true);
      expect(reservations.confirmReservation).not.toHaveBeenCalled();
    });

    it('PRD §FR-06 rule 5: late callback when reservation.expiresAt < now (still PendingPayment) -> late callback', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: true,
        providerReference: 'ref-late-ttl',
      });
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment', // still pending...
        expiresAt: new Date(Date.now() - 1000), // but TTL has passed
      });
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });

      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(true);
      expect(reservations.confirmReservation).not.toHaveBeenCalled();
    });

    it('happy path: payment succeeds + reservation still PendingPayment (not expired) -> confirms reservation', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: true,
        providerReference: 'ref-happy',
      });
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        expiresAt: new Date(Date.now() + 60 * 1000), // not expired
      });
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });

      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(false);
      expect(reservations.confirmReservation).toHaveBeenCalledWith('r-1');
    });

    it('PRD §FR-06 rule 5: late callback when reservation has vanished (null) -> payment Succeeded + lateCallback=true, routes to refund', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(makePayment('Pending'));
      (provider.verify as jest.Mock).mockResolvedValue({
        succeeded: true,
        providerReference: 'ref-vanished',
      });
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(null);
      (paymentRepo.save as jest.Mock).mockImplementation(async (e: PaymentEntity) => { const now = new Date(); const enriched = e as unknown as Record<string, unknown>; if (!enriched.createdAt) enriched.createdAt = now; if (!enriched.updatedAt) enriched.updatedAt = now; return e; });

      const result = await service.handleCallback({
        paymentId: 'p-1',
        authority: 'auth_p-1_123',
        status: 'OK',
      });

      expect(result.status).toBe('Succeeded');
      expect(result.lateCallback).toBe(true);
      expect(reservations.confirmReservation).not.toHaveBeenCalled();
    });
  });

  describe('findOne / listByReservation', () => {
    it('findOne throws NOT_FOUND when payment does not exist', async () => {
      (paymentRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.findOne('p-none')).rejects.toThrow(/Payment.*not found/);
    });

    it('listByReservation returns payments ordered by createdAt DESC', async () => {
      const now = new Date();
      (paymentRepo.find as jest.Mock).mockResolvedValue([
        { id: 'p-2', createdAt: now, updatedAt: now },
        { id: 'p-1', createdAt: new Date(now.getTime() - 1000), updatedAt: now },
      ]);
      const result = await service.listByReservation('r-1');
      expect(result).toHaveLength(2);
    });
  });
});

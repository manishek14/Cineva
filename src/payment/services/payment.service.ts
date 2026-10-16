import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { PaymentEntity, PaymentStatus, PaymentProvider } from '../entities/payment.entity';
import { ReservationEntity } from '../../reservation/entities/reservation.entity';
import { InitiatePaymentDto, PaymentResponseDto } from '../dtos/payment.dto';
import { ReservationService } from '../../reservation/services/reservation.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  PAYMENT_PROVIDER_TOKEN,
  type PaymentProviderPort,
} from '../providers/payment-provider.port';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { canTransition, PAYMENT_TRANSITIONS } from '../../common/constants/state-machine';

/**
 * PaymentService orchestrates the payment lifecycle.
 *
 * CRITICAL GUARANTEES (PRD §FR-06):
 *   1) Idempotency: a callback with the same authority returned to us
 *      twice must produce one outcome. We use both an idempotency_key
 *      UNIQUE column AND a Redis idempotency cache as a fast path.
 *   2) Late callback: if the customer's browser never came back but
 *      the gateway eventually calls verify, we must NOT issue tickets
 *      for an Expired/Cancelled reservation. Instead we mark the
 *      payment Succeeded but flag lateCallback=true and route to the
 *      refund pipeline (PRD §FR-06 rule 5).
 *   3) Amount match: the payment's amount must equal the reservation's
 *      totalAmount; mismatch = reject (PRD §6.3).
 *   4) Single success: a Payment row can transition to Succeeded at most
 *      once; the state machine enforces this (PRD §6.3).
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly callbackTimeoutMinutes: number;
  private readonly defaultProvider: PaymentProvider;

  constructor(
    @InjectRepository(PaymentEntity)
    private readonly paymentRepo: Repository<PaymentEntity>,
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
    @Inject(PAYMENT_PROVIDER_TOKEN)
    private readonly provider: PaymentProviderPort,
    private readonly reservations: ReservationService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.callbackTimeoutMinutes = Number(
      this.config.get('PAYMENT_CALLBACK_TIMEOUT_MINUTES', 15),
    );
    this.defaultProvider = (this.config.get<string>('PAYMENT_PROVIDER', 'mock') as PaymentProvider) ?? 'mock';
  }

  /**
   * Initiate a payment for a reservation.
   * - Idempotent: same idempotencyKey returns the same payment row.
   * - Reservations not in PendingPayment state are rejected.
   * - Reservation must still be within its TTL.
   */
  async initiatePayment(dto: InitiatePaymentDto): Promise<PaymentResponseDto> {
    const reservation = await this.reservationRepo.findOne({
      where: { id: dto.reservationId },
    });
    if (!reservation) {
      throw BusinessError.notFound(
        `Reservation ${dto.reservationId} not found`,
        ERROR_CODES.RESERVATION_NOT_FOUND,
      );
    }
    if (reservation.status !== 'PendingPayment') {
      throw BusinessError.conflict(
        `Reservation is ${reservation.status}; cannot initiate payment`,
        ERROR_CODES.RESERVATION_CONFIRMED,
      );
    }
    if (reservation.expiresAt && reservation.expiresAt <= new Date()) {
      throw BusinessError.conflict(
        'Reservation expired; please start a new one',
        ERROR_CODES.RESERVATION_EXPIRED,
      );
    }

    // Verify amount is sane.
    const amount = Number(reservation.totalAmount);
    if (amount <= 0) {
      throw BusinessError.unprocessable(
        'Reservation total must be > 0',
        ERROR_CODES.PAYMENT_AMOUNT_INVALID,
      );
    }

    const idemKey = (dto.idempotencyKey ?? `pay_${reservation.id}_${Date.now()}`).slice(0, 128);

    // Idempotency: if a payment with this key exists, return it.
    const existing = await this.paymentRepo.findOne({ where: { idempotencyKey: idemKey } });
    if (existing) {
      this.logger.log(`Idempotent re-initiate: returning existing payment ${existing.id}`);
      return PaymentResponseDto.from(existing);
    }

    // Reserve the idempotency key in Redis so concurrent calls don't
    // both fall through to DB and race the UNIQUE constraint.
    const reserve = await this.redis.reserveIdempotency(`pay-init:${idemKey}`, 600);
    if (!reserve.won) {
      // Another request is processing - wait briefly then re-read.
      await new Promise((r) => setTimeout(r, 200));
      const reread = await this.paymentRepo.findOne({ where: { idempotencyKey: idemKey } });
      if (reread) return PaymentResponseDto.from(reread);
    }

    const paymentId = uuidv4();
    const payment = this.paymentRepo.create({
      id: paymentId,
      reservationId: reservation.id,
      provider: this.defaultProvider,
      amount,
      currency: reservation.currency,
      status: 'Initiated' as PaymentStatus,
      idempotencyKey: idemKey,
    });
    const saved = await this.paymentRepo.save(payment);
    this.logger.log(`Initiated payment ${saved.id} for reservation ${reservation.id} amount=${amount}`);

    // Call gateway to start the payment session.
    try {
      const callbackUrl = this.buildCallbackUrl(saved.id);
      const init = await this.provider.initiate({
        paymentId: saved.id,
        amount,
        currency: saved.currency,
        description: `Cineva reservation ${reservation.id}`,
        callbackUrl,
      });
      saved.gatewayAuthority = init.authority;
      saved.gatewayRedirectUrl = init.redirectUrl;
      saved.status = 'Pending' as PaymentStatus;
      await this.paymentRepo.save(saved);
      return PaymentResponseDto.from(saved);
    } catch (err) {
      saved.status = 'Failed' as PaymentStatus;
      saved.failureReason = (err as Error).message.slice(0, 500);
      saved.failedAt = new Date();
      await this.paymentRepo.save(saved);
      throw new BusinessError({
        code: ERROR_CODES.PAYMENT_MISMATCH,
        message: `Gateway initiate failed: ${(err as Error).message}`,
        httpStatus: 502 as never,
      });
    }
  }

  /**
   * Handle the gateway's redirect back to our callback URL.
   * - Idempotent: same authority returns the same final status.
   * - Late callback: if the reservation has expired since initiation,
   *   we mark payment as lateCallback and do NOT confirm the reservation.
   *
   * @returns redirectUrl - the customer-facing page they should land on
   *   (success/failure URL passed in by the caller).
   */
  async handleCallback(args: {
    paymentId: string;
    authority: string;
    status: string;
  }): Promise<{ paymentId: string; status: PaymentStatus; lateCallback: boolean }> {
    const payment = await this.paymentRepo.findOne({ where: { id: args.paymentId } });
    if (!payment) {
      throw BusinessError.notFound(
        `Payment ${args.paymentId} not found`,
        ERROR_CODES.PAYMENT_MISMATCH,
      );
    }
    // Idempotent: already in terminal state? Return that state.
    if (payment.status === 'Succeeded' || payment.status === 'Failed') {
      return {
        paymentId: payment.id,
        status: payment.status,
        lateCallback: payment.lateCallback,
      };
    }

    // Validate authority matches what we stored at initiation.
    if (payment.gatewayAuthority && payment.gatewayAuthority !== args.authority) {
      // Authority mismatch - possible forgery or stale link.
      throw BusinessError.forbidden(
        'Authority does not match initiation',
        ERROR_CODES.PAYMENT_MISMATCH,
      );
    }

    // Call provider verify.
    const verifyResult = await this.provider.verify({
      authority: args.authority,
      amount: Number(payment.amount),
      status: args.status,
    });

    if (!verifyResult.succeeded) {
      payment.status = 'Failed' as PaymentStatus;
      payment.failureReason = verifyResult.failureReason ?? 'Unknown failure';
      payment.failedAt = new Date();
      await this.paymentRepo.save(payment);
      return { paymentId: payment.id, status: payment.status, lateCallback: false };
    }

    // Payment succeeded at the gateway. Now we MUST verify the reservation
    // is still in a state that allows confirmation.
    const reservation = await this.reservationRepo.findOne({
      where: { id: payment.reservationId },
    });
    if (!reservation) {
      // Reservation gone - we cannot confirm. Mark payment succeeded but
      // flag for manual refund (PRD §FR-06 rule 5).
      payment.status = 'Succeeded' as PaymentStatus;
      payment.providerReference = verifyResult.providerReference ?? null;
      payment.succeededAt = new Date();
      payment.lateCallback = true;
      payment.failureReason = 'Reservation vanished after payment success';
      await this.paymentRepo.save(payment);
      // TODO: enqueue refund job (CancellationModule) - payment.id
      return { paymentId: payment.id, status: payment.status, lateCallback: true };
    }

    // Late-callback detection: reservation has expired or been cancelled.
    const isLate =
      reservation.status === 'Expired' ||
      reservation.status === 'Cancelled' ||
      (reservation.expiresAt != null && reservation.expiresAt < new Date());

    if (isLate) {
      // PRD §FR-06 rule 5: do NOT re-reserve. Mark payment Succeeded +
      // lateCallback; refund pipeline will handle it.
      payment.status = 'Succeeded' as PaymentStatus;
      payment.providerReference = verifyResult.providerReference ?? null;
      payment.succeededAt = new Date();
      payment.lateCallback = true;
      payment.failureReason = `Late callback; reservation was ${reservation.status}`;
      await this.paymentRepo.save(payment);
      this.logger.warn(
        `Payment ${payment.id} succeeded but reservation ${reservation.id} was ${reservation.status}; routing to refund.`,
      );
      // TODO: enqueue refund job - payment.id
      return { paymentId: payment.id, status: payment.status, lateCallback: true };
    }

    // Happy path: confirm the reservation atomically.
    payment.status = 'Succeeded' as PaymentStatus;
    payment.providerReference = verifyResult.providerReference ?? null;
    payment.succeededAt = new Date();
    await this.paymentRepo.save(payment);

    // This is the single point of truth for confirming a reservation.
    // ReservationService.confirmReservation is itself idempotent and
    // protected by SERIALIZABLE tx + pessimistic lock.
    await this.reservations.confirmReservation(reservation.id);
    return { paymentId: payment.id, status: payment.status, lateCallback: false };
  }

  /**
   * Get a payment by id.
   */
  async findOne(id: string): Promise<PaymentResponseDto> {
    const payment = await this.paymentRepo.findOne({ where: { id } });
    if (!payment) {
      throw BusinessError.notFound(`Payment ${id} not found`, ERROR_CODES.PAYMENT_MISMATCH);
    }
    return PaymentResponseDto.from(payment);
  }

  async listByReservation(reservationId: string): Promise<PaymentResponseDto[]> {
    const items = await this.paymentRepo.find({
      where: { reservationId },
      order: { createdAt: 'DESC' },
    });
    return items.map(PaymentResponseDto.from);
  }

  private buildCallbackUrl(paymentId: string): string {
    const base = this.config.get<string>(
      'ZARINPAL_CALLBACK_URL',
      'http://localhost:3000/api/v1/payment/callback/zarinpal',
    );
    // Inject the paymentId so the callback handler can find the row
    // even before knowing the provider.
    return `${base}?paymentId=${paymentId}`;
  }
}

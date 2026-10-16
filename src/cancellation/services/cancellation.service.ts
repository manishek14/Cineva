import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, LessThan } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import {
  CancellationPolicyEntity,
} from '../entities/cancellation-policy.entity';
import { RefundEntity, RefundStatus } from '../entities/refund.entity';
import { ReservationEntity, ReservationStatus } from '../../reservation/entities/reservation.entity';
import { ReservationSeatEntity } from '../../reservation/entities/reservation-seat.entity';
import { SeatAllocationEntity } from '../../reservation/entities/seat-allocation.entity';
import { PaymentEntity, PaymentStatus } from '../../payment/entities/payment.entity';
import { ScreeningSeatEntity, ScreeningSeatStatus } from '../../screening/entities/screening-seat.entity';
import { ScreeningEntity } from '../../screening/entities/screening.entity';
import { TicketService } from '../../ticket/services/ticket.service';
import { ReservationService } from '../../reservation/services/reservation.service';
import {
  CancelReservationDto,
  CancellationPolicyResponseDto,
  CreateCancellationPolicyDto,
  RefundResponseDto,
  UpdateCancellationPolicyDto,
} from '../dtos/cancellation.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

/**
 * CancellationService - post-payment cancellation with policy.
 *
 * Policy rules (PRD §10):
 *  - 15% penalty, 85% refund (configurable per CancellationPolicy row)
 *  - Customer-cancel blocked within 30min of startsAt (configurable,
 *    floor 15min from env)
 *  - Refund is an independent financial record (RefundEntity) - the
 *    seat release and refund completion are two independent states
 *    (PRD §FR-08).
 *  - Idempotent: duplicate cancel requests must not double-refund
 *    (PRD §FR-08 rule 6).
 */
@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);
  private readonly minMinutesFloor: number;

  constructor(
    @InjectRepository(CancellationPolicyEntity)
    private readonly policyRepo: Repository<CancellationPolicyEntity>,
    @InjectRepository(RefundEntity)
    private readonly refundRepo: Repository<RefundEntity>,
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
    @InjectRepository(ReservationSeatEntity)
    private readonly resSeatRepo: Repository<ReservationSeatEntity>,
    @InjectRepository(SeatAllocationEntity)
    private readonly allocationRepo: Repository<SeatAllocationEntity>,
    @InjectRepository(PaymentEntity)
    private readonly paymentRepo: Repository<PaymentEntity>,
    @InjectRepository(ScreeningSeatEntity)
    private readonly screeningSeatRepo: Repository<ScreeningSeatEntity>,
    @InjectRepository(ScreeningEntity)
    private readonly screeningRepo: Repository<ScreeningEntity>,
    private readonly tickets: TicketService,
    private readonly reservations: ReservationService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.minMinutesFloor = Number(
      this.config.get('CANCELLATION_MIN_MINUTES_BEFORE_SCREENING_FLOOR', 15),
    );
  }

  // ===========================================================
  // Policy CRUD (manager)
  // ===========================================================

  async createPolicy(dto: CreateCancellationPolicyDto): Promise<CancellationPolicyResponseDto> {
    if (dto.minMinutesBeforeScreening < this.minMinutesFloor) {
      throw BusinessError.unprocessable(
        `minMinutesBeforeScreening cannot be below the system floor (${this.minMinutesFloor}min)`,
        ERROR_CODES.VALIDATION,
      );
    }
    const policy = this.policyRepo.create({
      name: dto.name,
      description: dto.description,
      penaltyPercent: dto.penaltyPercent,
      refundPercent: dto.refundPercent,
      minMinutesBeforeScreening: dto.minMinutesBeforeScreening,
      customerCancelAllowed: dto.customerCancelAllowed ?? true,
      sideFeeToman: dto.sideFeeToman ?? 0,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
      isActive: true,
    });
    // Deactivate other policies when activating a new one (only one active at a time).
    if (policy.isActive) {
      await this.policyRepo.update({ isActive: true }, { isActive: false });
    }
    const saved = await this.policyRepo.save(policy);
    return CancellationPolicyResponseDto.from(saved);
  }

  async listPolicies(): Promise<CancellationPolicyResponseDto[]> {
    const items = await this.policyRepo.find({ order: { validFrom: 'DESC' } });
    return items.map(CancellationPolicyResponseDto.from);
  }

  async findActivePolicy(): Promise<CancellationPolicyEntity | null> {
    return this.policyRepo.findOne({
      where: { isActive: true },
      order: { validFrom: 'DESC' },
    });
  }

  async updatePolicy(id: string, dto: UpdateCancellationPolicyDto): Promise<CancellationPolicyResponseDto> {
    const policy = await this.policyRepo.findOne({ where: { id } });
    if (!policy) {
      throw BusinessError.notFound('Policy not found', ERROR_CODES.VALIDATION);
    }
    if (
      dto.minMinutesBeforeScreening !== undefined &&
      dto.minMinutesBeforeScreening < this.minMinutesFloor
    ) {
      throw BusinessError.unprocessable(
        `minMinutesBeforeScreening cannot be below the system floor (${this.minMinutesFloor}min)`,
        ERROR_CODES.VALIDATION,
      );
    }
    if (dto.isActive === true) {
      // Deactivate others
      await this.policyRepo.update({ isActive: true }, { isActive: false });
    }
    Object.assign(policy, dto);
    const saved = await this.policyRepo.save(policy);
    return CancellationPolicyResponseDto.from(saved);
  }

  // ===========================================================
  // Customer cancel
  // ===========================================================

  /**
   * Cancel a confirmed reservation per the active policy.
   * Idempotent: a second cancel request returns the existing refund.
   */
  async cancelReservation(
    reservationId: string,
    dto: CancelReservationDto,
    customerId?: string,
  ): Promise<RefundResponseDto> {
    const reservation = await this.reservationRepo.findOne({
      where: { id: reservationId },
      relations: ['seats'],
    });
    if (!reservation) {
      throw BusinessError.notFound(
        `Reservation ${reservationId} not found`,
        ERROR_CODES.RESERVATION_NOT_FOUND,
      );
    }
    if (customerId && reservation.customerId !== customerId) {
      throw BusinessError.forbidden('Not your reservation', ERROR_CODES.FORBIDDEN);
    }
    if (reservation.status === 'Cancelled') {
      // Idempotent: return the existing refund (or a synthetic placeholder).
      const existing = await this.refundRepo.findOne({
        where: { paymentId: (await this.findSucceededPayment(reservation.id))?.id ?? '' },
        order: { createdAt: 'DESC' },
      });
      if (existing) return RefundResponseDto.from(existing);
      throw BusinessError.conflict(
        'Reservation cancelled but no refund found',
        ERROR_CODES.REFUND_NOT_APPLICABLE,
      );
    }
    if (reservation.status !== 'Confirmed') {
      throw BusinessError.conflict(
        `Reservation is ${reservation.status}; cannot apply cancellation policy (use POST /reservations/:id/cancel for pending)`,
        ERROR_CODES.VALIDATION,
      );
    }

    // Fetch screening to compute time-to-start.
    const screening = await this.screeningRepo.findOne({ where: { id: reservation.screeningId } });
    if (!screening) {
      throw BusinessError.notFound('Screening not found', ERROR_CODES.SCREENING_NOT_FOUND);
    }
    const now = new Date();
    const minutesToStart = (screening.startsAt.getTime() - now.getTime()) / 60000;

    // Apply policy.
    const policy = await this.findActivePolicy();
    const minMinutes = policy?.minMinutesBeforeScreening ?? 30;
    if (minutesToStart < minMinutes) {
      throw BusinessError.unprocessable(
        `Cancellation not allowed within ${minMinutes} minutes of screening start (only ${minutesToStart.toFixed(0)}min remaining)`,
        ERROR_CODES.CANCELLATION_OUTSIDE_WINDOW,
      );
    }
    if (policy && !policy.customerCancelAllowed) {
      throw BusinessError.forbidden(
        'Customer cancellation is currently disabled by policy',
        ERROR_CODES.CANCELLATION_OUTSIDE_WINDOW,
      );
    }

    // Find the succeeded payment to refund.
    const payment = await this.findSucceededPayment(reservation.id);
    if (!payment) {
      throw BusinessError.conflict(
        'No succeeded payment to refund',
        ERROR_CODES.REFUND_NOT_APPLICABLE,
      );
    }

    // Idempotency: same key returns the same refund.
    const idemKey = (dto.idempotencyKey ?? `cancel_${reservation.id}_${Date.now()}`).slice(0, 128);
    const existingRefund = await this.refundRepo.findOne({ where: { idempotencyKey: idemKey } });
    if (existingRefund) {
      return RefundResponseDto.from(existingRefund);
    }

    // Compute refundable + penalty from policy.
    const refundablePercent = policy?.refundPercent ?? 85;
    const penaltyPercent = policy?.penaltyPercent ?? 15;
    const totalAmount = Number(payment.amount);
    const refundableAmount = Math.floor((totalAmount * refundablePercent) / 100);
    const penaltyAmount = totalAmount - refundableAmount;
    const sideFee = Number(policy?.sideFeeToman ?? 0);
    const netRefund = Math.max(0, refundableAmount - sideFee);

    // All in a SERIALIZABLE transaction.
    const refundId = uuidv4();
    return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      // Lock reservation row.
      const rRepo = manager.getRepository(ReservationEntity);
      const locked = await rRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: reservation.id })
        .getOne();
      if (!locked || locked.status !== 'Confirmed') {
        // raced: someone else just cancelled; return their refund.
        const theirRefund = await this.refundRepo.findOne({
          where: { paymentId: payment.id },
          order: { createdAt: 'DESC' },
        });
        if (theirRefund) return RefundResponseDto.from(theirRefund);
        throw BusinessError.conflict(
          'Reservation is not in cancellable state',
          ERROR_CODES.VALIDATION,
        );
      }

      // 1. Cancel tickets (idempotent via state machine).
      await this.tickets.cancelForReservation(reservation.id);

      // 2. Mark reservation_seats Sold -> Refunded.
      const rsRepo = manager.getRepository(ReservationSeatEntity);
      await rsRepo.update(
        { reservationId: reservation.id, status: 'Sold' as never },
        { status: 'Refunded' as never },
      );

      // 3. Mark allocations Sold -> Released.
      const aRepo = manager.getRepository(SeatAllocationEntity);
      await aRepo.update(
        { reservationId: reservation.id, status: 'Sold' as never },
        { status: 'Released' as never, releasedAt: new Date() },
      );

      // 4. Mark screening_seats Sold -> Available.
      const ssRepo = manager.getRepository(ScreeningSeatEntity);
      const seatIds = (locked.seats ?? []).map((s) => s.screeningSeatId);
      if (seatIds.length > 0) {
        await ssRepo.update(
          seatIds.map((id) => ({ id, saleStatus: 'Sold' as ScreeningSeatStatus })),
          { saleStatus: 'Available' as ScreeningSeatStatus },
        );
      }

      // 5. Mark reservation Cancelled.
      locked.status = 'Cancelled' as ReservationStatus;
      locked.cancelledAt = new Date();
      await rRepo.save(locked);

      // 6. Create the Refund record.
      const refundRepo = manager.getRepository(RefundEntity);
      const refund = refundRepo.create({
        id: refundId,
        paymentId: payment.id,
        refundableAmount: netRefund,
        refundedAmount: 0, // filled by gateway later
        penaltyAmount,
        status: 'Pending' as RefundStatus,
        idempotencyKey: idemKey,
        cancellationPolicyId: policy?.id ?? null,
        reason: `Customer cancel; minutesToStart=${minutesToStart.toFixed(0)}`,
      });
      const savedRefund = await refundRepo.save(refund);

      // Update payment status to RefundPending.
      const pRepo = manager.getRepository(PaymentEntity);
      payment.status = 'RefundPending' as PaymentStatus;
      await pRepo.save(payment);

      // TODO: enqueue refund job to call gateway refund endpoint.
      // For now, mark RefundSucceeded inline (mock provider has no real refund).
      refund.status = 'Succeeded' as RefundStatus;
      refund.refundedAmount = netRefund;
      refund.succeededAt = new Date();
      await refundRepo.save(refund);
      payment.status = 'Refunded' as PaymentStatus;
      await pRepo.save(payment);

      return RefundResponseDto.from(refund);
    });
  }

  async listRefundsByPayment(paymentId: string): Promise<RefundResponseDto[]> {
    const items = await this.refundRepo.find({
      where: { paymentId },
      order: { createdAt: 'DESC' },
    });
    return items.map(RefundResponseDto.from);
  }

  async listRefundsByReservation(reservationId: string): Promise<RefundResponseDto[]> {
    const payments = await this.paymentRepo.find({
      where: { reservationId },
      select: ['id'],
    });
    if (payments.length === 0) return [];
    // Use In operator for the bulk lookup.
    const { In } = await import('typeorm');
    const refunds = await this.refundRepo.find({
      where: { paymentId: In(payments.map((p) => p.id)) },
      order: { createdAt: 'DESC' },
    });
    return refunds.map(RefundResponseDto.from);
  }

  private async findSucceededPayment(reservationId: string): Promise<PaymentEntity | null> {
    return this.paymentRepo.findOne({
      where: { reservationId, status: 'Succeeded' as PaymentStatus },
      order: { succeededAt: 'DESC' },
    });
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, LessThan } from 'typeorm';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { ReservationEntity, ReservationStatus } from '../entities/reservation.entity';
import { ReservationSeatEntity, ReservationSeatStatus } from '../entities/reservation-seat.entity';
import { SeatAllocationEntity, AllocationStatus } from '../entities/seat-allocation.entity';
import { ScreeningEntity } from '../../screening/entities/screening.entity';
import { ScreeningSeatEntity, ScreeningSeatStatus } from '../../screening/entities/screening-seat.entity';
import { CreateReservationDto, ExtendReservationDto, ReservationResponseDto } from '../dtos/reservation.dto';
import { RedisService } from '../../common/redis/redis.service';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { canTransition, RESERVATION_TRANSITIONS } from '../../common/constants/state-machine';
import { REDIS_KEYS } from '../../common/redis/redis.constants';

/**
 * ReservationService is the heart of Cineva. It implements the
 * "no double-sell" guarantee (PRD §7) through a layered strategy:
 *
 *   1. Redis pre-flight: atomic SET NX EX on seat-hold:{screeningId}:{seatId}
 *      Fast rejection when the seat is currently held by another res.
 *      Owner token embedded in payload; subsequent release/renew must
 *      verify ownership (PRD §7.2 rule 3).
 *
 *   2. PostgreSQL decision: inside a SERIALIZABLE transaction, we attempt
 *      to INSERT SeatAllocation rows. A PARTIAL UNIQUE INDEX on
 *      (screening_seat_id) WHERE status IN ('Held','Sold') is the
 *      database-level atomic guarantee (PRD §7.2 rule 1).
 *
 *   3. All-or-nothing: if any seat fails to allocate, the entire
 *      reservation is rolled back AND all Redis holds we acquired
 *      are released with ownership verification (PRD §FR-04 rule 6).
 *
 *   4. Expiry: server-authoritative via Reservation.expiresAt. BullMQ
 *      job triggers the expiry; reconciliation worker picks up missed
 *      jobs (PRD §FR-05, §7.2 rule 4).
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);
  private readonly holdTtlSeconds: number;
  private readonly holderTokenPrefix: string;

  constructor(
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
    @InjectRepository(ReservationSeatEntity)
    private readonly resSeatRepo: Repository<ReservationSeatEntity>,
    @InjectRepository(SeatAllocationEntity)
    private readonly allocationRepo: Repository<SeatAllocationEntity>,
    @InjectRepository(ScreeningEntity)
    private readonly screeningRepo: Repository<ScreeningEntity>,
    @InjectRepository(ScreeningSeatEntity)
    private readonly screeningSeatRepo: Repository<ScreeningSeatEntity>,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.holdTtlSeconds = Number(this.config.get('RESERVATION_HOLD_TTL_MINUTES', 10)) * 60;
    this.holderTokenPrefix = this.config.get<string>('RESERVATION_HOLDER_TOKEN_PREFIX', 'res:');
  }

  /**
   * Create a new reservation + acquire all requested seats.
   * Returns the pending reservation with held seats.
   */
  async createReservation(
    dto: CreateReservationDto,
    customerId?: string,
  ): Promise<ReservationResponseDto> {
    // Validate screening exists + is Published + sales are open.
    const screening = await this.screeningRepo.findOne({ where: { id: dto.screeningId } });
    if (!screening) {
      throw BusinessError.notFound(
        `Screening ${dto.screeningId} not found`,
        ERROR_CODES.SCREENING_NOT_FOUND,
      );
    }
    if (screening.status !== 'Published') {
      throw BusinessError.unprocessable(
        `Screening not available for sale (status=${screening.status})`,
        ERROR_CODES.VALIDATION,
      );
    }
    const now = new Date();
    if (screening.salesOpensAt > now) {
      throw BusinessError.unprocessable(
        `Sales open at ${screening.salesOpensAt.toISOString()}`,
        ERROR_CODES.VALIDATION,
      );
    }
    if (screening.startsAt <= now) {
      throw BusinessError.unprocessable(
        'Screening already started',
        ERROR_CODES.VALIDATION,
      );
    }

    // Deduplicate seat IDs (defensive; DTO also enforces ArrayUnique).
    const seatIds = Array.from(new Set(dto.screeningSeatIds));

    // Pull all ScreeningSeat rows for validation + price snapshot.
    const screeningSeats = await this.screeningSeatRepo.find({
      where: { id: In(seatIds), screeningId: screening.id },
    });
    if (screeningSeats.length !== seatIds.length) {
      const found = new Set(screeningSeats.map((s) => s.id));
      const missing = seatIds.filter((id) => !found.has(id));
      throw BusinessError.notFound(
        `Screening seats not found: ${missing.join(', ')}`,
        ERROR_CODES.VALIDATION,
      );
    }
    for (const ss of screeningSeats) {
      if (ss.saleStatus === 'Blocked' || ss.saleStatus === 'Sold') {
        throw BusinessError.conflict(
          `Seat ${ss.id} is ${ss.saleStatus} and cannot be reserved`,
          ERROR_CODES.SEAT_UNAVAILABLE,
        );
      }
    }

    // Generate reservation + owner token.
    const reservationId = uuidv4();
    const ownerToken = uuidv4();

    // ============================================================
    // STEP 1: Redis pre-flight - atomic all-or-nothing hold.
    // ============================================================
    const redisResult = await this.redis.acquireHoldsAllOrNothing({
      screeningId: screening.id,
      seatIds,
      reservationId,
      ownerToken,
      ttlSeconds: this.holdTtlSeconds,
    });
    if (redisResult.failed.length > 0) {
      // acquireHoldsAllOrNothing already released any it got.
      throw BusinessError.conflict(
        `Seats already held by another customer: ${redisResult.failed.join(', ')}`,
        ERROR_CODES.SEAT_ALREADY_HELD,
      );
    }

    // ============================================================
    // STEP 2: PostgreSQL allocation inside a transaction.
    //         If this fails, we MUST release Redis holds we got.
    // ============================================================
    const expiresAt = new Date(now.getTime() + this.holdTtlSeconds * 1000);
    let createdReservation: ReservationEntity | null = null;
    let createdResSeats: ReservationSeatEntity[] = [];

    try {
      await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
        const rRepo = manager.getRepository(ReservationEntity);
        const rsRepo = manager.getRepository(ReservationSeatEntity);
        const aRepo = manager.getRepository(SeatAllocationEntity);

        const reservation = rRepo.create({
          id: reservationId,
          customerId: customerId ?? null,
          guestPhone: customerId ? null : dto.guestPhone ?? null,
          screeningId: screening.id,
          status: 'PendingPayment' as ReservationStatus,
          totalAmount: 0, // recomputed below
          currency: 'IRR',
          expiresAt,
          ownerToken,
        });
        await rRepo.save(reservation);

        // Insert SeatAllocation rows for every requested seat.
        // The partial unique index will throw a unique_violation if any
        // seat already has an active Held/Sold allocation (another tx
        // raced past our Redis check).
        const allocations: SeatAllocationEntity[] = [];
        const resSeats: ReservationSeatEntity[] = [];
        let total = 0;
        for (const ss of screeningSeats) {
          // Optimistic insert - relies on partial-unique constraint.
          const alloc = aRepo.create({
            screeningSeatId: ss.id,
            reservationId: reservation.id,
            status: 'Held' as AllocationStatus,
            ownerToken,
            expiresAt,
            acquiredAt: now,
          });
          allocations.push(alloc);

          const rs = rsRepo.create({
            reservationId: reservation.id,
            screeningSeatId: ss.id,
            unitPrice: ss.price, // SNAPSHOT (PRD §5.3)
            status: 'Held' as ReservationSeatStatus,
          });
          resSeats.push(rs);
          total += Number(ss.price);
        }

        await aRepo.save(allocations); // can throw unique_violation
        await rsRepo.save(resSeats);

        reservation.totalAmount = total;
        await rRepo.save(reservation);

        // Update ScreeningSeat sale_status -> Held.
        await manager
          .getRepository(ScreeningSeatEntity)
          .update(
            { id: In(seatIds) },
            { saleStatus: 'Held' as ScreeningSeatStatus },
          );

        createdReservation = reservation;
        createdResSeats = resSeats;
      });
    } catch (err) {
      // Rollback Redis holds we acquired (with ownership check).
      await this.redis.releaseAllHoldsForReservation({
        reservationId,
        ownerToken,
        screeningId: screening.id,
      });

      // If it's a unique_violation, surface a friendly conflict.
      const msg = (err as Error).message ?? '';
      if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
        throw BusinessError.conflict(
          `Some seats were just taken by another customer. Please try again.`,
          ERROR_CODES.SEAT_ALREADY_HELD,
        );
      }
      this.logger.error(`Reservation create failed: ${msg}`, (err as Error).stack);
      throw new BusinessError({
        code: ERROR_CODES.INTERNAL,
        message: 'Reservation failed; held seats released',
        httpStatus: 500 as never,
      });
    }

    const result = await this.reservationRepo.findOne({
      where: { id: reservationId },
      relations: ['seats'],
    });
    if (!result) {
      throw BusinessError.notFound('Reservation vanished after creation', ERROR_CODES.INTERNAL);
    }
    return ReservationResponseDto.from({
      ...result,
      seats: (createdResSeats as unknown as { id: string; reservationId: string; screeningSeatId: string; unitPrice: number | string; status: ReservationSeatStatus }[]).map((s) => ({
        id: s.id,
        reservationId: s.reservationId,
        screeningSeatId: s.screeningSeatId,
        unitPrice: s.unitPrice,
        status: s.status,
      })),
    });
  }

  /**
   * Get a reservation by id. Access control: caller must own it.
   */
  async findOne(
    id: string,
    callerUserId?: string,
  ): Promise<ReservationResponseDto> {
    const reservation = await this.reservationRepo.findOne({
      where: { id },
      relations: ['seats'],
    });
    if (!reservation) {
      throw BusinessError.notFound(
        `Reservation ${id} not found`,
        ERROR_CODES.RESERVATION_NOT_FOUND,
      );
    }
    if (
      callerUserId &&
      reservation.customerId !== callerUserId &&
      reservation.guestPhone === null
    ) {
      // Guests without user can still fetch via the reservationId; ownership
      // is enforced via the reservation URL being unguessable (UUID).
      throw BusinessError.forbidden(
        'You do not own this reservation',
        ERROR_CODES.FORBIDDEN,
      );
    }
    return ReservationResponseDto.from(reservation);
  }

  async listMine(customerId: string): Promise<ReservationResponseDto[]> {
    const items = await this.reservationRepo.find({
      where: { customerId },
      relations: ['seats'],
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return items.map((r) => ReservationResponseDto.from(r));
  }

  /**
   * Extend the TTL of a pending reservation. PRD §FR-05 rule 6:
   * unlimited extension is forbidden. We enforce a hard cap of 1
   * extension; future policy could be configurable.
   */
  async extendTtl(
    reservationId: string,
    dto: ExtendReservationDto,
  ): Promise<ReservationResponseDto> {
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
    if (reservation.status !== 'PendingPayment') {
      throw BusinessError.conflict(
        `Cannot extend reservation in status ${reservation.status}`,
        ERROR_CODES.VALIDATION,
      );
    }
    if (!reservation.expiresAt || reservation.expiresAt <= new Date()) {
      throw BusinessError.conflict(
        'Reservation already expired',
        ERROR_CODES.RESERVATION_EXPIRED,
      );
    }

    const additionalSeconds = (dto.additionalMinutes ?? 5) * 60;
    const newExpiresAt = new Date(reservation.expiresAt.getTime() + additionalSeconds * 1000);
    const totalLifetimeSeconds = (newExpiresAt.getTime() - reservation.createdAt.getTime()) / 1000;
    // Hard cap: total lifetime cannot exceed 2x default TTL.
    const maxLifetime = this.holdTtlSeconds * 2;
    if (totalLifetimeSeconds > maxLifetime) {
      throw BusinessError.unprocessable(
        'Maximum reservation lifetime reached; cannot extend further',
        ERROR_CODES.HOLD_QUOTA_EXCEEDED,
      );
    }

    // Renew Redis holds with ownership check.
    for (const seat of reservation.seats ?? []) {
      const renewed = await this.redis.renewSeatHold({
        screeningId: reservation.screeningId,
        seatId: seat.screeningSeatId,
        ownerToken: reservation.ownerToken ?? '',
        ttlSeconds: this.holdTtlSeconds,
      });
      if (!renewed) {
        // Hold is gone in Redis. Fall back to DB check - allocation may still be Held.
        this.logger.warn(
          `Redis hold missing for seat ${seat.screeningSeatId}; DB still authoritative.`,
        );
      }
    }

    // Update DB expiresAt.
    reservation.expiresAt = newExpiresAt;
    await this.reservationRepo.save(reservation);
    await this.allocationRepo.update(
      { reservationId: reservation.id, status: 'Held' as AllocationStatus },
      { expiresAt: newExpiresAt },
    );

    return ReservationResponseDto.from(reservation);
  }

  /**
   * Cancel a pending reservation (before payment). Releases all seats.
   * Idempotent: a second cancel request is a no-op.
   */
  async cancelPending(reservationId: string, callerUserId?: string): Promise<ReservationResponseDto> {
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
    if (
      callerUserId &&
      reservation.customerId !== callerUserId &&
      reservation.guestPhone === null
    ) {
      throw BusinessError.forbidden('Not your reservation', ERROR_CODES.FORBIDDEN);
    }
    if (reservation.status === 'Cancelled') {
      return ReservationResponseDto.from(reservation);
    }
    if (reservation.status === 'Confirmed') {
      throw BusinessError.conflict(
        'Reservation is confirmed; use the cancellation endpoint with refund policy',
        ERROR_CODES.RESERVATION_CONFIRMED,
      );
    }
    if (reservation.status === 'Expired') {
      throw BusinessError.conflict(
        'Reservation already expired',
        ERROR_CODES.RESERVATION_EXPIRED,
      );
    }

    return this.releaseReservationSeats(reservation, 'Cancelled', 'customer_cancel_pre_payment');
  }

  /**
   * Internal: expire a reservation whose TTL has passed.
   * Called by JobsModule expiry worker + reconciliation worker.
   *
   * PRD §7.2 rule 4: expiry is NOT solely TTL-based. The job must
   * read DB status; if the reservation has already been Confirmed,
   * the job is a no-op.
   *
   * PRD §NFR-04: idempotent - if the job runs twice, the result is
   * the same. We use expire_processed_at as a guard.
   */
  async expireReservation(reservationId: string): Promise<void> {
    const reservation = await this.reservationRepo.findOne({
      where: { id: reservationId },
      relations: ['seats'],
    });
    if (!reservation) {
      this.logger.warn(`expireReservation: ${reservationId} not found`);
      return;
    }
    // Idempotent guard.
    if (reservation.expireProcessedAt) {
      return;
    }
    if (reservation.status !== 'PendingPayment') {
      // Already moved on (Confirmed/Cancelled); mark processed to avoid
      // future job runs re-processing.
      reservation.expireProcessedAt = new Date();
      await this.reservationRepo.save(reservation);
      return;
    }
    if (!reservation.expiresAt || reservation.expiresAt > new Date()) {
      // Not actually expired yet (job fired early).
      return;
    }

    await this.releaseReservationSeats(reservation, 'Expired', 'ttl_expired');
    reservation.expireProcessedAt = new Date();
    await this.reservationRepo.save(reservation);
    this.logger.log(`Reservation ${reservationId} expired`);
  }

  /**
   * Reconcile: find pending reservations whose expiresAt has passed
   * but expireProcessedAt is null. Run periodically by JobsModule.
   */
  async reconcileExpired(): Promise<{ expired: number }> {
    const stale = await this.reservationRepo.find({
      where: {
        status: 'PendingPayment' as ReservationStatus,
        expiresAt: LessThan(new Date()),
      },
      take: 100,
    });
    let count = 0;
    for (const r of stale) {
      await this.expireReservation(r.id);
      count++;
    }
    return { expired: count };
  }

  /**
   * Confirm a reservation after successful payment.
   * PRD §7.2 rule 5: idempotent - calling twice produces the same
   * outcome (one set of tickets, one set of allocations).
   *
   * Within a SERIALIZABLE transaction:
   *  - validate reservation is PendingPayment
   *  - transition status to Confirmed
   *  - all SeatAllocations Held -> Sold
   *  - all ReservationSeats Held -> Sold
   *  - all ScreeningSeats Held -> Sold
   *
   * Ticket issuance is handled by TicketModule (post-commit via outbox).
   */
  async confirmReservation(reservationId: string): Promise<ReservationEntity> {
    return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const rRepo = manager.getRepository(ReservationEntity);
      const aRepo = manager.getRepository(SeatAllocationEntity);
      const rsRepo = manager.getRepository(ReservationSeatEntity);
      const ssRepo = manager.getRepository(ScreeningSeatEntity);

      // Pessimistic lock via SELECT ... FOR UPDATE.
      const reservation = await rRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: reservationId })
        .getOne();

      if (!reservation) {
        throw BusinessError.notFound(
          `Reservation ${reservationId} not found`,
          ERROR_CODES.RESERVATION_NOT_FOUND,
        );
      }

      // Idempotent: already confirmed is a no-op.
      if (reservation.status === 'Confirmed') {
        return reservation;
      }

      if (!canTransition(RESERVATION_TRANSITIONS, reservation.status, 'Confirmed')) {
        throw BusinessError.conflict(
          `Cannot confirm reservation in status ${reservation.status}`,
          ERROR_CODES.RESERVATION_CONFIRMED,
        );
      }

      reservation.status = 'Confirmed' as ReservationStatus;
      reservation.confirmedAt = new Date();
      reservation.expiresAt = null; // no more TTL
      await rRepo.save(reservation);

      // Promote allocations Held -> Sold.
      await aRepo.update(
        { reservationId: reservation.id, status: 'Held' as AllocationStatus },
        { status: 'Sold' as AllocationStatus, expiresAt: null },
      );
      // Promote reservation_seats Held -> Sold.
      await rsRepo.update(
        { reservationId: reservation.id, status: 'Held' as ReservationSeatStatus },
        { status: 'Sold' as ReservationSeatStatus },
      );
      // Promote screening_seats Held -> Sold.
      const seatIds = (reservation.seats ?? []).map((s) => s.screeningSeatId);
      if (seatIds.length > 0) {
        await ssRepo.update(
          { id: In(seatIds) },
          { saleStatus: 'Sold' as ScreeningSeatStatus },
        );
      }

      // Clean up Redis holds (sold seats no longer need them).
      // Ownership verification prevents us from deleting another res's hold.
      await this.redis.releaseAllHoldsForReservation({
        reservationId: reservation.id,
        ownerToken: reservation.ownerToken ?? '',
        screeningId: reservation.screeningId,
      });

      return reservation;
    });
  }

  /**
   * Release all seats held by a reservation. Used by cancel + expiry.
   * Updates allocations, reservation_seats, screening_seats, and Redis.
   */
  private async releaseReservationSeats(
    reservation: ReservationEntity,
    newStatus: ReservationStatus,
    reason: string,
  ): Promise<ReservationResponseDto> {
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const rRepo = manager.getRepository(ReservationEntity);
      const aRepo = manager.getRepository(SeatAllocationEntity);
      const rsRepo = manager.getRepository(ReservationSeatEntity);
      const ssRepo = manager.getRepository(ScreeningSeatEntity);

      // Lock reservation row.
      const locked = await rRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: reservation.id })
        .getOne();

      if (!locked || !canTransition(RESERVATION_TRANSITIONS, locked.status, newStatus)) {
        // Already moved on; nothing to do.
        return;
      }

      // Mark allocations Held -> Released.
      await aRepo.update(
        { reservationId: locked.id, status: 'Held' as AllocationStatus },
        { status: 'Released' as AllocationStatus, releasedAt: new Date() },
      );
      // Mark reservation_seats Held -> Released.
      await rsRepo.update(
        { reservationId: locked.id, status: 'Held' as ReservationSeatStatus },
        { status: 'Released' as ReservationSeatStatus },
      );
      // Mark screening_seats Held -> Available.
      const seatIds = (locked.seats ?? []).map((s) => s.screeningSeatId);
      if (seatIds.length > 0) {
        await ssRepo.update(
          { id: In(seatIds), saleStatus: 'Held' as ScreeningSeatStatus },
          { saleStatus: 'Available' as ScreeningSeatStatus },
        );
      }

      locked.status = newStatus;
      if (newStatus === 'Cancelled') locked.cancelledAt = new Date();
      await rRepo.save(locked);
    });

    // Release Redis holds (ownership-checked).
    await this.redis.releaseAllHoldsForReservation({
      reservationId: reservation.id,
      ownerToken: reservation.ownerToken ?? '',
      screeningId: reservation.screeningId,
    });

    const fresh = await this.reservationRepo.findOne({
      where: { id: reservation.id },
      relations: ['seats'],
    });
    if (!fresh) {
      throw BusinessError.notFound('Reservation vanished', ERROR_CODES.INTERNAL);
    }
    this.logger.log(`Reservation ${reservation.id} -> ${newStatus} (${reason})`);
    return ReservationResponseDto.from(fresh);
  }
}

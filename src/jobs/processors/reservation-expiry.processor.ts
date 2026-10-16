import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ReservationEntity } from '../../reservation/entities/reservation.entity';
import { ReservationService } from '../../reservation/services/reservation.service';
import { QUEUES, type ReservationExpiryJobData } from '../jobs.constants';

/**
 * ReservationExpiryProcessor - consumes jobs from the
 * 'reservation-expiry' queue. Each job carries a reservationId and
 * was scheduled to fire at the reservation's expiresAt.
 *
 * Per PRD §7.2 rule 4: the JOB is NOT the source of truth. We must
 * re-read the reservation from DB and decide based on actual state:
 *  - If already Confirmed/Cancelled -> no-op (idempotent)
 *  - If still PendingPayment and expiresAt has passed -> expire
 *  - If still PendingPayment but expiresAt has NOT passed (job fired
 *    early or was retried) -> re-queue
 *
 * Per PRD §NFR-04: idempotent. If the job runs twice, the result is
 * the same. ReservationService.expireReservation uses an
 * `expire_processed_at` guard for this.
 *
 * Per PRD §7.3 (Redis/DB failure): if the worker was down and jobs
 * were never queued, the reconciliation worker catches missed
 * expirations.
 */
@Processor(QUEUES.RESERVATION_EXPIRY, { concurrency: 5 })
@Injectable()
export class ReservationExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(ReservationExpiryProcessor.name);

  constructor(
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
    private readonly reservations: ReservationService,
  ) {
    super();
  }

  async process(job: Job<ReservationExpiryJobData>): Promise<void> {
    const { reservationId } = job.data;
    this.logger.debug(`Processing expiry for ${reservationId} (attempt ${job.attemptsMade + 1})`);

    try {
      // ReservationService.expireReservation is idempotent and
      // re-checks the DB status before doing anything.
      await this.reservations.expireReservation(reservationId);
    } catch (err) {
      // Re-throw so BullMQ can retry per the queue's retry policy.
      this.logger.error(
        `Expiry job failed for ${reservationId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `Expiry job ${job.id} for reservation ${job.data.reservationId} failed permanently: ${err.message}`,
    );
  }
}

/**
 * ReconciliationProcessor - periodically scans for reservations that
 * should have expired but whose expiry job was lost (worker was down,
 * Redis was flushed, etc).
 *
 * Runs every 1 minute via a repeatable job. Uses the same
 * ReservationService.reconcileExpired entry point as the regular
 * expiry processor, so semantics are identical.
 */
@Processor(QUEUES.RECONCILIATION)
@Injectable()
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly reservations: ReservationService,
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.debug(`Reconciliation running (job ${job.id})`);
    try {
      const result = await this.reservations.reconcileExpired();
      if (result.expired > 0) {
        this.logger.log(`Reconciliation expired ${result.expired} stale reservations`);
      }
    } catch (err) {
      this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
      throw err;
    }
  }
}

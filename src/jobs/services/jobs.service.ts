import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ReservationEntity } from '../../reservation/entities/reservation.entity';
import { QUEUES, type ReconciliationJobData, type ReservationExpiryJobData } from '../jobs.constants';

/**
 * JobsService - producer side. Used by ReservationService to enqueue
 * an expiry job at reservation creation time, scheduled to fire at
 * expiresAt (using BullMQ's delayed jobs).
 *
 * Also registers the repeatable reconciliation job on startup.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectQueue(QUEUES.RESERVATION_EXPIRY)
    private readonly expiryQueue: Queue<ReservationExpiryJobData>,
    @InjectQueue(QUEUES.RECONCILIATION)
    private readonly reconciliationQueue: Queue<ReconciliationJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register the repeatable reconciliation job (every 60 seconds).
    // Idempotent: addJob with same repeat options won't duplicate.
    try {
      await this.reconciliationQueue.add(
        'reconcile-expired',
        { scope: 'all' },
        {
          repeat: { pattern: '*/1 * * * *' }, // every minute (cron)
          jobId: 'reconcile-expired-repeatable',
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      this.logger.log('Registered reconciliation repeatable job (every 1 min)');
    } catch (err) {
      // Already exists - that's fine.
      this.logger.debug(`Reconciliation repeatable job already registered: ${(err as Error).message}`);
    }
  }

  /**
   * Schedule an expiry job for a reservation. The job will fire at
   * `expiresAt`. If the worker is busy/down at that time, BullMQ
   * retries per the queue's default backoff.
   *
   * jobId = reservationId for idempotency - if we enqueue the same
   * reservation's expiry twice (e.g. via extendTtl), BullMQ replaces
   * the old delayed job instead of queueing a duplicate.
   */
  async scheduleReservationExpiry(reservation: ReservationEntity): Promise<void> {
    if (!reservation.expiresAt) return;
    const delay = Math.max(0, reservation.expiresAt.getTime() - Date.now());
    await this.expiryQueue.add(
      'expire-reservation',
      {
        reservationId: reservation.id,
        expiresAt: reservation.expiresAt.toISOString(),
      },
      {
        delay,
        jobId: `expire-${reservation.id}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s, 40s, 80s
        },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );
    this.logger.debug(`Scheduled expiry for ${reservation.id} in ${Math.round(delay / 1000)}s`);
  }

  /**
   * Cancel a previously scheduled expiry job. Called by
   * ReservationService.confirmReservation (no more TTL).
   */
  async cancelReservationExpiry(reservationId: string): Promise<void> {
    await this.expiryQueue.remove(`expire-${reservationId}`).catch(() => {
      // job already gone - that's fine
    });
    this.logger.debug(`Cancelled expiry job for ${reservationId}`);
  }
}

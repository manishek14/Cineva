import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { AuditService } from '../services/audit.service';
import { OutboxEventEntity, OutboxStatus } from '../entities/outbox-event.entity';
import { QUEUES } from '../../jobs/jobs.constants';

/**
 * OutboxProcessor - scans the outbox_events table for Pending entries
 * and dispatches them.
 *
 * For now, dispatching just means logging (real implementations would
 * publish to a webhook, Kafka, or push notification service). The
 * pattern guarantees no event is lost if the app crashes between tx
 * commit and event publication (PRD §12).
 *
 * Runs as a repeatable BullMQ job every 30s.
 */
@Processor(QUEUES.OUTBOX_DISPATCH)
@Injectable()
export class OutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxRepo: Repository<OutboxEventEntity>,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    // Find pending events whose next_retry_at has passed (or is null).
    const stale = await this.outboxRepo.find({
      where: { status: 'Pending' as OutboxStatus },
      take: 50,
      order: { createdAt: 'ASC' },
    });
    if (stale.length === 0) return;

    this.logger.debug(`Dispatching ${stale.length} outbox events`);
    for (const event of stale) {
      try {
        // TODO: real dispatch logic (webhook, Kafka, notification, etc).
        // For now: just log the event payload.
        this.logger.log(
          `[OUTBOX] ${event.eventType} ${event.aggregateType}:${event.aggregateId}`,
        );
        await this.audit.markDispatched(event.id);
      } catch (err) {
        this.logger.error(
          `Failed to dispatch outbox event ${event.id}: ${(err as Error).message}`,
        );
        await this.audit.markFailed(event.id, err as Error);
      }
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`Outbox dispatch job ${job.id} failed: ${err.message}`);
  }
}

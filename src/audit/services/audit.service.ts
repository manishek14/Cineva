import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, LessThan } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { AuditLogEntity, AuditLogLevel } from '../entities/audit-log.entity';
import { OutboxEventEntity, OutboxStatus } from '../entities/outbox-event.entity';

interface LogArgs {
  actorId?: string | null;
  actorRole?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  level?: AuditLogLevel;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  traceId?: string | null;
  message?: string | null;
}

/**
 * AuditService - dual purpose:
 *  1) auditLog(args): append an AuditLog row. Should be called from
 *     within a transaction if you want the audit row to commit/rollback
 *     alongside the business row.
 *  2) recordEvent(args): append an OutboxEvent row. Used for events
 *     that must fire AFTER the business tx commits (webhooks, notifs).
 *
 * Both write to PostgreSQL - we never publish to in-process event
 * emitters from inside the tx because NestJS EventEmitter is not
 * transactional (PRD §12: 'استفاده از الگوی Transactional Outbox
 * گزینه مناسبی است').
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly auditRepo: Repository<AuditLogEntity>,
    @InjectRepository(OutboxEventEntity)
    private readonly outboxRepo: Repository<OutboxEventEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Append an audit log entry. If a transaction manager is provided
   * via `manager`, the row is written inside that tx; otherwise it's
   * written in its own tx.
   */
  async log(args: LogArgs, manager?: import('typeorm').EntityManager): Promise<void> {
    const repo = manager?.getRepository(AuditLogEntity) ?? this.auditRepo;
    const entry = repo.create({
      actorId: args.actorId ?? null,
      actorRole: args.actorRole ?? null,
      entityType: args.entityType,
      entityId: args.entityId,
      action: args.action,
      level: args.level ?? 'info',
      beforeJson: args.before ?? null,
      afterJson: args.after ?? null,
      occurredAt: new Date(),
      traceId: args.traceId ?? null,
      message: args.message ?? null,
    });
    await repo.save(entry);
  }

  /**
   * Append an outbox event. Must be called from within the same tx
   * as the business operation (PRD §12 - transactional outbox).
   */
  async recordEvent(
    args: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
      headers?: Record<string, unknown> | null;
    },
    manager?: import('typeorm').EntityManager,
  ): Promise<void> {
    const repo = manager?.getRepository(OutboxEventEntity) ?? this.outboxRepo;
    const event = repo.create({
      aggregateType: args.aggregateType,
      aggregateId: args.aggregateId,
      eventType: args.eventType,
      payload: args.payload,
      headers: args.headers ?? null,
      status: 'Pending' as OutboxStatus,
    });
    await repo.save(event);
  }

  /**
   * Reconciliation: scan for stale Pending outbox events older than
   * a threshold and re-dispatch them. Called by JobsModule periodically.
   */
  async findStaleOutboxEvents(olderThanSeconds: number, take = 50): Promise<OutboxEventEntity[]> {
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
    return this.outboxRepo.find({
      where: { status: 'Pending' as OutboxStatus, createdAt: LessThan(cutoff) },
      take,
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Mark an outbox event as dispatched.
   */
  async markDispatched(eventId: string, manager?: import('typeorm').EntityManager): Promise<void> {
    const repo = manager?.getRepository(OutboxEventEntity) ?? this.outboxRepo;
    await repo.update(eventId, {
      status: 'Dispatched' as OutboxStatus,
      dispatchedAt: new Date(),
    });
  }

  /**
   * Mark as failed, schedule retry.
   */
  async markFailed(
    eventId: string,
    err: Error,
    manager?: import('typeorm').EntityManager,
  ): Promise<void> {
    const repo = manager?.getRepository(OutboxEventEntity) ?? this.outboxRepo;
    const event = await repo.findOne({ where: { id: eventId } });
    if (!event) return;
    event.status = 'Pending' as OutboxStatus;
    event.retryCount = (event.retryCount ?? 0) + 1;
    event.lastError = err.message.slice(0, 1000);
    // Exponential backoff: 2^retryCount seconds (max 5 min = 300s).
    const backoff = Math.min(2 ** event.retryCount, 300);
    event.nextRetryAt = new Date(Date.now() + backoff * 1000);
    if (event.retryCount >= 10) {
      event.status = 'Failed' as OutboxStatus;
    }
    await repo.save(event);
  }
}

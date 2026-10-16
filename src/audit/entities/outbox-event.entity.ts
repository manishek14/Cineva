import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type OutboxStatus = 'Pending' | 'Dispatched' | 'Failed' | 'Skipped';

/**
 * OutboxEvent - entries written inside the same transaction as the
 * business operation, then published to consumers AFTER commit by
 * the OutboxProcessor.
 *
 * This implements the Transactional Outbox pattern (PRD §12):
 *   - INSERT reservation UPDATE + INSERT outbox_event in one tx
 *   - A separate poller (OutboxProcessor) scans for Pending events
 *     and dispatches them (webhook, notification, log sink, etc.)
 *   - If the app crashes between commit and dispatch, the event is
 *     not lost - the poller picks it up on restart.
 *
 * `payload` is the event body (JSONB). `headers` carry tracing metadata.
 */
@Entity({ name: 'outbox_events' })
@Index('idx_outbox_status_created', ['status', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxEventEntity extends BaseEntity {
  @Column({
    name: 'aggregate_type',
    type: 'varchar',
    length: 32,
    nullable: false,
  })
  aggregateType!: string;

  @Column({ name: 'aggregate_id', type: 'uuid', nullable: false })
  aggregateId!: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 64,
    nullable: false,
  })
  eventType!: string;

  @Column({ name: 'payload', type: 'jsonb', nullable: false })
  payload!: Record<string, unknown>;

  @Column({ name: 'headers', type: 'jsonb', nullable: true })
  headers?: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Pending',
  })
  status!: OutboxStatus;

  @Column({ name: 'retry_count', type: 'integer', nullable: false, default: 0 })
  retryCount!: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt?: Date | null;

  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt?: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;
}

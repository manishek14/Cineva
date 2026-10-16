import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type AuditLogLevel = 'info' | 'warn' | 'error';

/**
 * AuditLog - append-only record of sensitive business operations.
 * Every state transition of a Reservation, Payment, Ticket, or Refund
 * should write an AuditLog row.
 *
 * `beforeJson` / `afterJson` capture the entity state pre/post action.
 * Never mutated after creation (no UPDATE - app layer enforces).
 */
@Entity({ name: 'audit_logs' })
@Index('idx_audit_entity', ['entityType', 'entityId'])
@Index('idx_audit_actor', ['actorId'])
@Index('idx_audit_occurred_at', ['occurredAt'])
export class AuditLogEntity extends BaseEntity {
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId?: string | null;

  @Column({ name: 'actor_role', type: 'varchar', length: 32, nullable: true })
  actorRole?: string | null;

  @Column({
    name: 'entity_type',
    type: 'varchar',
    length: 32,
    nullable: false,
  })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: false })
  entityId!: string;

  @Column({
    name: 'action',
    type: 'varchar',
    length: 64,
    nullable: false,
  })
  action!: string;

  @Column({ name: 'level', type: 'varchar', length: 8, nullable: false, default: 'info' })
  level!: AuditLogLevel;

  @Column({ name: 'before_json', type: 'jsonb', nullable: true })
  beforeJson?: Record<string, unknown> | null;

  @Column({ name: 'after_json', type: 'jsonb', nullable: true })
  afterJson?: Record<string, unknown> | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', nullable: false })
  occurredAt!: Date;

  @Column({ name: 'trace_id', type: 'varchar', length: 64, nullable: true })
  traceId?: string | null;

  @Column({ name: 'message', type: 'text', nullable: true })
  message?: string | null;
}

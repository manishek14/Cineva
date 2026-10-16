import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { PaymentEntity } from '../../payment/entities/payment.entity';

export type RefundStatus = 'Pending' | 'Succeeded' | 'Failed' | 'Cancelled';

/**
 * Refund - independent financial record of a refund for a payment.
 * Decoupled from the Payment status field (PRD §9.2: 'در صورت پشتیبانی
 * از بازپرداخت جزئی، وضعیت بازپرداخت باید مستقل از وضعیت پرداخت اصلی
 * مدل شود'). A single Payment can have multiple Refund rows.
 *
 * `refundableAmount` is the maximum cap (PRD §6.3 - مجموع بازپرداخت‌ها
 * نباید از مبلغ قابل بازپرداخت بیشتر شود). Service layer enforces.
 *
 * `idempotencyKey` makes duplicate refund requests idempotent.
 */
@Entity({ name: 'refunds' })
@Index('idx_refund_payment', ['paymentId'])
@Index('idx_refund_status', ['status'])
@Check(`"refundable_amount" >= 0`)
@Check(`"refunded_amount" >= 0 AND "refunded_amount" <= "refundable_amount"`)
export class RefundEntity extends BaseEntity {
  @Column({ name: 'payment_id', type: 'uuid', nullable: false })
  paymentId!: string;

  @ManyToOne(() => PaymentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment?: PaymentEntity;

  @Column({
    name: 'refundable_amount',
    type: 'numeric',
    precision: 14,
    scale: 0,
    nullable: false,
  })
  refundableAmount!: number;

  @Column({
    name: 'refunded_amount',
    type: 'numeric',
    precision: 14,
    scale: 0,
    nullable: false,
    default: 0,
  })
  refundedAmount!: number;

  @Column({
    name: 'penalty_amount',
    type: 'numeric',
    precision: 14,
    scale: 0,
    nullable: false,
    default: 0,
  })
  penaltyAmount!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Pending',
  })
  status!: RefundStatus;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: false, unique: true })
  idempotencyKey!: string;

  @Column({ name: 'provider_reference', type: 'varchar', length: 128, nullable: true })
  providerReference?: string | null;

  @Column({ name: 'cancellation_policy_id', type: 'uuid', nullable: true })
  cancellationPolicyId?: string | null;

  @Column({ name: 'reason', type: 'varchar', length: 200, nullable: true })
  reason?: string | null;

  @Column({ name: 'succeeded_at', type: 'timestamptz', nullable: true })
  succeededAt?: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null;
}

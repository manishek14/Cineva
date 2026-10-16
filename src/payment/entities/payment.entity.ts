import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { ReservationEntity } from '../../reservation/entities/reservation.entity';

export type PaymentStatus =
  | 'Initiated'
  | 'Pending'
  | 'Succeeded'
  | 'Failed'
  | 'Cancelled'
  | 'RefundPending'
  | 'Refunded';

export type PaymentProvider = 'mock' | 'zarinpal';

/**
 * Payment - one attempt to pay for a reservation.
 * A reservation can have multiple Payment rows (retries), but only one
 * can reach Succeeded (PRD §5.2: Reservation 1 -> N Payment).
 *
 * `idempotencyKey` is the KEY for duplicate-callback protection
 * (PRD §FR-06). Same key across two requests must produce one outcome.
 *
 * `providerReference` is the bank/gateway reference returned after a
 * successful verification (e.g. Zarinpal's ref_id). UNIQUE when non-null
 * to prevent duplicate recording of the same bank transaction (PRD §6
 * - "یکتایی مرجع پرداخت درگاه در صورت وجود").
 *
 * `amount` and `currency` snapshot the reservation's totalAmount at
 * the time of payment attempt. Mismatch with reservation totalAmount
 * must be caught and rejected (PRD §6.3).
 */
@Entity({ name: 'payments' })
@Index('idx_payments_reservation', ['reservationId'])
@Index('idx_payments_status', ['status'])
@Index('idx_payments_idem', ['idempotencyKey'], { unique: true })
@Check(`"amount" > 0`)
export class PaymentEntity extends BaseEntity {
  @Column({ name: 'reservation_id', type: 'uuid', nullable: false })
  reservationId!: string;

  @ManyToOne(() => ReservationEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reservation_id' })
  reservation?: ReservationEntity;

  @Column({
    name: 'provider',
    type: 'varchar',
    length: 16,
    nullable: false,
  })
  provider!: PaymentProvider;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 14,
    scale: 0,
    nullable: false,
  })
  amount!: number;

  @Column({ name: 'currency', type: 'varchar', length: 8, nullable: false, default: 'IRR' })
  currency!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Initiated',
  })
  status!: PaymentStatus;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: false })
  idempotencyKey!: string;

  @Column({ name: 'provider_reference', type: 'varchar', length: 128, nullable: true })
  providerReference?: string | null;

  @Column({ name: 'gateway_authority', type: 'varchar', length: 128, nullable: true })
  gatewayAuthority?: string | null;

  @Column({ name: 'gateway_redirect_url', type: 'varchar', length: 500, nullable: true })
  gatewayRedirectUrl?: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', length: 500, nullable: true })
  failureReason?: string | null;

  @Column({ name: 'succeeded_at', type: 'timestamptz', nullable: true })
  succeededAt?: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null;

  @Column({ name: 'late_callback', type: 'boolean', nullable: false, default: false })
  lateCallback!: boolean;
}

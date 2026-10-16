import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  Check,
  type Relation,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { ReservationSeatEntity } from './reservation-seat.entity';

export type ReservationStatus = 'PendingPayment' | 'Confirmed' | 'Expired' | 'Cancelled';

/**
 * Reservation - a customer's order attempt. Lifecycle:
 *
 *   PendingPayment --[confirm]--> Confirmed
 *   PendingPayment --[expire]----> Expired
 *   PendingPayment --[cancel]----> Cancelled
 *   Confirmed      --[cancel w/ policy]--> Cancelled
 *
 * `expiresAt` is the SERVER-AUTHORITATIVE deadline for PendingPayment
 * (PRD §FR-05 rule 4 - browser timer is display-only, never decision).
 * Stored both in PostgreSQL (here) and mirrored in Redis TTL for fast
 * pre-checks.
 *
 * `totalAmount` is a snapshot of the sum of ReservationSeat.unitPrice
 * at creation time (PRD §5.3 - prices don't change post-order).
 *
 * `guestPhone` is set for guest reservations (user not yet logged in
 * but OTP-verified the phone). `customerId` is set after the guest
 * completes OTP, lazy-linking to a User row.
 */
@Entity({ name: 'reservations' })
@Index('idx_reservations_customer', ['customerId'])
@Index('idx_reservations_status_expires', ['status', 'expiresAt'])
@Index('idx_reservations_screening', ['screeningId'])
@Check(`"total_amount" >= 0`)
export class ReservationEntity extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'customer_id' })
  customer?: UserEntity | null;

  @Column({ name: 'guest_phone', type: 'varchar', length: 16, nullable: true })
  guestPhone?: string | null;

  @Column({ name: 'screening_id', type: 'uuid', nullable: false })
  screeningId!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 24,
    nullable: false,
    default: 'PendingPayment',
  })
  status!: ReservationStatus;

  @Column({
    name: 'total_amount',
    type: 'numeric',
    precision: 14,
    scale: 0,
    nullable: false,
    default: 0,
  })
  totalAmount!: number;

  @Column({ name: 'currency', type: 'varchar', length: 8, nullable: false, default: 'IRR' })
  currency!: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @Column({ name: 'expire_processed_at', type: 'timestamptz', nullable: true })
  expireProcessedAt?: Date | null;

  @Column({ name: 'owner_token', type: 'varchar', length: 64, nullable: true })
  ownerToken?: string | null;

  @OneToMany(() => ReservationSeatEntity, (rs) => rs.reservation)
  seats?: Relation<ReservationSeatEntity>[];
}

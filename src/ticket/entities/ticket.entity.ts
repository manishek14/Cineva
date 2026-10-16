import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { ReservationSeatEntity } from '../../reservation/entities/reservation-seat.entity';

export type TicketStatus = 'Valid' | 'Used' | 'Cancelled';

/**
 * Ticket - one admission ticket per sold seat. Exactly one Ticket per
 * ReservationSeat (UNIQUE reservation_seat_id, PRD §6).
 *
 * `publicCode` is the customer-facing identifier (short, guessable for
 * convenience - e.g. for ticket printing).
 *
 * `qrTokenHash` is the BCRYPT hash of the unguessable QR token. The QR
 * token itself is returned to the customer ONCE at issue time; we never
 * store the plaintext. Gate validation matches the hash.
 *
 * PRD §FR-07 rule 4: scanning must be atomic - two concurrent scans
 * must not both succeed. We use SELECT FOR UPDATE on the ticket row +
 * state-machine check (Valid -> Used) inside a SERIALIZABLE tx.
 */
@Entity({ name: 'tickets' })
@Index('idx_tickets_public_code', ['publicCode'], { unique: true })
@Index('idx_tickets_status', ['status'])
@Check(`"public_code" IS NOT NULL`)
export class TicketEntity extends BaseEntity {
  @Column({ name: 'reservation_seat_id', type: 'uuid', nullable: false })
  reservationSeatId!: string;

  @OneToOne(() => ReservationSeatEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reservation_seat_id' })
  reservationSeat?: ReservationSeatEntity;

  @Column({ name: 'public_code', type: 'varchar', length: 16, nullable: false })
  publicCode!: string;

  @Column({ name: 'qr_token_hash', type: 'varchar', length: 100, nullable: false })
  qrTokenHash!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Valid',
  })
  status!: TicketStatus;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt?: Date | null;

  @Column({ name: 'used_by_user_id', type: 'uuid', nullable: true })
  usedByUserId?: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;
}

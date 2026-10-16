import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { ScreeningSeatEntity } from '../../screening/entities/screening-seat.entity';
import { ReservationEntity } from './reservation.entity';

export type AllocationStatus = 'Held' | 'Sold' | 'Released';

/**
 * SeatAllocation - the active owner of a ScreeningSeat at any moment.
 *
 * UNIQUE(screeningSeatId, status) WHERE status IN ('Held','Sold')
 * (via partial unique index in migration 0002) guarantees that at most
 * ONE active allocation row exists per screening_seat. Two concurrent
 * reservations attempting to grab the same seat will both try to insert
 * a Held row; only one INSERT wins (PRD §7.2 rule 2 - atomic allocation).
 *
 * This table is the SOURCE OF TRUTH for ownership - not Redis.
 * Redis is just a fast pre-check; the DB transaction here makes the
 * final decision (PRD §7.2 rule 1 - PostgreSQL decides).
 *
 * `ownerToken` matches the reservation's ownerToken. Any release/extend
 * operation verifies ownership via this token (PRD §7.2 rule 3).
 */
@Entity({ name: 'seat_allocations' })
@Index('idx_alloc_screening', ['screeningSeatId'])
@Index('idx_alloc_reservation', ['reservationId'])
@Index('idx_alloc_status_expires', ['status', 'expiresAt'])
@Check(`"acquired_at" IS NOT NULL`)
export class SeatAllocationEntity extends BaseEntity {
  @Column({ name: 'screening_seat_id', type: 'uuid', nullable: false })
  screeningSeatId!: string;

  @ManyToOne(() => ScreeningSeatEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'screening_seat_id' })
  screeningSeat?: ScreeningSeatEntity;

  @Column({ name: 'reservation_id', type: 'uuid', nullable: false })
  reservationId!: string;

  @ManyToOne(() => ReservationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reservation_id' })
  reservation?: ReservationEntity;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Held',
  })
  status!: AllocationStatus;

  @Column({ name: 'owner_token', type: 'varchar', length: 64, nullable: false })
  ownerToken!: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  @Column({ name: 'acquired_at', type: 'timestamptz', nullable: false })
  acquiredAt!: Date;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt?: Date | null;
}

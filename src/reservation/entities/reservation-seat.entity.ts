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
import { ReservationEntity } from './reservation.entity';
import { ScreeningSeatEntity } from '../../screening/entities/screening-seat.entity';

export type ReservationSeatStatus = 'Held' | 'Sold' | 'Released' | 'Refunded';

/**
 * ReservationSeat - one seat line in a reservation.
 *
 * UNIQUE(reservationId, screeningSeatId) prevents double-counting
 * the same seat in the same order (PRD §6).
 *
 * `unitPrice` is a snapshot of ScreeningSeat.price at the time the
 * seat was held. Subsequent edits to ScreeningSeat.price (e.g. manager
 * raises prices) don't affect this reservation's financials (PRD §5.3).
 *
 * `status` transitions in lockstep with the reservation:
 *   Held      -> Sold      (on payment confirmation)
 *   Sold      -> Refunded  (on cancellation with refund)
 *   Held      -> Released  (on expiry or pre-payment cancel)
 */
@Entity({ name: 'reservation_seats' })
@Unique('uq_res_seat', ['reservationId', 'screeningSeatId'])
@Index('idx_res_seats_reservation', ['reservationId'])
@Index('idx_res_seats_screening_seat', ['screeningSeatId'])
@Check(`"unit_price" >= 0`)
export class ReservationSeatEntity extends BaseEntity {
  @Column({ name: 'reservation_id', type: 'uuid', nullable: false })
  reservationId!: string;

  @ManyToOne(() => ReservationEntity, (r) => r.seats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reservation_id' })
  reservation?: ReservationEntity;

  @Column({ name: 'screening_seat_id', type: 'uuid', nullable: false })
  screeningSeatId!: string;

  @ManyToOne(() => ScreeningSeatEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'screening_seat_id' })
  screeningSeat?: ScreeningSeatEntity;

  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 12,
    scale: 0,
    nullable: false,
  })
  unitPrice!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Held',
  })
  status!: ReservationSeatStatus;
}

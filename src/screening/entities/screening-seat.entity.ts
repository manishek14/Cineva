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
import { ScreeningEntity } from './screening.entity';
import { SeatEntity } from '../../hall/entities/seat.entity';

export type ScreeningSeatStatus = 'Available' | 'Held' | 'Sold' | 'Blocked';

/**
 * ScreeningSeat - per-screening sale slot for a physical seat.
 *
 * There is exactly ONE row per (screeningId, seatId) pair - enforced by
 * UNIQUE(screening_id, seat_id) (PRD §6). The status column tracks the
 * sale lifecycle of this seat in this screening (independent of the
 * physical seat's maintenance status, PRD §FR-02).
 *
 * `price` is a snapshot of the calculated price at screening creation
 * time; it does NOT change when the catalog's category multiplier or
 * the screening's base_price_toman is later edited. This guarantees
 * past reservations see consistent prices (PRD §5.3).
 */
@Entity({ name: 'screening_seats' })
@Unique('uq_screening_seat', ['screeningId', 'seatId'])
@Index('idx_screening_seats_screening_status', ['screeningId', 'saleStatus'])
@Index('idx_screening_seats_seat', ['seatId'])
@Check(`"price" >= 0`)
export class ScreeningSeatEntity extends BaseEntity {
  @Column({ name: 'screening_id', type: 'uuid', nullable: false })
  screeningId!: string;

  @ManyToOne(() => ScreeningEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'screening_id' })
  screening?: ScreeningEntity;

  @Column({ name: 'seat_id', type: 'uuid', nullable: false })
  seatId!: string;

  @ManyToOne(() => SeatEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seat_id' })
  seat?: SeatEntity;

  @Column({ name: 'price', type: 'numeric', precision: 12, scale: 0, nullable: false })
  price!: number;

  @Column({
    name: 'sale_status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Available',
  })
  saleStatus!: ScreeningSeatStatus;

  /**
   * Populated by manager to manually block specific seats (broken chair,
   * VIP reservation hold). If set, status='Blocked' regardless of sale.
   */
  @Column({ name: 'block_reason', type: 'varchar', length: 200, nullable: true })
  blockReason?: string | null;
}

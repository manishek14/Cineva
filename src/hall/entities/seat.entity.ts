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
import { CinemaHallEntity } from './cinema-hall.entity';
import { SeatCategoryEntity } from '../../catalog/entities/seat-category.entity';

export type SeatStatus = 'Active' | 'Maintenance' | 'Removed';

/**
 * Seat - physical chair in a hall. Decoupled from sale status per screening
 * (PRD §FR-02: "صندلی فیزیکی از وضعیت فروش آن در یک سانس جدا نگه داشته می‌شود").
 *
 * UNIQUE(hallId, rowLabel, seatNumber) prevents duplicate seat definitions
 * within a hall (PRD §6).
 *
 * `positionX/Y` are coordinates on the rendered seat map (0..1 of width/height).
 */
@Entity({ name: 'seats' })
@Unique('uq_seat_hall_row_number', ['hallId', 'rowLabel', 'seatNumber'])
@Index('idx_seats_hall', ['hallId'])
@Index('idx_seats_category', ['categoryId'])
@Index('idx_seats_status', ['status'])
@Check(`"position_x" >= 0 AND "position_x" <= 1`)
@Check(`"position_y" >= 0 AND "position_y" <= 1`)
@Check(`"seat_number" > 0`)
export class SeatEntity extends BaseEntity {
  @Column({ name: 'hall_id', type: 'uuid', nullable: false })
  hallId!: string;

  @ManyToOne(() => CinemaHallEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'hall_id' })
  hall?: CinemaHallEntity;

  @Column({ name: 'category_id', type: 'uuid', nullable: false })
  categoryId!: string;

  @ManyToOne(() => SeatCategoryEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: SeatCategoryEntity;

  @Column({ name: 'row_label', type: 'varchar', length: 8, nullable: false })
  rowLabel!: string;

  @Column({ name: 'seat_number', type: 'integer', nullable: false })
  seatNumber!: number;

  @Column({ name: 'position_x', type: 'numeric', precision: 5, scale: 4, nullable: false, default: 0 })
  positionX!: number;

  @Column({ name: 'position_y', type: 'numeric', precision: 5, scale: 4, nullable: false, default: 0 })
  positionY!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Active',
  })
  status!: SeatStatus;

  @Column({ name: 'maintenance_reason', type: 'varchar', length: 200, nullable: true })
  maintenanceReason?: string | null;
}

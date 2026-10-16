import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { MovieEntity } from '../../catalog/entities/movie.entity';
import { CinemaHallEntity } from '../../hall/entities/cinema-hall.entity';

export type ScreeningStatus = 'Draft' | 'Published' | 'Cancelled' | 'Completed';

/**
 * Screening - a scheduled showing of a movie in a hall.
 *
 * Anti-overlap protection lives at the database level via an EXCLUDE
 * constraint (added by migration `0001_screening_overlap_exclude`):
 *
 *   EXCLUDE USING gist (
 *     hall_id WITH =,
 *     tstzrange(starts_at, ends_at) WITH &&
 *   ) WHERE (status IN ('Draft','Published'))
 *
 * This guarantees two screenings in the same hall can NEVER overlap in
 * time, regardless of application-layer race conditions (PRD §6.2).
 *
 * `salesOpensAt` is the earliest time customers can buy tickets - usually
 * a few hours/days before startsAt. `setupBufferMinutes` is the gap
 * between screenings for cleaning/tech; baked into endsAt computation.
 */
@Entity({ name: 'screenings' })
@Index('idx_screenings_hall_status', ['hallId', 'status'])
@Index('idx_screenings_movie', ['movieId'])
@Index('idx_screenings_starts_at', ['startsAt'])
@Check(`"ends_at" > "starts_at"`)
@Check(`"sales_opens_at" <= "starts_at"`)
@Check(`"setup_buffer_minutes" >= 0`)
export class ScreeningEntity extends BaseEntity {
  @Column({ name: 'movie_id', type: 'uuid', nullable: false })
  movieId!: string;

  @ManyToOne(() => MovieEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'movie_id' })
  movie?: MovieEntity;

  @Column({ name: 'hall_id', type: 'uuid', nullable: false })
  hallId!: string;

  @ManyToOne(() => CinemaHallEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'hall_id' })
  hall?: CinemaHallEntity;

  @Column({ name: 'starts_at', type: 'timestamptz', nullable: false })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz', nullable: false })
  endsAt!: Date;

  @Column({ name: 'sales_opens_at', type: 'timestamptz', nullable: false })
  salesOpensAt!: Date;

  @Column({ name: 'setup_buffer_minutes', type: 'integer', nullable: false, default: 15 })
  setupBufferMinutes!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Draft',
  })
  status!: ScreeningStatus;

  @Column({ name: 'base_price_toman', type: 'numeric', precision: 12, scale: 0, nullable: false })
  basePriceToman!: number;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 200, nullable: true })
  cancelReason?: string | null;
}

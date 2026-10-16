import {
  Column,
  Entity,
  Index,
  Check,
} from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type MovieStatus = 'Draft' | 'Published' | 'Archived';

export type AgeRating =
  | 'ALL'
  | '+3'
  | '+7'
  | '+12'
  | '+15'
  | '+16'
  | '+18';

/**
 * Movie entity - catalogue row, soft-deleted via status='Archived' (PRD §FR-01).
 * Movies with active screenings or sales history must never be hard-deleted.
 */
@Entity({ name: 'movies' })
@Index('idx_movies_status', ['status'])
// The pg_trgm index for fuzzy title search is created by migration
// in production (SQLite doesn't support it; the integration test
// suite runs without it).
@Check(`"duration_minutes" > 0`)
export class MovieEntity extends BaseEntity {
  @Column({ name: 'title', type: 'varchar', length: 200, nullable: false })
  title!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string | null;

  @Column({ name: 'duration_minutes', type: 'integer', nullable: false })
  durationMinutes!: number;

  @Column({ name: 'age_rating', type: 'varchar', length: 8, nullable: false, default: 'ALL' })
  ageRating!: AgeRating;

  @Column({ name: 'poster_url', type: 'varchar', length: 500, nullable: true })
  posterUrl?: string | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Draft',
  })
  status!: MovieStatus;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  // Back-ref to screenings is intentionally omitted here to avoid a circular
  // import; we add it in ScreeningModule via its own OneToMany on the Movie
  // side using forwardRef when needed (lazy query from outside).
}

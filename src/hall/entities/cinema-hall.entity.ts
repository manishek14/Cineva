import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type CinemaHallStatus = 'Active' | 'Archived';

/**
 * CinemaHall - physical venue with a seat map.
 *
 * Layout changes (seat additions/removals) must NOT corrupt historical
 * screening sales. The relationship between Hall and past screenings is
 * preserved via screening_seat.screening_id; historical screenings keep
 * their own snapshots of seat ids (PRD §FR-02).
 */
@Entity({ name: 'cinema_halls' })
@Index('idx_halls_status', ['status'])
export class CinemaHallEntity extends BaseEntity {
  @Column({ name: 'name', type: 'varchar', length: 100, nullable: false })
  name!: string;

  @Column({ name: 'slug', type: 'varchar', length: 100, nullable: false, unique: true })
  slug!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Active',
  })
  status!: CinemaHallStatus;

  @Column({ name: 'total_capacity', type: 'integer', nullable: false, default: 0 })
  totalCapacity!: number;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;
}

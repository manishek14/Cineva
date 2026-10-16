import { PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Base class for all Cineva entities. All primary keys are UUID v4.
 * Created/updated timestamps are always present for audit purposes.
 *
 * Soft-delete is implemented per-entity via a `status` or `archivedAt` column
 * rather than TypeORM's @DeleteDateColumn to avoid accidental hard delete
 * of catalog rows that have financial history.
 *
 * No @Entity decorator on the base class - subclasses must declare their own.
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

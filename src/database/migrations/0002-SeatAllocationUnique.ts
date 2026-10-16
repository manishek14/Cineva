import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a PARTIAL UNIQUE INDEX on seat_allocations(screening_seat_id)
 * WHERE status IN ('Held', 'Sold') - this is the database-level
 * guarantee that at most ONE active allocation row exists per
 * screening_seat at any moment.
 *
 * Two concurrent transactions trying to INSERT a Held row for the same
 * screening_seat_id will both attempt to claim the partial-unique slot;
 * only one wins. The loser gets a 23505 (unique_violation) error which
 * the application translates to "seat already held" (PRD §7.2 rule 2).
 *
 * Rows with status='Released' are excluded, so historical allocations
 * remain for audit but don't block future re-allocation.
 */
export class SeatAllocationUnique1700000000001 implements MigrationInterface {
  name = 'SeatAllocationUnique1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_alloc_active_per_seat
      ON seat_allocations (screening_seat_id)
      WHERE status IN ('Held', 'Sold');
    `);

    // Helpful index for the expiry reconciliation query (find Held rows
    // whose expiresAt has passed but status is still Held).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_alloc_expires_pending
      ON seat_allocations (expires_at)
      WHERE status = 'Held';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_alloc_expires_pending;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_alloc_active_per_seat;`);
  }
}

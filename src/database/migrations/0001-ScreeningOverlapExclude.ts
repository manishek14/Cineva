import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the EXCLUDE constraint that prevents two screenings in the same hall
 * from overlapping in time. This is enforced at the database level using
 * PostgreSQL's GiST index on a tstzrange - the strongest possible
 * guarantee against concurrent manager requests racing through the
 * application-layer overlap check.
 *
 * PRD §6.2: "صرف بررسی هم‌پوشانی در کد کافی نیست؛ دو درخواست هم‌زمان
 * مدیر ممکن است هر دو از بررسی عبور کنند."
 *
 * Only active states (Draft, Published) participate in the exclusion -
 * Cancelled/Completed screenings don't block new ones being scheduled.
 *
 * Requires the `btree_gist` extension (already enabled by initdb script).
 */
export class ScreeningOverlapExclude1700000000000 implements MigrationInterface {
  name = 'ScreeningOverlapExclude1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- Sanity: extension must be present (initdb script does this).
      CREATE EXTENSION IF NOT EXISTS "btree_gist";
    `);

    // GiST index supporting the EXCLUDE constraint on tstzrange.
    // The range covers starts_at..ends_at so two screenings in the same
    // hall whose ranges overlap cannot both be in Draft/Published.
    await queryRunner.query(`
      ALTER TABLE screenings
      ADD CONSTRAINT screenings_no_overlap_per_hall
      EXCLUDE USING gist (
        hall_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status IN ('Draft', 'Published'));
    `);

    // Helpful secondary index for upcoming-screening queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_screenings_upcoming
      ON screenings (hall_id, starts_at)
      WHERE status IN ('Draft', 'Published');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_screenings_upcoming;`);
    await queryRunner.query(`
      ALTER TABLE screenings
      DROP CONSTRAINT IF EXISTS screenings_no_overlap_per_hall;
    `);
  }
}

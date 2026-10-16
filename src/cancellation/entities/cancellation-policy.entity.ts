import { Column, Entity, Index, Check } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

/**
 * CancellationPolicy - configurable refund/penalty rules.
 *
 * Per the design decision: the 30-minute customer-cancel cutoff has
 * a HARD FLOOR of 15 minutes (env CANCELLATION_MIN_MINUTES_BEFORE_SCREENING_FLOOR).
 * The manager may raise this floor (e.g. 45min) but cannot go below it.
 *
 * Default values (matching PRD §10):
 *  - penaltyPercent: 15%
 *  - refundPercent: 85%
 *  - customerCancelAllowed: true
 *  - minMinutesBeforeScreening: 30 (overridable upward by manager,
 *    never below the env-set floor of 15min)
 */
@Entity({ name: 'cancellation_policies' })
@Index('idx_cancel_policy_active', ['isActive', 'validFrom'])
@Check(`"penalty_percent" >= 0 AND "penalty_percent" <= 100`)
@Check(`"refund_percent" >= 0 AND "refund_percent" <= 100`)
export class CancellationPolicyEntity extends BaseEntity {
  @Column({ name: 'name', type: 'varchar', length: 100, nullable: false })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string | null;

  @Column({
    name: 'penalty_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: false,
    default: 15,
  })
  penaltyPercent!: number;

  @Column({
    name: 'refund_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: false,
    default: 85,
  })
  refundPercent!: number;

  /**
   * Minimum minutes remaining before screening.startsAt for the
   * customer to be allowed to cancel. Cannot be set below the env
   * hard floor (default 15min) - enforced by service layer.
   */
  @Column({
    name: 'min_minutes_before_screening',
    type: 'integer',
    nullable: false,
    default: 30,
  })
  minMinutesBeforeScreening!: number;

  @Column({
    name: 'customer_cancel_allowed',
    type: 'boolean',
    nullable: false,
    default: true,
  })
  customerCancelAllowed!: boolean;

  @Column({ name: 'side_fee_toman', type: 'numeric', precision: 12, scale: 0, nullable: false, default: 0 })
  sideFeeToman!: number;

  @Column({ name: 'valid_from', type: 'timestamptz', nullable: false })
  validFrom!: Date;

  @Column({ name: 'is_active', type: 'boolean', nullable: false, default: true })
  isActive!: boolean;
}

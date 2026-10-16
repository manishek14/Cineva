import { Column, Entity, Index, Check } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type SeatCategoryStatus = 'Active' | 'Archived';

/**
 * SeatCategory - named tiers like Standard / VIP / CIP (PRD §1, §5.1).
 *
 * Pricing: each ScreeningSeat has its own price column snapshot; the
 * category's `basePriceMultiplier` is only a suggestion used by PricingModule
 * when seeding ScreeningSeat.price from a screening-level base price.
 * Stored prices win; multiplier changes do not retro-edit existing sales.
 */
@Entity({ name: 'seat_categories' })
@Index('idx_seat_categories_code', ['code'], { unique: true })
@Index('idx_seat_categories_status', ['status'])
@Check(`"base_price_multiplier" > 0`)
export class SeatCategoryEntity extends BaseEntity {
  @Column({ name: 'name', type: 'varchar', length: 100, nullable: false })
  name!: string;

  @Column({ name: 'code', type: 'varchar', length: 16, nullable: false, unique: true })
  code!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string | null;

  @Column({
    name: 'base_price_multiplier',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: false,
    default: 1.0,
  })
  basePriceMultiplier!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Active',
  })
  status!: SeatCategoryStatus;

  @Column({ name: 'display_order', type: 'integer', nullable: false, default: 0 })
  displayOrder!: number;
}

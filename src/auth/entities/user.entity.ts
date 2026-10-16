import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';
import { Role } from '../../common/constants/state-machine';

export type UserStatus = 'Active' | 'Suspended' | 'Deleted';

/**
 * User - customer or staff. Phone is the unique identifier in Cineva
 * (no email/passwords). OTP verification marks `phoneVerifiedAt`.
 *
 * Guest customers can have a User row created lazily after OTP - we
 * don't require profile info. `role` defaults to 'customer'.
 *
 * Soft-delete via status='Deleted' preserves reservation/ticket FKs.
 */
@Entity({ name: 'users' })
@Index('idx_users_phone', ['phone'], { unique: true })
@Index('idx_users_role_status', ['role', 'status'])
export class UserEntity extends BaseEntity {
  @Column({ name: 'phone', type: 'varchar', length: 16, nullable: false })
  phone!: string;

  @Column({ name: 'phone_verified_at', type: 'timestamptz', nullable: true })
  phoneVerifiedAt?: Date | null;

  @Column({
    name: 'role',
    type: 'varchar',
    length: 32,
    nullable: false,
    default: 'customer',
  })
  role!: Role;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'Active',
  })
  status!: UserStatus;

  @Column({ name: 'display_name', type: 'varchar', length: 100, nullable: true })
  displayName?: string | null;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt?: Date | null;

  @Column({ name: 'suspended_reason', type: 'varchar', length: 200, nullable: true })
  suspendedReason?: string | null;
}

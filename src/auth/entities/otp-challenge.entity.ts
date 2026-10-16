import { Column, Entity, Index, Check } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

export type OtpPurpose = 'login' | 'guest_login' | 'ownership_reclaim';

/**
 * OtpChallenge - one-time challenge issued for a phone number.
 * The code is stored BCRYPT-hashed (never plaintext). Attempts counter
 * prevents brute force. consumedAt marks successful verification.
 *
 * PRD §NFR-05: limit attempts, expiry, one-time use, resend cooldown.
 */
@Entity({ name: 'otp_challenges' })
@Index('idx_otp_phone_purpose', ['phone', 'purpose'])
@Index('idx_otp_expires_at', ['expiresAt'])
@Check(`"attempts" <= "max_attempts"`)
@Check(`"max_attempts" > 0`)
export class OtpChallengeEntity extends BaseEntity {
  @Column({ name: 'phone', type: 'varchar', length: 16, nullable: false })
  phone!: string;

  @Column({
    name: 'purpose',
    type: 'varchar',
    length: 24,
    nullable: false,
    default: 'login',
  })
  purpose!: OtpPurpose;

  @Column({ name: 'code_hash', type: 'varchar', length: 100, nullable: false })
  codeHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ name: 'attempts', type: 'integer', nullable: false, default: 0 })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'integer', nullable: false, default: 5 })
  maxAttempts!: number;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt?: Date | null;

  @Column({ name: 'succeeded', type: 'boolean', nullable: false, default: false })
  succeeded!: boolean;

  @Column({ name: 'reservation_id', type: 'uuid', nullable: true })
  reservationId?: string | null;
}

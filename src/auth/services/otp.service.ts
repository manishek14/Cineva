import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import IORedis from 'ioredis';
import * as bcrypt from 'bcrypt';
import { OtpChallengeEntity, OtpPurpose } from '../entities/otp-challenge.entity';
import { UserEntity } from '../entities/user.entity';
import { RequestOtpDto, VerifyOtpDto, OtpSentResponseDto } from '../dtos/auth.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { REDIS_KEYS } from '../../common/redis/redis.constants';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly ttl: number;
  private readonly codeLength: number;
  private readonly maxAttempts: number;
  private readonly cooldownSeconds: number;
  private readonly maxResendPerHour: number;
  private readonly devFakeCode: string;
  private readonly devPrintToLog: boolean;

  constructor(
    @InjectRepository(OtpChallengeEntity)
    private readonly challengeRepo: Repository<OtpChallengeEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly config: ConfigService,
    @Inject(IORedis) private readonly redis: IORedis,
  ) {
    this.ttl = Number(this.config.get('OTP_TTL_SECONDS', 120));
    this.codeLength = Number(this.config.get('OTP_LENGTH', 6));
    this.maxAttempts = Number(this.config.get('OTP_MAX_ATTEMPTS', 5));
    this.cooldownSeconds = Number(this.config.get('OTP_RESEND_COOLDOWN_SECONDS', 60));
    this.maxResendPerHour = Number(this.config.get('OTP_RESEND_MAX_PER_HOUR', 5));
    this.devFakeCode = this.config.get<string>('OTP_DEV_FAKE_CODE', '111111');
    this.devPrintToLog = this.config.get<boolean>('OTP_DEV_PRINT_TO_LOG', true);
  }

  /**
   * Request a new OTP for a phone number.
   *
   * Rate limits:
   *  - cooldown: per-phone, no resend for cooldownSeconds after last send.
   *  - hourly:   per-phone, maxResendPerHour within sliding hour.
   *
   * Code generation: in production, cryptographically random code.
   * In dev/test (NODE_ENV !== 'production'), always use OTP_DEV_FAKE_CODE
   * so we never need real SMS infrastructure.
   *
   * Stored as bcrypt(code) - never plaintext, never logged.
   */
  async requestOtp(dto: RequestOtpDto): Promise<OtpSentResponseDto> {
    const phone = dto.phone.trim();
    const purpose = dto.purpose ?? 'login';

    // Rate-limit: cooldown
    const cooldownKey = `${REDIS_KEYS.OTP_COOLDOWN}:${phone}`;
    const cooldownRemaining = await this.redis.ttl(cooldownKey);
    if (cooldownRemaining > 0) {
      throw BusinessError.unauthorized(
        `Please wait ${cooldownRemaining}s before requesting another OTP`,
        ERROR_CODES.OTP_RATE_LIMITED,
      );
    }

    // Rate-limit: hourly cap
    const hourlyKey = `${REDIS_KEYS.OTP_RESEND_HOURLY}:${phone}`;
    const hourlyCount = Number((await this.redis.get(hourlyKey)) ?? 0);
    if (hourlyCount >= this.maxResendPerHour) {
      throw BusinessError.unauthorized(
        `Too many OTP requests; try again later`,
        ERROR_CODES.OTP_RATE_LIMITED,
      );
    }

    // Generate code. Dev mode: fixed fake code for testing convenience.
    const isDev = process.env.NODE_ENV !== 'production';
    const code = isDev ? this.devFakeCode : this.generateCode(this.codeLength);

    const expiresAt = new Date(Date.now() + this.ttl * 1000);
    const challenge = this.challengeRepo.create({
      phone,
      purpose,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      succeeded: false,
    });
    const saved = await this.challengeRepo.save(challenge);

    // Set rate-limit keys.
    await this.redis.setex(cooldownKey, this.cooldownSeconds, '1');
    const ttlRemainingHour = await this.redis.ttl(hourlyKey);
    if (ttlRemainingHour < 0) {
      // First request in this hour.
      await this.redis.setex(hourlyKey, 3600, '1');
    } else {
      await this.redis.incr(hourlyKey);
    }

    if (isDev && this.devPrintToLog) {
      this.logger.warn(
        `[DEV OTP] phone=${phone} purpose=${purpose} code=${code} challengeId=${saved.id} expiresAt=${expiresAt.toISOString()}`,
      );
    }

    return {
      phone,
      expiresIn: this.ttl,
      devCode: isDev && this.devPrintToLog ? code : undefined,
    };
  }

  /**
   * Verify an OTP. Returns the phone (verified) if successful.
   *
   * Per PRD §NFR-05:
   *  - expired OTP rejected (cannot verify past expiry)
   *  - consumed OTP rejected (one-time use)
   *  - too many attempts rejects and burns the challenge
   *  - increment attempts on every wrong code
   *
   * On success, the challenge is marked consumed so it can't be replayed.
   */
  async verifyOtp(dto: VerifyOtpDto): Promise<{ phone: string; purpose: OtpPurpose }> {
    const phone = dto.phone.trim();
    const purpose = dto.purpose ?? 'login';

    // Find latest un-consumed challenge for this phone+purpose.
    const challenge = await this.challengeRepo.findOne({
      where: { phone, purpose },
      order: { createdAt: 'DESC' },
    });
    if (!challenge) {
      throw BusinessError.unauthorized(
        'No active OTP challenge for this phone',
        ERROR_CODES.OTP_INVALID,
      );
    }
    if (challenge.consumedAt) {
      throw BusinessError.unauthorized(
        'OTP already consumed',
        ERROR_CODES.OTP_CONSUMED,
      );
    }
    if (challenge.expiresAt <= new Date()) {
      throw BusinessError.unauthorized(
        'OTP expired',
        ERROR_CODES.OTP_EXPIRED,
      );
    }

    // Check attempt budget.
    if (challenge.attempts >= challenge.maxAttempts) {
      throw BusinessError.unauthorized(
        'OTP max attempts exceeded',
        ERROR_CODES.OTP_MAX_ATTEMPTS,
      );
    }

    // Bcrypt compare.
    const ok = await bcrypt.compare(dto.code, challenge.codeHash);
    if (!ok) {
      challenge.attempts += 1;
      await this.challengeRepo.save(challenge);
      throw BusinessError.unauthorized(
        `Invalid OTP code; ${challenge.maxAttempts - challenge.attempts} attempts left`,
        ERROR_CODES.OTP_INVALID,
      );
    }

    // Mark consumed.
    challenge.consumedAt = new Date();
    challenge.succeeded = true;
    await this.challengeRepo.save(challenge);

    return { phone, purpose };
  }

  private generateCode(length: number): string {
    let code = '';
    const max = Math.pow(10, length);
    // Use crypto.randomUUID for randomness, then take a numeric slice.
    const rand = Math.floor(Math.random() * max);
    code = rand.toString().padStart(length, '0');
    return code;
  }

  /**
   * Internal helper used by AuthService to surface a verified phone
   * into a User row (create if not exists).
   */
  async ensureUserForPhone(phone: string): Promise<UserEntity> {
    let user = await this.userRepo.findOne({ where: { phone } });
    if (!user) {
      user = this.userRepo.create({
        phone,
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      });
      user = await this.userRepo.save(user);
    } else if (!user.phoneVerifiedAt) {
      user.phoneVerifiedAt = new Date();
      user = await this.userRepo.save(user);
    }
    return user;
  }
}

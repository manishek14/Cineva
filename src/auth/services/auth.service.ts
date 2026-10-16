import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import IORedis from 'ioredis';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { UserEntity } from '../entities/user.entity';
import { OtpService } from './otp.service';
import { VerifyOtpDto, AuthResponseDto, RefreshTokenDto } from '../dtos/auth.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { Role, ROLES } from '../../common/constants/state-machine';
import { REDIS_KEYS } from '../../common/redis/redis.constants';

/**
 * Auth flow:
 *   1) Client -> POST /auth/otp/request { phone }
 *      -> server creates OtpChallenge, prints/logs code in dev.
 *   2) Client -> POST /auth/otp/verify { phone, code }
 *      -> server verifies, marks challenge consumed, ensures User row,
 *         issues AccessToken (15m JWT) + RefreshToken (7d JWT) AND
 *         writes a Redis allowlist entry for the refresh jti so we can
 *         revoke it later. Refresh token is also returned as httpOnly
 *         cookie by the controller (setCookie not here).
 *   3) Client -> POST /auth/refresh { refreshToken }  (cookie)
 *      -> server validates signature, jti allowlist, NOT blacklisted,
 *         rotates: blacklists old jti, issues new pair (refresh rotation).
 *   4) Client -> POST /auth/logout
 *      -> server blacklists current access jti + refresh jti.
 *
 * Refresh rotation strategy:
 *  - access jti: short TTL, so we just rely on natural expiry
 *  - refresh jti: stored in Redis allowlist (1=valid); on rotate/delete
 *    we set blacklist (jti -> 1) with TTL = remaining refresh lifetime.
 *
 * PRD §3: guest customers must own their phone via OTP before placing
 * an order. Ownership of past orders requires re-auth, not just phone.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly refreshPrefix: string;
  private readonly blacklistPrefix: string;

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly otp: OtpService,
    @Inject(IORedis) private readonly redis: IORedis,
  ) {
    this.accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    this.refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');
    this.refreshPrefix = this.config.get<string>('JWT_REFRESH_REDIS_PREFIX', 'auth:refresh:');
    this.blacklistPrefix = 'auth:refresh-bl:';
  }

  async verifyOtpAndLogin(dto: VerifyOtpDto): Promise<AuthResponseDto> {
    const { phone } = await this.otp.verifyOtp(dto);
    const user = await this.otp.ensureUserForPhone(phone);
    if (user.status === 'Suspended') {
      throw BusinessError.forbidden('User suspended', ERROR_CODES.FORBIDDEN);
    }
    return this.issueTokens(user);
  }

  async refreshTokens(dto: RefreshTokenDto): Promise<AuthResponseDto> {
    // Verify signature first (will throw if expired/invalid).
    let payload: { sub?: string; phone?: string; role?: Role; jti?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(dto.refreshToken);
    } catch {
      throw BusinessError.unauthorized('Invalid refresh token', ERROR_CODES.UNAUTHORIZED);
    }
    if (payload.typ !== 'refresh' || !payload.sub || !payload.jti) {
      throw BusinessError.unauthorized('Invalid refresh token payload', ERROR_CODES.UNAUTHORIZED);
    }

    const userId = payload.sub;
    const jti = payload.jti;

    // Check blacklist (revoked or already-rotated).
    const blKey = `${this.blacklistPrefix}${jti}`;
    if (await this.redis.get(blKey)) {
      throw BusinessError.unauthorized('Refresh token revoked', ERROR_CODES.UNAUTHORIZED);
    }
    // Check allowlist (must be present, otherwise it was never issued or expired).
    const allowKey = `${this.refreshPrefix}${userId}:${jti}`;
    if (!(await this.redis.get(allowKey))) {
      throw BusinessError.unauthorized('Refresh token expired', ERROR_CODES.UNAUTHORIZED);
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || user.status !== 'Active') {
      throw BusinessError.unauthorized('User not found or suspended', ERROR_CODES.UNAUTHORIZED);
    }

    // Rotate: blacklist old jti, issue new pair.
    const remainingTtl = await this.redis.ttl(allowKey);
    if (remainingTtl > 0) {
      await this.redis.setex(blKey, remainingTtl, '1');
    }
    await this.redis.del(allowKey);

    return this.issueTokens(user);
  }

  async logout(userId: string, refreshToken?: string): Promise<void> {
    // Revoke refresh if provided.
    if (refreshToken) {
      try {
        const payload = await this.jwt.verifyAsync(refreshToken);
        if (payload.typ === 'refresh' && payload.jti && payload.sub === userId) {
          const allowKey = `${this.refreshPrefix}${userId}:${payload.jti}`;
          const blKey = `${this.blacklistPrefix}${payload.jti}`;
          const remainingTtl = await this.redis.ttl(allowKey);
          if (remainingTtl > 0) {
            await this.redis.setex(blKey, remainingTtl, '1');
          }
          await this.redis.del(allowKey);
        }
      } catch {
        // invalid refresh token on logout is not a critical error
      }
    }
    // Could also blacklist access jti but short TTL makes that optional.
  }

  /**
   * Issue an access+refresh token pair. Refresh jti is stored in Redis
   * allowlist with TTL matching the refresh token's TTL.
   */
  async issueTokens(user: UserEntity): Promise<AuthResponseDto> {
    const accessJti = crypto.randomUUID();
    const refreshJti = crypto.randomUUID();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        phone: user.phone,
        role: user.role,
        jti: accessJti,
        typ: 'access',
      },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.accessTtl as never,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      {
        sub: user.id,
        phone: user.phone,
        role: user.role,
        jti: refreshJti,
        typ: 'refresh',
      },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.refreshTtl as never,
      },
    );

    // Persist refresh allowlist.
    const refreshTtlSeconds = this.ttlToSeconds(this.refreshTtl);
    const allowKey = `${this.refreshPrefix}${user.id}:${refreshJti}`;
    await this.redis.setex(allowKey, refreshTtlSeconds, '1');

    const accessExpiresAt = new Date(Date.now() + this.ttlToSeconds(this.accessTtl) * 1000);

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessExpiresAt.toISOString(),
      userId: user.id,
      phone: user.phone,
      role: user.role,
    };
  }

  private ttlToSeconds(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) return 900;
    const n = Number(m[1]);
    const u = m[2];
    switch (u) {
      case 's': return n;
      case 'm': return n * 60;
      case 'h': return n * 3600;
      case 'd': return n * 86400;
      default: return 900;
    }
  }

  /**
   * Promote a customer to a staff role (used by tech_admin only).
   */
  async assignRole(userId: string, role: Role): Promise<UserEntity> {
    if (!Object.values(ROLES).includes(role)) {
      throw BusinessError.unprocessable(`Invalid role: ${role}`, ERROR_CODES.VALIDATION);
    }
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw BusinessError.notFound(`User ${userId} not found`, ERROR_CODES.UNAUTHORIZED);
    }
    user.role = role;
    return this.userRepo.save(user);
  }
}

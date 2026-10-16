import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

export interface JwtPayload {
  sub: string;
  phone: string;
  role: string;
  jti: string;
  typ: string;
}

export interface RequestUser {
  id: string;
  phone: string;
  role: string;
  jti: string;
}

/**
 * JWT Bearer strategy. Extracts token from `Authorization: Bearer xxx`,
 * verifies signature with JWT_ACCESS_SECRET, and loads the User row.
 *
 * Returns the user object attached to `req.user` for downstream guards
 * (RolesGuard) and decorators (@CurrentUser).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev_only_secret',
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<RequestUser> {
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Wrong token type');
    }
    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.status !== 'Active') {
      throw new BusinessError({
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'User not active',
        httpStatus: 401 as never,
      });
    }
    return {
      id: user.id,
      phone: user.phone,
      role: user.role,
      jti: payload.jti,
    };
  }
}

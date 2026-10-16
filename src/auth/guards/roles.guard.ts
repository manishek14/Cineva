import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import type { RequestUser } from '../strategies/jwt.strategy';

/**
 * Roles guard. Checks req.user.role against @Roles(...) metadata.
 * Stack with JwtAuthGuard: JwtAuthGuard sets req.user, then this guard
 * enforces role-based authorization.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true; // No role restriction
    }
    const request = context.switchToHttp().getRequest<{
      user?: RequestUser;
    }>();
    const user = request.user;
    if (!user) {
      throw BusinessError.unauthorized('Authentication required', ERROR_CODES.UNAUTHORIZED);
    }
    if (!required.includes(user.role)) {
      throw BusinessError.forbidden(
        `Role '${user.role}' is not allowed`,
        ERROR_CODES.FORBIDDEN,
      );
    }
    return true;
  }
}

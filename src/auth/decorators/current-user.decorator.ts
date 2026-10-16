import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../strategies/jwt.strategy';

/**
 * Extract the authenticated user from the request. Throws if not present.
 * Usage: `findOne(@CurrentUser() user: RequestUser)`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    if (!user) {
      throw new Error('CurrentUser decorator used on an unauthenticated route');
    }
    return data ? user[data] : user;
  },
);

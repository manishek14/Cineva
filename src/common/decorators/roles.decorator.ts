import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Attach required roles to a route or controller.
 * Checked by RolesGuard (added with AuthModule).
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

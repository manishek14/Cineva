import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a route as publicly accessible (skips auth guards).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

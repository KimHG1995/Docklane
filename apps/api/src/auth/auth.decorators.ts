import { SetMetadata } from '@nestjs/common';
import type { Role } from './auth.types.js';

export const PUBLIC_ROUTE = 'docklane:public';
export const REQUIRED_ROLE = 'docklane:required-role';

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

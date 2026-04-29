export type VpautoRole = 'owner' | 'admin' | 'analyst' | 'user' | 'viewer';

export type VpautoPermission =
  | 'vehicles:read'
  | 'vehicles:write'
  | 'vehicles:import'
  | 'captures:plan'
  | 'captures:run'
  | 'auction:summary'
  | 'debug:view'
  | 'watchlist:write';

export interface VpautoAccessProfile {
  role: VpautoRole;
  permissions: VpautoPermission[];
}

export const VPAUTO_ROLE_PERMISSIONS: Record<VpautoRole, readonly VpautoPermission[]> = {
  owner: [
    'vehicles:read',
    'vehicles:write',
    'vehicles:import',
    'captures:plan',
    'captures:run',
    'auction:summary',
    'debug:view',
    'watchlist:write',
  ],
  admin: [
    'vehicles:read',
    'vehicles:write',
    'vehicles:import',
    'captures:plan',
    'captures:run',
    'auction:summary',
    'debug:view',
    'watchlist:write',
  ],
  analyst: [
    'vehicles:read',
    'auction:summary',
    'watchlist:write',
  ],
  user: [
    'vehicles:read',
    'watchlist:write',
  ],
  viewer: [
    'vehicles:read',
  ],
};

export function normalizeVpautoRole(value: unknown, fallback: VpautoRole = 'user'): VpautoRole {
  if (
    value === 'owner'
    || value === 'admin'
    || value === 'analyst'
    || value === 'user'
    || value === 'viewer'
  ) {
    return value;
  }

  return fallback;
}

export function buildVpautoAccessProfile(role: VpautoRole): VpautoAccessProfile {
  return {
    role,
    permissions: [...VPAUTO_ROLE_PERMISSIONS[role]],
  };
}

export function vpautoRoleHasPermission(role: VpautoRole, permission: VpautoPermission): boolean {
  return VPAUTO_ROLE_PERMISSIONS[role].includes(permission);
}

export function vpautoAccessHasPermission(access: VpautoAccessProfile, permission: VpautoPermission): boolean {
  return access.permissions.includes(permission);
}

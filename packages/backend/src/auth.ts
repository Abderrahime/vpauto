import type { Context, MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import {
  buildVpautoAccessProfile,
  normalizeVpautoRole,
  vpautoAccessHasPermission,
} from '@vpauto/shared';
import type {
  ApiResponse,
  VpautoAccessProfile,
  VpautoPermission,
  VpautoRole,
} from '@vpauto/shared';

const ADMIN_TOKEN = process.env.VPAUTO_ADMIN_TOKEN || process.env.VPAUTO_API_TOKEN || '';

type AuthAccount = {
  email: string;
  password: string;
  role: VpautoRole;
  token: string;
};

export type AuthSession = {
  token: string;
  email: string;
  access: VpautoAccessProfile;
};

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildAccountToken(email: string, password: string, role: VpautoRole, explicitToken?: unknown): string {
  if (typeof explicitToken === 'string' && explicitToken.trim()) {
    return explicitToken.trim();
  }

  const secret = process.env.VPAUTO_AUTH_SECRET || ADMIN_TOKEN || 'vpauto-local-dev';
  return createHash('sha256')
    .update(`${secret}:${email}:${password}:${role}`)
    .digest('hex');
}

function readConfiguredAccounts(): AuthAccount[] {
  const accounts: AuthAccount[] = [];
  const rawUsers = process.env.VPAUTO_AUTH_USERS;

  if (rawUsers?.trim()) {
    try {
      const parsed = JSON.parse(rawUsers) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const record = item as Record<string, unknown>;
          const email = normalizeEmail(record.email);
          const password = typeof record.password === 'string' ? record.password : '';
          if (!email || !password) continue;
          const role = normalizeVpautoRole(record.role, 'user');
          accounts.push({
            email,
            password,
            role,
            token: buildAccountToken(email, password, role, record.token),
          });
        }
      }
    } catch (error) {
      console.warn('[VPauto auth] VPAUTO_AUTH_USERS must be a JSON array:', error);
    }
  }

  const adminEmail = normalizeEmail(process.env.VPAUTO_ADMIN_EMAIL);
  const adminPassword = process.env.VPAUTO_ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword) {
    const role = normalizeVpautoRole(process.env.VPAUTO_ADMIN_ROLE, 'owner');
    accounts.push({
      email: adminEmail,
      password: adminPassword,
      role,
      token: buildAccountToken(adminEmail, adminPassword, role, ADMIN_TOKEN || process.env.VPAUTO_ADMIN_SESSION_TOKEN),
    });
  }

  return accounts;
}

function findAccountByToken(token: string): AuthAccount | null {
  if (!token) return null;
  return readConfiguredAccounts().find((account) => account.token === token) || null;
}

export function authenticateCredentials(emailInput: unknown, passwordInput: unknown): AuthSession | null {
  const email = normalizeEmail(emailInput);
  const password = typeof passwordInput === 'string' ? passwordInput : '';
  if (!email || !password) return null;

  const account = readConfiguredAccounts()
    .find((candidate) => candidate.email === email && candidate.password === password);
  if (!account) return null;

  return {
    token: account.token,
    email: account.email,
    access: buildVpautoAccessProfile(account.role),
  };
}

function readBearerToken(c: Context): string {
  const authorization = c.req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || c.req.header('x-vpauto-token') || '';
}

function isLocalRequest(c: Context): boolean {
  try {
    const host = new URL(c.req.url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function resolveRole(c: Context): VpautoRole {
  const requestedRole = c.req.header('x-vpauto-role');
  const token = readBearerToken(c);
  const account = findAccountByToken(token);
  if (account) {
    return account.role;
  }

  if (!ADMIN_TOKEN) {
    // Local-dev compatibility: the local admin extension can still enrich the
    // database without a token. A hosted backend without VPAUTO_ADMIN_TOKEN
    // must never trust a client-supplied admin role.
    return isLocalRequest(c) ? normalizeVpautoRole(requestedRole, 'owner') : 'user';
  }

  if (token && token === ADMIN_TOKEN) {
    return normalizeVpautoRole(requestedRole, 'owner');
  }

  return 'user';
}

export function getRequestAccess(c: Context): VpautoAccessProfile {
  return buildVpautoAccessProfile(resolveRole(c));
}

export function requirePermission(permission: VpautoPermission): MiddlewareHandler {
  return async (c, next) => {
    const access = getRequestAccess(c);
    if (!vpautoAccessHasPermission(access, permission)) {
      return c.json<ApiResponse<null>>({
        success: false,
        error: `forbidden:${permission}:${access.role}`,
      }, 403);
    }

    await next();
  };
}

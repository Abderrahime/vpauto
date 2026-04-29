import { browser } from 'wxt/browser';
import {
  buildVpautoAccessProfile,
  normalizeVpautoRole,
  vpautoAccessHasPermission,
} from '@vpauto/shared';
import type {
  VpautoAccessProfile,
  VpautoPermission,
  VpautoRole,
} from '@vpauto/shared';

export const EXTENSION_ROLE_STORAGE_KEY = 'vpautoExtensionRole';
export const EXTENSION_AUTH_STORAGE_KEY = 'vpautoAuthSession';

export interface VpautoAuthSession {
  token: string;
  email?: string;
  access?: VpautoAccessProfile;
}

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, string | undefined>;
};

function getBuildDefaultRole(): VpautoRole {
  const env = (import.meta as ImportMetaWithEnv).env || {};
  return normalizeVpautoRole(env.VITE_VPAUTO_EXTENSION_ROLE, 'owner');
}

export async function getExtensionAccess(): Promise<VpautoAccessProfile> {
  const stored = await browser.storage.local
    .get([EXTENSION_AUTH_STORAGE_KEY, EXTENSION_ROLE_STORAGE_KEY])
    .catch(() => ({}));
  const session = (stored as Record<string, unknown>)[EXTENSION_AUTH_STORAGE_KEY] as VpautoAuthSession | undefined;
  if (session?.access?.role && Array.isArray(session.access.permissions)) {
    return session.access;
  }

  const storedRole = (stored as Record<string, unknown>)[EXTENSION_ROLE_STORAGE_KEY];
  return buildVpautoAccessProfile(normalizeVpautoRole(storedRole, getBuildDefaultRole()));
}

export function canAccess(access: VpautoAccessProfile, permission: VpautoPermission): boolean {
  return vpautoAccessHasPermission(access, permission);
}

export function isAdminAccess(access: VpautoAccessProfile): boolean {
  return canAccess(access, 'vehicles:import')
    || canAccess(access, 'captures:run')
    || canAccess(access, 'debug:view');
}

export async function getAuthSession(): Promise<VpautoAuthSession | null> {
  const stored = await browser.storage.local.get(EXTENSION_AUTH_STORAGE_KEY).catch(() => ({}));
  const session = (stored as Record<string, unknown>)[EXTENSION_AUTH_STORAGE_KEY] as VpautoAuthSession | undefined;
  return session?.token ? session : null;
}

export async function setAuthSession(session: VpautoAuthSession): Promise<void> {
  await browser.storage.local.set({ [EXTENSION_AUTH_STORAGE_KEY]: session });
}

export async function clearAuthSession(): Promise<void> {
  await browser.storage.local.remove(EXTENSION_AUTH_STORAGE_KEY);
}

export async function getAccessHeaders(): Promise<Record<string, string>> {
  const access = await getExtensionAccess();
  const session = await getAuthSession();
  const headers: Record<string, string> = {
    'X-VPauto-Role': access.role,
  };
  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  return headers;
}

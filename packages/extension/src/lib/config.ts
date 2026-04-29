import { DEFAULT_API_URL } from '@vpauto/shared';

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, string | undefined>;
};

function readEnv(name: string): string | undefined {
  return (import.meta as ImportMetaWithEnv).env?.[name];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  return trimTrailingSlash(readEnv('VITE_VPAUTO_API_URL') || DEFAULT_API_URL);
}

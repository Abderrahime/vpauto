import { defineConfig } from 'wxt';

const extensionRole = process.env.VITE_VPAUTO_EXTENSION_ROLE || 'owner';
const isAdminBuild = extensionRole === 'owner' || extensionRole === 'admin';
const apiUrl = process.env.VITE_VPAUTO_API_URL || (isAdminBuild ? 'http://localhost:3456' : '');
const outputDir = process.env.VITE_VPAUTO_OUTPUT_DIR || (isAdminBuild ? '.output-admin' : '.output-user');

function hostPermissionFor(url: string): string | null {
  if (!url) return null;
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

const apiHostPermission = hostPermissionFor(apiUrl);
const hostPermissions = Array.from(new Set([
  ...(isAdminBuild ? ['<all_urls>'] : []),
  'https://vpauto.fr/*',
  'https://www.vpauto.fr/*',
  'https://cdn.vpauto.fr/*',
  ...(apiHostPermission ? [apiHostPermission] : []),
  ...(isAdminBuild ? ['http://localhost/*', 'http://127.0.0.1/*'] : []),
]));

export default defineConfig({
  srcDir: 'src',
  publicDir: 'public',
  outDir: outputDir,
  manifest: {
    name: isAdminBuild ? 'VPauto Assistant Admin' : 'VPauto Assistant User',
    description: isAdminBuild
      ? 'Assistant interne VPauto - import, capture et enrichissement de donnees'
      : 'Assistant d\'analyse pour les encheres VPauto - historique, comparaison et alertes vehicules',
    version: '0.1.0',
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: [
      'storage',
      'sidePanel',
      'tabs',
      ...(isAdminBuild ? ['windows', 'activeTab'] : []),
    ],
    // `<all_urls>` is required for `chrome.tabs.captureVisibleTab` —
    // narrower host permissions like `https://vpauto.fr/*` are not accepted
    // by Chrome for this API (it explicitly demands `<all_urls>` or
    // `activeTab`, even when the captured tab matches a host permission).
    // Without this entry the orchestrator's capture call rejects with
    // "Either the '<all_urls>' or 'activeTab' permission is required".
    host_permissions: hostPermissions,
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
  runner: {
    startUrls: ['https://www.vpauto.fr/vehicule/liste'],
  },
});

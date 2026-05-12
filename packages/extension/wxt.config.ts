import { defineConfig } from 'wxt';

const extensionRole = process.env.VITE_VPAUTO_EXTENSION_ROLE || 'owner';
const isAdminBuild = extensionRole === 'owner' || extensionRole === 'admin';
const apiUrl = process.env.VITE_VPAUTO_API_URL || (isAdminBuild ? 'http://localhost:3456' : '');
const outputDir = process.env.VITE_VPAUTO_OUTPUT_DIR || (isAdminBuild ? '.output-admin' : '.output-user');
// `build:user:local` writes to `.output-user-local` and points at the local
// backend — same code path as a prod user build, but pointed at localhost
// for dev testing. We suffix the extension name with " (Local)" so it can
// coexist in `chrome://extensions` with a prod-pointed build without
// confusion ("which one am I testing?" — solved by the badge).
const isLocalBuild = outputDir.endsWith('-local');

const baseExtensionName = isAdminBuild ? 'VPauto Assistant Admin' : 'VPauto Assistant User';
const extensionName = isLocalBuild ? `${baseExtensionName} (Local)` : baseExtensionName;

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
    name: extensionName,
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
      // `alarms` is used by the SW keep-alive ping. MV3 evicts idle
      // service workers after ~30 s and our CT pipeline can take 1-2
      // minutes to drain 50 vehicles. A no-op alarm every 25 s extends
      // the SW lifetime indefinitely while the extension is enabled.
      'alarms',
      ...(isAdminBuild ? ['windows', 'activeTab'] : []),
    ],
    // `<all_urls>` is required for `chrome.tabs.captureVisibleTab` —
    // narrower host permissions like `https://vpauto.fr/*` are not accepted
    // by Chrome for this API (it explicitly demands `<all_urls>` or
    // `activeTab`, even when the captured tab matches a host permission).
    // Without this entry the orchestrator's capture call rejects with
    // "Either the '<all_urls>' or 'activeTab' permission is required".
    host_permissions: hostPermissions,
    // `action` declares the toolbar icon. Without this key,
    // `chrome.action` is `undefined` inside the SW and any call to
    // `chrome.action.onClicked.addListener(...)` throws synchronously at
    // startup — Chrome then reports "Service worker registration failed.
    // Status code: 15" and the SW never starts. Declaring `action` even
    // with just the icons keeps the API alive and lets the SW handle
    // toolbar clicks (we use it to open the sidepanel).
    action: {
      default_title: extensionName,
      default_icon: {
        16: 'icons/icon-16.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // The pdfjs worker (`pdf.worker.mjs`) ships in `public/` and is
    // loaded by the content script via `chrome.runtime.getURL`. Content
    // scripts can already access their own extension's files, but
    // pdfjs's worker bootstrap performs a `new Worker(url)` whose
    // resolution rules are stricter — listing the file in
    // `web_accessible_resources` removes any ambiguity and also lets the
    // sidepanel/popup contexts reuse the same parser if we ever need to.
    web_accessible_resources: [
      {
        resources: ['pdf.worker.js'],
        matches: ['<all_urls>'],
      },
    ],
  },
  runner: {
    startUrls: ['https://www.vpauto.fr/vehicule/liste'],
  },
});

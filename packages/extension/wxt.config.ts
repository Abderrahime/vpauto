import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  publicDir: 'public',
  manifest: {
    name: 'VPauto Assistant',
    description: 'Assistant d\'analyse pour les enchères VPauto - historique, comparaison, suivi des véhicules',
    version: '0.1.0',
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://vpauto.fr/*',
      'https://www.vpauto.fr/*',
      'https://cdn.vpauto.fr/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
  runner: {
    startUrls: ['https://www.vpauto.fr/vehicule/liste'],
  },
});

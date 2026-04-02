interface ScrapeDebugPayload {
  stage: string;
  pageType?: 'detail' | 'list' | 'unknown';
  url?: string;
  vehicleCount?: number;
  hashId?: string;
  brand?: string;
  model?: string;
  reason?: string;
}

export default defineBackground(() => {
  console.log('[VPauto] Background service worker started');

  // Open side panel when clicking the extension icon
  browser.action.onClicked.addListener(async (tab) => {
    if (tab.id) {
      try {
        // @ts-expect-error - sidePanel API types may not be available
        await browser.sidePanel.open({ tabId: tab.id });
      } catch {
        // Firefox fallback: open popup
        console.log('[VPauto] Side panel not available, using popup');
      }
    }
  });

  // Listen for messages from content scripts
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (message.type === 'OPEN_SIDE_PANEL' && sender.tab?.id) {
      try {
        // @ts-expect-error
        await browser.sidePanel.open({ tabId: sender.tab.id });
      } catch {
        // Fallback
      }
    }

    if (message.type === 'VEHICLE_DETECTED') {
      // Store current vehicle data for the side panel to pick up
      await browser.storage.local.set({
        currentVehicle: message.payload,
        currentTabId: sender.tab?.id,
      });
    }

    if (message.type === 'VEHICLE_LIST_DETECTED') {
      await browser.storage.local.set({
        currentVehicleList: message.payload,
        currentTabId: sender.tab?.id,
      });
    }

    if (message.type === 'SCRAPE_DEBUG') {
      const payload = message.payload as ScrapeDebugPayload;

      await browser.storage.local.set({
        scrapeDebug: {
          ...payload,
          tabId: sender.tab?.id,
          timestamp: new Date().toISOString(),
        },
        currentTabId: sender.tab?.id,
      });
    }
  });

  // Enable side panel on VPauto pages
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.url?.includes('vpauto.fr')) {
      try {
        // @ts-expect-error
        browser.sidePanel.setOptions({
          tabId,
          path: 'sidepanel.html',
          enabled: true,
        });
      } catch {
        // Firefox
      }
    }
  });
});

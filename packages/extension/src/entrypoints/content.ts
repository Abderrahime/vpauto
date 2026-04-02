import { VPAUTO_VEHICLE_URL_PATTERN } from '@vpauto/shared';
import { scrapeVehicleDetail, scrapeVehicleList, waitForVehicleCards } from '../lib/scraper';
import { api } from '../lib/api';
import { injectBadges } from '../lib/badges';

function detectPageType(url: string): 'detail' | 'list' | 'unknown' {
  if (VPAUTO_VEHICLE_URL_PATTERN.test(url)) {
    return 'detail';
  }

  if (url.includes('/vehicule/liste')) {
    return 'list';
  }

  return 'unknown';
}

function sendDebug(payload: Record<string, unknown>): void {
  const debugPayload = {
    ...payload,
    timestamp: new Date().toISOString(),
  };

  void browser.storage.local.set({
    scrapeDebug: debugPayload,
  }).catch(() => {});

  void browser.runtime.sendMessage({
    type: 'SCRAPE_DEBUG',
    payload: debugPayload,
  }).catch(() => {});
}

export default defineContentScript({
  matches: ['https://vpauto.fr/*', 'https://www.vpauto.fr/*'],
  runAt: 'document_idle',

  async main() {
    console.log('[VPauto] Content script loaded on', window.location.href);
    sendDebug({
      stage: 'content_loaded',
      pageType: detectPageType(window.location.href),
      url: window.location.href,
    });

    let lastHandledUrl = '';

    const handleCurrentPage = async () => {
      const url = window.location.href;
      if (url === lastHandledUrl) return;
      lastHandledUrl = url;

      if (VPAUTO_VEHICLE_URL_PATTERN.test(url)) {
        await handleVehiclePage();
      } else if (url.includes('/vehicule/liste') || url.includes('/vehicule/liste')) {
        await handleListPage();
      }
    };

    // Handle initial page
    await handleCurrentPage();

    // Watch for SPA navigation (pushState / hash changes)
    const navObserver = new MutationObserver(async () => {
      if (window.location.href !== lastHandledUrl) {
        await handleCurrentPage();
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: false });

    window.addEventListener('popstate', handleCurrentPage);
  },
});

// ── Vehicle detail page ────────────────────────────────────────────────────

async function handleVehiclePage() {
  console.log('[VPauto] 🚗 Vehicle detail page detected');
  sendDebug({
    stage: 'detail_detected',
    pageType: 'detail',
    url: window.location.href,
  });

  const snapshot = scrapeVehicleDetail();
  if (!snapshot || !snapshot.brand) {
    console.warn('[VPauto] Could not scrape vehicle detail — retrying in 1s');
    sendDebug({
      stage: 'detail_scrape_failed',
      pageType: 'detail',
      url: window.location.href,
      reason: !snapshot ? 'snapshot_null' : 'brand_missing',
    });
    setTimeout(handleVehiclePage, 1000);
    return;
  }

  console.log('[VPauto] Scraped:', snapshot.brand, snapshot.model, snapshot.year, snapshot.mileage + 'km');
  sendDebug({
    stage: 'detail_scraped',
    pageType: 'detail',
    url: window.location.href,
    hashId: snapshot.hashId,
    brand: snapshot.brand,
    model: snapshot.model,
  });

  // Save to backend (non-blocking)
  const result = await api.saveSnapshot(snapshot).catch(() => null);

  sendDebug({
    stage: result?.vehicleId ? (result.duplicate ? 'detail_saved_duplicate' : 'detail_saved') : 'detail_save_failed',
    pageType: 'detail',
    url: window.location.href,
    hashId: snapshot.hashId,
    brand: snapshot.brand,
    model: snapshot.model,
    reason: result?.vehicleId ? (result.duplicate ? 'duplicate_snapshot' : 'saved') : 'save_snapshot_returned_null',
    backendVehicleId: result?.vehicleId ?? null,
    backendSnapshotId: result?.snapshotId ?? null,
  });

  const currentVehicle = {
    snapshot,
    vehicleId: result?.vehicleId ?? null,
    snapshotId: result?.snapshotId ?? null,
    isNew: result ? !result.duplicate : undefined,
  };

  void browser.storage.local.set({
    currentVehicle,
  }).catch(() => {});

  // Notify side panel
  browser.runtime.sendMessage({
    type: 'VEHICLE_DETECTED',
    payload: currentVehicle,
  }).catch(() => {});

  // Inject inline banner on the page
  if (result?.vehicleId) {
    injectVehicleBanner(result.vehicleId, snapshot);
  }
}

// ── Vehicle list page ──────────────────────────────────────────────────────

async function handleListPage() {
  console.log('[VPauto] 📋 List page detected — waiting for cards...');
  void browser.storage.local.remove('currentVehicle').catch(() => {});

  sendDebug({
    stage: 'list_detected',
    pageType: 'list',
    url: window.location.href,
  });

  try {
    // Wait for SPA to inject cards into the DOM
    const cards = await waitForVehicleCards(8000);
    sendDebug({
      stage: 'list_cards_found',
      pageType: 'list',
      url: window.location.href,
      vehicleCount: cards.length,
    });
  } catch {
    console.warn('[VPauto] Cards not found after 8s — page might not have loaded');
    sendDebug({
      stage: 'list_cards_timeout',
      pageType: 'list',
      url: window.location.href,
      reason: 'no_vehicle_links_found',
    });
    return;
  }

  const vehicles = scrapeVehicleList();
  console.log(`[VPauto] Found ${vehicles.length} vehicle cards`);
  sendDebug({
    stage: vehicles.length > 0 ? 'list_scraped' : 'list_scraped_empty',
    pageType: 'list',
    url: window.location.href,
    vehicleCount: vehicles.length,
  });

  if (vehicles.length === 0) return;

  void browser.storage.local.set({
    currentVehicleList: vehicles,
  }).catch(() => {});

  // Send list to side panel via storage
  browser.runtime.sendMessage({
    type: 'VEHICLE_LIST_DETECTED',
    payload: vehicles,
  }).catch(() => {});

  // Inject badges on cards (async, non-blocking)
  injectBadges(vehicles).catch(() => {});
}

// ── Inline banner on detail page ───────────────────────────────────────────

async function injectVehicleBanner(vehicleId: number, snapshot: import('@vpauto/shared').VehicleSnapshot) {
  if (document.getElementById('vpauto-assistant-banner')) return;

  const [history, badges] = await Promise.all([
    api.getHistory(vehicleId).catch(() => null),
    api.getBadges(vehicleId).catch(() => null),
  ]);

  const banner = document.createElement('div');
  banner.id = 'vpauto-assistant-banner';
  Object.assign(banner.style, {
    background: 'linear-gradient(135deg, #003366 0%, #004488 100%)',
    color: 'white',
    padding: '10px 16px',
    margin: '8px 0',
    borderRadius: '8px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px',
    alignItems: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    zIndex: '9999',
  });

  // Badges
  if (badges?.length) {
    for (const b of badges) {
      const el = document.createElement('span');
      Object.assign(el.style, {
        padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '700',
        background: b.type === 'new' ? '#22c55e' : b.type === 'seen' ? '#3b82f6'
          : b.type === 'price_drop' ? '#22c55e' : b.type === 'price_up' ? '#ef4444' : '#f59e0b',
        color: b.type === 'reappeared' ? '#333' : 'white',
      });
      el.textContent = b.detail ? `${b.label} (${b.detail})` : b.label;
      banner.appendChild(el);
    }
  }

  // History summary
  if (history && history.totalPassages > 1) {
    const info = document.createElement('span');
    info.style.opacity = '0.9';
    let text = `📋 ${history.totalPassages} passages — Premier vu : ${history.firstSeen.slice(0,10)}`;
    if (history.priceHistory.length >= 2) {
      const diff = history.priceHistory.at(-1)!.price - history.priceHistory[0].price;
      text += ` | Prix : ${diff > 0 ? '▲' : diff < 0 ? '▼' : '→'} ${Math.abs(diff).toLocaleString('fr-FR')} €`;
    }
    info.textContent = text;
    banner.appendChild(info);
  }

  // Open panel button
  const btn = document.createElement('button');
  Object.assign(btn.style, {
    marginLeft: 'auto', background: '#f47920', color: 'white', border: 'none',
    padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '700',
  });
  btn.textContent = '📊 Ouvrir le panneau';
  btn.onclick = () => browser.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
  banner.appendChild(btn);

  // Insert after H1 or at top of main content
  const target = document.querySelector('h1, main, [class*="vehicle"], [class*="fiche"], #content');
  if (target?.parentNode) {
    target.parentNode.insertBefore(banner, target.nextSibling);
  } else {
    document.body.prepend(banner);
  }
}

import { VPAUTO_VEHICLE_URL_PATTERN } from '@vpauto/shared';
import { scrapeVehicleDetail, scrapeVehicleList, waitForVehicleCards, detectPagination, scrapeRemotePage } from '../lib/scraper';
import { api } from '../lib/api';
import { injectBadges } from '../lib/badges';

type VehicleVisitEntry = {
  count: number;
  lastVisitedAt: string;
  lastSourceUrl?: string;
  label?: string;
};

type VehicleVisitsMap = Record<string, VehicleVisitEntry>;

function detectPageType(url: string): 'detail' | 'list' | 'unknown' {
  if (VPAUTO_VEHICLE_URL_PATTERN.test(url)) {
    return 'detail';
  }

  // VPauto uses multiple URL patterns for list pages:
  // /vehicule/liste - standard vehicle list
  // /enchere/liste - live auction list
  // /rechercher/ - search results
  // /selection/liste - saved selections
  // /vehicule/resultats - sale results
  if (/\/(vehicule|enchere|selection)\/(liste|resultats)/i.test(url)
    || url.includes('/rechercher/')
    || url.includes('/recherche/')
    || url.includes('?vente=')
    || url.includes('?recherche=')) {
    return 'list';
  }

  return 'unknown';
}

/** Check if current page has vehicle cards (fallback detection for unknown URL patterns) */
function hasVehicleCards(): boolean {
  return document.querySelectorAll('a[href*="/vehicule/"]').length > 3;
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

function buildVisitKeys(snapshot: { hashId?: string; reference?: string }, vehicleId?: number | null): string[] {
  const keys = new Set<string>();
  if (vehicleId) keys.add(`vehicle:${vehicleId}`);
  if (snapshot.hashId) keys.add(`hash:${snapshot.hashId}`);
  if (snapshot.reference) keys.add(`ref:${snapshot.reference}`);
  return [...keys];
}

async function recordVehicleVisit(
  snapshot: { hashId?: string; reference?: string; brand?: string; model?: string; sourceUrl?: string },
  vehicleId?: number | null,
): Promise<void> {
  const keys = buildVisitKeys(snapshot, vehicleId);
  if (keys.length === 0) return;

  const canonicalKey = vehicleId
    ? `vehicle:${vehicleId}`
    : snapshot.hashId
    ? `hash:${snapshot.hashId}`
    : `ref:${snapshot.reference}`;

  const label = [snapshot.brand, snapshot.model].filter(Boolean).join(' ').trim() || 'Vehicule';
  const now = new Date().toISOString();

  const storage = await browser.storage.local.get('vehicleVisits').catch(() => ({ vehicleVisits: {} }));
  const current = (storage.vehicleVisits && typeof storage.vehicleVisits === 'object')
    ? storage.vehicleVisits as VehicleVisitsMap
    : {};

  let priorCount = 0;
  for (const key of keys) {
    priorCount += current[key]?.count || 0;
  }

  const nextVisits: VehicleVisitsMap = { ...current };
  for (const key of keys) {
    if (key !== canonicalKey) {
      delete nextVisits[key];
    }
  }

  nextVisits[canonicalKey] = {
    count: priorCount + 1,
    lastVisitedAt: now,
    lastSourceUrl: snapshot.sourceUrl,
    label,
  };

  await browser.storage.local.set({
    vehicleVisits: nextVisits,
  }).catch(() => {});
}

async function persistDetailSnapshot(snapshot: import('@vpauto/shared').VehicleSnapshot): Promise<{
  vehicleId: number | null;
  snapshotId: number | null;
  duplicate: boolean;
  createdVehicle: boolean;
  recoveredByLookup: boolean;
  error: string | null;
}> {
  console.log(`[VPauto] persistDetailSnapshot: Saving ${snapshot.brand} ${snapshot.model} (hashId=${snapshot.hashId}, ref=${snapshot.reference})`);

  const saveResult = await api.saveSnapshotDetailed(snapshot);
  console.log(`[VPauto] persistDetailSnapshot: saveResult =`, JSON.stringify({
    hasData: !!saveResult.data,
    vehicleId: saveResult.data?.vehicleId,
    snapshotId: saveResult.data?.snapshotId,
    duplicate: saveResult.data?.duplicate,
    error: saveResult.error,
  }));

  if (saveResult.data?.vehicleId) {
    return {
      vehicleId: saveResult.data.vehicleId,
      snapshotId: saveResult.data.snapshotId,
      duplicate: saveResult.data.duplicate,
      createdVehicle: !!saveResult.data.createdVehicle,
      recoveredByLookup: false,
      error: saveResult.error,
    };
  }

  console.log(`[VPauto] persistDetailSnapshot: Save failed (error: ${saveResult.error}), trying lookup fallback...`);
  const lookup = await api.lookup({
    reference: snapshot.reference || undefined,
    hashId: snapshot.hashId || undefined,
  }).catch((err) => {
    console.warn('[VPauto] persistDetailSnapshot: Lookup also failed:', err);
    return null;
  });

  if (lookup?.vehicleId) {
    console.log(`[VPauto] persistDetailSnapshot: Lookup recovered vehicleId=${lookup.vehicleId}`);
    return {
      vehicleId: lookup.vehicleId,
      snapshotId: null,
      duplicate: true,
      createdVehicle: false,
      recoveredByLookup: true,
      error: saveResult.error || 'lookup_recovered_existing_vehicle',
    };
  }

  console.error(`[VPauto] persistDetailSnapshot: FAILED — no vehicleId from save or lookup. Error: ${saveResult.error}`);
  return {
    vehicleId: null,
    snapshotId: null,
    duplicate: false,
    createdVehicle: false,
    recoveredByLookup: false,
    error: saveResult.error,
  };
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

      const pageType = detectPageType(url);

      if (pageType === 'detail') {
        await handleVehiclePage();
      } else if (pageType === 'list') {
        await handleListPage();
      } else if (hasVehicleCards()) {
        // Fallback: unknown URL but page has vehicle cards → treat as list
        console.log('[VPauto] Unknown URL pattern but vehicle cards detected — treating as list');
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

  // Set currentVehicle IMMEDIATELY so side panel switches to detail view
  const currentVehicle: {
    snapshot: typeof snapshot;
    vehicleId: number | null;
    snapshotId: number | null;
    isNew: boolean | undefined;
  } = {
    snapshot,
    vehicleId: null,
    snapshotId: null,
    isNew: undefined,
  };

  void browser.storage.local.set({ currentVehicle }).catch(() => {});

  // Save to backend (via background proxy), with lookup fallback if the save result
  // is lost but the vehicle already exists in the local DB.
  const persistence = await persistDetailSnapshot(snapshot);

  if (persistence.vehicleId) {
    currentVehicle.vehicleId = persistence.vehicleId;
    currentVehicle.snapshotId = persistence.snapshotId;
    currentVehicle.isNew = persistence.recoveredByLookup ? undefined : persistence.createdVehicle;

    // Update storage with vehicleId so side panel can fetch intelligence data
    void browser.storage.local.set({ currentVehicle }).catch(() => {});
  }

  await recordVehicleVisit(snapshot, persistence.vehicleId);

  sendDebug({
    stage: persistence.vehicleId
      ? (persistence.recoveredByLookup
        ? 'detail_lookup_recovered'
        : persistence.duplicate
        ? 'detail_saved_duplicate'
        : 'detail_saved')
      : 'detail_save_failed',
    pageType: 'detail',
    url: window.location.href,
    hashId: snapshot.hashId,
    brand: snapshot.brand,
    model: snapshot.model,
    reason: persistence.error || null,
    backendVehicleId: persistence.vehicleId,
  });

  // Inject inline banner on the page
  if (persistence.vehicleId) {
    injectVehicleBanner(persistence.vehicleId, snapshot);
  }
}

// ── Vehicle list page ──────────────────────────────────────────────────────

async function handleListPage() {
  console.log('[VPauto] 📋 List page detected — waiting for cards...');
  // Clear vehicle detail view — MUST await so side panel switches to list
  await browser.storage.local.remove('currentVehicle').catch(() => {});

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

  // Scrape current page
  const vehicles = scrapeVehicleList();
  console.log(`[VPauto] Found ${vehicles.length} vehicle cards on current page`);

  if (vehicles.length === 0) {
    sendDebug({ stage: 'list_scraped_empty', pageType: 'list', url: window.location.href, vehicleCount: 0 });
    return;
  }

  // Send current page results immediately so the side panel updates fast
  updateListState(vehicles, 'list_scraped');

  // Inject badges on visible cards (async, non-blocking)
  injectBadges(vehicles).catch(() => {});

  // Detect pagination and scrape remaining pages in background
  const { currentPage, totalPages, baseUrl } = detectPagination();
  if (totalPages > 1) {
    scrapeAllPages(vehicles, currentPage, totalPages, baseUrl);
  } else {
    // Single page — send to background for batch save
    console.log(`[VPauto] Single page, sending ${vehicles.length} vehicles to background for batch save...`);
    void sendBatchToBackground(vehicles);
  }
}

/** Ask the background worker to persist the full batch independently of the page lifecycle. */
async function sendBatchToBackground(vehicles: Partial<import('@vpauto/shared').VehicleSnapshot>[]): Promise<void> {
  sendDebug({
    stage: 'list_batch_started',
    pageType: 'list',
    url: window.location.href,
    vehicleCount: vehicles.length,
  });

  const response = await api.runBackgroundBatchSave(vehicles);

  if (response.error || !response.data) {
    const reason = response.error || 'batch_save_failed';
    console.warn('[VPauto] Batch save failed:', reason);
    sendDebug({
      stage: 'list_batch_failed',
      pageType: 'list',
      url: window.location.href,
      vehicleCount: vehicles.length,
      reason,
    });
    return;
  }

  console.log(`[VPauto] Batch complete: ${response.data.saved} saved, ${response.data.newVehicles} new`);
  void browser.storage.local.set({ batchTrackingResult: response.data }).catch(() => {});
  sendDebug({
    stage: 'list_batch_saved',
    pageType: 'list',
    url: window.location.href,
    vehicleCount: vehicles.length,
    reason: `saved=${response.data.saved}, new=${response.data.newVehicles}, priceChanges=${response.data.priceChanges?.length || 0}`,
  });
}

function updateListState(vehicles: Partial<import('@vpauto/shared').VehicleSnapshot>[], stage: string): void {
  sendDebug({
    stage,
    pageType: 'list',
    url: window.location.href,
    vehicleCount: vehicles.length,
  });

  void browser.storage.local.set({
    currentVehicleList: vehicles,
  }).catch(() => {});

  browser.runtime.sendMessage({
    type: 'VEHICLE_LIST_DETECTED',
    payload: vehicles,
  }).catch(() => {});
}

async function scrapeAllPages(
  initialVehicles: Partial<import('@vpauto/shared').VehicleSnapshot>[],
  currentPage: number,
  totalPages: number,
  baseUrl: string,
): Promise<void> {
  const allVehicles = [...initialVehicles];
  const seenIds = new Set(allVehicles.map(v => v.hashId).filter(Boolean));

  console.log(`[VPauto] Scraping remaining pages (${currentPage}/${totalPages})...`);

  for (let page = 1; page <= totalPages; page++) {
    if (page === currentPage) continue; // Already scraped

    const separator = baseUrl.includes('?') ? '&' : '?';
    const pageUrl = `${baseUrl}${separator}page=${page}`;
    console.log(`[VPauto] Fetching page ${page}/${totalPages}: ${pageUrl}`);

    const pageVehicles = await scrapeRemotePage(pageUrl);

    // Deduplicate
    for (const v of pageVehicles) {
      if (v.hashId && !seenIds.has(v.hashId)) {
        seenIds.add(v.hashId);
        allVehicles.push(v);
      }
    }

    // Update side panel progressively every 2 pages
    if (page % 2 === 0 || page === totalPages) {
      updateListState(allVehicles, `list_scraping_page_${page}_of_${totalPages}`);
    }

    // Small delay to avoid hammering the server
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[VPauto] All pages scraped: ${allVehicles.length} total vehicles`);
  updateListState(allVehicles, 'list_all_pages_scraped');

  // Batch save — send to background (handles chunking + stores tracking results)
  if (allVehicles.length > 0) {
    await sendBatchToBackground(allVehicles);
  }
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
  const previousPassageCount = history ? Math.max(history.totalPassages - 1, 0) : 0;
  if (history && previousPassageCount > 0) {
    const info = document.createElement('span');
    info.style.opacity = '0.9';
    let text = `📋 ${previousPassageCount} passage${previousPassageCount > 1 ? 's' : ''} precedent${previousPassageCount > 1 ? 's' : ''} — Premier vu : ${history.firstSeen.slice(0,10)}`;
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

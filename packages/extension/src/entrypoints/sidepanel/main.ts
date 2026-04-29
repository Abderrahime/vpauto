import { browser } from 'wxt/browser';
import type { MatchResult, VehicleBadge, VehicleHistory, VehicleSnapshot } from '@vpauto/shared';
import type { VpautoAccessProfile, VpautoPermission } from '@vpauto/shared';
import { buildPriceHistory, computeEvolution } from '@vpauto/shared';
import { api } from '../../lib/api';
import {
  canAccess,
  clearAuthSession,
  getAccessHeaders,
  getAuthSession,
  getExtensionAccess,
  setAuthSession,
} from '../../lib/access';
import type { VpautoAuthSession } from '../../lib/access';
import { getApiBaseUrl } from '../../lib/config';
import type { CaptureCandidate, CaptureTimelineEntry } from '../../lib/api';
import { scrapeRemotePage, scrapeVehicleDetailFromHtml } from '../../lib/scraper';
import './style.css';

interface CurrentVehicleState {
  snapshot: VehicleSnapshot;
  vehicleId?: number;
  snapshotId?: number;
  isNew?: boolean;
  /**
   * Set by the content script when the user lands on a VPauto fiche that
   * VPauto itself returned as 404. The sidepanel renders a yellow banner +
   * the locally archived screenshot at the top of the detail view, while the
   * rest of the panel is built from the latest snapshot we have in DB.
   */
  vpauto404?: boolean;
  /** VPauto URL that 404'd — kept for the "Réessayer" link in the banner. */
  vpauto404SourceUrl?: string;
}

interface BatchTrackingResult {
  saved: number;
  newVehicles: number;
  priceChanges: { hashId: string; vehicleId: number; diff: number }[];
  disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
  timestamp: string;
}

interface StoredPanelState {
  currentVehicle?: CurrentVehicleState;
  currentVehicleList?: Partial<VehicleSnapshot>[];
  batchTrackingResult?: BatchTrackingResult;
  scrapeDebug?: ScrapeDebugState;
  vehicleVisits?: Record<string, {
    count: number;
    lastVisitedAt: string;
    lastSourceUrl?: string;
    label?: string;
  }>;
  /**
   * Map of hashIds known to 404 on VPauto, populated by content.ts whenever
   * the user lands on a `.container404` page. Read at render time so that
   * cross-auction passages can be flagged without re-probing the network.
   */
  vpauto404Hashes?: Vpauto404Map;
  backgroundDebug?: {
    startedAt?: string;
    status?: string;
    updatedAt?: string;
    lastStage?: string;
    lastMethod?: string;
    lastPath?: string;
    lastError?: string | null;
    lastRequestId?: string;
  };
}

interface CrossAuctionPassage {
  snapshotId: number;
  canonicalSnapshotId: number;
  /** VPauto hashId — used to look up the global 404 cache. */
  hashId?: string | null;
  /** True when a screenshot was captured at scrape time and is on disk. */
  hasScreenshot?: boolean;
  city: string;
  saleDate: string;
  saleTime: string | null;
  status: string;
  startingPrice: number | null;
  soldPrice: number | null;
  lotNumber: number | null;
  mileage: number;
  scrapedAt: string;
  sourceUrl: string;
  isSourceUrlStable: boolean;
  openMode: 'vpauto' | 'local';
  openReason: string;
}

/**
 * Persistent map of VPauto hashIds known to return 404. Populated by the
 * content script when the user lands on a `.container404` page; consumed by
 * the sidepanel cross-auction renderer to mark dead passages with a chip
 * and offer the screenshot lightbox + local fiche fallback.
 */
type Vpauto404Map = Record<string, { detectedAt: string; vehicleId?: number }>;

interface CrossAuctionData {
  vehicleId: number;
  brand: string;
  model: string;
  year: number;
  passages: CrossAuctionPassage[];
  firstStartingPrice: number | null;
  postSaleTruncatedPassages?: CrossAuctionPassage[];
}

interface SimilarSoldData {
  results: {
    hashId: string;
    brand: string;
    model: string;
    version: string;
    year: number;
    mileage: number;
    city: string;
    startingPrice: number | null;
    soldPrice: number;
    saleDate: string | null;
    sourceUrl: string;
    observations: string | null;
    photoUrls?: string[];
    yearMatch: boolean;
    modelMatch: boolean;
    mileageMatch?: boolean;
  }[];
  stats: {
    count: number;
    avgSoldPrice: number | null;
    minSoldPrice: number | null;
    maxSoldPrice: number | null;
  };
}

interface ScrapeDebugState {
  stage: string;
  pageType?: 'detail' | 'list' | 'unknown';
  url?: string;
  vehicleCount?: number;
  hashId?: string;
  brand?: string;
  model?: string;
  reason?: string;
  backendVehicleId?: number | null;
  backendSnapshotId?: number | null;
  timestamp?: string;
  tabId?: number;
}

type VerdictTone = 'good' | 'warn' | 'bad';

interface VerdictInsight {
  tone: VerdictTone;
  tag: string;
  title: string;
  subtitle: string;
  emoji: string;
  score: number;
  market: number;
  marketLabel: string;
  rangeMin: number;
  rangeMax: number;
  markerPct: number;
  fillPct: number;
  diffPct: number;
  comparableCount: number;
  kmPerYear?: number;
  marketValue?: number;
  referencePrice?: number;
  referenceLabel?: string;
}

interface GamificationStats {
  streak: number;
  xp: number;
  level: number;
  nextLevelXp: number;
  progressPct: number;
  goodDeals: number;
  levelTitle: string;
}

type ImportScope = 'detected' | 'current_page' | 'first_n' | 'page_range';
type ImportMode = 'silent' | 'visible';

interface ImportOptions {
  scope: ImportScope;
  mode: ImportMode;
  firstN: number;
  fromPage: number;
  toPage: number;
}

interface ImportTarget {
  url: string;
  label: string;
}

interface ImportChangeEntry {
  label: string;
  kind: 'new' | 'price_up' | 'price_down' | 'status_change' | 'updated';
  /** Short one-line summary (kept for backwards-compat with filters). */
  detail: string;
  /**
   * Detailed, per-field diff between the previous snapshot (or none) and the
   * freshly scraped one. Rendered under `detail` so the user sees *exactly*
   * what changed on this vehicle, e.g. "Mise à prix : 15 400 € → 14 900 €
   * (−500 €)", "Kilométrage : 78 500 → 82 300 (+3 800)".
   */
  updates: FieldUpdate[];
  url: string;
}

interface FieldUpdate {
  /** Technical field key — matches `VehicleSnapshot` property name. */
  field: string;
  /** Human-friendly French label shown to the user. */
  label: string;
  /** Pre-formatted "before" value, or '—' when absent. */
  before: string;
  /** Pre-formatted "after" value, or '—' when absent. */
  after: string;
  /**
   * Direction of the change — 'up' for an increase (green for km, red for
   * mise-à-prix raise), 'down' for a drop, 'neutral' for non-numeric shifts
   * like a status or city change.
   */
  direction: 'up' | 'down' | 'neutral';
  /**
   * Optional short delta label (e.g. "+3 800 km", "−500 €") shown next to
   * the arrow. Omitted for non-numeric changes.
   */
  delta?: string;
}

type ImportChangeFilter = 'all' | ImportChangeEntry['kind'];

/**
 * Which bucket of the capture plan the user is currently capturing.
 * - `new`     → vehicles never captured AND first seen during the running
 *               import (default click target after a fresh import)
 * - `modified`→ vehicles already captured but with a relevant change
 *               (price / status / city or saleDate)
 * - `missing` → "rattrapage" pass over vehicles never captured but first
 *               seen before the import started
 */
type CaptureBucket = 'new' | 'modified' | 'missing';

interface CapturePlanCounts {
  new: number;
  modified: number;
  missing: number;
  skipped: number;
  computedAt: string;
  error?: string;
}

interface CaptureJobState {
  status: 'idle' | 'planning' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  bucket: CaptureBucket | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  /** Per-iteration error log, capped at the last 5 entries to bound memory. */
  errors: string[];
  candidates: CaptureCandidate[];
  cursorIndex: number;
  /** ID of the popup window driving the capture loop, when one is open. */
  windowId?: number;
  /** ID of the active tab inside that window. */
  tabId?: number;
  currentLabel?: string;
  lastMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  abortRequested?: boolean;
  pauseRequested?: boolean;
}

interface ImportJobState {
  status: 'idle' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled';
  scope: ImportScope;
  mode: ImportMode;
  total: number;
  processed: number;
  saved: number;
  duplicates: number;
  failed: number;
  newVehicles: number;
  updated: number;
  unchanged: number;
  priceUps: number;
  priceDowns: number;
  statusChanges: number;
  currentLabel?: string;
  lastMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  errors: string[];
  changes: ImportChangeEntry[];
  capturePlanCounts?: CapturePlanCounts;
  abortRequested?: boolean;
}

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing side panel root element.');
}

const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('fr-FR');
const dateFormatter = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let showDebug = false;
let activeAccess: VpautoAccessProfile = {
  role: 'owner',
  permissions: [
    'vehicles:read',
    'vehicles:write',
    'vehicles:import',
    'captures:plan',
    'captures:run',
    'auction:summary',
    'debug:view',
    'watchlist:write',
  ],
};
let activeAuthSession: VpautoAuthSession | null = null;
let authFeedback: { tone: 'ok' | 'error'; text: string } | null = null;
let hasRenderedOnce = false;
let isRefreshing = false;
let pendingRefresh = false;

/**
 * In-flight VPauto-URL probes (hashIds currently being HEAD-probed by the
 * background). Module-level so a refresh that happens MID-probe doesn't
 * redundantly re-probe the same URL — the prober skips any hashId already
 * in this set. Cleared as each probe resolves.
 */
const inflightVpautoProbes = new Set<string>();

/**
 * True while at least one cross-auction passage is being probed. Drives the
 * "Vérification VPauto…" indicator next to the section title and is checked
 * by `renderCrossAuction` to render the badge — completely passive, no DOM
 * mutation outside the normal render cycle.
 */
let crossAuctionProbing = false;
let importOptions: ImportOptions = {
  scope: 'detected',
  mode: 'silent',
  firstN: 50,
  fromPage: 1,
  toPage: 3,
};
let importJob: ImportJobState | null = null;
let importChangeQuery = '';
let importChangeFilter: ImportChangeFilter = 'all';
let importChangePage = 1;

function hasAccess(permission: VpautoPermission): boolean {
  return canAccess(activeAccess, permission);
}

/**
 * Module-level orchestrator state for the post-import capture run. Exists for
 * the lifetime of the side panel — survives storage events but NOT a panel
 * close (intentional: a half-finished capture run is not worth resuming
 * across reloads since the popup window would have been closed too).
 */
let captureJob: CaptureJobState | null = null;
// VPauto detail pages keep firing background analytics/iframe requests well
// past the point where the visible content has rendered, so `tab.status` often
// never reaches `'complete'`. We poll briefly and then proceed regardless —
// `CAPTURE_RENDER_SETTLE_MS` after navigation is the real "is this paintable
// yet" guard.
const CAPTURE_TAB_LOAD_TIMEOUT_MS = 6000;
const CAPTURE_RENDER_SETTLE_MS = 2500;
// Hard cap per capture iteration. Without this, a stuck `chrome.tabs.captureVisibleTab`
// call (e.g. popup window minimized to dock on macOS) or a slow screenshot upload
// can hang the entire orchestrator on the first vehicle.
const CAPTURE_ITERATION_TIMEOUT_MS = 30000;
const IMPORT_FETCH_TIMEOUT_MS = 15000;

const IMPORT_CHANGE_PAGE_SIZE = 12;

void refreshPanel();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (
    !changes.currentVehicle
    && !changes.currentVehicleList
    && !changes.scrapeDebug
    && !changes.batchTrackingResult
    && !changes.vehicleVisits
    && !changes.vpautoExtensionRole
    && !changes.vpautoAuthSession
  ) return;

  scheduleRefresh();
});

function scheduleRefresh(delay = 150): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (isRefreshing) {
      pendingRefresh = true;
      return;
    }
    void refreshPanel();
  }, delay);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = IMPORT_FETCH_TIMEOUT_MS): Promise<Response> {
  if (init.signal) {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

async function syncCurrentVehicleFromPanel(
  currentVehicle: CurrentVehicleState,
  scrapeDebug?: ScrapeDebugState,
): Promise<{ currentVehicle: CurrentVehicleState; scrapeDebug: ScrapeDebugState | undefined }> {
  if (currentVehicle.vehicleId) {
    return { currentVehicle, scrapeDebug };
  }

  const snapshot = currentVehicle.snapshot;
  const saveResult = hasAccess('vehicles:write')
    ? await api.saveSnapshotDetailed(snapshot)
    : { data: null, error: `read_only:${activeAccess.role}` };

  if (saveResult.data?.vehicleId) {
    const nextState: CurrentVehicleState = {
      ...currentVehicle,
      vehicleId: saveResult.data.vehicleId,
      snapshotId: saveResult.data.snapshotId,
      isNew: !!saveResult.data.createdVehicle,
    };

    const nextDebug: ScrapeDebugState = {
      ...scrapeDebug,
      stage: saveResult.data.duplicate ? 'detail_saved_duplicate' : 'detail_saved',
      pageType: 'detail',
      url: snapshot.sourceUrl,
      hashId: snapshot.hashId,
      brand: snapshot.brand,
      model: snapshot.model,
      backendVehicleId: saveResult.data.vehicleId,
      backendSnapshotId: saveResult.data.snapshotId,
      reason: null,
      timestamp: new Date().toISOString(),
    };

    await browser.storage.local.set({
      currentVehicle: nextState,
      scrapeDebug: nextDebug,
    });

    return { currentVehicle: nextState, scrapeDebug: nextDebug };
  }

  const lookup = await api.lookup({
    reference: snapshot.reference || undefined,
    hashId: snapshot.hashId || undefined,
  });

  if (lookup?.vehicleId) {
    const nextState: CurrentVehicleState = {
      ...currentVehicle,
      vehicleId: lookup.vehicleId,
    };

    const nextDebug: ScrapeDebugState = {
      ...scrapeDebug,
      stage: 'detail_lookup_recovered',
      pageType: 'detail',
      url: snapshot.sourceUrl,
      hashId: snapshot.hashId,
      brand: snapshot.brand,
      model: snapshot.model,
      backendVehicleId: lookup.vehicleId,
      reason: saveResult.error || 'lookup_recovered_existing_vehicle',
      timestamp: new Date().toISOString(),
    };

    await browser.storage.local.set({
      currentVehicle: nextState,
      scrapeDebug: nextDebug,
    });

    return { currentVehicle: nextState, scrapeDebug: nextDebug };
  }

  const nextDebug: ScrapeDebugState = {
    ...scrapeDebug,
    stage: 'detail_save_failed',
    pageType: 'detail',
    url: snapshot.sourceUrl,
    hashId: snapshot.hashId,
    brand: snapshot.brand,
    model: snapshot.model,
    backendVehicleId: null,
    reason: saveResult.error || 'panel_sync_failed',
    timestamp: new Date().toISOString(),
  };

  await browser.storage.local.set({
    scrapeDebug: nextDebug,
  });

  return { currentVehicle, scrapeDebug: nextDebug };
}

async function persistImportedSnapshot(snapshot: VehicleSnapshot): Promise<{
  vehicleId: number | null;
  duplicate: boolean;
  createdVehicle: boolean;
  recoveredByLookup: boolean;
  error: string | null;
}> {
  const saveResult = await api.saveSnapshotDetailed(snapshot);

  if (saveResult.data?.vehicleId) {
    return {
      vehicleId: saveResult.data.vehicleId,
      duplicate: !!saveResult.data.duplicate,
      createdVehicle: !!saveResult.data.createdVehicle,
      recoveredByLookup: false,
      error: saveResult.error,
    };
  }

  const lookup = await api.lookup({
    reference: snapshot.reference || undefined,
    hashId: snapshot.hashId || undefined,
  }).catch(() => null);

  if (lookup?.vehicleId) {
    return {
      vehicleId: lookup.vehicleId,
      duplicate: true,
      createdVehicle: false,
      recoveredByLookup: true,
      error: saveResult.error || 'lookup_recovered_existing_vehicle',
    };
  }

  return {
    vehicleId: null,
    duplicate: false,
    createdVehicle: false,
    recoveredByLookup: false,
    error: saveResult.error || 'import_save_failed',
  };
}

function describeImportChange(
  label: string,
  url: string,
  createdVehicle: boolean,
  previous: VehicleSnapshot | null,
  next: VehicleSnapshot,
): {
  isNew: boolean;
  updated: boolean;
  unchanged: boolean;
  priceDirection: 'up' | 'down' | null;
  statusChanged: boolean;
  changeEntry: ImportChangeEntry | null;
} {
  if (!previous) {
    if (createdVehicle) {
      return {
        isNew: true,
        updated: false,
        unchanged: false,
        priceDirection: null,
        statusChanged: false,
        changeEntry: {
          label,
          kind: 'new',
          detail: 'Nouveau vehicule enregistre.',
          updates: buildNewVehicleSummary(next),
          url,
        },
      };
    }

    // If the backend matched this scrape to an existing vehicle but the UI had
    // no previous snapshot to compare, don't manufacture a fake "updated" row.
    // Only a real field diff should count as an import update.
    return {
      isNew: false,
      updated: false,
      unchanged: true,
      priceDirection: null,
      statusChanged: false,
      changeEntry: null,
    };
  }

  // Full field-by-field diff. Order matters — this is the display order in
  // the UI. Most actionable changes first (price, km, status).
  const updates = diffSnapshots(previous, next);

  const priceUpdate = updates.find((u) => u.field === 'startingPrice');
  const statusUpdate = updates.find((u) => u.field === 'status');
  const priceDirection = priceUpdate?.direction === 'up'
    ? 'up'
    : priceUpdate?.direction === 'down' ? 'down' : null;
  const statusChanged = !!statusUpdate;
  const updated = updates.length > 0;

  let changeEntry: ImportChangeEntry | null = null;
  if (updated) {
    // Pick the most salient change to drive the filter chip colour and the
    // one-line summary. Price changes dominate, then status, then "updated".
    let kind: ImportChangeEntry['kind'];
    let detail: string;
    if (priceUpdate && priceUpdate.direction !== 'neutral') {
      kind = priceUpdate.direction === 'up' ? 'price_up' : 'price_down';
      detail = `Mise a prix: ${priceUpdate.before} → ${priceUpdate.after}${priceUpdate.delta ? ` (${priceUpdate.delta})` : ''}`;
    } else if (statusUpdate) {
      kind = 'status_change';
      detail = `Statut: ${statusUpdate.before} → ${statusUpdate.after}`;
    } else {
      kind = 'updated';
      // Build a short multi-field summary (first 2 fields).
      const preview = updates.slice(0, 2).map((u) => u.label).join(', ');
      detail = `${updates.length} modification${updates.length > 1 ? 's' : ''}: ${preview}${updates.length > 2 ? `, +${updates.length - 2}` : ''}`;
    }

    changeEntry = { label, kind, detail, updates, url };
  }

  return {
    isNew: false,
    updated,
    unchanged: !updated,
    priceDirection,
    statusChanged,
    changeEntry,
  };
}

/**
 * For a newly-imported vehicle (no previous snapshot), build a short list of
 * salient fields so the UI can still say "voilà ce qui a été enregistré"
 * instead of just "Nouveau véhicule".
 */
function buildNewVehicleSummary(next: VehicleSnapshot): FieldUpdate[] {
  const items: FieldUpdate[] = [];
  const push = (field: string, label: string, value: string | null | undefined) => {
    if (value == null || value === '') return;
    items.push({ field, label, before: '—', after: value, direction: 'neutral' });
  };
  push('startingPrice', 'Mise a prix', formatMoney(next.startingPrice));
  if (next.status === 'sold') push('soldPrice', 'Prix adjuge', formatMoney(next.soldPrice));
  push('mileage', 'Kilometrage', formatKm(next.mileage));
  push('status', 'Statut', formatStatus(next.status || 'available'));
  push('city', 'Ville', next.city || null);
  if (next.saleDate) push('saleDate', 'Date de vente', formatSaleDate(next.saleDate));
  return items;
}

/**
 * Compare every user-visible field between two snapshots and return a
 * structured list of what changed, with pre-formatted before/after strings
 * ready for rendering.
 */
function diffSnapshots(previous: VehicleSnapshot, next: VehicleSnapshot): FieldUpdate[] {
  const updates: FieldUpdate[] = [];

  // ── Pricing (most important, displayed first) ──
  const priceDelta = numberDelta(previous.startingPrice, next.startingPrice);
  if (priceDelta !== null) {
    updates.push({
      field: 'startingPrice',
      label: 'Mise a prix',
      before: formatMoney(previous.startingPrice),
      after: formatMoney(next.startingPrice),
      direction: priceDelta > 0 ? 'up' : priceDelta < 0 ? 'down' : 'neutral',
      delta: priceDelta !== 0 ? `${priceDelta > 0 ? '+' : ''}${priceDelta.toLocaleString('fr-FR')} €` : undefined,
    });
  }

  const soldDelta = numberDelta(previous.soldPrice, next.soldPrice);
  if (soldDelta !== null) {
    updates.push({
      field: 'soldPrice',
      label: 'Prix adjuge',
      before: formatMoney(previous.soldPrice),
      after: formatMoney(next.soldPrice),
      direction: soldDelta > 0 ? 'up' : soldDelta < 0 ? 'down' : 'neutral',
      delta: soldDelta !== 0 ? `${soldDelta > 0 ? '+' : ''}${soldDelta.toLocaleString('fr-FR')} €` : undefined,
    });
  }

  const htDelta = numberDelta(previous.startingPriceHT, next.startingPriceHT);
  if (htDelta !== null) {
    updates.push({
      field: 'startingPriceHT',
      label: 'Mise a prix HT',
      before: formatMoney(previous.startingPriceHT),
      after: formatMoney(next.startingPriceHT),
      direction: htDelta > 0 ? 'up' : htDelta < 0 ? 'down' : 'neutral',
      delta: htDelta !== 0 ? `${htDelta > 0 ? '+' : ''}${htDelta.toLocaleString('fr-FR')} €` : undefined,
    });
  }

  const coteDelta = numberDelta(previous.marketValue, next.marketValue);
  if (coteDelta !== null) {
    updates.push({
      field: 'marketValue',
      label: 'Cote',
      before: formatMoney(previous.marketValue),
      after: formatMoney(next.marketValue),
      direction: coteDelta > 0 ? 'up' : coteDelta < 0 ? 'down' : 'neutral',
      delta: coteDelta !== 0 ? `${coteDelta > 0 ? '+' : ''}${coteDelta.toLocaleString('fr-FR')} €` : undefined,
    });
  }

  // ── Vehicle state ──
  const kmDelta = numberDelta(previous.mileage, next.mileage);
  if (kmDelta !== null && kmDelta !== 0) {
    updates.push({
      field: 'mileage',
      label: 'Kilometrage',
      before: formatKm(previous.mileage),
      after: formatKm(next.mileage),
      direction: kmDelta > 0 ? 'up' : 'down',
      delta: `${kmDelta > 0 ? '+' : ''}${kmDelta.toLocaleString('fr-FR')} km`,
    });
  }

  const prevStatus = previous.status || 'available';
  const nextStatus = next.status || 'available';
  if (prevStatus !== nextStatus) {
    updates.push({
      field: 'status',
      label: 'Statut',
      before: formatStatus(prevStatus),
      after: formatStatus(nextStatus),
      direction: 'neutral',
    });
  }

  // ── Sale metadata ──
  if ((previous.lotNumber ?? null) !== (next.lotNumber ?? null)) {
    updates.push({
      field: 'lotNumber',
      label: 'Numero de lot',
      before: previous.lotNumber != null ? `N°${previous.lotNumber}` : '—',
      after: next.lotNumber != null ? `N°${next.lotNumber}` : '—',
      direction: 'neutral',
    });
  }

  if ((previous.city || '').trim() !== (next.city || '').trim()) {
    updates.push({
      field: 'city',
      label: 'Ville',
      before: previous.city || '—',
      after: next.city || '—',
      direction: 'neutral',
    });
  }

  if ((previous.saleDate || '') !== (next.saleDate || '')) {
    updates.push({
      field: 'saleDate',
      label: 'Date de vente',
      before: formatSaleDate(previous.saleDate) || '—',
      after: formatSaleDate(next.saleDate) || '—',
      direction: 'neutral',
    });
  }

  // ── Condition ──
  if ((previous.observations || '').trim() !== (next.observations || '').trim()) {
    updates.push({
      field: 'observations',
      label: 'Observations',
      before: truncate(previous.observations) || '—',
      after: truncate(next.observations) || '—',
      direction: 'neutral',
    });
  }

  // ── Media (photo count) ──
  const prevPhotos = previous.photoUrls?.length ?? 0;
  const nextPhotos = next.photoUrls?.length ?? 0;
  const photoDelta = nextPhotos - prevPhotos;
  // VPauto frequently returns one fewer photo because of lazy-loading/CDN
  // timing. We keep the backend's archived photos, and we also avoid counting
  // exactly "-1 photo" as an import update. Larger drops still surface.
  if (photoDelta !== 0 && photoDelta !== -1) {
    updates.push({
      field: 'photoUrls',
      label: 'Photos',
      before: `${prevPhotos} photo${prevPhotos > 1 ? 's' : ''}`,
      after: `${nextPhotos} photo${nextPhotos > 1 ? 's' : ''}`,
      direction: nextPhotos > prevPhotos ? 'up' : 'down',
      delta: `${photoDelta > 0 ? '+' : ''}${photoDelta}`,
    });
  }

  return updates;
}

function numberDelta(a: number | null | undefined, b: number | null | undefined): number | null {
  const aNum = typeof a === 'number' ? a : null;
  const bNum = typeof b === 'number' ? b : null;
  if (aNum === null && bNum === null) return null;
  if (aNum === null || bNum === null) return (bNum ?? 0) - (aNum ?? 0);
  if (aNum === bNum) return null;
  return bNum - aNum;
}

function formatMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toLocaleString('fr-FR')} €`;
}

function formatKm(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toLocaleString('fr-FR')} km`;
}

function formatSaleDate(s: string | null | undefined): string {
  if (!s) return '';
  // Snapshot format is ISO `YYYY-MM-DD` — render as `DD/MM/YYYY` for FR users.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

function truncate(s: string | null | undefined, max = 60): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function dedupeImportTargets(targets: ImportTarget[]): ImportTarget[] {
  const seen = new Set<string>();
  const deduped: ImportTarget[] = [];

  for (const target of targets) {
    if (!target.url || seen.has(target.url)) continue;
    seen.add(target.url);
    deduped.push(target);
  }

  return deduped;
}

function buildImportTargetsFromList(list: Partial<VehicleSnapshot>[], limit?: number): ImportTarget[] {
  const items = limit ? list.slice(0, limit) : list;
  return dedupeImportTargets(items
    .filter((vehicle) => !!vehicle.sourceUrl)
    .map((vehicle) => ({
      url: vehicle.sourceUrl!,
      label: [vehicle.brand, vehicle.model, vehicle.city].filter(Boolean).join(' • ') || vehicle.hashId || 'Vehicule VPauto',
    })));
}

function buildPagedUrl(baseListUrl: string, page: number): string {
  const url = new URL(baseListUrl);
  if (page <= 1) {
    url.searchParams.delete('page');
  } else {
    url.searchParams.set('page', String(page));
  }
  return url.toString();
}

async function collectImportTargets(state: StoredPanelState): Promise<ImportTarget[]> {
  const detectedList = state.currentVehicleList || [];
  const listUrl = state.scrapeDebug?.pageType === 'list' ? state.scrapeDebug.url : undefined;

  if (importOptions.scope === 'detected') {
    if (!detectedList.length) {
      throw new Error('Aucun vehicule detecte dans la liste courante.');
    }
    return buildImportTargetsFromList(detectedList);
  }

  if (importOptions.scope === 'first_n') {
    if (!detectedList.length) {
      throw new Error('La liste detectee est vide. Attends la fin du scraping.');
    }
    const firstN = Math.max(1, Math.floor(importOptions.firstN || 1));
    return buildImportTargetsFromList(detectedList, firstN);
  }

  if (!listUrl) {
    throw new Error('Ouvre une page liste VPauto pour lancer un import.');
  }

  if (importOptions.scope === 'current_page') {
    const pageVehicles = await scrapeRemotePage(listUrl);
    if (!pageVehicles.length) {
      throw new Error('Impossible de lire les vehicules de la page courante.');
    }
    return buildImportTargetsFromList(pageVehicles);
  }

  const fromPage = Math.max(1, Math.floor(importOptions.fromPage || 1));
  const toPage = Math.max(fromPage, Math.floor(importOptions.toPage || fromPage));
  const targets: ImportTarget[] = [];

  for (let page = fromPage; page <= toPage; page += 1) {
    const pageUrl = buildPagedUrl(listUrl, page);
    const pageVehicles = await scrapeRemotePage(pageUrl);
    targets.push(...buildImportTargetsFromList(pageVehicles));
  }

  if (!targets.length) {
    throw new Error('Aucun vehicule trouve sur la plage de pages demandee.');
  }

  return dedupeImportTargets(targets);
}

function patchImportJob(patch: Partial<ImportJobState>): void {
  if (!importJob) return;
  importJob = {
    ...importJob,
    ...patch,
  };
  scheduleRefresh(0);
}

function getCapturePlanSince(state: StoredPanelState): string {
  // `since` defines the line between "new" (first seen during the running
  // import) and "missing" (first seen before). Prefer the manual import start
  // time when available: `batchTrackingResult` can be cleared when the list
  // page reloads, while the import summary remains in the open side panel.
  return (importJob?.status === 'done' ? importJob.startedAt : undefined)
    || state.batchTrackingResult?.timestamp
    || new Date(Date.now() - 24 * 3600_000).toISOString();
}

async function computeCapturePlanCounts(state: StoredPanelState): Promise<CapturePlanCounts | null> {
  const hashIds = (state.currentVehicleList || [])
    .map((vehicle) => vehicle.hashId)
    .filter(Boolean) as string[];

  if (hashIds.length === 0) return null;

  const plan = await api.getCapturePlan(hashIds, getCapturePlanSince(state)).catch(() => null);
  if (!plan) {
    return {
      new: 0,
      modified: 0,
      missing: 0,
      skipped: 0,
      computedAt: new Date().toISOString(),
      error: 'Plan de capture indisponible.',
    };
  }

  return {
    new: plan.new.length,
    modified: plan.modified.length,
    missing: plan.missing.length,
    skipped: plan.skipped,
    computedAt: new Date().toISOString(),
  };
}

function buildImportDoneMessage(job: ImportJobState, counts?: CapturePlanCounts | null): string {
  const base = `Import termine. ${job.updated || 0} fiches mises a jour, ${job.newVehicles || 0} nouvelles.`;
  if (!counts || counts.error) return base;
  return `${base} ${counts.modified} capture${counts.modified > 1 ? 's' : ''} modifiee${counts.modified > 1 ? 's' : ''} a faire.`;
}

function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getVisibleImportChanges(): {
  pageItems: ImportChangeEntry[];
  totalMatches: number;
  totalPages: number;
  currentPage: number;
} {
  const allChanges = importJob?.changes || [];
  const query = normalizeSearchValue(importChangeQuery);

  const filtered = allChanges.filter((change) => {
    if (importChangeFilter !== 'all' && change.kind !== importChangeFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = normalizeSearchValue(`${change.label} ${change.detail} ${change.url}`);
    return haystack.includes(query);
  });

  const totalMatches = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalMatches / IMPORT_CHANGE_PAGE_SIZE));
  const currentPage = Math.min(importChangePage, totalPages);
  const startIndex = (currentPage - 1) * IMPORT_CHANGE_PAGE_SIZE;

  return {
    pageItems: filtered.slice(startIndex, startIndex + IMPORT_CHANGE_PAGE_SIZE),
    totalMatches,
    totalPages,
    currentPage,
  };
}

function cancelImportJob(): void {
  if (!importJob || importJob.status !== 'running') return;
  importJob.abortRequested = true;
  importJob.lastMessage = 'Arret demande...';
  scheduleRefresh(0);
}

async function importVehicleSilently(target: ImportTarget): Promise<{
  ok: boolean;
  duplicate: boolean;
  error: string | null;
  isNew: boolean;
  updated: boolean;
  unchanged: boolean;
  priceDirection: 'up' | 'down' | null;
  statusChanged: boolean;
  changeEntry: ImportChangeEntry | null;
}> {
  let previousSnapshot: VehicleSnapshot | null = null;

  const res = await fetchWithTimeout(target.url, { credentials: 'include' });
  if (!res.ok) {
    return {
      ok: false,
      duplicate: false,
      error: `HTTP ${res.status}`,
      isNew: false,
      updated: false,
      unchanged: false,
      priceDirection: null,
      statusChanged: false,
      changeEntry: null,
    };
  }

  const html = await res.text();
  const snapshot = scrapeVehicleDetailFromHtml(html, target.url);
  if (!snapshot || !snapshot.brand) {
    return {
      ok: false,
      duplicate: false,
      error: 'detail_scrape_failed',
      isNew: false,
      updated: false,
      unchanged: false,
      priceDirection: null,
      statusChanged: false,
      changeEntry: null,
    };
  }

  const lookupBeforeSave = await api.lookup({
    reference: snapshot.reference || undefined,
    hashId: snapshot.hashId || undefined,
  }).catch(() => null);
  previousSnapshot = lookupBeforeSave?.lastSnapshot || null;

  const persisted = await persistImportedSnapshot(snapshot);
  const change = describeImportChange(target.label, target.url, persisted.createdVehicle, previousSnapshot, snapshot);

  return {
    ok: !!persisted.vehicleId,
    duplicate: persisted.duplicate || persisted.recoveredByLookup,
    error: persisted.error,
    isNew: persisted.createdVehicle,
    updated: change.updated,
    unchanged: change.unchanged,
    priceDirection: change.priceDirection,
    statusChanged: change.statusChanged,
    changeEntry: change.changeEntry,
  };
}

async function runSilentImport(state: StoredPanelState): Promise<void> {
  if (!hasAccess('vehicles:import')) {
    importJob = {
      status: 'error',
      scope: importOptions.scope,
      mode: importOptions.mode,
      total: 0,
      processed: 0,
      saved: 0,
      duplicates: 0,
      failed: 0,
      newVehicles: 0,
      updated: 0,
      unchanged: 0,
      priceUps: 0,
      priceDowns: 0,
      statusChanges: 0,
      currentLabel: undefined,
      lastMessage: 'Import reserve au role admin.',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      errors: [`Role actif: ${activeAccess.role}`],
      changes: [],
    };
    scheduleRefresh(0);
    return;
  }

  if (importJob && (importJob.status === 'preparing' || importJob.status === 'running')) {
    return;
  }

  if (importOptions.mode !== 'silent') {
    importJob = {
      status: 'error',
      scope: importOptions.scope,
      mode: importOptions.mode,
      total: 0,
      processed: 0,
      saved: 0,
      duplicates: 0,
      failed: 0,
      newVehicles: 0,
      updated: 0,
      unchanged: 0,
      priceUps: 0,
      priceDowns: 0,
      statusChanges: 0,
      errors: ['Le mode avec onglets sera ajoute apres le flux silencieux.'],
      changes: [],
      lastMessage: 'Mode avec onglets non active pour le moment.',
      finishedAt: new Date().toISOString(),
    };
    scheduleRefresh(0);
    return;
  }

  importJob = {
    status: 'preparing',
    scope: importOptions.scope,
    mode: importOptions.mode,
    total: 0,
    processed: 0,
    saved: 0,
    duplicates: 0,
    failed: 0,
    newVehicles: 0,
    updated: 0,
    unchanged: 0,
    priceUps: 0,
    priceDowns: 0,
    statusChanges: 0,
    errors: [],
    changes: [],
    lastMessage: 'Preparation de la file d\'import...',
    startedAt: new Date().toISOString(),
  };
  importChangePage = 1;
  scheduleRefresh(0);

  try {
    const targets = await collectImportTargets(state);
    patchImportJob({
      status: 'running',
      total: targets.length,
      lastMessage: 'Import silencieux en cours...',
    });

    for (let index = 0; index < targets.length; index += 1) {
      if (!importJob || importJob.abortRequested) {
        importJob = {
          ...(importJob as ImportJobState),
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          lastMessage: 'Import interrompu.',
        };
        scheduleRefresh(0);
        return;
      }

      const target = targets[index];
      patchImportJob({
        currentLabel: target.label,
        lastMessage: `Traitement ${index + 1}/${targets.length}`,
      });

      try {
        const result = await importVehicleSilently(target);
        patchImportJob({
          processed: index + 1,
          saved: (importJob?.saved || 0) + (result.ok ? 1 : 0),
          duplicates: (importJob?.duplicates || 0) + (result.duplicate ? 1 : 0),
          failed: (importJob?.failed || 0) + (result.ok ? 0 : 1),
          newVehicles: (importJob?.newVehicles || 0) + (result.isNew ? 1 : 0),
          updated: (importJob?.updated || 0) + (result.updated ? 1 : 0),
          unchanged: (importJob?.unchanged || 0) + (result.unchanged ? 1 : 0),
          priceUps: (importJob?.priceUps || 0) + (result.priceDirection === 'up' ? 1 : 0),
          priceDowns: (importJob?.priceDowns || 0) + (result.priceDirection === 'down' ? 1 : 0),
          statusChanges: (importJob?.statusChanges || 0) + (result.statusChanged ? 1 : 0),
          errors: result.ok
            ? (importJob?.errors || [])
            : [...(importJob?.errors || []), `${target.label}: ${result.error || 'erreur inconnue'}`].slice(-5),
          changes: result.changeEntry
            ? [result.changeEntry, ...(importJob?.changes || [])]
            : (importJob?.changes || []),
        });
      } catch (error) {
        patchImportJob({
          processed: index + 1,
          failed: (importJob?.failed || 0) + 1,
          errors: [...(importJob?.errors || []), `${target.label}: ${error instanceof Error ? error.message : String(error)}`].slice(-5),
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    importJob = {
      ...(importJob as ImportJobState),
      status: 'done',
      finishedAt: new Date().toISOString(),
      currentLabel: undefined,
    };
    importJob.lastMessage = buildImportDoneMessage(importJob);

    // Persist a BatchTrackingResult so downstream surfaces (notably the capture
    // bar, which gates on `state.batchTrackingResult` to avoid showing up before
    // an import has run) treat the manual import as equivalent to the silent
    // auto-import. Without this, "LANCER L'IMPORT" finishes successfully but
    // the capture bar stays hidden because `tracking` is only ever written by
    // the background's RUN_BATCH_SAVE flow.
    const trackingFromManualImport: BatchTrackingResult = {
      saved: importJob?.saved || 0,
      newVehicles: importJob?.newVehicles || 0,
      priceChanges: [],
      disappeared: [],
      timestamp: new Date().toISOString(),
    };
    void browser.storage.local.set({ batchTrackingResult: trackingFromManualImport }).catch(() => {});

    const capturePlanCounts = await computeCapturePlanCounts(state);
    if (importJob && capturePlanCounts) {
      importJob = {
        ...importJob,
        capturePlanCounts,
        lastMessage: buildImportDoneMessage(importJob, capturePlanCounts),
      };
    }

    scheduleRefresh(0);
  } catch (error) {
    importJob = {
      ...(importJob as ImportJobState),
      status: 'error',
      finishedAt: new Date().toISOString(),
      currentLabel: undefined,
      lastMessage: 'Import impossible.',
      errors: [error instanceof Error ? error.message : String(error)],
    };
    scheduleRefresh(0);
  }
}

// ── Capture orchestrator ──────────────────────────────────────────────
// Drives a separate popup window through a list of vehicles, screenshotting
// each one and uploading the JPEG to the backend. Runs entirely in the side
// panel because:
//   1. chrome.windows.create / chrome.tabs.update need an extension page
//   2. the user needs visible progress + pause/cancel without giving up
//      their main browser window
//   3. captureVisibleTab + the upload fetch live here too — under MV3 the
//      background service worker can be killed at any moment, so any state
//      we held there mid-iteration would be lost. The side panel has a
//      stable lifetime while it's open and gives us a non-flaky owner.

function patchCaptureJob(patch: Partial<CaptureJobState>): void {
  if (!captureJob) return;
  captureJob = { ...captureJob, ...patch };
  scheduleRefresh(0);
}

function captureBucketLabel(bucket: CaptureBucket): string {
  return bucket === 'new' ? 'nouveaux' : bucket === 'modified' ? 'modifies' : 'manquants';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId: number, timeoutMs = CAPTURE_TAB_LOAD_TIMEOUT_MS): Promise<void> {
  // Poll instead of using onUpdated so the same logic works for both the
  // initial popup load and subsequent chrome.tabs.update navigations.
  //
  // Importantly, we RESOLVE on timeout instead of rejecting. VPauto detail
  // pages routinely keep `tab.status === 'loading'` for >20 s (background
  // analytics, lazy iframes, persistent sockets) even though the visible
  // content rendered seconds earlier. The CAPTURE_RENDER_SETTLE_MS delay
  // applied right after this call is the real "ready to capture" guard;
  // here we just want to avoid capturing a brand-new about:blank tab.
  return new Promise((resolve) => {
    const start = Date.now();
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      chrome.tabs.get(tabId).then((tab) => {
        if (cancelled) return;
        if (tab.status === 'complete') {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          // Page is still "loading" after the budget — proceed anyway, the
          // settle delay will give the visible content time to render.
          resolve();
          return;
        }
        setTimeout(check, 250);
      }).catch(() => {
        // Tab disappeared (window closed, navigation crashed). Resolve so the
        // outer try/catch around the capture call can surface the real error
        // when sendOrchestratedCaptureMessage runs.
        cancelled = true;
        resolve();
      });
    };
    check();
  });
}

/**
 * Take a screenshot of the popup tab and upload it to the backend.
 *
 * Originally this round-tripped through the background service worker
 * (`ORCHESTRATED_CAPTURE` message), which is the textbook way to centralize
 * privileged API calls. In practice that flow was unreliable: under Manifest
 * V3 the SW can be torn down at any moment (idle timeout, memory pressure)
 * and when it dies mid-`captureVisibleTab`, the side panel's `sendMessage`
 * callback is never invoked — the orchestrator stalls 30 s on every vehicle
 * even when individual operations (`windows.update`, `captureVisibleTab`,
 * the upload `fetch`) had their own internal timeouts. The SW lifecycle
 * itself is what we couldn't bound.
 *
 * The side panel is a regular extension page with full `chrome.tabs` access
 * and a stable lifetime (alive while it's open), so doing the capture and
 * upload directly here removes the SW middleman entirely.
 */
async function captureAndUploadFromPanel(payload: {
  tabId: number;
  windowId: number;
  snapshotId: number;
}): Promise<{ data?: { snapshotId: number; bytes: number }; error?: string }> {
  // Sanity: confirm the popup tab is still on a vpauto.fr page before we
  // capture, so a navigation gone wrong doesn't get us uploading e.g. the
  // user's bank tab if windowId pointed somewhere unexpected.
  let resolvedWindowId = payload.windowId;
  try {
    const tab = await chrome.tabs.get(payload.tabId);
    const url = tab.url || '';
    if (!/^https:\/\/(www\.)?vpauto\.fr\//.test(url)) {
      return { error: `tab_not_on_vpauto:${url}` };
    }
    if (resolvedWindowId == null) resolvedWindowId = tab.windowId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // Bring the popup forward so macOS actually paints it before the capture.
  // 2 s timeout because windows.update has been observed to hang on macOS.
  try {
    await Promise.race([
      chrome.windows.update(resolvedWindowId!, { state: 'normal', focused: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('windows.update timeout')), 2000)),
    ]);
  } catch (err) {
    console.warn('[VPauto SP] windows.update before capture failed:', err);
  }

  let dataUrl: string;
  try {
    dataUrl = await Promise.race<string>([
      chrome.tabs.captureVisibleTab(resolvedWindowId!, { format: 'jpeg', quality: 75 }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('captureVisibleTab timeout')), 8000)),
    ]);
  } catch (err) {
    return { error: `captureVisibleTab: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { error: 'capture_returned_invalid_payload' };
  }

  // POST the JPEG straight to the backend. The side panel is a chrome-extension
  // page so it can talk to http://localhost without mixed-content blocks, and
  // we explicitly set a 15 s timeout so a hung backend bubbles up as an error
  // and the loop advances instead of stalling.
  const controller = new AbortController();
  const uploadTimer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/vehicles/screenshot/${payload.snapshotId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...await getAccessHeaders() },
      body: JSON.stringify({ image: dataUrl }),
      signal: controller.signal,
    });
    window.clearTimeout(uploadTimer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json() as { success?: boolean; data?: { snapshotId: number; bytes: number }; error?: string };
    if (!json.success || !json.data) {
      return { error: json.error || 'screenshot_upload_failed' };
    }
    return { data: json.data };
  } catch (err) {
    window.clearTimeout(uploadTimer);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function planAndStartCapture(state: StoredPanelState, bucket: CaptureBucket): Promise<void> {
  if (!hasAccess('captures:run')) {
    captureJob = {
      status: 'error',
      bucket,
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [`Role actif: ${activeAccess.role}`],
      currentLabel: undefined,
      lastMessage: 'Capture reservee au role admin.',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      candidates: [],
      cursorIndex: 0,
      abortRequested: false,
      pauseRequested: false,
    };
    scheduleRefresh(0);
    return;
  }

  if (captureJob && (captureJob.status === 'planning' || captureJob.status === 'running')) {
    return;
  }

  const list = state.currentVehicleList || [];
  const hashIds = list.map((v) => v.hashId).filter(Boolean) as string[];

  captureJob = {
    status: 'planning',
    bucket,
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    candidates: [],
    cursorIndex: 0,
    startedAt: new Date().toISOString(),
    lastMessage: 'Calcul du plan de capture...',
  };
  scheduleRefresh(0);

  if (hashIds.length === 0) {
    captureJob = {
      ...captureJob,
      status: 'error',
      errors: ['Aucun vehicule dans la liste actuelle.'],
      finishedAt: new Date().toISOString(),
      lastMessage: 'Liste VPauto vide.',
    };
    scheduleRefresh(0);
    return;
  }

  // `since` defines the line between "new" (first seen during the running
  // import) and "missing" (first seen before). Prefer the manual import start
  // time when available: `batchTrackingResult` can be cleared when the list
  // page reloads, while the import summary remains in the open side panel.
  const since = (importJob?.status === 'done' ? importJob.startedAt : undefined)
    || state.batchTrackingResult?.timestamp
    || new Date(Date.now() - 24 * 3600_000).toISOString();

  const plan = await api.getCapturePlan(hashIds, since).catch(() => null);
  if (!plan) {
    captureJob = {
      ...captureJob,
      status: 'error',
      errors: ['Impossible de calculer le plan de capture (backend hors ligne ?)'],
      finishedAt: new Date().toISOString(),
      lastMessage: 'Plan de capture indisponible.',
    };
    scheduleRefresh(0);
    return;
  }

  const freshCounts: CapturePlanCounts = {
    new: plan.new.length,
    modified: plan.modified.length,
    missing: plan.missing.length,
    skipped: plan.skipped,
    computedAt: new Date().toISOString(),
  };
  if (importJob?.status === 'done') {
    patchImportJob({
      capturePlanCounts: freshCounts,
      lastMessage: buildImportDoneMessage(importJob, freshCounts),
    });
  }

  const candidates = plan[bucket] || [];
  captureJob = {
    ...captureJob,
    total: candidates.length,
    candidates,
    lastMessage: candidates.length
      ? `${candidates.length} vehicule${candidates.length > 1 ? 's' : ''} a capturer.`
      : `Aucun vehicule a capturer dans la categorie "${captureBucketLabel(bucket)}".`,
  };
  scheduleRefresh(0);

  if (candidates.length === 0) {
    captureJob = {
      ...captureJob,
      status: 'done',
      finishedAt: new Date().toISOString(),
    };
    scheduleRefresh(0);
    return;
  }

  // Open a fresh popup window — the orchestrator drives it via tabs.update.
  // We open the popup focused on purpose: macOS does not paint background
  // popup windows reliably, which causes `chrome.tabs.captureVisibleTab` to
  // hang or return a transparent frame. The popup keeps focus for the
  // duration of the run and the loop closes the window when it's done, so
  // the user gets focus back automatically.
  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.create({
      url: candidates[0].sourceUrl,
      type: 'popup',
      width: 1280,
      height: 900,
      focused: true,
    });
  } catch (err) {
    captureJob = {
      ...captureJob,
      status: 'error',
      errors: [err instanceof Error ? err.message : String(err)],
      finishedAt: new Date().toISOString(),
      lastMessage: 'Echec ouverture fenetre.',
    };
    scheduleRefresh(0);
    return;
  }

  const tabId = win.tabs?.[0]?.id;
  if (!win.id || !tabId) {
    captureJob = {
      ...captureJob,
      status: 'error',
      errors: ['Fenetre popup sans onglet exploitable.'],
      finishedAt: new Date().toISOString(),
      lastMessage: 'Echec ouverture fenetre.',
    };
    scheduleRefresh(0);
    return;
  }

  captureJob = {
    ...captureJob,
    status: 'running',
    windowId: win.id,
    tabId,
    lastMessage: `Capture 1/${candidates.length}...`,
  };
  scheduleRefresh(0);

  await runCaptureLoop();
}

async function runCaptureLoop(): Promise<void> {
  while (captureJob && captureJob.status === 'running') {
    if (captureJob.abortRequested) {
      const windowId = captureJob.windowId;
      captureJob = {
        ...captureJob,
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        lastMessage: 'Capture interrompue.',
      };
      if (windowId != null) {
        try { await chrome.windows.remove(windowId); } catch {}
      }
      scheduleRefresh(0);
      return;
    }

    if (captureJob.pauseRequested) {
      captureJob = {
        ...captureJob,
        status: 'paused',
        pauseRequested: false,
        lastMessage: 'En pause.',
      };
      scheduleRefresh(0);
      return;
    }

    if (captureJob.cursorIndex >= captureJob.candidates.length) {
      const windowId = captureJob.windowId;
      captureJob = {
        ...captureJob,
        status: 'done',
        finishedAt: new Date().toISOString(),
        lastMessage: `Termine. ${captureJob.succeeded}/${captureJob.total} captures.`,
      };
      if (windowId != null) {
        try { await chrome.windows.remove(windowId); } catch {}
      }
      scheduleRefresh(0);
      return;
    }

    const candidate = captureJob.candidates[captureJob.cursorIndex];
    const tabId = captureJob.tabId;
    const windowId = captureJob.windowId;
    if (tabId == null || windowId == null) {
      captureJob = {
        ...captureJob,
        status: 'error',
        errors: [...captureJob.errors, 'Onglet de capture introuvable.'].slice(-5),
        finishedAt: new Date().toISOString(),
        lastMessage: 'Onglet de capture perdu.',
      };
      scheduleRefresh(0);
      return;
    }

    patchCaptureJob({
      currentLabel: `${candidate.brand} ${candidate.model} ${candidate.version}`.trim()
        + (candidate.city ? ` · ${candidate.city}` : ''),
      lastMessage: `Capture ${captureJob.cursorIndex + 1}/${captureJob.total}`,
    });

    try {
      // First iteration: the popup already opened on candidate[0].sourceUrl,
      // so we skip the navigation round-trip. From the second on, we drive
      // the same tab through chrome.tabs.update.
      if (captureJob.cursorIndex > 0) {
        await chrome.tabs.update(tabId, { url: candidate.sourceUrl });
      }
      await waitForTabComplete(tabId);
      // Brief settle to let VPauto render images / fonts before the snapshot.
      await sleep(CAPTURE_RENDER_SETTLE_MS);

      // Re-check abort after the settle window — the user may have cancelled
      // while we were waiting on a slow page load.
      if (!captureJob || (captureJob as CaptureJobState).abortRequested) continue;

      console.log(`[VPauto SP] Capture ${captureJob.cursorIndex + 1}/${captureJob.total} → snapshot ${candidate.snapshotId} (${candidate.brand} ${candidate.model})`);
      const result = await captureAndUploadFromPanel({
        tabId,
        windowId,
        snapshotId: candidate.snapshotId,
      });
      if (result.error) throw new Error(result.error);

      console.log(`[VPauto SP] Capture ${captureJob.cursorIndex + 1}/${captureJob.total} ok (${result.data?.bytes ?? '?'} bytes)`);
      if (!captureJob) return;
      captureJob = {
        ...captureJob,
        processed: captureJob.processed + 1,
        succeeded: captureJob.succeeded + 1,
        cursorIndex: captureJob.cursorIndex + 1,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[VPauto SP] Capture ${captureJob?.cursorIndex ?? '?'} failed for snapshot ${candidate.snapshotId} (${candidate.brand} ${candidate.model}): ${reason}`);
      if (!captureJob) return;
      captureJob = {
        ...captureJob,
        processed: captureJob.processed + 1,
        failed: captureJob.failed + 1,
        cursorIndex: captureJob.cursorIndex + 1,
        errors: [...captureJob.errors, `${candidate.brand} ${candidate.model}: ${reason}`].slice(-5),
      };
    }
    scheduleRefresh(0);
  }
}

async function resumeCaptureJob(): Promise<void> {
  if (!captureJob || captureJob.status !== 'paused') return;
  captureJob = {
    ...captureJob,
    status: 'running',
    pauseRequested: false,
    lastMessage: `Capture ${captureJob.cursorIndex + 1}/${captureJob.total}`,
  };
  scheduleRefresh(0);
  await runCaptureLoop();
}

function pauseCaptureJob(): void {
  if (!captureJob || captureJob.status !== 'running') return;
  captureJob.pauseRequested = true;
  captureJob.lastMessage = 'Pause demandee...';
  scheduleRefresh(0);
}

function cancelCaptureJob(): void {
  if (!captureJob) return;
  if (captureJob.status === 'paused') {
    // Loop is parked — flip to cancelled directly and close the window.
    const windowId = captureJob.windowId;
    captureJob = {
      ...captureJob,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      lastMessage: 'Capture interrompue.',
    };
    if (windowId != null) {
      void chrome.windows.remove(windowId).catch(() => {});
    }
    scheduleRefresh(0);
    return;
  }
  if (captureJob.status === 'running' || captureJob.status === 'planning') {
    captureJob.abortRequested = true;
    captureJob.lastMessage = 'Arret demande...';
    scheduleRefresh(0);
  }
}

function dismissCaptureJob(): void {
  if (!captureJob) return;
  if (captureJob.status === 'running' || captureJob.status === 'planning' || captureJob.status === 'paused') {
    return;
  }
  captureJob = null;
  scheduleRefresh(0);
}

async function refreshPanel(): Promise<void> {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }
  isRefreshing = true;

  if (!hasRenderedOnce) {
    root.innerHTML = renderLoading();
  }

  try {
    const [storage, health, access, authSession] = await Promise.all([
      browser.storage.local.get(['currentVehicle', 'currentVehicleList', 'scrapeDebug', 'batchTrackingResult', 'backgroundDebug', 'vehicleVisits', 'vpauto404Hashes']),
      api.healthCheck(),
      getExtensionAccess(),
      getAuthSession(),
    ]);

    activeAccess = access;
    activeAuthSession = authSession;
    if (!hasAccess('debug:view') && showDebug) {
      showDebug = false;
    }

    const state = storage as StoredPanelState;
    const isApiOnline = health !== null;
    const effectiveBackgroundDebug = state.backgroundDebug;

    void api.pingBackground().catch(() => null);

    if (state.currentVehicle?.snapshot) {
      let currentVehicle = state.currentVehicle;
      let effectiveScrapeDebug = state.scrapeDebug;
      if (isApiOnline && !currentVehicle.vehicleId) {
        const synced = await syncCurrentVehicleFromPanel(currentVehicle, state.scrapeDebug);
        currentVehicle = synced.currentVehicle;
        effectiveScrapeDebug = synced.scrapeDebug;
      }

      const snapshot = currentVehicle.snapshot;
      let history: VehicleHistory | null = null;
      let badges: VehicleBadge[] | null = null;
      let crossAuction: CrossAuctionData | null = null;
      let similarAvailable: MatchResult[] | null = null;
      let similarSold: SimilarSoldData | null = null;
      let captureTimeline: CaptureTimelineEntry[] | null = null;

      if (!currentVehicle.vehicleId && (snapshot.reference || snapshot.hashId)) {
        const lookup = await api.lookup({
          reference: snapshot.reference || undefined,
          hashId: snapshot.hashId || undefined,
        });

        if (lookup?.vehicleId) {
          currentVehicle = {
            ...currentVehicle,
            vehicleId: lookup.vehicleId,
          };
          void browser.storage.local.set({ currentVehicle }).catch(() => {});
          effectiveScrapeDebug = {
            ...effectiveScrapeDebug,
            stage: 'detail_lookup_recovered',
            pageType: 'detail',
            url: snapshot.sourceUrl,
            hashId: snapshot.hashId,
            brand: snapshot.brand,
            model: snapshot.model,
            backendVehicleId: lookup.vehicleId,
            reason: effectiveScrapeDebug?.reason || 'lookup_recovered_existing_vehicle',
            timestamp: new Date().toISOString(),
          };
        }
      }

      if (currentVehicle.vehicleId) {
        const currentStage = effectiveScrapeDebug?.stage;
        const failedStage = currentStage === 'detail_save_failed' || currentStage === 'detail_scraped';

        effectiveScrapeDebug = {
          ...effectiveScrapeDebug,
          stage: failedStage ? 'detail_saved' : (effectiveScrapeDebug?.stage || 'detail_saved'),
          pageType: 'detail',
          url: snapshot.sourceUrl,
          hashId: snapshot.hashId,
          brand: snapshot.brand,
          model: snapshot.model,
          backendVehicleId: currentVehicle.vehicleId,
          backendSnapshotId: currentVehicle.snapshotId ?? effectiveScrapeDebug?.backendSnapshotId ?? null,
          reason: failedStage ? null : (effectiveScrapeDebug?.reason ?? null),
          timestamp: effectiveScrapeDebug?.timestamp || new Date().toISOString(),
        };
      }

      const promises: Promise<void>[] = [];

      if (currentVehicle.vehicleId) {
        promises.push(
          Promise.all([
            api.getHistory(currentVehicle.vehicleId),
            api.getBadges(currentVehicle.vehicleId),
          ]).then(([h, b]) => { history = h; badges = b; })
        );
        promises.push(
          api.getCaptures(currentVehicle.vehicleId)
            .then((d) => { captureTimeline = d?.captures ?? null; })
            .catch(() => { captureTimeline = null; }),
        );
      }

      if (snapshot.hashId) {
        promises.push(
          api.getCrossAuction(snapshot.hashId).then(d => { crossAuction = d; })
        );
      }

      if (snapshot.brand) {
        promises.push(
          api.findSimilar(snapshot, currentVehicle.vehicleId)
            .then(d => { similarAvailable = d; })
        );
        promises.push(
          api.getSimilarSold(snapshot.brand, snapshot.model, snapshot.year, snapshot.mileage, snapshot.hashId)
            .then(d => { similarSold = d; })
        );
      }

      await Promise.all(promises);

      root.innerHTML = renderVehicleState({
        currentVehicle,
        currentVehicleList: state.currentVehicleList,
        batchTracking: state.batchTrackingResult,
        scrapeDebug: effectiveScrapeDebug,
        vehicleVisits: state.vehicleVisits,
        vpauto404Hashes: state.vpauto404Hashes,
        backgroundDebug: effectiveBackgroundDebug,
        history,
        badges,
        crossAuction,
        similarAvailable,
        similarSold,
        captureTimeline,
        isApiOnline,
      });

      // Kick off the silent VPauto-URL prober AFTER the render so the user
      // sees the cached state immediately. The prober writes any newly-
      // discovered 404 hashIds to chrome.storage.local and triggers a
      // re-render so chips + thumbnails appear progressively. Fire-and-
      // forget — never blocks the panel.
      const passagesForProbe = (crossAuction as CrossAuctionData | null)?.passages ?? [];
      if (passagesForProbe.length > 0) {
        void probeCrossAuctionPassages(
          passagesForProbe,
          state.vpauto404Hashes || {},
          snapshot.hashId || null,
        );
      }
    } else {
      root.innerHTML = renderListState({
        ...state,
        backgroundDebug: effectiveBackgroundDebug,
      }, isApiOnline);
    }

    bindActions(state);
    hasRenderedOnce = true;
  } catch (error) {
    root.innerHTML = renderError(error instanceof Error ? error.message : String(error));
    hasRenderedOnce = true;
  } finally {
    isRefreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      setTimeout(() => void refreshPanel(), 0);
    }
  }
}

let tweaksOutsideClickBound = false;

/**
 * Wire the floating Tweaks panel: toggle open/close, accent swatch picker,
 * density (cozy/compact), and paper (warm/cool/pure). All state is expressed
 * as CSS custom props / data-attrs on the document root so the styles pick
 * the changes up automatically, and user preferences survive re-renders by
 * being persisted through `browser.storage.local` under the `ui` key.
 */
function bindTweaksPanel(): void {
  const panel = document.getElementById('tweaks');
  const toggleBtn = document.querySelector<HTMLButtonElement>('[data-action="toggle-tweaks"]');
  toggleBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!panel) return;
    const willOpen = !panel.classList.contains('on');
    panel.classList.toggle('on', willOpen);
    toggleBtn.classList.toggle('active', willOpen);
  });

  // Outside click: closed via a single document-level listener installed once,
  // not once per render (otherwise we'd pile up handlers on every refresh).
  if (!tweaksOutsideClickBound) {
    document.addEventListener('click', (event) => {
      const panelEl = document.getElementById('tweaks');
      if (!panelEl || !panelEl.classList.contains('on')) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (panelEl.contains(target)) return;
      const currentToggle = document.querySelector<HTMLButtonElement>('[data-action="toggle-tweaks"]');
      if (currentToggle && currentToggle.contains(target)) return;
      panelEl.classList.remove('on');
      currentToggle?.classList.remove('active');
    });
    tweaksOutsideClickBound = true;
  }

  const currentAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  document.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((btn) => {
    // Mirror the saved accent onto the swatch ring.
    if (btn.dataset.accent && currentAccent && btn.dataset.accent.toLowerCase() === currentAccent.toLowerCase()) {
      document.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
    }
    btn.addEventListener('click', () => {
      const color = btn.dataset.accent;
      if (!color) return;
      document.documentElement.style.setProperty('--accent', color);
      document.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      persistUiPref({ accent: color });
    });
  });

  const densitySel = document.querySelector<HTMLSelectElement>('[data-tweak="density"]');
  if (densitySel) {
    densitySel.value = document.documentElement.dataset.density || 'cozy';
    densitySel.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      document.documentElement.dataset.density = value;
      persistUiPref({ density: value });
    });
  }

  const paperSel = document.querySelector<HTMLSelectElement>('[data-tweak="paper"]');
  if (paperSel) {
    paperSel.value = document.documentElement.dataset.paper || 'warm';
    paperSel.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      document.documentElement.dataset.paper = value;
      persistUiPref({ paper: value });
    });
  }
}

/**
 * Re-arm the T−HH:MM:SS countdown ticker. Called once per render; the
 * previous interval is cleared so only one timer ever runs. The DOM hook is
 * a single `[data-countdown]` element whose sibling `.ticker` element carries
 * the sale date/time data-attributes.
 */
function startTickerCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const tickerEl = document.querySelector<HTMLElement>('.ticker');
  const valueEl = tickerEl?.querySelector<HTMLElement>('[data-countdown]');
  if (!tickerEl || !valueEl) return;
  // Honour the terminal / live status stamped by renderTicker. If the ticker
  // reports a terminal state (sold/unsold/removed), do not tick — the SSR
  // label ("ADJUGÉ", "NON ADJUGÉ", "RETIRÉ") must stay put. Without this
  // guard, the sold→'EN COURS' fallback below would overwrite "ADJUGÉ" one
  // second later (Toyota Yaris Cross 11403878 regression).
  const status = tickerEl.dataset.status;
  if (status === 'sold' || status === 'unsold' || status === 'removed' || status === 'auction_live') {
    return;
  }
  const saleDate = tickerEl.dataset.saleDate;
  if (!saleDate) return;
  const rawTime = tickerEl.dataset.saleTime || '';
  const timePart = /^\d{1,2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : '10:00';
  const target = new Date(`${saleDate}T${timePart}:00`);
  if (Number.isNaN(target.getTime())) return;

  const tick = (): void => {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      valueEl.textContent = 'EN COURS';
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      return;
    }
    const totalSeconds = Math.floor(diff / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    valueEl.textContent = `${h}:${m}:${s}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

/**
 * Persist a partial UI preference patch under `storage.local.ui`. Reads the
 * existing blob, merges, and writes back — non-critical so failures are
 * swallowed silently to avoid console noise on every tweak.
 */
function persistUiPref(patch: Record<string, string>): void {
  void (async () => {
    try {
      const current = await browser.storage.local.get('ui');
      const ui = (current?.ui as Record<string, string>) || {};
      await browser.storage.local.set({ ui: { ...ui, ...patch } });
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Apply the saved UI preferences (accent / density / paper) to the document
 * root as early as possible. Runs once at module init so the first paint
 * already reflects the user's choices rather than flashing the defaults.
 */
function applySavedUiPrefs(): void {
  void (async () => {
    try {
      const stored = await browser.storage.local.get('ui');
      const ui = (stored?.ui as Record<string, string>) || {};
      if (ui.accent) document.documentElement.style.setProperty('--accent', ui.accent);
      if (ui.density) document.documentElement.dataset.density = ui.density;
      if (ui.paper) document.documentElement.dataset.paper = ui.paper;
    } catch {
      /* ignore */
    }
  })();
}

applySavedUiPrefs();

async function handleAuthLogin(form: HTMLFormElement): Promise<void> {
  const email = form.querySelector<HTMLInputElement>('[data-auth-email]')?.value.trim() || '';
  const password = form.querySelector<HTMLInputElement>('[data-auth-password]')?.value || '';
  if (!email || !password) {
    authFeedback = { tone: 'error', text: 'Email et mot de passe requis.' };
    scheduleRefresh(0);
    return;
  }

  authFeedback = null;
  const result = await api.login(email, password);
  if (!result.data) {
    authFeedback = { tone: 'error', text: 'Connexion refusee.' };
    scheduleRefresh(0);
    return;
  }

  await setAuthSession(result.data);
  activeAuthSession = result.data;
  activeAccess = result.data.access;
  authFeedback = { tone: 'ok', text: 'Connecte.' };
  scheduleRefresh(0);
}

async function handleAuthLogout(): Promise<void> {
  await clearAuthSession();
  activeAuthSession = null;
  activeAccess = await getExtensionAccess();
  authFeedback = { tone: 'ok', text: 'Deconnecte.' };
  scheduleRefresh(0);
}

function bindActions(state: StoredPanelState): void {
  // Refresh and Open-source buttons can appear twice (header icon + footer button);
  // bind every match so either triggers the action.
  document.querySelectorAll<HTMLButtonElement>('[data-action="refresh"]').forEach((btn) => {
    btn.addEventListener('click', () => void refreshPanel());
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="open-source"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = state.currentVehicle?.snapshot?.sourceUrl;
      if (url) void browser.tabs.create({ url });
    });
  });

  document.querySelector<HTMLButtonElement>('[data-action="toggle-debug"]')
    ?.addEventListener('click', () => {
      if (!hasAccess('debug:view')) return;
      showDebug = !showDebug;
      void refreshPanel();
    });

  document.querySelectorAll<HTMLElement>('.card > .card__title').forEach((title) => {
    title.addEventListener('click', () => {
      title.closest('.card')?.classList.toggle('closed');
    });
  });

  bindTweaksPanel();
  startTickerCountdown();

  document.querySelector<HTMLFormElement>('[data-auth-login]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      void handleAuthLogin(event.currentTarget as HTMLFormElement);
    });

  document.querySelector<HTMLButtonElement>('[data-action="auth-logout"]')
    ?.addEventListener('click', () => void handleAuthLogout());

  document.querySelector<HTMLSelectElement>('[data-import-scope]')
    ?.addEventListener('change', (event) => {
      importOptions.scope = (event.currentTarget as HTMLSelectElement).value as ImportScope;
      scheduleRefresh(0);
    });

  document.querySelector<HTMLSelectElement>('[data-import-mode]')
    ?.addEventListener('change', (event) => {
      importOptions.mode = (event.currentTarget as HTMLSelectElement).value as ImportMode;
      scheduleRefresh(0);
    });

  document.querySelector<HTMLInputElement>('[data-import-first-n]')
    ?.addEventListener('input', (event) => {
      const nextValue = Math.max(1, parseInt((event.currentTarget as HTMLInputElement).value || '1', 10) || 1);
      importOptions.firstN = nextValue;
    });

  document.querySelector<HTMLInputElement>('[data-import-from-page]')
    ?.addEventListener('input', (event) => {
      const nextValue = Math.max(1, parseInt((event.currentTarget as HTMLInputElement).value || '1', 10) || 1);
      importOptions.fromPage = nextValue;
      if (importOptions.toPage < nextValue) {
        importOptions.toPage = nextValue;
        scheduleRefresh(0);
      }
    });

  document.querySelector<HTMLInputElement>('[data-import-to-page]')
    ?.addEventListener('input', (event) => {
      const nextValue = Math.max(importOptions.fromPage, parseInt((event.currentTarget as HTMLInputElement).value || String(importOptions.fromPage), 10) || importOptions.fromPage);
      importOptions.toPage = nextValue;
    });

  document.querySelector<HTMLButtonElement>('[data-action="start-import"]')
    ?.addEventListener('click', () => {
      if (!hasAccess('vehicles:import')) return;
      void runSilentImport(state);
    });

  document.querySelector<HTMLButtonElement>('[data-action="cancel-import"]')
    ?.addEventListener('click', () => cancelImportJob());

  document.querySelector<HTMLInputElement>('[data-import-change-query]')
    ?.addEventListener('input', (event) => {
      importChangeQuery = (event.currentTarget as HTMLInputElement).value || '';
      importChangePage = 1;
      scheduleRefresh(0);
    });

  document.querySelector<HTMLSelectElement>('[data-import-change-filter]')
    ?.addEventListener('change', (event) => {
      importChangeFilter = (event.currentTarget as HTMLSelectElement).value as ImportChangeFilter;
      importChangePage = 1;
      scheduleRefresh(0);
    });

  document.querySelector<HTMLButtonElement>('[data-action="import-changes-prev"]')
    ?.addEventListener('click', () => {
      importChangePage = Math.max(1, importChangePage - 1);
      scheduleRefresh(0);
    });

  document.querySelector<HTMLButtonElement>('[data-action="import-changes-next"]')
    ?.addEventListener('click', () => {
      const { totalPages } = getVisibleImportChanges();
      importChangePage = Math.min(totalPages, importChangePage + 1);
      scheduleRefresh(0);
    });

  // Vehicle list item clicks
  document.querySelectorAll<HTMLElement>('[data-vehicle-url]').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.vehicleUrl;
      if (url) void browser.tabs.create({ url });
    });
  });

  document.querySelectorAll<HTMLElement>('[data-history-open-mode]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rawId = el.dataset.historySnapshotId;
      const snapshotId = rawId ? parseInt(rawId, 10) : NaN;
      openHistoryTarget({
        openMode: el.dataset.historyOpenMode,
        snapshotId: Number.isFinite(snapshotId) ? snapshotId : null,
        sourceUrl: el.dataset.historySourceUrl || '',
      });
    });
  });

  bindVpauto404Lightbox();

  // Capture orchestrator buttons.
  document.querySelectorAll<HTMLButtonElement>('[data-action="capture-bucket"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!hasAccess('captures:run')) return;
      const bucket = btn.dataset.captureBucket as CaptureBucket | undefined;
      if (!bucket) return;
      void planAndStartCapture(state, bucket);
    });
  });
  document.querySelector<HTMLButtonElement>('[data-action="capture-pause"]')
    ?.addEventListener('click', () => pauseCaptureJob());
  document.querySelector<HTMLButtonElement>('[data-action="capture-resume"]')
    ?.addEventListener('click', () => void resumeCaptureJob());
  document.querySelector<HTMLButtonElement>('[data-action="capture-cancel"]')
    ?.addEventListener('click', () => cancelCaptureJob());
  document.querySelector<HTMLButtonElement>('[data-action="capture-dismiss"]')
    ?.addEventListener('click', () => dismissCaptureJob());
}

// VPauto 404 lightbox — open/close + Escape key. Re-bound on every refresh,
// but the Escape handler is registered only once via a module-level guard
// so multiple refreshes don't stack listeners on the document.
let vpauto404EscapeBound = false;

function bindVpauto404Lightbox(): void {
  const overlay = document.querySelector<HTMLDivElement>('[data-vpauto404-lightbox]');
  if (!overlay) return;
  const img = overlay.querySelector<HTMLImageElement>('.lightbox__img');

  document.querySelectorAll<HTMLButtonElement>('[data-action="open-vpauto404-lightbox"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      const url = btn.dataset.screenshotUrl;
      if (!url || !img) return;
      img.src = url;
      overlay.dataset.open = 'true';
      document.body.style.overflow = 'hidden';
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>('[data-action="close-vpauto404-lightbox"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      closeVpauto404Lightbox();
    });
  });

  // Click on the dark backdrop (but not on the image) closes too.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeVpauto404Lightbox();
  });

  if (!vpauto404EscapeBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const live = document.querySelector<HTMLDivElement>('[data-vpauto404-lightbox][data-open="true"]');
      if (live) closeVpauto404Lightbox();
    });
    vpauto404EscapeBound = true;
  }
}

function closeVpauto404Lightbox(): void {
  const overlay = document.querySelector<HTMLDivElement>('[data-vpauto404-lightbox]');
  if (!overlay) return;
  overlay.dataset.open = 'false';
  const img = overlay.querySelector<HTMLImageElement>('.lightbox__img');
  if (img) img.src = '';
  document.body.style.overflow = '';
}

// ── Vehicle Detail View ──────────────────────────────────────────────────

function renderVehicleState(input: {
  currentVehicle: CurrentVehicleState;
  currentVehicleList?: Partial<VehicleSnapshot>[];
  batchTracking?: BatchTrackingResult;
  scrapeDebug?: ScrapeDebugState;
  vehicleVisits?: StoredPanelState['vehicleVisits'];
  vpauto404Hashes?: Vpauto404Map;
  backgroundDebug?: StoredPanelState['backgroundDebug'];
  history: VehicleHistory | null;
  badges: VehicleBadge[] | null;
  crossAuction?: CrossAuctionData | null;
  similarAvailable?: MatchResult[] | null;
  similarSold?: SimilarSoldData | null;
  /** All hasScreenshot=true snapshots for this vehicle, ordered chronologically. */
  captureTimeline?: CaptureTimelineEntry[] | null;
  isApiOnline: boolean;
}): string {
  const { currentVehicle, history, badges, crossAuction, similarAvailable, similarSold, captureTimeline, isApiOnline, scrapeDebug } = input;
  const vpauto404Hashes = input.vpauto404Hashes || {};
  const currentList = input.currentVehicleList || [];
  const { snapshot, vehicleId, isNew } = currentVehicle;
  const visitKey = vehicleId
    ? `vehicle:${vehicleId}`
    : snapshot.hashId
    ? `hash:${snapshot.hashId}`
    : snapshot.reference
    ? `ref:${snapshot.reference}`
    : '';
  const visitStats = visitKey ? input.vehicleVisits?.[visitKey] : undefined;

  // Recover startingPrice for the CURRENT passage (sold detail pages hide "Mise à prix").
  // Priority order matters: we want the MAP of this passage, NOT the MAP of an older passage.
  //   1. snapshot.startingPrice — scraped directly from the current detail page (when available)
  //   2. currentList card — live DOM of the current auction list ALWAYS reflects the current MAP
  //   3. Latest history passage that has a startingPrice — a recent passage is likely this one
  // We deliberately do NOT fall back to crossAuction.firstStartingPrice because that's the
  // OLDEST MAP ever recorded; using it would mix prices from different listings and has
  // caused "-300 € vs mise à prix" when the current passage was actually +100 € vs its MAP.
  //
  // Placeholder guard: if ANY candidate resolves to 100 € AND the current snapshot
  // shows a live bid / sold price that dwarfs it, reject the 100 € as VPauto's
  // default placeholder rather than a real scooter-level MAP. Same thresholds as
  // the scraper / backend / DB cleanup (500 € live-bid floor, 1000 € valuation).
  const isMapPlaceholder = (sp: number | null | undefined): boolean => {
    if (sp !== 100) return false;
    if ((snapshot.currentAuctionPrice ?? 0) >= 500) return true;
    if ((snapshot.soldPrice ?? 0) >= 500) return true;
    if ((snapshot.marketValue ?? 0) >= 1000) return true;
    if ((snapshot.newPrice ?? 0) >= 1000) return true;
    return false;
  };
  const acceptMap = (sp: number | null | undefined): boolean =>
    Boolean(sp) && !isMapPlaceholder(sp);

  let startingPrice: number | undefined = acceptMap(snapshot.startingPrice)
    ? (snapshot.startingPrice as number)
    : undefined;
  if (!startingPrice && snapshot.hashId && currentList.length > 0) {
    const fromList = currentList.find(v => v.hashId === snapshot.hashId);
    if (acceptMap(fromList?.startingPrice)) {
      startingPrice = fromList!.startingPrice as number;
    }
  }
  if (!startingPrice && history && history.passages.length > 0) {
    // passages are oldest-first; walk backwards to find the most recent passage with a MAP
    for (let i = history.passages.length - 1; i >= 0; i--) {
      const sp = history.passages[i].startingPrice;
      if (acceptMap(sp)) { startingPrice = sp as number; break; }
    }
  }

  // Find similar vehicles in current auction list
  const similarInAuction = findSimilarInList(snapshot, currentList);

  // Patch the server-side history with the live-resolved MAP so the history
  // section and price chart stay in sync. Compute once, reuse twice.
  const enrichedHistory = enrichHistoryWithResolvedMap(history, snapshot, startingPrice);
  const verdictInsight = buildVerdictInsight(snapshot, startingPrice, similarSold);
  const gamification = buildGamificationStats(snapshot, verdictInsight, badges, enrichedHistory, isNew);

  // Build metrics dynamically — only show metrics with real data
  const metrics: string[] = [];
  if (startingPrice) {
    metrics.push(metricCard('Mise a prix', formatPrice(startingPrice), 'price'));
  } else if (snapshot.currentAuctionPrice || snapshot.soldPrice) {
    metrics.push(metricCard('Mise a prix', 'Inconnue', 'price'));
  }
  // "Enchère en cours" — distinct from MAP, shown when a live bid is active.
  // Bug #1 fix: previously VPauto's live bid (e.g. 28 000 €) was being
  // stored as startingPrice and labelled "Mise à prix", misleading the user
  // about the seller's reserve. We now display it as its own metric so the
  // two values never get confused.
  if (snapshot.currentAuctionPrice) {
    metrics.push(metricCard('Enchere en cours', formatPrice(snapshot.currentAuctionPrice), 'price'));
  }
  if (snapshot.soldPrice) metrics.push(metricCard('Prix adjuge', formatPrice(snapshot.soldPrice), 'sold'));
  if (snapshot.marketValue) metrics.push(metricCard('Cote', formatPrice(snapshot.marketValue), 'price'));
  if (snapshot.newPrice) metrics.push(metricCard('Prix neuf', formatPrice(snapshot.newPrice), 'price'));
  metrics.push(metricCard('Kilometrage', formatDistance(snapshot.mileage), 'km'));
  metrics.push(metricCard('Centre', esc(snapshot.center || snapshot.city || 'N/D'), 'location'));
  if (visitStats?.count) metrics.push(metricCard('Visites', String(visitStats.count), 'visit'));
  const totalAuctionPassages = history?.totalPassages
    ?? crossAuction?.passages?.length
    ?? (vehicleId ? 1 : 0);
  const previousPassageCount = Math.max(totalAuctionPassages - 1, 0);
  metrics.push(metricCard('Passages precedents', String(previousPassageCount), 'history'));

  // Profit/loss for sold vehicles
  const profitLine = (snapshot.soldPrice && startingPrice)
    ? renderProfitLine(startingPrice, snapshot.soldPrice, snapshot.marketValue, snapshot.newPrice)
    : '';
  const updatedAt = scrapeDebug?.timestamp || snapshot.scrapedAt;

  return `
    <div class="panel">
      ${renderHeader(isApiOnline, gamification)}
      <div class="panel-scroll">
        ${currentVehicle.vpauto404 ? renderVpauto404Banner(snapshot, currentVehicle.vpauto404SourceUrl) : ''}
        ${renderTicker(snapshot)}
        ${renderVehicleHero(snapshot, vehicleId)}

        ${renderSoldBanner(snapshot, startingPrice)}
        ${renderVerdict(snapshot, startingPrice, similarSold, verdictInsight)}

        <div class="metrics-grid">
          ${metrics.join('')}
        </div>

        ${profitLine}
        ${renderPersistenceWarning(vehicleId, scrapeDebug)}

        ${renderBadgesSection(badges)}
        ${renderCrossAuction(crossAuction, snapshot, vpauto404Hashes)}
        ${renderSimilarInAuction(similarInAuction, snapshot, currentList.length)}
        ${renderSimilarElsewhere(similarAvailable, snapshot)}
        ${renderSimilarSold(similarSold, snapshot)}
        ${renderCaptureTimelineSection(captureTimeline)}
        ${renderHistorySection(enrichedHistory, vehicleId, snapshot)}
        ${renderPriceChart(enrichedHistory)}
        ${hasAccess('debug:view') && showDebug ? renderDebugCard(isApiOnline, input.currentVehicleList, scrapeDebug, input.backgroundDebug) : ''}
        ${renderGamificationSection(gamification)}
        ${renderUpdatedLine(updatedAt, isApiOnline)}
      </div>
      ${renderActionsBar(true)}
      ${renderTweaksPanel()}
      ${renderVpauto404Lightbox()}
    </div>
  `;
}

// ── List View ────────────────────────────────────────────────────────────

function renderListState(state: StoredPanelState, isApiOnline: boolean): string {
  const list = state.currentVehicleList;
  const tracking = state.batchTrackingResult;
  const debug = state.scrapeDebug;

  const hasVehicles = list && list.length > 0;
  const canSeeAuctionTools = hasAccess('auction:summary');
  const canImport = hasAccess('vehicles:import');
  const canCapture = hasAccess('captures:run');
  const canDebug = hasAccess('debug:view');
  const hasCaptureContext = Boolean(
    tracking || (importJob?.status === 'done' && importJob.processed > 0),
  );
  const gamification = buildListGamificationStats(list || [], tracking);
  const updatedAt = tracking?.timestamp || debug?.timestamp;

  return `
    <div class="panel">
      ${renderHeader(isApiOnline, gamification)}
      <div class="panel-scroll">
        ${hasVehicles && canSeeAuctionTools ? renderAuctionSummary(list) : ''}
        ${tracking && canSeeAuctionTools ? renderTrackingAlerts(tracking) : ''}
        ${hasVehicles && canSeeAuctionTools ? renderTrackingSummary(tracking) : ''}
        ${hasVehicles && canCapture && hasCaptureContext ? renderCaptureBar(state) : ''}
        ${hasVehicles && canImport ? renderImportSection(state, isApiOnline) : ''}
        ${hasVehicles
          ? (canSeeAuctionTools ? renderVehicleList(list) : renderUserListNotice(isApiOnline))
          : renderEmptyState(isApiOnline)}
        ${canDebug && showDebug ? renderDebugCard(isApiOnline, list, debug, state.backgroundDebug) : ''}
        ${renderUpdatedLine(updatedAt, isApiOnline)}
      </div>
      ${renderActionsBar(false)}
      ${renderTweaksPanel()}
    </div>
  `;
}

// ── Shared Components ────────────────────────────────────────────────────

function renderHeader(isApiOnline: boolean, stats?: Pick<GamificationStats, 'streak' | 'xp'>): string {
  const roleLabel = activeAccess.role === 'owner' || activeAccess.role === 'admin'
    ? ` · ${activeAccess.role}`
    : '';
  const statusLabel = `${isApiOnline ? 'Connecte' : 'Hors ligne'}${roleLabel} · v2.4`;
  const streak = Math.max(1, stats?.streak ?? 1);
  const xp = Math.max(0, stats?.xp ?? 0);
  return `
    <header class="hero ext-head">
      <div class="hero__brand">
        <div class="hero__logo ext-logo">VP</div>
        <div class="ext-head-text">
          <div class="a">VPauto Assistant</div>
          <div class="b">
            <span class="status-dot ${isApiOnline ? 'status-dot--ok' : 'status-dot--off'}"></span>
            ${esc(statusLabel)}
          </div>
        </div>
      </div>
      <div class="head-pills">
        <div class="head-pill head-pill--streak"><span class="head-pill__icon">🔥</span>${streak}</div>
        <div class="head-pill head-pill--xp"><span class="head-pill__icon">⚡</span>${xp} XP</div>
      </div>
      <button class="ibtn" type="button" data-action="toggle-tweaks" title="Tweaks" aria-label="Ouvrir les tweaks">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      </button>
    </header>
  `;
}

function renderStatusBar(snapshot: VehicleSnapshot, vehicleId?: number, isNew?: boolean): string {
  const chips: string[] = [];
  chips.push(chip(formatStatus(snapshot.status), statusColor(snapshot.status)));
  if (isNew) chips.push(chip('Nouveau', 'green'));
  if (isNonRoulant(snapshot)) chips.push(chip('Non roulant', 'red'));
  if (snapshot.lotNumber) chips.push(chip(`Lot ${snapshot.lotNumber}`, 'neutral'));
  if (snapshot.saleDate) chips.push(chip(formatDate(snapshot.saleDate), 'neutral'));
  if (vehicleId) chips.push(chip(`#${vehicleId}`, 'muted'));

  return `<div class="chip-bar">${chips.join('')}</div>`;
}

function isNonRoulant(v: Partial<VehicleSnapshot>): boolean {
  return /non\s*roulant/i.test(v.observations || '') || /non\s*roulant/i.test(v.model || '');
}

function renderSoldBanner(snapshot: VehicleSnapshot, resolvedStartingPrice?: number): string {
  if (snapshot.status === 'sold' && snapshot.soldPrice) {
    const sp = resolvedStartingPrice || snapshot.startingPrice;
    const diff = sp ? snapshot.soldPrice - sp : null;
    const diffText = diff !== null
      ? `${diff >= 0 ? '+' : ''}${diff.toLocaleString('fr-FR')} \u20AC vs mise a prix`
      : '';
    return `
      <div class="sold-banner sold-banner--sold">
        <div class="sold-banner__label">ADJUGE</div>
        <div class="sold-banner__price">${formatPrice(snapshot.soldPrice)}</div>
        ${sp ? `<div class="sold-banner__original">Mise a prix: ${formatPrice(sp)}</div>` : ''}
        ${diffText ? `<div class="sold-banner__diff">${diffText}</div>` : ''}
      </div>
    `;
  }
  if (snapshot.status === 'unsold') {
    return `
      <div class="sold-banner sold-banner--unsold">
        <div class="sold-banner__label">NON ADJUGE</div>
        <div class="sold-banner__price">Invendu - en apres-vente</div>
      </div>
    `;
  }
  if (snapshot.status === 'auction_live') {
    return `
      <div class="sold-banner sold-banner--live">
        <div class="sold-banner__label">VENTE EN COURS</div>
      </div>
    `;
  }
  return '';
}

function renderProfitLine(startingPrice: number, soldPrice: number, marketValue?: number, newPrice?: number): string {
  const diff = soldPrice - startingPrice;
  const pct = ((diff / startingPrice) * 100).toFixed(0);
  const diffClass = diff >= 0 ? 'price-up' : 'price-down';

  const parts: string[] = [];
  parts.push(`<span class="${diffClass}">${diff >= 0 ? '+' : ''}${diff.toLocaleString('fr-FR')} \u20AC (${diff >= 0 ? '+' : ''}${pct}%)</span> vs mise a prix`);

  if (marketValue && marketValue > 0) {
    const vsMarket = soldPrice - marketValue;
    const vsMarketPct = ((vsMarket / marketValue) * 100).toFixed(0);
    parts.push(`<span class="${vsMarket < 0 ? 'price-down' : 'price-up'}">${vsMarket < 0 ? '' : '+'}${vsMarket.toLocaleString('fr-FR')} \u20AC (${vsMarket < 0 ? '' : '+'}${vsMarketPct}%)</span> vs cote`);
  }

  if (newPrice && newPrice > 0) {
    const vsNew = soldPrice - newPrice;
    const vsNewPct = ((vsNew / newPrice) * 100).toFixed(0);
    parts.push(`<span class="price-down">${vsNew.toLocaleString('fr-FR')} \u20AC (${vsNewPct}%)</span> vs neuf`);
  }

  return `
    <div class="profit-line">
      ${parts.map(p => `<div class="profit-line__item">${p}</div>`).join('')}
    </div>
  `;
}

function renderBadgesSection(badges: VehicleBadge[] | null): string {
  if (!badges || badges.length === 0) return '';

  const items = badges.map(b => {
    const color = b.type === 'new' ? 'green' : b.type === 'price_drop' ? 'green'
      : b.type === 'price_up' ? 'red' : b.type === 'reappeared' ? 'amber' : 'blue';
    const label = b.detail ? `${b.label} (${b.detail})` : b.label;
    return chip(label, color);
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('🏅', 'Badges & alertes', { count: badges.length, tone: 'blue' })}
      <div class="chip-bar">${items}</div>
    </section>
  `;
}

function renderPersistenceWarning(vehicleId: number | null | undefined, debug?: ScrapeDebugState): string {
  if (vehicleId) return '';

  const reason = debug?.reason ? ` (${esc(debug.reason)})` : '';
  return `
    <section class="card">
      ${renderCardTitle('⚠️', 'Synchronisation', { tone: 'amber' })}
      <div class="card__empty">
        Le vehicule est scrape localement, mais l'identifiant backend n'est pas encore confirme${reason}. Les sections historiques resteront limitees tant que cette sauvegarde n'aboutit pas.
      </div>
    </section>
  `;
}

function getCurrentAuctionDate(snapshot: Partial<VehicleSnapshot>): string | undefined {
  return snapshot.saleDate || snapshot.scrapedAt?.split('T')[0];
}

function isCurrentAuctionPassage(
  passage: { city?: string; date?: string; saleDate?: string; center?: string; lotNumber?: number | null },
  snapshot: Partial<VehicleSnapshot>,
): boolean {
  const currentDate = getCurrentAuctionDate(snapshot);
  const passageDate = passage.date || passage.saleDate;
  if (!currentDate || !passageDate) return false;
  if ((snapshot.city || '') !== (passage.city || '')) return false;
  if (passageDate !== currentDate) return false;
  if (snapshot.center && passage.center && snapshot.center !== passage.center) return false;
  if (snapshot.lotNumber != null && passage.lotNumber != null && snapshot.lotNumber !== passage.lotNumber) return false;
  return true;
}

function openHistorySnapshot(snapshotId: number) {
  return browser.tabs.create({
    url: browser.runtime.getURL(`/history-snapshot.html?snapshotId=${encodeURIComponent(String(snapshotId))}`),
  });
}

function openHistoryTarget(input: {
  openMode?: string | null;
  snapshotId?: number | null;
  sourceUrl?: string | null;
}): void {
  // Always open VPauto links DIRECTLY when openMode === 'vpauto'. If VPauto
  // returns 404 the user lands on VPauto's own 404 page and the content
  // script there flips the sidepanel into "VPauto-404 mode" — we no longer
  // intercept the click ourselves.
  const mode = input.openMode === 'vpauto' && input.sourceUrl ? 'vpauto' : 'local';

  if (mode === 'vpauto' && input.sourceUrl) {
    void browser.tabs.create({ url: input.sourceUrl });
    return;
  }

  if (input.snapshotId != null) {
    void openHistorySnapshot(input.snapshotId);
  }
}

function renderHistoryOpenButton(input: {
  snapshotId?: number | null;
  sourceUrl?: string | null;
  openMode?: string | null;
  label?: string;
}): string {
  if (input.snapshotId == null && !input.sourceUrl) return '';

  const mode = input.openMode === 'vpauto' && input.sourceUrl ? 'vpauto' : 'local';
  const label = input.label || (mode === 'vpauto' ? 'Ouvrir la fiche VPauto' : 'Ouvrir la fiche historique');

  return `
    <button
      class="timeline-link timeline-link--button"
      type="button"
      data-history-open-mode="${mode}"
      data-history-snapshot-id="${input.snapshotId ?? ''}"
      data-history-source-url="${esc(input.sourceUrl || '')}"
    >
      ${esc(label)}
    </button>
  `;
}

function formatHistoryOpenReason(reason?: string | null, openMode?: string | null): string {
  if (reason) return reason;
  return openMode === 'vpauto' ? 'URL historique stable' : 'Fiche locale reconstruite';
}

function formatPassageMoment(input: { saleDate?: string | null; saleTime?: string | null; scrapedAt?: string }): string {
  if (input.saleDate) {
    return `${formatDate(input.saleDate)}${input.saleTime ? ` · ${input.saleTime}` : ''}`;
  }
  if (input.scrapedAt) return formatDateTime(input.scrapedAt);
  return 'Date inconnue';
}

function historyStatusTone(status?: string): 'green' | 'red' | 'blue' | 'amber' {
  if (status === 'sold') return 'green';
  if (status === 'unsold' || status === 'removed') return 'red';
  if (status === 'auction_live') return 'amber';
  return 'blue';
}

/**
 * Patch the passage that matches the current snapshot with a MAP resolved from
 * the live list card (or other fallback). This compensates for sold/unsold
 * detail pages that hide "Mise à prix" — the stored snapshot has null MAP,
 * but the list card still displays it. Also regenerates priceHistory so the
 * chart reflects the real MAP→Adjugé trajectory instead of a misleading drop
 * between two passages' MAPs.
 */
function enrichHistoryWithResolvedMap(
  history: VehicleHistory | null,
  snapshot: VehicleSnapshot,
  resolvedStartingPrice: number | undefined,
): VehicleHistory | null {
  if (!history || !resolvedStartingPrice) return history;

  // The resolved MAP comes from the live list card, which represents the most
  // recent state of this vehicle. So we patch the LATEST passage in the same
  // city that still has a null MAP. If the most-recent passage already has a
  // MAP, nothing to do — the data is already correct.
  const snapshotCity = snapshot.city || '';
  const passages = history.passages.slice();
  let patched = false;
  for (let i = passages.length - 1; i >= 0; i--) {
    const p = passages[i];
    if ((p.city || '') !== snapshotCity) continue;
    if (p.startingPrice != null) break;
    const events = (p.events || []).slice();
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex--) {
      if (events[eventIndex].startingPrice != null) break;
      events[eventIndex] = { ...events[eventIndex], startingPrice: resolvedStartingPrice };
      break;
    }
    passages[i] = { ...p, startingPrice: resolvedStartingPrice, events };
    patched = true;
    break;
  }
  if (!patched) return history;

  // Re-derive the chart data and the evolution summary from the patched
  // passages using the same helpers the backend uses, so client and server
  // stay in lock-step on labelling and anchor-point selection.
  return {
    ...history,
    passages,
    priceHistory: buildPriceHistory(passages),
    evolution: computeEvolution(passages),
  };
}

/**
 * Compact representation of a passage that the backend dropped because it
 * was scraped after the most recent sale. We accept both the VehiclePassage
 * shape (history endpoint, uses `date`) and the cross-auction inline shape
 * (uses `saleDate`) so a single helper can serve both cards.
 */
type TruncatedPassageLike = {
  snapshotId?: number | null;
  city?: string | null;
  date?: string | null;
  saleDate?: string | null;
  saleTime?: string | null;
  sourceUrl?: string | null;
  openMode?: string | null;
};

function renderPostSaleTruncatedNote(passages: TruncatedPassageLike[] | undefined): string {
  if (!passages || passages.length === 0) return '';
  const count = passages.length;
  const label = count === 1
    ? '1 passage post-vente masqué'
    : `${count} passages post-vente masqués`;

  const chips = passages.map((p) => {
    const moment = formatPassageMoment({
      saleDate: p.saleDate ?? p.date ?? null,
      saleTime: p.saleTime ?? null,
    });
    const cityText = p.city ? `${p.city} · ` : '';
    const buttonLabel = `${cityText}${moment} ↗`;
    return renderHistoryOpenButton({
      snapshotId: p.snapshotId ?? null,
      sourceUrl: p.sourceUrl ?? null,
      openMode: p.openMode ?? null,
      label: buttonLabel,
    });
  }).join('');

  return `
    <div class="passages-truncated-note" title="VPauto laisse parfois la page d'annonce accessible quelques jours après la vente, avec la mention « Vente Live terminée / Véhicule non disponible ». Ces passages orphelins ne sont pas affichés.">
      <div class="passages-truncated-note__head">
        ${esc(label)} <span class="passages-truncated-note__hint">(annonce orpheline VPauto)</span>
      </div>
      <div class="passages-truncated-note__chips">${chips}</div>
    </div>
  `;
}

function renderCaptureTimelineSection(captures: CaptureTimelineEntry[] | null | undefined): string {
  if (!captures || captures.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('📸', 'Historique des captures', { tone: 'blue' })}
        <div class="card__empty">
          Aucune capture pour ce vehicule. Lance une capture depuis la liste (Nouveaux / Modifies / Manquants) pour archiver une fiche.
        </div>
      </section>
    `;
  }

  const items = captures.slice().reverse().map((c) => {
    const dateLabel = c.saleDate ? formatDate(c.saleDate) : formatDate(c.scrapedAt.slice(0, 10));
    const statusChip = c.status === 'sold'
      ? '<span class="chip chip--green" style="font-size:9px;padding:2px 6px;">Vendu</span>'
      : c.status === 'unsold'
      ? '<span class="chip chip--red" style="font-size:9px;padding:2px 6px;">Invendu</span>'
      : '<span class="chip chip--blue" style="font-size:9px;padding:2px 6px;">Disponible</span>';
    const priceLine = c.soldPrice
      ? `Adjuge ${formatPrice(c.soldPrice)}`
      : c.startingPrice
      ? `MAP ${formatPrice(c.startingPrice)}`
      : '';

    return `
      <div class="capture-timeline__item">
        <button
          class="capture-timeline__thumb"
          type="button"
          data-action="open-vpauto404-lightbox"
          data-screenshot-url="${esc(buildScreenshotUrl(c.snapshotId))}"
          aria-label="Agrandir la capture"
        >
          <img
            class="capture-timeline__img"
            src="${esc(buildScreenshotUrl(c.snapshotId))}"
            alt="Capture archivee"
            loading="lazy"
          />
          <span class="capture-timeline__zoom">Agrandir</span>
        </button>
        <div class="capture-timeline__meta">
          <div class="capture-timeline__head">
            <strong>${esc(dateLabel)}</strong>
            ${statusChip}
          </div>
          <div class="capture-timeline__city">${esc(c.city || 'Ville inconnue')}</div>
          ${priceLine ? `<div class="capture-timeline__price">${esc(priceLine)}</div>` : ''}
          <div class="capture-timeline__reason">${esc(c.reason)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('📸', 'Historique des captures', { count: captures.length, tone: 'blue' })}
      <div class="capture-timeline">${items}</div>
    </section>
  `;
}

function renderHistorySection(history: VehicleHistory | null, vehicleId: number | null | undefined, snapshot: VehicleSnapshot): string {
  const historicalPassages = history?.passages.slice().reverse() || [];

  if (!history || historicalPassages.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('📅', 'Historique de passages', { tone: 'yellow' })}
        <div class="card__empty">
          ${vehicleId
            ? "Aucun passage connu pour ce vehicule dans la base locale."
            : "Historique indisponible tant que le vehicule n'est pas rattache a un identifiant backend."}
        </div>
      </section>
    `;
  }

  const items = historicalPassages
    .map((p) => {
      const isCurrent = isCurrentAuctionPassage(p, snapshot);
      const events = p.events?.length
        ? p.events
        : [{
            snapshotId: p.snapshotId,
            scrapedAt: p.date,
            saleDate: p.date,
            saleTime: p.saleTime,
            status: p.status,
            startingPrice: p.startingPrice,
            soldPrice: p.soldPrice,
            mileage: p.mileage,
            sourceUrl: p.sourceUrl,
            openMode: p.openMode,
            openReason: p.openReason,
          }];
      const eventRows = events.map((event, index) => `
        <div class="timeline-event ${index === events.length - 1 ? 'timeline-event--latest' : ''}">
          <div class="timeline-event__head">
            <span class="timeline-event__moment">${esc(formatPassageMoment(event))}</span>
            <span class="chip chip--${historyStatusTone(event.status)}">${esc(formatStatus(event.status))}</span>
          </div>
          <div class="timeline-event__meta">
            MAP observee: ${formatPrice(event.startingPrice ?? undefined)}${event.soldPrice ? ` · Adjuge: ${formatPrice(event.soldPrice)}` : ''}${event.mileage ? ` · ${formatDistance(event.mileage)}` : ''}
          </div>
          <div class="timeline-event__actions">
            ${renderHistoryOpenButton({
              snapshotId: event.snapshotId,
              sourceUrl: event.sourceUrl,
              openMode: event.openMode,
            })}
            <span class="timeline-event__reason">${esc(formatHistoryOpenReason(event.openReason, event.openMode))}</span>
          </div>
        </div>
      `).join('');
      return `
        <div class="timeline-item ${isCurrent ? 'timeline-item--current' : ''}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="timeline-date">${esc(formatPassageMoment({ saleDate: p.date, saleTime: p.saleTime }))}</span>
              <span class="timeline-status">${esc(formatStatus(p.status))}</span>
            </div>
            <div class="timeline-body">
              ${esc(p.city)}${p.center ? ` - ${esc(p.center)}` : ''}${isCurrent ? ' <span class="timeline-current-badge">Passage courant</span>' : ''}
            </div>
            <div class="timeline-meta">
              Mise a prix passage: ${formatPrice(p.startingPrice)}${p.soldPrice ? ` \u2192 Adjuge: ${formatPrice(p.soldPrice)}` : ''}${p.mileage ? ` \u2022 ${formatDistance(p.mileage)}` : ''} \u2022 ${events.length} variation${events.length > 1 ? 's' : ''}
            </div>
            <div class="timeline-events">${eventRows}</div>
          </div>
        </div>
      `;
    }).join('');

  return `
    <section class="card">
      ${renderCardTitle('📅', 'Historique de passages', { count: historicalPassages.length, tone: 'yellow' })}
      <div class="timeline">${items}</div>
      ${renderPostSaleTruncatedNote(history.postSaleTruncatedPassages)}
    </section>
  `;
}

function renderCrossAuction(
  data: CrossAuctionData | null | undefined,
  snapshot: VehicleSnapshot,
  vpauto404Hashes: Vpauto404Map = {},
): string {
  const previousPassages = data?.passages.slice().reverse() || [];

  if (!data || previousPassages.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('🌍', 'Parcours multi-encheres', { tone: 'purple' })}
        <div class="card__empty">
          Aucun passage connu pour ce vehicule dans la base locale pour le moment.
        </div>
      </section>
    `;
  }

  const items = previousPassages.map(p => {
    const isCurrent = isCurrentAuctionPassage(p, snapshot);
    const statusLabel = p.status === 'sold' ? 'Vendu' : p.status === 'unsold' ? 'Invendu' : 'Disponible';
    const statusColor = p.status === 'sold' ? 'green' : p.status === 'unsold' ? 'red' : 'blue';

    // 404 detection: prefer the explicit hashId from the DTO, fall back to
    // extracting it from sourceUrl for older API responses that haven't been
    // redeployed yet. Either way we look up the global cache populated by
    // content.ts when the user lands on a `.container404` page.
    const passageHashId = p.hashId || extractHashIdFromVpautoUrl(p.sourceUrl);
    const is404 = Boolean(passageHashId && vpauto404Hashes[passageHashId]);
    const screenshotAvailable = is404 && p.hasScreenshot && p.canonicalSnapshotId;

    let priceHtml = '';
    if (p.soldPrice) {
      priceHtml = `<span class="price-down" style="font-size:12px;">Adjuge ${formatPrice(p.soldPrice)}</span>`;
      if (p.startingPrice) priceHtml += ` <span style="text-decoration:line-through;color:var(--text-muted);font-size:10px;">${formatPrice(p.startingPrice)}</span>`;
    } else if (p.startingPrice) {
      priceHtml = `${formatPrice(p.startingPrice)}`;
    }

    // When the passage is 404'd AND we have a screenshot, render an inline
    // thumbnail right below the meta block. The thumbnail itself is the
    // lightbox trigger — clicking it enlarges the capture in the same modal
    // used by the top-level VPauto-404 banner. When the passage is 404'd but
    // no screenshot exists, we surface that explicitly so the user knows the
    // fiche is gone forever (rather than wondering why the row is empty).
    const screenshotBlock = screenshotAvailable
      ? `
        <button
          class="cross-item__capture"
          type="button"
          data-action="open-vpauto404-lightbox"
          data-screenshot-url="${esc(buildScreenshotUrl(p.canonicalSnapshotId))}"
          aria-label="Agrandir la capture VPauto archivee de ce passage"
        >
          <img
            class="cross-item__capture-img"
            src="${esc(buildScreenshotUrl(p.canonicalSnapshotId))}"
            alt="Capture archivee de la fiche VPauto"
            loading="lazy"
          />
          <span class="cross-item__capture-zoom">Agrandir</span>
        </button>`
      : is404
      ? `<div class="cross-item__no-capture" role="note">📷 Pas de capture pour ce passage</div>`
      : '';

    return `
      <div class="cross-item ${isCurrent ? 'cross-item--current' : ''}${is404 ? ' cross-item--vpauto404' : ''}">
        <div class="cross-item__header">
          <span class="cross-item__city">
            ${esc(p.city)}${isCurrent ? ' <span class="timeline-current-badge">Courant</span>' : ''}
          </span>
          <span class="cross-item__chips">
            ${is404 ? '<span class="chip chip--amber cross-item__404-chip" title="VPauto a renvoye 404 — fiche archivee localement">VPauto 404</span>' : ''}
            <span class="chip chip--${statusColor}" style="font-size:9px;padding:2px 6px;">${statusLabel}</span>
          </span>
        </div>
        <div class="cross-item__detail">
          <span>${esc(formatPassageMoment({ saleDate: p.saleDate, saleTime: p.saleTime, scrapedAt: p.scrapedAt }))}</span>
          <span>${priceHtml}</span>
        </div>
        ${screenshotBlock}
        <div class="cross-item__detail cross-item__detail--footer">
          <span>${formatDistance(p.mileage)}</span>
          <div class="cross-item__open">
            ${renderHistoryOpenButton({
              snapshotId: p.snapshotId,
              sourceUrl: p.sourceUrl,
              openMode: p.openMode,
            })}
            <span class="timeline-event__reason">${esc(is404 ? 'URL VPauto retourne 404 — clic pour verifier' : formatHistoryOpenReason(p.openReason, p.openMode))}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('🌍', 'Parcours multi-encheres', { count: previousPassages.length, tone: 'purple' })}
      ${crossAuctionProbing ? `
        <div class="cross-probing" role="status" aria-live="polite">
          <span class="cross-probing__dot"></span>
          <span class="cross-probing__label">Verification VPauto en cours&hellip;</span>
        </div>
      ` : ''}
      <div class="cross-list">${items}</div>
      ${renderPostSaleTruncatedNote(data.postSaleTruncatedPassages)}
    </section>
  `;
}

/**
 * Extract the hashId from a VPauto vehicle URL.
 * Format: https://www.vpauto.fr/vehicule/<hashId>/<slug>.
 * Used as fallback for cross-auction DTOs that don't yet ship the hashId field
 * (e.g. when the extension is paired with an older backend build).
 */
function extractHashIdFromVpautoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/vehicule\/([a-f0-9]+)\//i);
  return match?.[1] || null;
}

/**
 * Silently probe every cross-auction passage URL we don't already have a
 * 404-verdict for. Runs in the background service worker so VPauto doesn't
 * see a real browser tab and the user sees nothing in their tab bar — only
 * the side panel discreetly grows the "VPauto 404" chips and capture
 * thumbnails as probes resolve.
 *
 * Concurrency capped at 3 to be polite with VPauto. We persist any new 404
 * verdicts back to chrome.storage.local immediately, so a subsequent panel
 * refresh sees them even if the user closes the tab mid-batch.
 *
 * `currentHashId` is excluded — the user is literally on that page, so it's
 * obviously not 404 (or we'd already have flagged it via the content-script
 * `.container404` detector).
 */
async function probeCrossAuctionPassages(
  passages: CrossAuctionPassage[],
  knownVpauto404Hashes: Vpauto404Map,
  currentHashId: string | null,
): Promise<void> {
  // Build the queue: passages with a hashId, not already 404, not the current
  // page, not already being probed by another concurrent refresh, and with a
  // legitimate VPauto vehicle URL.
  const toProbe: { hashId: string; url: string }[] = [];
  const seenInBatch = new Set<string>();
  for (const passage of passages) {
    const hashId = passage.hashId || extractHashIdFromVpautoUrl(passage.sourceUrl);
    if (!hashId) continue;
    if (seenInBatch.has(hashId)) continue;
    if (knownVpauto404Hashes[hashId]) continue;
    if (inflightVpautoProbes.has(hashId)) continue;
    if (currentHashId && hashId === currentHashId) continue;
    if (!/^https:\/\/(?:www\.)?vpauto\.fr\/vehicule\//.test(passage.sourceUrl)) continue;

    seenInBatch.add(hashId);
    inflightVpautoProbes.add(hashId);
    toProbe.push({ hashId, url: passage.sourceUrl });
  }

  if (toProbe.length === 0) return;

  crossAuctionProbing = true;
  // Re-render once to show the "Vérification VPauto…" indicator. We schedule
  // it via the regular refresh path so all the other UI state stays coherent.
  scheduleRefresh(0);

  const discovered: Record<string, { detectedAt: string }> = {};
  let cursor = 0;
  const concurrency = 3;
  const workers = Array.from({ length: Math.min(concurrency, toProbe.length) }, async () => {
    while (cursor < toProbe.length) {
      const item = toProbe[cursor++];
      try {
        const response = await api.probeVpautoUrl(item.url, item.hashId);
        if (response?.data?.is404) {
          discovered[item.hashId] = { detectedAt: new Date().toISOString() };
        }
      } catch (err) {
        // Network failure — leave the hashId out of the cache so it gets
        // re-probed next time the panel refreshes. We log to console only.
        console.warn(`[VPauto probe] HEAD ${item.url} failed:`, err);
      } finally {
        inflightVpautoProbes.delete(item.hashId);
      }
    }
  });

  await Promise.all(workers);

  if (Object.keys(discovered).length > 0) {
    // Merge with whatever has been written to storage in the meantime — the
    // content script may have flagged hashes from another tab while we were
    // probing. Last-write-wins per key, but since we never overwrite an
    // already-known hash, this is safe.
    const stored = await browser.storage.local.get('vpauto404Hashes').catch(() => ({} as Record<string, unknown>));
    const rawExisting = (stored as Record<string, unknown>).vpauto404Hashes;
    const existing: Vpauto404Map = (rawExisting && typeof rawExisting === 'object')
      ? rawExisting as Vpauto404Map
      : {};
    const merged: Vpauto404Map = { ...existing };
    for (const [hashId, info] of Object.entries(discovered)) {
      if (!merged[hashId]) merged[hashId] = info;
    }
    await browser.storage.local.set({ vpauto404Hashes: merged }).catch(() => {});
  }

  crossAuctionProbing = false;
  // Trigger one final re-render so chips/thumbnails appear and the indicator
  // disappears. Even if no 404 was discovered, we re-render to remove the
  // "Vérification…" badge.
  scheduleRefresh(0);
}

/** Find vehicles of same brand/model in the current auction list */
function findSimilarInList(
  current: VehicleSnapshot,
  list: Partial<VehicleSnapshot>[],
): Partial<VehicleSnapshot>[] {
  if (!current.brand || list.length === 0) return [];

  const brandUpper = current.brand.toUpperCase();
  const modelFirst = current.model?.split(/\s+/)[0]?.toUpperCase() || '';

  return list
    .filter(v => {
      if (v.hashId === current.hashId) return false; // Skip self
      const vBrand = (v.brand || '').toUpperCase();
      if (vBrand !== brandUpper) return false;
      // Same brand — bonus if same model
      return true;
    })
    .sort((a, b) => {
      // Sort: same model first, then by price
      const aModel = (a.model || '').toUpperCase().includes(modelFirst) ? 1 : 0;
      const bModel = (b.model || '').toUpperCase().includes(modelFirst) ? 1 : 0;
      if (bModel !== aModel) return bModel - aModel;
      return (a.startingPrice || 0) - (b.startingPrice || 0);
    })
    .slice(0, 10);
}

/** Render similar vehicles from the current auction (no backend needed) */
function renderSimilarInAuction(vehicles: Partial<VehicleSnapshot>[], current: VehicleSnapshot, listSize: number): string {
  if (vehicles.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('🔎', 'Similaires dans cette vente', { tone: 'green' })}
        <div class="card__empty">
          ${listSize > 0
            ? "Aucun autre vehicule comparable n'a ete trouve dans la liste memoire de l'enchere en cours."
            : "La liste memoire de l'enchere n'est pas encore disponible pour comparer ce vehicule."}
        </div>
      </section>
    `;
  }

  const modelFirst = current.model?.split(/\s+/)[0]?.toUpperCase() || '';

  // Stats from similar in current auction
  const prices = vehicles.filter(v => v.startingPrice).map(v => v.startingPrice!);
  const soldInList = vehicles.filter(v => v.status === 'sold' && v.soldPrice);
  const soldPrices = soldInList.map(v => v.soldPrice!);

  let statsHtml = '';
  if (prices.length > 0) {
    const avgStart = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const minStart = Math.min(...prices);
    const maxStart = Math.max(...prices);
    statsHtml += `
      <div class="recommend-box">
        <div class="recommend-box__title">Comparaison dans cette vente</div>
        <div class="recommend-box__row">
          <span>Mise a prix moyenne (${prices.length})</span>
          <span class="recommend-box__value">${formatPrice(avgStart)}</span>
        </div>
        <div class="recommend-box__row">
          <span>Fourchette</span>
          <span class="recommend-box__value">${formatPrice(minStart)} - ${formatPrice(maxStart)}</span>
        </div>
        ${soldPrices.length > 0 ? `
          <div class="recommend-box__row">
            <span>Adjuge moyen (${soldPrices.length} vendus)</span>
            <span class="recommend-box__value">${formatPrice(Math.round(soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length))}</span>
          </div>
        ` : ''}
        ${current.startingPrice ? `
          <div class="recommend-box__verdict ${current.startingPrice <= (soldPrices.length > 0 ? Math.round(soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length) : avgStart) ? 'recommend-box__verdict--good' : 'recommend-box__verdict--high'}">
            ${current.startingPrice <= avgStart
              ? `Mise a prix inferieure de ${formatPrice(avgStart - current.startingPrice)} a la moyenne`
              : current.startingPrice === avgStart
              ? 'Prix aligne avec les autres'
              : `Mise a prix superieure de ${formatPrice(current.startingPrice - avgStart)} a la moyenne`
            }
          </div>
        ` : ''}
      </div>
    `;
  }

  const items = vehicles.map(v => {
    const isModelMatch = (v.model || '').toUpperCase().includes(modelFirst);
    const nonRoulant = isNonRoulant(v);
    const statusLabel = v.status === 'sold' ? 'Vendu' : v.status === 'unsold' ? 'Invendu' : '';
    const statusColor = v.status === 'sold' ? 'green' : v.status === 'unsold' ? 'red' : '';
    const altText = `${v.brand || ''} ${v.model || ''}`.trim();
    return `
      <div class="similar-item${nonRoulant ? ' similar-item--nr' : ''}" data-vehicle-url="${esc(v.sourceUrl || '')}">
        ${renderThumbnail(v.photoUrls, altText)}
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(v.brand || '')} ${esc(v.model || '')}
            ${isModelMatch ? '<span class="badge-match">Match</span>' : ''}
            ${nonRoulant ? '<span class="badge-nr" title="Véhicule non roulant">NON ROULANT</span>' : ''}
          </div>
          <div class="similar-item__meta">${v.year || ''} \u2022 ${formatDistance(v.mileage || 0)} \u2022 ${esc(v.city || '')}</div>
        </div>
        <div class="similar-item__prices">
          ${v.soldPrice ? `<div class="similar-item__sold">Adjuge ${formatPrice(v.soldPrice)}</div>` : ''}
          ${v.startingPrice ? `<div class="similar-item__start">${formatPrice(v.startingPrice)}</div>` : ''}
          ${statusLabel ? `<span class="chip chip--${statusColor}" style="font-size:9px;padding:1px 5px;">${statusLabel}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('🔎', 'Similaires dans cette vente', { count: vehicles.length, tone: 'green' })}
      ${statsHtml}
      <div class="similar-list">${items}</div>
    </section>
  `;
}

function renderSimilarElsewhere(matches: MatchResult[] | null | undefined, current: VehicleSnapshot): string {
  const currentPrice = current.startingPrice || current.soldPrice || null;
  // Defensive same-vehicle dedup. The backend already excludes the current
  // `vehicleId`, but VPauto creates a NEW hashId every time it re-lists a car
  // (e.g. invendu → repasse, non-roulant → roulant). The two listings live in
  // distinct Vehicle rows until `merge-split-vehicles.ts` runs, so without a
  // second-line defence here the same physical car shows up under
  // "Similaires ailleurs" — observed on VW Golf 11396385 in LILLE.
  //
  // Defence layers, fastest checks first:
  //   1. hashId equality (catches most direct dupes)
  //   2. VPauto reference equality (catches the rare ref-reuse on relisting)
  //   3. sourceUrl equality (catches the case where ref is missing both sides)
  //   4. brand+model+year + odometer drift ≤ 500 km — two distinct cars of
  //      the same trim never read the same odometer to the kilometre, so a
  //      tight match here means it's the same physical vehicle that the
  //      matcher hasn't yet been able to merge.
  const sameVehicle = (snap: VehicleSnapshot): boolean => {
    if (snap.hashId && current.hashId && snap.hashId === current.hashId) return true;
    if (snap.reference && current.reference && snap.reference === current.reference) return true;
    if (snap.sourceUrl && current.sourceUrl && snap.sourceUrl === current.sourceUrl) return true;
    const brandMatch = (snap.brand || '').toUpperCase() === (current.brand || '').toUpperCase();
    const modelMatch = (snap.model || '').toUpperCase() === (current.model || '').toUpperCase();
    const yearMatch = snap.year === current.year;
    const kmClose = Math.abs((snap.mileage || 0) - (current.mileage || 0)) <= 500;
    return brandMatch && modelMatch && yearMatch && kmClose;
  };
  // Same-city filter — case-insensitive. The detail-page scraper Title-Cases
  // the city ("LILLE" → "Lille") while the list-page scraper preserves the
  // original UPPERCASE, so a strict !== comparison lets same-city dupes leak.
  const normalizeCity = (city: string | undefined | null): string =>
    (city || '').toUpperCase().trim();
  const currentCity = normalizeCity(current.city);
  const filtered = (matches || [])
    .filter((match) => match.level !== 'exact')
    .filter((match) => !sameVehicle(match.snapshot))
    .filter((match) => {
      const candCity = normalizeCity(match.snapshot.city);
      return Boolean(candCity) && candCity !== currentCity;
    })
    .filter((match) => ['available', 'auction_live', 'unsold'].includes(match.snapshot.status))
    .sort((a, b) => {
      const levelScore = (m: MatchResult) => m.level === 'same_model' ? 2 : 1;
      const availabilityScore = (m: MatchResult) => m.snapshot.status === 'available' ? 2 : m.snapshot.status === 'auction_live' ? 1 : 0;
      const priceDelta = (m: MatchResult) => {
        if (currentPrice == null || m.snapshot.startingPrice == null) return Number.POSITIVE_INFINITY;
        return m.snapshot.startingPrice - currentPrice;
      };

      return (
        levelScore(b) - levelScore(a)
        || availabilityScore(b) - availabilityScore(a)
        || priceDelta(a) - priceDelta(b)
        || b.score - a.score
      );
    })
    .slice(0, 8);

  if (filtered.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('📍', 'Similaires disponibles ailleurs', { tone: 'blue' })}
        <div class="card__empty">
          Aucun exemplaire similaire actuellement disponible dans une autre ville n'a encore ete trouve dans la base locale.
        </div>
      </section>
    `;
  }

  const cheaperCount = currentPrice != null
    ? filtered.filter((match) => match.snapshot.startingPrice != null && match.snapshot.startingPrice < currentPrice).length
    : 0;
  const sameModelCount = filtered.filter((match) => match.level === 'same_model').length;

  const summaryBits = [
    `${sameModelCount} mêmes modèles`,
    currentPrice != null ? `${cheaperCount} moins chers` : '',
  ].filter(Boolean).join(' · ');

  const summary = `
    <div class="opp-banner">
      <div class="n">${filtered.length}</div>
      <div class="t">
        Véhicules disponibles trouvés ailleurs
        <small>${esc(summaryBits || 'Même marque · analyse locale')}</small>
      </div>
    </div>
  `;

  const items = filtered.map((match) => {
    const candidate = match.snapshot;
    const priceDiff = currentPrice != null && candidate.startingPrice != null
      ? candidate.startingPrice - currentPrice
      : null;
    const kmDiff = candidate.mileage - current.mileage;
    const nonRoulant = isNonRoulant(candidate);
    const statusLabel = candidate.status === 'auction_live'
      ? 'En cours'
      : candidate.status === 'unsold'
      ? 'Invendu'
      : 'Disponible';
    const statusColor = candidate.status === 'auction_live'
      ? 'blue'
      : candidate.status === 'unsold'
      ? 'amber'
      : 'green';

    // Show the similarity score next to the title with a colour tone so the
    // bidder can see at a glance how loose the match is. The new power-gate
    // (backend `calculateSimilarityScore`) rejects > ±20 % candidates, so any
    // result here is at least power-aligned, but a 60/100 still tells the
    // user "this is a close-but-not-identical comparable, price-adjust".
    const scoreTone = match.score >= 80 ? 'good' : match.score >= 65 ? 'warn' : 'bad';
    const scoreBadge = `<span class="badge-score badge-score--${scoreTone}" title="Indice de similarité — plus c'est haut, plus la comparaison est fiable">${match.score}/100</span>`;

    // Build the delta line: actionable differences (year, power, trim, fuel,
    // gearbox, engine size, colour). When everything matches, fall back to
    // a positive "Spécifications identiques" — that's a strong signal too.
    const deltas = buildSpecDelta(candidate, current);
    const deltaBits = deltas.length > 0
      ? deltas.slice(0, 4).join(' \u2022 ')
      : 'Spécifications identiques';

    return `
      <div class="similar-item${nonRoulant ? ' similar-item--nr' : ''}" data-vehicle-url="${esc(candidate.sourceUrl || '')}">
        ${renderThumbnail(candidate.photoUrls, `${candidate.brand} ${candidate.model}`)}
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(candidate.brand)} ${esc(candidate.model)}
            ${match.level === 'same_model' ? '<span class="badge-match">Match</span>' : ''}
            ${scoreBadge}
            ${nonRoulant ? '<span class="badge-nr" title="Véhicule non roulant — explique un prix anormalement bas">NON ROULANT</span>' : ''}
          </div>
          <div class="similar-item__meta">
            ${candidate.year} \u2022 ${formatDistance(candidate.mileage)} \u2022 ${esc(candidate.city)}
          </div>
          <div class="similar-item__meta similar-item__deltas${deltas.length === 0 ? ' similar-item__deltas--ok' : ''}">
            ${esc(deltaBits)}
          </div>
        </div>
        <div class="similar-item__prices">
          ${candidate.startingPrice != null ? `<div class="similar-item__start">${formatPrice(candidate.startingPrice)}</div>` : ''}
          ${priceDiff != null && priceDiff !== 0 ? `<div class="${priceDiff < 0 ? 'similar-item__sold price-down' : 'similar-item__start price-up'}">${priceDiff > 0 ? '+' : ''}${formatPrice(priceDiff).replace(/\s?€/g, ' €')} </div>` : ''}
          <span class="chip chip--${statusColor}" style="font-size:9px;padding:1px 5px;">${statusLabel}</span>
          ${kmDiff !== 0 ? `<div class="similar-item__meta ${kmDiff < 0 ? 'price-down' : 'price-up'}">${kmDiff > 0 ? '+' : ''}${numberFormatter.format(kmDiff)} km</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('📍', 'Similaires disponibles ailleurs', { count: filtered.length, tone: 'blue' })}
      ${summary}
      <div class="similar-list">${items}</div>
    </section>
  `;
}

function renderSimilarSold(data: SimilarSoldData | null | undefined, currentSnapshot: VehicleSnapshot): string {
  if (!data || data.results.length === 0) {
    return `
      <section class="card">
        ${renderCardTitle('💰', 'Intelligence prix', { tone: 'blue' })}
        <div class="card__empty">
          Aucune reference vendue comparable n'est encore disponible dans la base locale pour produire une estimation fiable.
        </div>
      </section>
    `;
  }

  const stats = data.stats;

  // Price recommendation — only shown when we have at least one TRULY
  // comparable sale (same model + year ± 2 + mileage ± 50 k km, drivable).
  // When the sample is empty, we display an honest "insufficient sample"
  // message instead of a misleading average pulled from a 5-year-older
  // van with 4× the mileage.
  let recommendHtml = '';
  if (stats.avgSoldPrice && stats.count >= 1) {
    const currentPrice = currentSnapshot.startingPrice || currentSnapshot.soldPrice;
    recommendHtml = `
      <div class="estim-block">
        <div class="estim-row hero">
          <div class="k">Prix moyen adjugé</div>
          <div class="v">${formatPrice(stats.avgSoldPrice)}</div>
        </div>
        <div class="estim-row">
          <div class="k">Fourchette</div>
          <div class="v">${formatPrice(stats.minSoldPrice || 0)} - ${formatPrice(stats.maxSoldPrice || 0)}</div>
        </div>
        <div class="estim-row">
          <div class="k">Échantillon</div>
          <div class="v">${stats.count} vente${stats.count > 1 ? 's' : ''} comparable${stats.count > 1 ? 's' : ''}</div>
        </div>
        ${currentPrice ? `
          <div class="estim-row">
            <div class="k">Ce véhicule</div>
            <div class="v">${formatPrice(currentPrice)}</div>
          </div>
          <div class="estim-row">
            <div class="k">Verdict</div>
            <div class="v ${currentPrice <= stats.avgSoldPrice ? 'price-down' : 'price-up'}">
              ${currentPrice < stats.avgSoldPrice
                ? `-${formatPrice(stats.avgSoldPrice - currentPrice)} vs marché`
                : currentPrice === stats.avgSoldPrice
                ? 'Aligné marché'
                : `+${formatPrice(currentPrice - stats.avgSoldPrice)} vs marché`
              }
            </div>
          </div>
        ` : ''}
      </div>
    `;
  } else {
    recommendHtml = `
      <div class="estim-block estim-block--warn">
        <div class="estim-row hero">
          <div class="k">Estimation</div>
          <div class="v">Non disponible</div>
        </div>
        <div class="recommend-box__note">
          Echantillon insuffisant : aucun vehicule vendu comparable
          (meme modele, annee +/- 2, kilometrage +/- 50 000 km) n'est
          presnet dans la base. Les ventes ci-dessous sont affichees
          a titre indicatif mais ne sont pas assez proches pour une
          estimation fiable.
        </div>
      </div>
    `;
  }

  // Similar vehicles list — the "Match" badge now only lights up when the
  // vehicle is a TRUE comparable (model + year + mileage all within
  // tolerance). Anything else is shown for context but tagged as such.
  const items = data.results.slice(0, 8).map(v => {
    const isComparable = v.modelMatch && v.yearMatch && v.mileageMatch;
    const nonRoulant = isNonRoulant(v);
    const reasons: string[] = [];
    if (!v.yearMatch) reasons.push('annee eloignee');
    if (!v.mileageMatch) reasons.push('km eloigne');
    const offBadge = !isComparable && !nonRoulant && reasons.length > 0
      ? `<span class="badge-off" title="Exclu du prix moyen — ${esc(reasons.join(', '))}">hors echantillon</span>`
      : '';
    return `
      <div class="similar-item${nonRoulant ? ' similar-item--nr' : ''}" data-vehicle-url="${esc(v.sourceUrl)}">
        ${renderThumbnail(v.photoUrls, `${v.brand} ${v.model}`)}
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(v.brand)} ${esc(v.model)}
            ${isComparable ? '<span class="badge-match">Match</span>' : ''}
            ${offBadge}
            ${nonRoulant ? '<span class="badge-nr" title="Exclu du prix moyen — véhicule non roulant">NON ROULANT</span>' : ''}
          </div>
          <div class="similar-item__meta">${v.year} \u2022 ${formatDistance(v.mileage)} \u2022 ${esc(v.city)}</div>
        </div>
        <div class="similar-item__prices">
          <div class="similar-item__sold">Adjuge ${formatPrice(v.soldPrice)}</div>
          ${v.startingPrice ? `<div class="similar-item__start">${formatPrice(v.startingPrice)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      ${renderCardTitle('💰', 'Intelligence prix', { count: stats.count || data.results.length, tone: 'blue' })}
      ${recommendHtml}
      ${items ? `<div class="similar-list">${items}</div>` : ''}
    </section>
  `;
}

function renderPriceChart(history: VehicleHistory | null): string {
  if (!history || history.priceHistory.length < 2) return '';

  const prices = history.priceHistory;
  const min = Math.min(...prices.map(p => p.price));
  const max = Math.max(...prices.map(p => p.price));
  const range = max - min || 1;
  const w = 280;
  const h = 60;

  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((p.price - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');

  const first = prices[0].price;
  const last = prices[prices.length - 1].price;
  const diff = last - first;
  const diffClass = diff < 0 ? 'price-down' : diff > 0 ? 'price-up' : '';
  const diffText = diff < 0
    ? `\u25BC ${Math.abs(diff).toLocaleString('fr-FR')} \u20AC`
    : diff > 0
    ? `\u25B2 ${diff.toLocaleString('fr-FR')} \u20AC`
    : '\u2192 Stable';

  return `
    <section class="card">
      ${renderCardTitle('📈', 'Evolution prix', { tone: 'purple' })}
      <div class="price-chart">
        <svg viewBox="0 0 ${w} ${h}" class="price-svg">
          <defs>
            <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${diff <= 0 ? '#22c55e' : '#ef4444'}" stop-opacity="0.3"/>
              <stop offset="100%" stop-color="${diff <= 0 ? '#22c55e' : '#ef4444'}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <polygon points="0,${h} ${points} ${w},${h}" fill="url(#priceGrad)" />
          <polyline points="${points}" fill="none" stroke="${diff <= 0 ? '#22c55e' : '#ef4444'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="price-chart__labels">
          <span>${formatPrice(first)}</span>
          <span class="price-chart__diff ${diffClass}">${diffText}</span>
          <span>${formatPrice(last)}</span>
        </div>
      </div>
    </section>
  `;
}

function renderAuctionSummary(list: Partial<VehicleSnapshot>[]): string {
  const total = list.length;
  const sold = list.filter(v => v.status === 'sold');
  const unsold = list.filter(v => v.status === 'unsold');
  const available = total - sold.length - unsold.length;
  const nonRoulant = list.filter(v => isNonRoulant(v));

  // Price stats
  const soldPrices = sold.filter(v => v.soldPrice).map(v => v.soldPrice!);
  const startPrices = list.filter(v => v.startingPrice).map(v => v.startingPrice!);
  const totalSoldValue = soldPrices.reduce((a, b) => a + b, 0);
  const avgSoldPrice = soldPrices.length > 0 ? Math.round(totalSoldValue / soldPrices.length) : 0;
  const minPrice = startPrices.length > 0 ? Math.min(...startPrices) : 0;
  const maxPrice = startPrices.length > 0 ? Math.max(...startPrices) : 0;

  // Margins (sold price vs starting price)
  const margins = sold
    .filter(v => v.soldPrice && v.startingPrice)
    .map(v => v.soldPrice! - v.startingPrice!);
  const avgMargin = margins.length > 0 ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : 0;

  // Cities
  const cities = new Map<string, number>();
  for (const v of list) {
    if (v.city) cities.set(v.city, (cities.get(v.city) || 0) + 1);
  }

  return `
    <section class="card">
      ${renderCardTitle('📊', "Resume de l'enchere", { count: total, tone: 'blue' })}

      <div class="auction-stats">
        <div class="auction-stat">
          <div class="auction-stat__value">${total}</div>
          <div class="auction-stat__label">Total lots</div>
        </div>
        <div class="auction-stat">
          <div class="auction-stat__value auction-stat--green">${sold.length}</div>
          <div class="auction-stat__label">Vendus</div>
        </div>
        <div class="auction-stat">
          <div class="auction-stat__value auction-stat--red">${unsold.length}</div>
          <div class="auction-stat__label">Invendus</div>
        </div>
        <div class="auction-stat">
          <div class="auction-stat__value auction-stat--blue">${available}</div>
          <div class="auction-stat__label">En attente</div>
        </div>
      </div>

      ${sold.length > 0 ? `
        <div class="auction-detail">
          <div class="auction-detail__row">
            <span>Chiffre d'affaires</span>
            <span class="auction-detail__value">${formatPrice(totalSoldValue)}</span>
          </div>
          <div class="auction-detail__row">
            <span>Prix adjuge moyen</span>
            <span class="auction-detail__value">${formatPrice(avgSoldPrice)}</span>
          </div>
          ${margins.length > 0 ? `
            <div class="auction-detail__row">
              <span>Ecart moyen vs mise a prix</span>
              <span class="auction-detail__value ${avgMargin >= 0 ? 'price-up' : 'price-down'}">${avgMargin >= 0 ? '+' : ''}${avgMargin.toLocaleString('fr-FR')} \u20AC</span>
            </div>
          ` : ''}
          <div class="auction-detail__row">
            <span>Taux de vente</span>
            <span class="auction-detail__value">${total > 0 ? Math.round(sold.length / total * 100) : 0}%</span>
          </div>
        </div>
      ` : ''}

      <div class="auction-detail">
        <div class="auction-detail__row">
          <span>Fourchette prix</span>
          <span class="auction-detail__value">${formatPrice(minPrice)} - ${formatPrice(maxPrice)}</span>
        </div>
        ${nonRoulant.length > 0 ? `
          <div class="auction-detail__row">
            <span>Non roulants</span>
            <span class="auction-detail__value" style="color:var(--amber)">${nonRoulant.length} vehicules</span>
          </div>
        ` : ''}
        ${cities.size > 1 ? `
          <div class="auction-detail__row">
            <span>Villes</span>
            <span class="auction-detail__value">${[...cities.entries()].map(([c, n]) => `${c} (${n})`).join(', ')}</span>
          </div>
        ` : ''}
      </div>
    </section>
  `;
}

function renderTrackingAlerts(tracking: BatchTrackingResult): string {
  const alerts: string[] = [];

  if (tracking.newVehicles > 0) {
    alerts.push(`
      <div class="alert alert--green">
        <span class="alert__icon">&#10024;</span>
        <div>
          <strong>${tracking.newVehicles} nouveau${tracking.newVehicles > 1 ? 'x' : ''} vehicule${tracking.newVehicles > 1 ? 's' : ''}</strong>
          <p>Detecte${tracking.newVehicles > 1 ? 's' : ''} pour la premiere fois</p>
        </div>
      </div>
    `);
  }

  if (tracking.priceChanges.length > 0) {
    const drops = tracking.priceChanges.filter(p => p.diff < 0);
    const ups = tracking.priceChanges.filter(p => p.diff > 0);

    if (drops.length > 0) {
      alerts.push(`
        <div class="alert alert--green">
          <span class="alert__icon">&#9660;</span>
          <div>
            <strong>${drops.length} baisse${drops.length > 1 ? 's' : ''} de prix</strong>
            <p>${drops.map(d => `${Math.abs(d.diff).toLocaleString('fr-FR')} \u20AC`).join(', ')}</p>
          </div>
        </div>
      `);
    }

    if (ups.length > 0) {
      alerts.push(`
        <div class="alert alert--red">
          <span class="alert__icon">&#9650;</span>
          <div>
            <strong>${ups.length} hausse${ups.length > 1 ? 's' : ''} de prix</strong>
            <p>${ups.map(d => `+${d.diff.toLocaleString('fr-FR')} \u20AC`).join(', ')}</p>
          </div>
        </div>
      `);
    }
  }

  if (tracking.disappeared.length > 0) {
    const count = tracking.disappeared.length;
    alerts.push(`
      <div class="alert alert--amber">
        <span class="alert__icon">&#128683;</span>
        <div>
          <strong>${count} vehicule${count > 1 ? 's' : ''} disparu${count > 1 ? 's' : ''}</strong>
          <p>${tracking.disappeared.slice(0, 3).map(d => `${d.brand} ${d.model}`).join(', ')}${count > 3 ? ` et ${count - 3} autres` : ''}</p>
        </div>
      </div>
    `);
  }

  if (alerts.length === 0) return '';
  return `<div class="alerts-stack">${alerts.join('')}</div>`;
}

function renderTrackingSummary(tracking?: BatchTrackingResult): string {
  if (!tracking) return '';
  return `
    <div class="tracking-bar">
      <div class="tracking-stat">
        <span class="tracking-stat__value">${tracking.saved}</span>
        <span class="tracking-stat__label">Sauves</span>
      </div>
      <div class="tracking-stat">
        <span class="tracking-stat__value tracking-stat--green">${tracking.newVehicles}</span>
        <span class="tracking-stat__label">Nouveaux</span>
      </div>
      <div class="tracking-stat">
        <span class="tracking-stat__value tracking-stat--blue">${tracking.priceChanges.length}</span>
        <span class="tracking-stat__label">Prix changes</span>
      </div>
      <div class="tracking-stat">
        <span class="tracking-stat__value tracking-stat--amber">${tracking.disappeared.length}</span>
        <span class="tracking-stat__label">Disparus</span>
      </div>
    </div>
  `;
}

function renderCaptureBar(state: StoredPanelState): string {
  // The capture bar lives inside the post-import section so it only appears
  // once the user has actually scraped a list. Buttons stay enabled even
  // when an empty plan is likely — the planner is cheap and the user
  // gets immediate feedback ("Aucun véhicule à capturer dans cette catégorie").
  const list = state.currentVehicleList || [];
  const job = captureJob;
  const counts = importJob?.capturePlanCounts;
  const isWorking = !!job && (job.status === 'planning' || job.status === 'running');
  const canStart = !isWorking && list.length > 0;
  const labelWithCount = (label: string, bucket: CaptureBucket): string => {
    if (!counts || counts.error) return label;
    return `${label} (${counts[bucket]})`;
  };

  return `
    <div class="capture-bar">
      <div class="capture-bar__head">
        <strong>📷 Captures VPauto</strong>
        <span class="capture-bar__hint">
          Detecte les vehicules nouveaux/modifies et capture leur fiche en arriere-plan.
        </span>
      </div>
      <div class="capture-bar__buttons">
        <button class="btn btn--primary" type="button" data-action="capture-bucket" data-capture-bucket="new" ${canStart ? '' : 'disabled'}>
          📷 ${labelWithCount('Nouveaux', 'new')}
        </button>
        <button class="btn btn--ghost" type="button" data-action="capture-bucket" data-capture-bucket="modified" ${canStart ? '' : 'disabled'}>
          📷 ${labelWithCount('Modifies', 'modified')}
        </button>
        <button class="btn btn--ghost" type="button" data-action="capture-bucket" data-capture-bucket="missing" ${canStart ? '' : 'disabled'}>
          📷 ${labelWithCount('Manquants', 'missing')}
        </button>
      </div>
      ${renderCaptureJobState()}
    </div>
  `;
}

function renderCaptureJobState(): string {
  if (!captureJob) return '';
  const job = captureJob;
  const percent = job.total > 0
    ? Math.max(4, Math.min(100, Math.round((job.processed / job.total) * 100)))
    : (job.status === 'planning' ? 8 : 100);
  const bucketName = job.bucket ? captureBucketLabel(job.bucket) : '';

  // Action buttons shown depending on status.
  const buttons: string[] = [];
  if (job.status === 'running') {
    buttons.push(`<button class="btn btn--ghost btn--small" type="button" data-action="capture-pause">Pause</button>`);
    buttons.push(`<button class="btn btn--ghost btn--small" type="button" data-action="capture-cancel">Arreter</button>`);
  } else if (job.status === 'paused') {
    buttons.push(`<button class="btn btn--primary btn--small" type="button" data-action="capture-resume">Reprendre</button>`);
    buttons.push(`<button class="btn btn--ghost btn--small" type="button" data-action="capture-cancel">Arreter</button>`);
  } else if (job.status === 'planning') {
    buttons.push(`<button class="btn btn--ghost btn--small" type="button" data-action="capture-cancel">Annuler</button>`);
  } else {
    // done | error | cancelled — only "Fermer"
    buttons.push(`<button class="btn btn--ghost btn--small" type="button" data-action="capture-dismiss">Fermer</button>`);
  }

  return `
    <div class="capture-job capture-job--${job.status}">
      <div class="capture-job__top">
        <strong>${esc(job.lastMessage || 'Capture')}</strong>
        <span>${esc(bucketName)} · ${esc(job.status)}</span>
      </div>
      <div class="capture-job__progress">
        <div class="capture-job__bar" style="width:${percent}%"></div>
      </div>
      <div class="capture-job__stats">
        <span>${job.processed}/${job.total || '?'}</span>
        <span class="capture-job__stat--ok">${job.succeeded} ok</span>
        <span class="capture-job__stat--err">${job.failed} echecs</span>
      </div>
      ${job.currentLabel ? `<div class="capture-job__current">${esc(job.currentLabel)}</div>` : ''}
      ${job.errors.length ? `<div class="capture-job__errors">${job.errors.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
      <div class="capture-job__actions">${buttons.join('')}</div>
    </div>
  `;
}

function renderVehicleList(list: Partial<VehicleSnapshot>[]): string {
  const sorted = [...list].sort((a, b) => (a.startingPrice ?? 0) - (b.startingPrice ?? 0));
  const displayed = sorted.slice(0, 50);

  // Stats
  const soldCount = list.filter(v => v.status === 'sold').length;
  const unsoldCount = list.filter(v => v.status === 'unsold').length;
  const availableCount = list.length - soldCount - unsoldCount;
  const nonRoulantCount = list.filter(v => isNonRoulant(v)).length;

  const items = displayed.map(v => {
    const name = [v.brand, v.model].filter(Boolean).join(' ') || 'Vehicule';
    const meta: string[] = [];
    if (v.year) meta.push(String(v.year));
    if (v.mileage) meta.push(formatDistance(v.mileage));
    if (v.city) meta.push(v.city);
    if (isNonRoulant(v)) meta.push('Non roulant');
    const url = v.sourceUrl || (v.hashId ? `https://www.vpauto.fr/vehicule/${v.hashId}/` : '');

    const isSold = v.status === 'sold';
    const isUnsold = v.status === 'unsold';
    const nonRoulant = isNonRoulant(v);
    const statusClass = isSold ? ' vehicle-card--sold' : isUnsold ? ' vehicle-card--unsold' : '';
    const nrClass = nonRoulant ? ' vehicle-card--nr' : '';

    // Live bid ("Enchère en cours") is displayed distinctly from the MAP.
    // When an auction is currently running, VPauto's list card shows the
    // bid value without a "Mise à prix" label — we now capture it as
    // `currentAuctionPrice` and surface it here so the user can tell at a
    // glance "this is a live auction, current bid is X" vs "this is the
    // seller's reserve price".
    const liveBidHtml = v.currentAuctionPrice
      ? `<div class="vehicle-card__live-bid">Enchere ${formatPrice(v.currentAuctionPrice)}</div>`
      : '';
    const priceDisplay = isSold && v.soldPrice
      ? `<div class="vehicle-card__sold-price">Adjuge ${formatPrice(v.soldPrice)}</div>${v.startingPrice ? `<div class="vehicle-card__start-price">${formatPrice(v.startingPrice)}</div>` : ''}`
      : isUnsold
      ? `<div class="vehicle-card__unsold">Invendu</div>${v.startingPrice ? `<div class="vehicle-card__start-price">${formatPrice(v.startingPrice)}</div>` : ''}`
      : `${liveBidHtml}${v.startingPrice ? `<div class="vehicle-card__price">${formatPrice(v.startingPrice)}</div>` : ''}`;

    return `
      <div class="vehicle-card${statusClass}${nrClass}" ${url ? `data-vehicle-url="${esc(url)}"` : ''}>
        <div class="vehicle-card__info">
          <div class="vehicle-card__name">${esc(name)}${nonRoulant ? ' <span class="badge-nr">NR</span>' : ''}</div>
          <div class="vehicle-card__meta">${esc(meta.join(' \u2022 '))}</div>
        </div>
        <div class="vehicle-card__pricing">${priceDisplay}</div>
      </div>
    `;
  }).join('');

  const moreText = list.length > 50 ? `<div class="list-more">et ${list.length - 50} autres vehicules...</div>` : '';

  const statsLine = [
    availableCount > 0 ? `${availableCount} disponibles` : '',
    soldCount > 0 ? `${soldCount} adjuges` : '',
    unsoldCount > 0 ? `${unsoldCount} invendus` : '',
    nonRoulantCount > 0 ? `${nonRoulantCount} non roulants` : '',
  ].filter(Boolean).join(' \u2022 ');

  return `
    <section class="card">
      ${renderCardTitle('🚗', 'Vehicules detectes', { count: list.length, tone: 'green' })}
      ${statsLine ? `<div class="list-stats">${statsLine}</div>` : ''}
      <div class="vehicle-list">${items}</div>
      ${moreText}
    </section>
  `;
}

function renderEmptyState(isApiOnline: boolean): string {
  return `
    <section class="empty-hero">
      <div class="empty-hero__icon">&#128269;</div>
      <h2>En attente</h2>
      <p>Naviguez sur une page VPauto pour commencer l'analyse.</p>
      <p class="empty-hero__status">${isApiOnline ? 'Backend connecte' : 'Backend hors ligne'}</p>
    </section>
  `;
}

function renderUserListNotice(isApiOnline: boolean): string {
  return `
    <section class="empty-hero">
      <div class="empty-hero__icon">&#128663;</div>
      <h2>Liste VPauto</h2>
      <p>Ouvrez une fiche vehicule pour afficher l'analyse.</p>
      <p class="empty-hero__status">${isApiOnline ? 'Backend connecte' : 'Backend hors ligne'}</p>
    </section>
  `;
}

function renderImportSection(state: StoredPanelState, isApiOnline: boolean): string {
  const list = state.currentVehicleList || [];
  const listUrl = state.scrapeDebug?.pageType === 'list' ? state.scrapeDebug.url : '';
  const canStart = isApiOnline
    && !!list.length
    && importOptions.mode === 'silent'
    && !importJob?.status?.match(/^(preparing|running)$/);
  const modeHint = importOptions.mode === 'silent'
    ? 'Recupere les fiches et les sauvegarde sans ouvrir une serie d’onglets.'
    : 'Le mode avec onglets sera ajoute ensuite. Le flux silencieux est la voie fiable pour l’instant.';

  return `
    <section class="card import-card">
      <div class="import-card__header">
        <div>
          <h2 class="card__title"><span class="card__icon">&#128190;</span> Importer cette vente</h2>
          <p class="import-card__subtitle">Alimente la base locale a la demande, sans ouvrir chaque fiche a la main.</p>
        </div>
        <span class="chip chip--blue">${importOptions.mode === 'silent' ? 'Silencieux' : 'Avec onglets'}</span>
      </div>

      <div class="import-grid">
        <label class="field">
          <span class="field__label">Portee</span>
          <select class="field__control" data-import-scope>
            <option value="detected" ${importOptions.scope === 'detected' ? 'selected' : ''}>Vehicules detectes (${list.length})</option>
            <option value="current_page" ${importOptions.scope === 'current_page' ? 'selected' : ''}>Page courante</option>
            <option value="first_n" ${importOptions.scope === 'first_n' ? 'selected' : ''}>N premiers</option>
            <option value="page_range" ${importOptions.scope === 'page_range' ? 'selected' : ''}>Pages X a Y</option>
          </select>
        </label>

        <label class="field">
          <span class="field__label">Mode</span>
          <select class="field__control" data-import-mode>
            <option value="silent" ${importOptions.mode === 'silent' ? 'selected' : ''}>Silencieux (recommande)</option>
            <option value="visible" ${importOptions.mode === 'visible' ? 'selected' : ''}>Avec onglets (bientot)</option>
          </select>
        </label>
      </div>

      <div class="import-grid import-grid--secondary">
        ${importOptions.scope === 'first_n' ? `
          <label class="field">
            <span class="field__label">Nombre</span>
            <input class="field__control" type="number" min="1" step="1" value="${importOptions.firstN}" data-import-first-n>
          </label>
        ` : ''}
        ${importOptions.scope === 'page_range' ? `
          <label class="field">
            <span class="field__label">Page de debut</span>
            <input class="field__control" type="number" min="1" step="1" value="${importOptions.fromPage}" data-import-from-page>
          </label>
          <label class="field">
            <span class="field__label">Page de fin</span>
            <input class="field__control" type="number" min="${importOptions.fromPage}" step="1" value="${importOptions.toPage}" data-import-to-page>
          </label>
        ` : ''}
      </div>

      <div class="import-hint">
        <div>${esc(modeHint)}</div>
        ${listUrl ? `<div class="import-hint__meta">Source liste: ${esc(shortenUrl(listUrl))}</div>` : ''}
      </div>

      ${renderImportJobState()}

      <div class="actions-bar actions-bar--import">
        <button class="btn btn--primary" type="button" data-action="start-import" ${canStart ? '' : 'disabled'}>
          &#11015; Lancer l'import
        </button>
        <button class="btn btn--ghost" type="button" data-action="cancel-import" ${(importJob?.status === 'running' || importJob?.status === 'preparing') ? '' : 'disabled'}>
          Arreter
        </button>
      </div>
    </section>
  `;
}

function renderImportJobState(): string {
  if (!importJob || importJob.status === 'idle') {
    return `
      <div class="import-job import-job--idle">
        <div class="import-job__meta">Pret a lancer un import cible.</div>
      </div>
    `;
  }

  const percent = importJob.total > 0
    ? Math.max(4, Math.min(100, Math.round((importJob.processed / importJob.total) * 100)))
    : (importJob.status === 'preparing' ? 8 : 100);
  const {
    pageItems: visibleChanges,
    totalMatches,
    totalPages,
    currentPage,
  } = getVisibleImportChanges();
  const capturePlanSummary = renderImportCapturePlanSummary(importJob.capturePlanCounts);

  return `
    <div class="import-job import-job--${importJob.status}">
      <div class="import-job__top">
        <strong>${esc(importJob.lastMessage || 'Import')}</strong>
        <span>${esc(importJob.status)}</span>
      </div>
      <div class="import-job__progress">
        <div class="import-job__bar" style="width:${percent}%"></div>
      </div>
      <div class="import-job__stats">
        <span>${importJob.processed}/${importJob.total || '?'}</span>
        <span>${importJob.saved} sauves</span>
        <span>${importJob.duplicates} deja connus</span>
        <span>${importJob.failed} erreurs</span>
      </div>
      <div class="import-job__stats import-job__stats--secondary">
        <span>${importJob.newVehicles} nouveaux</span>
        <span>${importJob.updated} mis a jour</span>
        <span>${importJob.unchanged} inchanges</span>
        <span>${importJob.priceUps} hausses</span>
        <span>${importJob.priceDowns} baisses</span>
        <span>${importJob.statusChanges} statuts modifies</span>
      </div>
      ${capturePlanSummary}
      ${importJob.currentLabel ? `<div class="import-job__current">${esc(importJob.currentLabel)}</div>` : ''}
      ${importJob.changes.length ? `
        <div class="import-job__toolbar">
          <input
            class="field__control import-job__search"
            type="search"
            placeholder="Rechercher un vehicule, ex: Peugeot"
            value="${esc(importChangeQuery)}"
            data-import-change-query
          >
          <select class="field__control import-job__filter" data-import-change-filter>
            <option value="all" ${importChangeFilter === 'all' ? 'selected' : ''}>Tous (${importJob.changes.length})</option>
            <option value="new" ${importChangeFilter === 'new' ? 'selected' : ''}>Nouveaux</option>
            <option value="updated" ${importChangeFilter === 'updated' ? 'selected' : ''}>Mises a jour</option>
            <option value="price_up" ${importChangeFilter === 'price_up' ? 'selected' : ''}>Prix en hausse</option>
            <option value="price_down" ${importChangeFilter === 'price_down' ? 'selected' : ''}>Prix en baisse</option>
            <option value="status_change" ${importChangeFilter === 'status_change' ? 'selected' : ''}>Statut modifie</option>
          </select>
        </div>
        <div class="import-job__meta import-job__meta--changes">
          ${totalMatches} resultat${totalMatches > 1 ? 's' : ''} ${importChangeFilter !== 'all' ? `• filtre: ${esc(importChangeFilter)}` : ''}
        </div>
        <div class="import-job__changes">
          ${visibleChanges.length ? visibleChanges.map((change) => `
            <div class="import-job__change import-job__change--${change.kind}">
              <div class="import-job__change-head">
                <strong>${esc(change.label)}</strong>
                ${change.url ? `<button class="btn btn--ghost btn--small import-job__change-link" type="button" data-vehicle-url="${esc(change.url)}">Ouvrir</button>` : ''}
              </div>
              <span class="import-job__change-detail">${esc(change.detail)}</span>
              ${change.updates && change.updates.length ? `
                <ul class="import-job__updates">
                  ${change.updates.map((u) => `
                    <li class="import-job__update import-job__update--${u.direction}">
                      <span class="import-job__update-label">${esc(u.label)}</span>
                      <span class="import-job__update-values">
                        <span class="import-job__update-before">${esc(u.before)}</span>
                        <span class="import-job__update-arrow" aria-hidden="true">→</span>
                        <span class="import-job__update-after">${esc(u.after)}</span>
                        ${u.delta ? `<span class="import-job__update-delta import-job__update-delta--${u.direction}">${esc(u.delta)}</span>` : ''}
                      </span>
                    </li>
                  `).join('')}
                </ul>
              ` : ''}
            </div>
          `).join('') : `
            <div class="import-job__empty">
              Aucun changement ne correspond a ce filtre.
            </div>
          `}
        </div>
        ${totalPages > 1 ? `
          <div class="import-job__pager">
            <button class="btn btn--ghost btn--small" type="button" data-action="import-changes-prev" ${currentPage <= 1 ? 'disabled' : ''}>Prec.</button>
            <span>Page ${currentPage}/${totalPages}</span>
            <button class="btn btn--ghost btn--small" type="button" data-action="import-changes-next" ${currentPage >= totalPages ? 'disabled' : ''}>Suiv.</button>
          </div>
        ` : ''}
      ` : ''}
      ${importJob.errors.length ? `<div class="import-job__errors">${importJob.errors.map((error) => `<div>${esc(error)}</div>`).join('')}</div>` : ''}
    </div>
  `;
}

function renderImportCapturePlanSummary(counts?: CapturePlanCounts): string {
  if (!counts) return '';
  if (counts.error) {
    return `<div class="import-job__meta">Captures: ${esc(counts.error)}</div>`;
  }

  return `
    <div class="import-job__meta">
      Captures a faire: ${counts.modified} modifiee${counts.modified > 1 ? 's' : ''}
      · ${counts.new} nouvelle${counts.new > 1 ? 's' : ''}
      · ${counts.missing} manquante${counts.missing > 1 ? 's' : ''}
    </div>
  `;
}

function renderActionsBar(hasSource: boolean): string {
  const debugButton = hasAccess('debug:view')
    ? `<button class="btn btn--ghost btn--small" type="button" data-action="toggle-debug" title="Diagnostic">
        ${showDebug ? 'Masquer' : 'Debug'}
      </button>`
    : '';

  return `
    <div class="actions-bar">
      <button class="btn btn--primary" type="button" data-action="refresh">
        <span aria-hidden="true">🔄</span>
        Rafraichir
      </button>
      ${hasSource ? `<button class="btn btn--ghost" type="button" data-action="open-source">
        <span aria-hidden="true">🔗</span>
        Ouvrir
      </button>` : ''}
      ${debugButton}
    </div>
  `;
}

// ── VPauto 404 fallback ──────────────────────────────────────────────────
// When VPauto itself returns 404 for a fiche we have in DB, the content
// script flips `vpauto404 = true` on the stored currentVehicle. We then
// render two extra blocks at the top of the panel:
//   1. a yellow banner explaining the situation + a "Réessayer sur VPauto"
//      link to the original URL (in case the page comes back later)
//   2. a hero capture of the VPauto fiche taken at scrape time (when
//      `snapshot.hasScreenshot && snapshot.id` are present), wrapped in a
//      button that opens the full-screen lightbox.
// All other sections (metrics, history, similar, ...) continue to render
// from the DB snapshot so the user still sees the full assistant view.

function buildScreenshotUrl(snapshotId: number): string {
  return `${getApiBaseUrl()}/api/vehicles/screenshot/${snapshotId}`;
}

function renderVpauto404Banner(snapshot: VehicleSnapshot, sourceUrl?: string): string {
  const retryUrl = sourceUrl || snapshot.sourceUrl;
  const hasScreenshot = Boolean(snapshot.hasScreenshot && snapshot.id != null);
  const hero = hasScreenshot
    ? `
      <button
        class="vpauto404-hero__btn"
        type="button"
        data-action="open-vpauto404-lightbox"
        data-screenshot-url="${esc(buildScreenshotUrl(snapshot.id as number))}"
        aria-label="Agrandir la capture VPauto archivee"
      >
        <img
          class="vpauto404-hero__img"
          src="${esc(buildScreenshotUrl(snapshot.id as number))}"
          alt="Capture archivee de la fiche VPauto"
          loading="lazy"
        />
        <span class="vpauto404-hero__zoom">Agrandir</span>
      </button>`
    : `<div class="vpauto404-hero__missing">Pas de capture archivee pour ce passage.</div>`;

  return `
    <section class="vpauto404-banner" role="alert">
      <div class="vpauto404-banner__head">
        <span class="vpauto404-banner__tag">VPauto 404</span>
        <h3 class="vpauto404-banner__title">La fiche VPauto n'est plus disponible</h3>
      </div>
      <p class="vpauto404-banner__body">
        VPauto a renvoye une erreur 404 pour cette fiche. Les informations affichees
        proviennent de la derniere capture stockee localement par l'extension.
        ${retryUrl ? `<a class="vpauto404-banner__retry" href="${esc(retryUrl)}" target="_blank" rel="noreferrer">Reessayer sur VPauto</a>` : ''}
      </p>
    </section>
    <section class="vpauto404-hero">
      <div class="vpauto404-hero__label">Capture VPauto archivee</div>
      ${hero}
    </section>
  `;
}

function renderVpauto404Lightbox(): string {
  return `
    <div class="lightbox" data-vpauto404-lightbox data-open="false" role="dialog" aria-modal="true" aria-label="Capture VPauto archivee">
      <button class="lightbox__close" type="button" data-action="close-vpauto404-lightbox" aria-label="Fermer">×</button>
      <img class="lightbox__img" alt="Capture VPauto archivee" />
    </div>
  `;
}

// ── Vehicle hero: ref + serif title + mono meta + badges + linear-gauge verdict ──

/**
 * Format a time-to-sale countdown "T− HH:MM:SS" from a saleDate/saleTime
 * pair. Returns undefined when no sale is scheduled or when the auction
 * has already started (the caller then hides the ticker entirely).
 */
function computeCountdown(snapshot: VehicleSnapshot): string | undefined {
  if (!snapshot.saleDate) return undefined;
  const timePart = snapshot.saleTime && /^\d{1,2}:\d{2}/.test(snapshot.saleTime)
    ? snapshot.saleTime.slice(0, 5)
    : '10:00';
  const target = new Date(`${snapshot.saleDate}T${timePart}:00`);
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  if (Number.isNaN(diff) || diff <= 0) return undefined;
  const totalSeconds = Math.floor(diff / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function renderTicker(snapshot: VehicleSnapshot): string {
  const startTime = snapshot.saleTime?.slice(0, 8) || (snapshot.saleDate ? '10:00:00' : '');
  const countdown = computeCountdown(snapshot);

  // Status priority: a terminal status (sold / unsold) always wins over the
  // countdown or "EN COURS" fallback — the ticker must never claim "EN COURS"
  // for a vehicle that is actually adjugé (Toyota Yaris Cross 11403878 bug:
  // 4 sold snapshots but the ticker still read "EN COURS"). For a non-terminal
  // vehicle, prefer the countdown; fall back to the live/available label.
  let rightKey: string;
  let rightValue: string;
  if (snapshot.status === 'sold') {
    rightKey = 'STATUT';
    rightValue = 'ADJUGÉ';
  } else if (snapshot.status === 'unsold') {
    rightKey = 'STATUT';
    rightValue = 'NON ADJUGÉ';
  } else if (snapshot.status === 'removed') {
    rightKey = 'STATUT';
    rightValue = 'RETIRÉ';
  } else if (countdown) {
    rightKey = 'T−';
    rightValue = countdown;
  } else if (snapshot.status === 'auction_live') {
    rightKey = 'STATUT';
    rightValue = 'EN COURS';
  } else {
    // 'available' without a countdown (e.g. missing saleDate): stay neutral.
    rightKey = 'STATUT';
    rightValue = 'À VENIR';
  }

  if (!countdown && !startTime && snapshot.status !== 'sold' && snapshot.status !== 'unsold' && snapshot.status !== 'removed') {
    return '';
  }
  const dateLabel = snapshot.saleDate ? formatDate(snapshot.saleDate).toUpperCase() : 'SANS DATE';
  return `
    <div class="ticker" data-sale-date="${esc(snapshot.saleDate || '')}" data-sale-time="${esc(snapshot.saleTime || '')}" data-status="${esc(snapshot.status)}">
      <div class="ticker-col">
        <div class="k">Début vente · ${esc(dateLabel)}</div>
        <div class="v">${esc(startTime || '—')}</div>
      </div>
      <div class="ticker-sep"></div>
      <div class="ticker-col right">
        <div class="k">${esc(rightKey)}</div>
        <div class="v" data-countdown>${esc(rightValue)}</div>
      </div>
    </div>
  `;
}

/**
 * Hero block for a scraped vehicle: reference line, serif title, mono
 * meta row, and (when enough data) a linear-gauge verdict panel that
 * shows the MAP and marché markers on the same €/€ scale.
 */
function renderVehicleHero(snapshot: VehicleSnapshot, vehicleId?: number): string {
  const brand = (snapshot.brand || '').trim();
  const model = (snapshot.model || '').trim();
  const version = (snapshot.version || '').trim();
  const vehicleTitle = [brand, model, version].filter(Boolean).join(' ') || 'Véhicule VPauto';
  const metaParts: string[] = [];
  if (snapshot.year) metaParts.push(String(snapshot.year));
  if (snapshot.mileage) metaParts.push(formatDistance(snapshot.mileage));
  if (snapshot.city) metaParts.push(snapshot.city);
  if (vehicleId) metaParts.push(`#${vehicleId}`);

  return `
    <div class="veh-pill">
      <div class="veh-icon">🚗</div>
      <div class="veh-info">
        <div class="veh-name">${esc(vehicleTitle)}</div>
        ${metaParts.length ? `<div class="veh-meta">${metaParts.map((part) => `<span>${esc(part)}</span>`).join('<span class="sep">·</span>')}</div>` : ''}
      </div>
    </div>
  `;
}

/**
 * Verdict panel with explicit price-source separation.
 * We never label the live bid (`currentAuctionPrice`) as "Mise à prix":
 * the marker/cells say "Mise à prix" only when `startingPrice` is known.
 * If the MAP is missing, we keep the verdict but mark the live bid as
 * "Enchère live" (or "Adjugé" on sold vehicles) and show "MAP inconnue".
 */
function renderVerdict(
  snapshot: VehicleSnapshot,
  startingPrice: number | undefined,
  similarSold: SimilarSoldData | null | undefined,
  insightArg?: VerdictInsight | null,
): string {
  const insight = insightArg ?? buildVerdictInsight(snapshot, startingPrice, similarSold);
  if (!insight) return '';
  const gaugeRadius = 39;
  const gaugeCircumference = 2 * Math.PI * gaugeRadius;
  const gaugeOffset = gaugeCircumference * (1 - insight.score / 100);
  const markerPct = Math.max(4, Math.min(96, insight.markerPct));
  const kmPerYear = insight.kmPerYear ? numberFormatter.format(Math.round(insight.kmPerYear)) : 'N/D';
  const marketLine = insight.marketValue
    ? `Prix marche <b>${formatPrice(insight.market)}</b> · Cote Argus <b>${formatPrice(insight.marketValue)}</b>`
    : `Prix marche <b>${formatPrice(insight.market)}</b> · ${insight.comparableCount} comparable${insight.comparableCount > 1 ? 's' : ''}`;

  return `
    <div class="verdict-card ${insight.tone}">
      <div class="v-top">
        <div class="v-emoji">${insight.emoji}</div>
        <div class="v-right">
          <div class="v-tag">${esc(insight.tag)}</div>
          <div class="v-title">${esc(insight.title)}</div>
          <div class="v-sub">${marketLine}</div>
        </div>
      </div>
      <div class="v-score">
        <div class="donut-wrap">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle class="donut-bg" cx="50" cy="50" r="${gaugeRadius}"></circle>
            <circle
              class="donut-fg"
              cx="50"
              cy="50"
              r="${gaugeRadius}"
              stroke-dasharray="${gaugeCircumference.toFixed(2)}"
              stroke-dashoffset="${gaugeOffset.toFixed(2)}"
            ></circle>
          </svg>
          <div class="donut-val"><b>${insight.score}</b><small>/100</small></div>
        </div>
        <div class="score-items">
          <div class="score-row"><span class="k">Prix moyen adjuge</span><span class="v">${formatPrice(insight.market)}</span></div>
          <div class="score-row"><span class="k">${esc(insight.marketValue ? 'Cote Argus' : 'Reference')}</span><span class="v">${formatPrice(insight.marketValue ?? insight.rangeMax)}</span></div>
          <div class="score-row"><span class="k">Km / an</span><span class="v">${kmPerYear}</span></div>
        </div>
      </div>
      <div class="pbar-wrap">
        <div class="pbar-label">
          <span>Moins cher</span>
          <span>Dans le marche</span>
          <span>Cher</span>
        </div>
        <div class="pbar-track">
          <div class="pbar-fill" style="width:${insight.fillPct.toFixed(1)}%"></div>
          <div class="pbar-marker" style="left:${markerPct.toFixed(1)}%" data-label="${esc(insight.referenceLabel || 'MISE A PRIX')}"></div>
        </div>
        <div class="pbar-ticks">
          <span>${formatShortPrice(insight.rangeMin)}</span>
          <span>${formatShortPrice(insight.market)}</span>
          <span>${formatShortPrice(insight.rangeMax)}</span>
        </div>
      </div>
    </div>
  `;
}

function formatShortPrice(v: number): string {
  if (v >= 1000) return `${numberFormatter.format(Math.round(v))} €`;
  return formatPrice(v);
}

/**
 * Floating settings panel: account session plus visual preferences. The
 * panel is kept in the DOM on every render so
 * its open/close state is driven by a single `.on` class toggle; all
 * settings persist via CSS custom properties / data-attributes on the
 * document root.
 */
function renderAuthPanel(): string {
  const role = activeAccess.role;
  const feedback = authFeedback
    ? `<div class="auth-feedback auth-feedback--${authFeedback.tone}">${esc(authFeedback.text)}</div>`
    : '';

  if (activeAuthSession?.email) {
    return `
      <h3>Compte</h3>
      <div class="auth-panel">
        <div class="auth-account">
          <strong>${esc(activeAuthSession.email)}</strong>
          <span>${esc(role)}</span>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-action="auth-logout">Deconnexion</button>
      </div>
      ${feedback}
    `;
  }

  return `
    <h3>Compte</h3>
    <form class="auth-form" data-auth-login>
      <label class="field">
        <span class="field__label">Email</span>
        <input class="field__control" type="email" autocomplete="username" data-auth-email>
      </label>
      <label class="field">
        <span class="field__label">Mot de passe</span>
        <input class="field__control" type="password" autocomplete="current-password" data-auth-password>
      </label>
      <button class="btn btn--primary btn--small" type="submit">Connexion</button>
    </form>
    ${feedback}
  `;
}

function renderTweaksPanel(): string {
  return `
    <div class="tweaks" id="tweaks" role="dialog" aria-label="Tweaks">
      ${renderAuthPanel()}
      <h3>Apparence</h3>
      <div class="tweak">
        <span>Accent</span>
        <div class="swatches" data-swatches>
          <button class="sw on" type="button" style="background:#EA7A3C" data-accent="#EA7A3C" aria-label="Orange"></button>
          <button class="sw" type="button" style="background:#5F87FF" data-accent="#5F87FF" aria-label="Bleu"></button>
          <button class="sw" type="button" style="background:#3CCB87" data-accent="#3CCB87" aria-label="Vert"></button>
          <button class="sw" type="button" style="background:#E85D75" data-accent="#E85D75" aria-label="Rose"></button>
        </div>
      </div>
      <div class="tweak">
        <span>Densité</span>
        <select data-tweak="density">
          <option value="cozy">Confortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      <div class="tweak">
        <span>Thème</span>
        <select data-tweak="paper">
          <option value="warm">Obsidienne</option>
          <option value="cool">Ardoise</option>
          <option value="pure">Nuit</option>
        </select>
      </div>
    </div>
  `;
}

function renderDebugCard(
  isApiOnline: boolean,
  list: Partial<VehicleSnapshot>[] | undefined,
  debug: ScrapeDebugState | undefined,
  backgroundDebug?: StoredPanelState['backgroundDebug'],
): string {
  const rows: [string, string][] = [
    ['API', isApiOnline ? 'connectee' : 'hors ligne'],
    ['BG', backgroundDebug?.status || 'inconnu'],
    ['BG Maj', backgroundDebug?.updatedAt ? formatDateTime(backgroundDebug.updatedAt) : backgroundDebug?.startedAt ? formatDateTime(backgroundDebug.startedAt) : 'n/d'],
    ['BG Etape', backgroundDebug?.lastStage || 'n/d'],
    ['BG Req', backgroundDebug?.lastRequestId || 'n/d'],
    ['BG Route', [backgroundDebug?.lastMethod, backgroundDebug?.lastPath].filter(Boolean).join(' ') || 'n/d'],
    ['BG Err', backgroundDebug?.lastError || 'n/d'],
    ['Liste', list?.length ? `${list.length} vehicules` : 'vide'],
    ['Etape', debug?.stage || 'aucune'],
    ['Page', debug?.pageType || 'inconnu'],
    ['Count', typeof debug?.vehicleCount === 'number' ? String(debug.vehicleCount) : 'n/d'],
    ['Vehicule', [debug?.brand, debug?.model].filter(Boolean).join(' ') || debug?.hashId || 'n/d'],
    ['ID Backend', debug?.backendVehicleId != null ? String(debug.backendVehicleId) : 'n/d'],
    ['Raison', debug?.reason || 'n/d'],
    ['Maj', debug?.timestamp ? formatDateTime(debug.timestamp) : 'n/d'],
  ];

  return `
    <section class="card card--debug">
      ${renderCardTitle('🛠️', 'Diagnostic', { tone: 'red' })}
      <div class="debug-grid">
        ${rows.map(([l, v]) => `<span class="debug-label">${esc(l)}</span><span class="debug-value">${esc(v)}</span>`).join('')}
      </div>
      ${debug?.url ? `<div class="debug-url">${esc(debug.url)}</div>` : ''}
    </section>
  `;
}

function renderLoading(): string {
  return `
    <div class="panel">
      <div class="loading">
        <div class="loading__spinner"></div>
        <p>Chargement...</p>
      </div>
    </div>
  `;
}

function renderError(message: string): string {
  return `
    <div class="panel">
      <section class="empty-hero">
        <div class="empty-hero__icon">&#9888;</div>
        <h2>Erreur de chargement</h2>
        <p>${esc(message || 'Erreur inconnue')}</p>
      </section>
      ${renderActionsBar(false)}
    </div>
  `;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function shortenUrl(url: string, max = 52): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function metricCard(label: string, value: string, icon: string): string {
  const iconMap: Record<string, string> = {
    price: '&#128176;', sold: '&#9989;', km: '&#128663;', location: '&#128205;', history: '&#128203;', visit: '&#128065;',
  };
  // `data-metric-icon` lets the Duolingo-theme CSS tint each icon tile by
  // kind (price=green, km=orange, history=purple, etc.) instead of the
  // uniform grey fallback defined on `.metric__icon`.
  return `
    <div class="metric" data-metric-icon="${esc(icon)}">
      <div class="metric__icon">${iconMap[icon] || ''}</div>
      <div>
        <div class="metric__label">${esc(label)}</div>
        <div class="metric__value">${esc(value)}</div>
      </div>
    </div>
  `;
}

function renderCardTitle(icon: string, label: string, opts?: { count?: number | string; tone?: string }): string {
  const count = opts?.count != null
    ? `<span class="card__count card__count--${esc(opts?.tone || 'blue')}">${esc(String(opts.count))}</span>`
    : '';
  return `
    <button class="card__title" type="button">
      <span class="card__icon">${icon}</span>
      <span class="card__label">${esc(label)}</span>
      ${count}
      <span class="card__chev" aria-hidden="true">›</span>
    </button>
  `;
}

function buildVerdictInsight(
  snapshot: VehicleSnapshot,
  startingPrice: number | undefined,
  similarSold: SimilarSoldData | null | undefined,
): VerdictInsight | null {
  const marketValue = snapshot.marketValue ?? undefined;
  const avgSold = similarSold?.stats?.avgSoldPrice ?? undefined;
  const market = avgSold || marketValue;
  if (!market) return null;

  const map = startingPrice;
  const liveBid = snapshot.currentAuctionPrice ?? undefined;
  const soldPrice = snapshot.soldPrice ?? undefined;
  const referencePrice = soldPrice ?? liveBid ?? map ?? market;
  const referenceLabel = soldPrice ? 'ADJUGE' : liveBid ? 'ENCHERE LIVE' : map ? 'MISE A PRIX' : 'REFERENCE';
  const comparableCount = similarSold?.stats?.count ?? 0;
  const rangeMin = similarSold?.stats?.minSoldPrice ?? Math.round(market * 0.86);
  const rangeMax = similarSold?.stats?.maxSoldPrice ?? Math.round(market * 1.16);
  const axisMin = Math.min(rangeMin, map ?? referencePrice, market) * 0.92;
  const axisMax = Math.max(rangeMax, map ?? referencePrice, market) * 1.04;
  const axisSpan = Math.max(axisMax - axisMin, 1);
  const markerPct = ((referencePrice - axisMin) / axisSpan) * 100;
  const diffPct = ((referencePrice - market) / market) * 100;
  const kmPerYear = snapshot.year
    ? snapshot.mileage / Math.max(1, new Date().getFullYear() - snapshot.year + 1)
    : undefined;

  let tone: VerdictTone = 'warn';
  let tag = '≈ Dans le marche';
  let title = 'Aligne sur le marche';
  let emoji = '😐';

  if (diffPct <= -8) {
    tone = 'good';
    tag = '✓ Bonne affaire';
    title = `${Math.round(diffPct)} % sous la cote`;
    emoji = '🎉';
  } else if (diffPct >= 8) {
    tone = 'bad';
    tag = '⚠ Attention';
    title = `+${Math.round(diffPct)} % au-dessus moy.`;
    emoji = '😬';
  } else if (diffPct !== 0) {
    title = `${diffPct > 0 ? '+' : ''}${Math.round(diffPct)} % vs marche`;
  }

  const score = Math.max(10, Math.min(95, Math.round(64 - diffPct * 2.2)));
  const fillPct = Math.max(14, Math.min(90, score - (tone === 'good' ? 4 : tone === 'bad' ? 18 : 10)));
  const marketLabel = comparableCount
    ? `${comparableCount} comparable${comparableCount > 1 ? 's' : ''}`
    : 'base locale';

  return {
    tone,
    tag,
    title,
    subtitle: marketLabel,
    emoji,
    score,
    market,
    marketLabel,
    rangeMin,
    rangeMax,
    markerPct,
    fillPct,
    diffPct,
    comparableCount,
    kmPerYear,
    marketValue,
    referencePrice,
    referenceLabel,
  };
}

function buildGamificationStats(
  snapshot: VehicleSnapshot,
  insight: VerdictInsight | null,
  badges: VehicleBadge[] | null,
  history: VehicleHistory | null,
  isNew?: boolean,
): GamificationStats {
  const score = insight?.score ?? 42;
  const passageCount = history?.totalPassages ?? 1;
  const badgeCount = badges?.length ?? 0;
  const xp = Math.max(
    90,
    Math.round(
      score * 3
      + passageCount * 18
      + badgeCount * 12
      + (snapshot.soldPrice ? 24 : 0)
      + (isNew ? 18 : 0),
    ),
  );
  const streak = Math.max(1, Math.min(12, passageCount + (insight?.tone === 'good' ? 2 : 0) + Math.min(3, badgeCount)));
  const goodDeals = Math.max(1, Math.round((score + badgeCount * 10) / 22));
  const level = Math.max(1, Math.floor(xp / 30) + 1);
  const nextLevelXp = level * 30;
  const levelStart = (level - 1) * 30;
  const progressPct = Math.max(6, Math.min(96, ((xp - levelStart) / Math.max(nextLevelXp - levelStart, 1)) * 100));
  const levelTitle = insight?.tone === 'good'
    ? 'Analyste Pro'
    : insight?.tone === 'bad'
    ? 'Observateur prudent'
    : 'Scout VPauto';

  return {
    streak,
    xp,
    level,
    nextLevelXp,
    progressPct,
    goodDeals,
    levelTitle,
  };
}

function buildListGamificationStats(list: Partial<VehicleSnapshot>[], tracking?: BatchTrackingResult): GamificationStats {
  const total = list.length;
  const sold = list.filter((item) => item.status === 'sold').length;
  const priceMoves = tracking?.priceChanges.length ?? 0;
  const xp = Math.max(50, total * 5 + sold * 14 + priceMoves * 18 + (tracking?.newVehicles ?? 0) * 12);
  const streak = Math.max(1, Math.min(12, Math.ceil(total / 8) + Math.min(4, priceMoves)));
  const level = Math.max(1, Math.floor(xp / 35) + 1);
  const nextLevelXp = level * 35;
  const levelStart = (level - 1) * 35;
  const progressPct = Math.max(5, Math.min(96, ((xp - levelStart) / Math.max(nextLevelXp - levelStart, 1)) * 100));

  return {
    streak,
    xp,
    level,
    nextLevelXp,
    progressPct,
    goodDeals: Math.max(1, sold + (tracking?.newVehicles ?? 0)),
    levelTitle: 'Analyste vente',
  };
}

function renderGamificationSection(stats: GamificationStats): string {
  const xpToNext = Math.max(0, stats.nextLevelXp - stats.xp);
  return `
    <section class="xp-section">
      <div class="xp-top">
        <div class="xp-avatar">🦉</div>
        <div class="xp-info">
          <div class="rank">${esc(stats.levelTitle)}</div>
          <div class="name">Niveau ${stats.level}</div>
          <div class="sub">${xpToNext} XP vers Niveau ${stats.level + 1}</div>
        </div>
      </div>
      <div class="xp-bar-wrap">
        <div class="xp-bar-lbl"><span>${stats.xp} XP</span><span>${stats.nextLevelXp} XP</span></div>
        <div class="xp-bar-track"><div class="xp-bar-fill" style="width:${stats.progressPct.toFixed(1)}%"></div></div>
      </div>
      <div class="xp-chips">
        <span class="xp-chip gold">🏆 ${stats.goodDeals} bonnes affaires</span>
        <span class="xp-chip fire">🔥 Serie de ${stats.streak}</span>
        <span class="xp-chip star">⚡ ${stats.xp} XP ce mois</span>
      </div>
    </section>
  `;
}

function renderUpdatedLine(updatedAt?: string, isApiOnline?: boolean): string {
  if (!updatedAt) return '';
  const date = new Date(updatedAt);
  const formatted = Number.isNaN(date.getTime())
    ? updatedAt
    : `${date.toLocaleDateString('fr-FR')} · ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return `
    <div class="panel-updated">
      <span class="panel-updated__dot ${isApiOnline ? 'panel-updated__dot--ok' : 'panel-updated__dot--off'}"></span>
      DONNEES A JOUR · ${esc(formatted)}
    </div>
  `;
}

function chip(label: string, color: string): string {
  return `<span class="chip chip--${color}">${esc(label)}</span>`;
}

function statusColor(status?: string): string {
  switch (status) {
    case 'available': case 'auction_live': return 'blue';
    case 'sold': return 'green';
    case 'unsold': case 'removed': return 'red';
    default: return 'neutral';
  }
}

function formatPrice(value?: number): string {
  if (value == null || Number.isNaN(value)) return 'N/D';
  return currencyFormatter.format(value);
}

function formatDistance(value?: number): string {
  if (value == null || Number.isNaN(value)) return 'N/D';
  return `${numberFormatter.format(value)} km`;
}

/**
 * Render a square thumbnail from the first available photo URL, or a
 * neutral placeholder when the snapshot has no photo. Used by the three
 * similar-vehicles cards (in-auction, elsewhere, sold) so the bidder can
 * visually triage candidates without reading specs.
 *
 * The wrapper element is always rendered (even when empty) so the row's
 * grid template stays stable — the alternative would shift the title left
 * for photo-less rows and look broken next to rows with thumbnails.
 */
function renderThumbnail(photoUrls: string[] | undefined | null, alt: string): string {
  const url = (photoUrls && photoUrls.length > 0) ? photoUrls[0] : '';
  if (!url) {
    // Empty placeholder keeps the layout aligned. The CSS gives it a faint
    // background so the user perceives "no photo available" rather than
    // thinking the image just hasn't loaded yet.
    return `<div class="similar-item__photo similar-item__photo--empty" aria-hidden="true"></div>`;
  }
  // `loading="lazy"` defers off-screen photos; `referrerpolicy="no-referrer"`
  // avoids leaking the extension URL when the CDN inspects the Referer.
  return `<img class="similar-item__photo" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
}

/**
 * Extract the trim/finition suffix from a VPauto version string.
 *
 * VPauto versions follow the pattern:
 *   "<engine code> <power> ch <gearbox> [<n>] <trim>"
 * e.g. "40 TFSI 207 ch S tronic 7 S Line" → "S Line"
 *      "1.5 dCi 110 ch BVM6 Business"      → "Business"
 *      "BlueHDi 100 ch BVM5 Active"        → "Active"
 *
 * Returns '' when the pattern doesn't match — the caller should treat that
 * as "no trim diff to display" rather than guessing.
 */
function extractTrim(version: string | undefined | null): string {
  if (!version) return '';
  const afterCh = version.match(/\bch\s+(.+)$/i);
  if (!afterCh) return '';
  const after = afterCh[1].trim();
  // Strip the gearbox token + optional ratio number that follows "ch"
  const stripped = after.replace(
    /^(?:S\s*tronic|DSG|EDC|EAT|BVA|BVM|CVT|tiptronic|automatique|manuelle|DCT|PowerShift|tronic)\s*\d*\s+/i,
    '',
  ).trim();
  return stripped;
}

/**
 * Build a list of human-readable spec differences between two snapshots.
 *
 * Used by the "Similaires disponibles ailleurs" card (`renderSimilarElsewhere`)
 * to surface the *actionable* differences a bidder needs to see — the things
 * that explain the price gap. We deliberately skip dimensions that are
 * identical (showing "Même boîte" buys nothing) and order entries by impact
 * on price: year, power, trim, fuel, gearbox, engine size, colour. The
 * caller caps the visible list, so only the top diffs make it on screen.
 */
function buildSpecDelta(
  candidate: VehicleSnapshot,
  current: VehicleSnapshot,
): string[] {
  const parts: string[] = [];

  // Year — most-buyer-relevant after price
  const yearDiff = candidate.year - current.year;
  if (yearDiff !== 0) {
    const sign = yearDiff > 0 ? '+' : '';
    const plural = Math.abs(yearDiff) > 1 ? 's' : '';
    parts.push(`${sign}${yearDiff} an${plural}`);
  }

  // Power — primary price driver, already gated to ±20 % by the backend
  const candPower = candidate.power;
  const currPower = current.power;
  if (candPower && currPower && candPower !== currPower) {
    const diff = candPower - currPower;
    parts.push(`${diff > 0 ? '+' : ''}${diff} ch`);
  }

  // Trim/finition — only when extractable on both sides
  const candTrim = extractTrim(candidate.version);
  const currTrim = extractTrim(current.version);
  if (
    candTrim
    && currTrim
    && candTrim.toLowerCase() !== currTrim.toLowerCase()
  ) {
    parts.push(`${candTrim} vs ${currTrim}`);
  }

  // Fuel — VPauto uses 2-letter codes (ES, GO, EH, …); shown raw because
  // bidders recognise them and translation tables get stale fast
  if (
    candidate.fuel
    && current.fuel
    && candidate.fuel.toLowerCase() !== current.fuel.toLowerCase()
  ) {
    parts.push(`${candidate.fuel} vs ${current.fuel}`);
  }

  // Transmission — only when both populated and they differ
  if (
    candidate.transmission
    && current.transmission
    && candidate.transmission.toLowerCase() !== current.transmission.toLowerCase()
  ) {
    parts.push(`Boîte ${candidate.transmission} vs ${current.transmission}`);
  }

  // Engine size — usually correlated with power, so often redundant. Show
  // only if power was equal but cylindrée differs (rare but informative)
  if (
    candidate.engineSize
    && current.engineSize
    && candidate.engineSize !== current.engineSize
    && candPower === currPower
  ) {
    parts.push(`${candidate.engineSize} cc vs ${current.engineSize} cc`);
  }

  // Colour — last because least price-relevant
  if (
    candidate.color
    && current.color
    && candidate.color.toLowerCase() !== current.color.toLowerCase()
  ) {
    parts.push(`${candidate.color} vs ${current.color}`);
  }

  return parts;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR');
}

function formatStatus(status?: string): string {
  switch (status) {
    case 'auction_live': return 'Enchere en cours';
    case 'sold': return 'Vendu';
    case 'unsold': return 'Invendu';
    case 'removed': return 'Retire';
    case 'available': return 'Disponible';
    default: return status || 'Inconnu';
  }
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

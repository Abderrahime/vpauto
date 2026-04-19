import { browser } from 'wxt/browser';
import type { MatchResult, VehicleBadge, VehicleHistory, VehicleSnapshot } from '@vpauto/shared';
import { buildPriceHistory, computeEvolution } from '@vpauto/shared';
import { api } from '../../lib/api';
import { scrapeRemotePage, scrapeVehicleDetailFromHtml } from '../../lib/scraper';
import './style.css';

interface CurrentVehicleState {
  snapshot: VehicleSnapshot;
  vehicleId?: number;
  snapshotId?: number;
  isNew?: boolean;
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

interface CrossAuctionData {
  vehicleId: number;
  brand: string;
  model: string;
  year: number;
  passages: {
    snapshotId: number;
    canonicalSnapshotId: number;
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
  }[];
  firstStartingPrice: number | null;
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
    yearMatch: boolean;
    modelMatch: boolean;
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
let hasRenderedOnce = false;
let isRefreshing = false;
let pendingRefresh = false;
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

const IMPORT_CHANGE_PAGE_SIZE = 12;

void refreshPanel();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.currentVehicle && !changes.currentVehicleList && !changes.scrapeDebug && !changes.batchTrackingResult && !changes.vehicleVisits) return;

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

async function syncCurrentVehicleFromPanel(
  currentVehicle: CurrentVehicleState,
  scrapeDebug?: ScrapeDebugState,
): Promise<{ currentVehicle: CurrentVehicleState; scrapeDebug: ScrapeDebugState | undefined }> {
  if (currentVehicle.vehicleId) {
    return { currentVehicle, scrapeDebug };
  }

  const snapshot = currentVehicle.snapshot;
  const saveResult = await api.saveSnapshotDetailed(snapshot);

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
    return createdVehicle
      ? {
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
        }
      : {
          isNew: false,
          updated: true,
          unchanged: false,
          priceDirection: null,
          statusChanged: false,
          changeEntry: {
            label,
            kind: 'updated',
            detail: 'Vehicule rattache a un enregistrement existant.',
            updates: [],
            url,
          },
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
  if (prevPhotos !== nextPhotos) {
    updates.push({
      field: 'photoUrls',
      label: 'Photos',
      before: `${prevPhotos} photo${prevPhotos > 1 ? 's' : ''}`,
      after: `${nextPhotos} photo${nextPhotos > 1 ? 's' : ''}`,
      direction: nextPhotos > prevPhotos ? 'up' : 'down',
      delta: `${nextPhotos > prevPhotos ? '+' : ''}${nextPhotos - prevPhotos}`,
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

  const res = await fetch(target.url, { credentials: 'include' });
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
      lastMessage: `Import termine. ${importJob?.updated || 0} fiches mises a jour, ${importJob?.newVehicles || 0} nouvelles.`,
    };
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
    const [storage, health] = await Promise.all([
      browser.storage.local.get(['currentVehicle', 'currentVehicleList', 'scrapeDebug', 'batchTrackingResult', 'backgroundDebug', 'vehicleVisits']),
      api.healthCheck(),
    ]);

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
        backgroundDebug: effectiveBackgroundDebug,
        history,
        badges,
        crossAuction,
        similarAvailable,
        similarSold,
        isApiOnline,
      });
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
      showDebug = !showDebug;
      void refreshPanel();
    });

  bindTweaksPanel();
  startTickerCountdown();

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
    ?.addEventListener('click', () => void runSilentImport(state));

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
}

// ── Vehicle Detail View ──────────────────────────────────────────────────

function renderVehicleState(input: {
  currentVehicle: CurrentVehicleState;
  currentVehicleList?: Partial<VehicleSnapshot>[];
  batchTracking?: BatchTrackingResult;
  scrapeDebug?: ScrapeDebugState;
  vehicleVisits?: StoredPanelState['vehicleVisits'];
  backgroundDebug?: StoredPanelState['backgroundDebug'];
  history: VehicleHistory | null;
  badges: VehicleBadge[] | null;
  crossAuction?: CrossAuctionData | null;
  similarAvailable?: MatchResult[] | null;
  similarSold?: SimilarSoldData | null;
  isApiOnline: boolean;
}): string {
  const { currentVehicle, history, badges, crossAuction, similarAvailable, similarSold, isApiOnline, scrapeDebug } = input;
  const currentList = input.currentVehicleList || [];
  const { snapshot, vehicleId, isNew } = currentVehicle;
  const title = [snapshot.brand, snapshot.model].filter(Boolean).join(' ').trim() || 'Vehicule VPauto';
  const subtitle = [snapshot.year || undefined, snapshot.city || undefined, snapshot.reference || undefined]
    .filter(Boolean)
    .join(' \u2022 ');
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
  let startingPrice = snapshot.startingPrice;
  if (!startingPrice && snapshot.hashId && currentList.length > 0) {
    const fromList = currentList.find(v => v.hashId === snapshot.hashId);
    if (fromList?.startingPrice) {
      startingPrice = fromList.startingPrice;
    }
  }
  if (!startingPrice && history && history.passages.length > 0) {
    // passages are oldest-first; walk backwards to find the most recent passage with a MAP
    for (let i = history.passages.length - 1; i >= 0; i--) {
      const sp = history.passages[i].startingPrice;
      if (sp) { startingPrice = sp; break; }
    }
  }

  // Find similar vehicles in current auction list
  const similarInAuction = findSimilarInList(snapshot, currentList);

  // Patch the server-side history with the live-resolved MAP so the history
  // section and price chart stay in sync. Compute once, reuse twice.
  const enrichedHistory = enrichHistoryWithResolvedMap(history, snapshot, startingPrice);

  // Build metrics dynamically — only show metrics with real data
  const metrics: string[] = [];
  if (startingPrice) metrics.push(metricCard('Mise a prix', formatPrice(startingPrice), 'price'));
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

  return `
    <div class="panel">
      ${renderHeader(title, subtitle, isApiOnline, { showTitle: false })}
      ${renderTicker(snapshot)}
      ${renderVehicleHero(snapshot, startingPrice, similarSold ?? null, vehicleId, isNew)}

      ${renderSoldBanner(snapshot, startingPrice)}

      <div class="metrics-grid">
        ${metrics.join('')}
      </div>

      ${profitLine}
      ${renderPersistenceWarning(vehicleId, scrapeDebug)}

      ${renderBadgesSection(badges)}
      ${renderCrossAuction(crossAuction, snapshot)}
      ${renderSimilarInAuction(similarInAuction, snapshot, currentList.length)}
      ${renderSimilarElsewhere(similarAvailable, snapshot)}
      ${renderSimilarSold(similarSold, snapshot)}
      ${renderHistorySection(enrichedHistory, vehicleId, snapshot)}
      ${renderPriceChart(enrichedHistory)}
      ${renderActionsBar(true)}
      ${renderTweaksPanel()}
      ${showDebug ? renderDebugCard(isApiOnline, input.currentVehicleList, scrapeDebug, input.backgroundDebug) : ''}
    </div>
  `;
}

// ── List View ────────────────────────────────────────────────────────────

function renderListState(state: StoredPanelState, isApiOnline: boolean): string {
  const list = state.currentVehicleList;
  const tracking = state.batchTrackingResult;
  const debug = state.scrapeDebug;

  const hasVehicles = list && list.length > 0;
  const title = hasVehicles ? `${list.length} vehicules detectes` : 'VPauto Assistant';
  const subtitle = hasVehicles
    ? (debug?.stage?.includes('scraping') ? 'Scraping en cours...' : 'Liste analysee')
    : 'En attente de donnees...';

  return `
    <div class="panel">
      ${renderHeader(title, subtitle, isApiOnline)}

      ${hasVehicles ? renderAuctionSummary(list) : ''}
      ${tracking ? renderTrackingAlerts(tracking) : ''}
      ${hasVehicles ? renderTrackingSummary(tracking) : ''}
      ${hasVehicles ? renderImportSection(state, isApiOnline) : ''}
      ${hasVehicles ? renderVehicleList(list) : renderEmptyState(isApiOnline)}

      ${renderActionsBar(false)}
      ${renderTweaksPanel()}
      ${showDebug ? renderDebugCard(isApiOnline, list, debug, state.backgroundDebug) : ''}
    </div>
  `;
}

// ── Shared Components ────────────────────────────────────────────────────

function renderHeader(title: string, subtitle: string, isApiOnline: boolean, opts?: { showTitle?: boolean }): string {
  const showTitle = opts?.showTitle !== false;
  const statusLabel = isApiOnline ? 'CONNECTÉ · TERMINAL 2.4' : 'HORS LIGNE · MODE LOCAL';
  return `
    <header class="hero ext-head">
      <div class="hero__brand">
        <div class="hero__logo ext-logo">vP</div>
        <div class="ext-head-text">
          <div class="a">${esc(title)}</div>
          <div class="b">
            <span class="status-dot ${isApiOnline ? 'status-dot--ok' : 'status-dot--off'}"></span>
            ${esc(statusLabel)}
          </div>
        </div>
      </div>
      <div class="head-btns">
        <button class="ibtn" type="button" data-action="toggle-tweaks" title="Tweaks" aria-label="Ouvrir les tweaks">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>
        <button class="ibtn" type="button" data-action="open-source" title="Ouvrir la fiche" aria-label="Ouvrir la fiche source">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="ibtn" type="button" data-action="refresh" title="Rafraîchir" aria-label="Rafraîchir">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        </button>
      </div>
      ${showTitle && subtitle ? `
        <h1 class="hero__title" style="width:100%; flex-basis:100%;">${esc(title === 'VPauto Assistant' ? subtitle : title)}</h1>
        <p class="hero__subtitle" style="width:100%; flex-basis:100%;">${esc(subtitle)}</p>
      ` : ''}
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
      <h2 class="card__title"><span class="card__icon">&#9733;</span> Badges</h2>
      <div class="chip-bar">${items}</div>
    </section>
  `;
}

function renderPersistenceWarning(vehicleId: number | null | undefined, debug?: ScrapeDebugState): string {
  if (vehicleId) return '';

  const reason = debug?.reason ? ` (${esc(debug.reason)})` : '';
  return `
    <section class="card">
      <h2 class="card__title"><span class="card__icon">&#9888;</span> Synchronisation</h2>
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

function renderHistorySection(history: VehicleHistory | null, vehicleId: number | null | undefined, snapshot: VehicleSnapshot): string {
  const historicalPassages = history?.passages.slice().reverse() || [];

  if (!history || historicalPassages.length === 0) {
    return `
      <section class="card">
        <h2 class="card__title"><span class="card__icon">&#128203;</span> Historique</h2>
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
      <h2 class="card__title"><span class="card__icon">&#128203;</span> Historique</h2>
      <div class="timeline">${items}</div>
    </section>
  `;
}

function renderCrossAuction(data: CrossAuctionData | null | undefined, snapshot: VehicleSnapshot): string {
  const previousPassages = data?.passages.slice().reverse() || [];

  if (!data || previousPassages.length === 0) {
    return `
      <section class="card">
        <h2 class="card__title"><span class="card__icon">&#127758;</span> Parcours multi-encheres</h2>
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

    let priceHtml = '';
    if (p.soldPrice) {
      priceHtml = `<span class="price-down" style="font-size:12px;">Adjuge ${formatPrice(p.soldPrice)}</span>`;
      if (p.startingPrice) priceHtml += ` <span style="text-decoration:line-through;color:var(--text-muted);font-size:10px;">${formatPrice(p.startingPrice)}</span>`;
    } else if (p.startingPrice) {
      priceHtml = `${formatPrice(p.startingPrice)}`;
    }

    return `
      <div class="cross-item ${isCurrent ? 'cross-item--current' : ''}">
        <div class="cross-item__header">
          <span class="cross-item__city">${esc(p.city)}${isCurrent ? ' <span class="timeline-current-badge">Courant</span>' : ''}</span>
          <span class="chip chip--${statusColor}" style="font-size:9px;padding:2px 6px;">${statusLabel}</span>
        </div>
        <div class="cross-item__detail">
          <span>${esc(formatPassageMoment({ saleDate: p.saleDate, saleTime: p.saleTime, scrapedAt: p.scrapedAt }))}</span>
          <span>${priceHtml}</span>
        </div>
        <div class="cross-item__detail cross-item__detail--footer">
          <span>${formatDistance(p.mileage)}</span>
          <div class="cross-item__open">
            ${renderHistoryOpenButton({
              snapshotId: p.snapshotId,
              sourceUrl: p.sourceUrl,
              openMode: p.openMode,
            })}
            <span class="timeline-event__reason">${esc(formatHistoryOpenReason(p.openReason, p.openMode))}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="card">
      <h2 class="card__title"><span class="card__icon">&#127758;</span> Parcours multi-encheres</h2>
      <div class="cross-list">${items}</div>
    </section>
  `;
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
        <h2 class="card__title"><span class="card__icon">&#128269;</span> Similaires dans cette vente</h2>
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
    return `
      <div class="similar-item${nonRoulant ? ' similar-item--nr' : ''}" data-vehicle-url="${esc(v.sourceUrl || '')}">
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
      <h2 class="card__title"><span class="card__icon">&#128269;</span> Similaires dans cette vente (${vehicles.length})</h2>
      ${statsHtml}
      <div class="similar-list">${items}</div>
    </section>
  `;
}

function renderSimilarElsewhere(matches: MatchResult[] | null | undefined, current: VehicleSnapshot): string {
  const currentPrice = current.startingPrice || current.soldPrice || null;
  const filtered = (matches || [])
    .filter((match) => match.level !== 'exact')
    .filter((match) => match.snapshot.hashId !== current.hashId)
    .filter((match) => Boolean(match.snapshot.city) && match.snapshot.city !== current.city)
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
        <h2 class="card__title"><span class="card__icon">&#127968;</span> Similaires disponibles ailleurs</h2>
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

  const summary = `
    <div class="recommend-box">
      <div class="recommend-box__title">Opportunites ailleurs</div>
      <div class="recommend-box__row">
        <span>Vehicules disponibles trouves</span>
        <span class="recommend-box__value">${filtered.length}</span>
      </div>
      <div class="recommend-box__row">
        <span>Memes modeles</span>
        <span class="recommend-box__value">${sameModelCount}</span>
      </div>
      ${currentPrice != null ? `
        <div class="recommend-box__row">
          <span>Moins chers que ce vehicule</span>
          <span class="recommend-box__value">${cheaperCount}</span>
        </div>
      ` : ''}
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

    return `
      <div class="similar-item${nonRoulant ? ' similar-item--nr' : ''}" data-vehicle-url="${esc(candidate.sourceUrl || '')}">
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(candidate.brand)} ${esc(candidate.model)}
            ${match.level === 'same_model' ? '<span class="badge-match">Match</span>' : ''}
            ${nonRoulant ? '<span class="badge-nr" title="Véhicule non roulant — explique un prix anormalement bas">NON ROULANT</span>' : ''}
          </div>
          <div class="similar-item__meta">
            ${candidate.year} \u2022 ${formatDistance(candidate.mileage)} \u2022 ${esc(candidate.city)}
          </div>
          <div class="similar-item__meta">
            ${match.reasons.slice(0, 3).join(' \u2022 ')}
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
      <h2 class="card__title"><span class="card__icon">&#127968;</span> Similaires disponibles ailleurs</h2>
      ${summary}
      <div class="similar-list">${items}</div>
    </section>
  `;
}

function renderSimilarSold(data: SimilarSoldData | null | undefined, currentSnapshot: VehicleSnapshot): string {
  if (!data || data.results.length === 0) {
    return `
      <section class="card">
        <h2 class="card__title"><span class="card__icon">&#128200;</span> Intelligence prix</h2>
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
      <div class="recommend-box">
        <div class="recommend-box__title">Estimation de prix</div>
        <div class="recommend-box__row">
          <span>Prix moyen adjuge (${stats.count} vente${stats.count > 1 ? 's' : ''} comparable${stats.count > 1 ? 's' : ''})</span>
          <span class="recommend-box__value">${formatPrice(stats.avgSoldPrice)}</span>
        </div>
        <div class="recommend-box__row">
          <span>Fourchette</span>
          <span class="recommend-box__value">${formatPrice(stats.minSoldPrice || 0)} - ${formatPrice(stats.maxSoldPrice || 0)}</span>
        </div>
        ${currentPrice ? `
          <div class="recommend-box__row">
            <span>Ce vehicule (mise a prix)</span>
            <span class="recommend-box__value">${formatPrice(currentPrice)}</span>
          </div>
          <div class="recommend-box__verdict ${currentPrice < stats.avgSoldPrice ? 'recommend-box__verdict--good' : 'recommend-box__verdict--high'}">
            ${currentPrice < stats.avgSoldPrice
              ? `Mise a prix inferieure de ${formatPrice(stats.avgSoldPrice - currentPrice)} au prix moyen adjuge`
              : currentPrice === stats.avgSoldPrice
              ? 'Prix aligne avec le marche'
              : `Mise a prix superieure de ${formatPrice(currentPrice - stats.avgSoldPrice)} au prix moyen adjuge`
            }
          </div>
        ` : ''}
      </div>
    `;
  } else {
    recommendHtml = `
      <div class="recommend-box recommend-box--warn">
        <div class="recommend-box__title">Estimation non disponible</div>
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
      <h2 class="card__title"><span class="card__icon">&#128200;</span> Intelligence prix</h2>
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
      <h2 class="card__title"><span class="card__icon">&#128200;</span> Evolution prix</h2>
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
      <h2 class="card__title"><span class="card__icon">&#128202;</span> Resume de l'enchere</h2>

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
      <h2 class="card__title"><span class="card__icon">&#128663;</span> Vehicules (${list.length})</h2>
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

function renderActionsBar(hasSource: boolean): string {
  return `
    <div class="actions-bar">
      <button class="btn btn--primary" type="button" data-action="refresh">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        Rafraîchir
      </button>
      ${hasSource ? `<button class="btn btn--ghost" type="button" data-action="open-source">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Ouvrir la page
      </button>` : ''}
      <button class="btn btn--ghost btn--small" type="button" data-action="toggle-debug" title="Diagnostic">
        ${showDebug ? 'Masquer' : 'Debug'}
      </button>
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
  if (!countdown && !startTime) return '';
  const dateLabel = snapshot.saleDate ? formatDate(snapshot.saleDate).toUpperCase() : 'SANS DATE';
  return `
    <div class="ticker" data-sale-date="${esc(snapshot.saleDate || '')}" data-sale-time="${esc(snapshot.saleTime || '')}">
      <div class="ticker-col">
        <div class="k">Début vente · ${esc(dateLabel)}</div>
        <div class="v">${esc(startTime || '—')}</div>
      </div>
      <div class="ticker-sep"></div>
      <div class="ticker-col right">
        <div class="k">${countdown ? 'T−' : 'STATUT'}</div>
        <div class="v" data-countdown>${esc(countdown || 'EN COURS')}</div>
      </div>
    </div>
  `;
}

/**
 * Hero block for a scraped vehicle: reference line, serif title, mono
 * meta row, and (when enough data) a linear-gauge verdict panel that
 * shows the MAP and marché markers on the same €/€ scale.
 */
function renderVehicleHero(
  snapshot: VehicleSnapshot,
  startingPrice: number | undefined,
  similarSold: SimilarSoldData | null | undefined,
  vehicleId?: number,
  isNew?: boolean,
): string {
  const brand = (snapshot.brand || '').trim();
  const model = (snapshot.model || '').trim();
  const version = (snapshot.version || '').trim();
  const serifTitle = [brand, model, version].filter(Boolean).join(' ') || 'Véhicule VPauto';
  const refPart = snapshot.reference ? `Réf. ${snapshot.reference}` : '';
  const vehiclePart = vehicleId ? `#${vehicleId}` : '';
  const refLine = [vehiclePart, refPart].filter(Boolean).join(' · ');
  const metaParts: string[] = [];
  if (snapshot.year) metaParts.push(String(snapshot.year));
  if (snapshot.mileage) metaParts.push(formatDistance(snapshot.mileage));
  if (snapshot.city) metaParts.push(snapshot.city);
  if (snapshot.vatRecoverable != null) metaParts.push(snapshot.vatRecoverable ? 'TVA récupérable' : 'TVA non');

  const badges: string[] = [];
  const nonRoulant = isNonRoulant(snapshot);
  badges.push(`<span class="badge ${nonRoulant ? 'bad' : 'good'}">● ${nonRoulant ? 'Non roulant' : 'Roulant'}</span>`);
  if (isNew) badges.push('<span class="badge ink">Nouveau</span>');
  if (snapshot.mileage && snapshot.year) {
    const age = Math.max(1, new Date().getFullYear() - snapshot.year);
    const kmPerYear = snapshot.mileage / age;
    if (kmPerYear > 20000) badges.push('<span class="badge bad">Km élevé</span>');
    else if (kmPerYear < 8000) badges.push('<span class="badge good">Km faible</span>');
    else badges.push('<span class="badge warn">Km moyen</span>');
  }
  if (snapshot.lotNumber) badges.push(`<span class="badge">Lot ${snapshot.lotNumber}</span>`);

  return `
    <div class="veh">
      ${refLine ? `<div class="veh-ref">${esc(refLine)}</div>` : ''}
      <div class="veh-title">${esc(serifTitle)}</div>
      ${metaParts.length ? `<div class="veh-meta">${metaParts.map((p, i) =>
        `<span>${esc(p)}</span>${i < metaParts.length - 1 ? '<span class="sep">/</span>' : ''}`
      ).join('')}</div>` : ''}
      ${badges.length ? `<div class="veh-badges">${badges.join('')}</div>` : ''}
    </div>
    ${renderVerdict(snapshot, startingPrice, similarSold)}
  `;
}

/**
 * Verdict panel with linear gauge. Only emitted when we have at least a
 * MAP and either a Cote (marketValue) or a similar-sold average — without
 * a market reference, there's no verdict to render. The gauge range spans
 * a "reasonable" € window centered on the marché value, with the MAP and
 * marché markers positioned on the same axis so the user can eyeball the
 * bargain at a glance.
 */
function renderVerdict(
  snapshot: VehicleSnapshot,
  startingPrice: number | undefined,
  similarSold: SimilarSoldData | null | undefined,
): string {
  const marketValue = snapshot.marketValue ?? undefined;
  const avgSold = similarSold?.stats?.avgSoldPrice ?? undefined;
  const market = avgSold || marketValue;
  if (!market) return '';

  const map = startingPrice ?? snapshot.currentAuctionPrice ?? snapshot.soldPrice;
  // Range: min/max from comparables when available, else ±40% of market.
  const minSold = similarSold?.stats?.minSoldPrice ?? undefined;
  const maxSold = similarSold?.stats?.maxSoldPrice ?? undefined;
  const rangeMin = minSold ?? Math.round(market * 0.85);
  const rangeMax = maxSold ?? Math.round(market * 1.15);

  // Axis: wider than the range so MAP + extremes fit even when the MAP is
  // far below the market (typical VPauto case).
  const axisLo = Math.min(map ?? market, rangeMin) * 0.9;
  const axisHi = Math.max(map ?? market, rangeMax) * 1.05;
  const axisSpan = Math.max(axisHi - axisLo, 1);
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - axisLo) / axisSpan) * 100));

  const rangeLeftPct = pct(rangeMin);
  const rangeWidthPct = Math.max(2, pct(rangeMax) - rangeLeftPct);

  // Verdict: compare MAP (or sold) against market average. Tunable thresholds.
  const reference = snapshot.soldPrice ?? map ?? market;
  const diffPct = ((reference - market) / market) * 100;
  let tag = 'DANS LE MARCHÉ';
  let toneClass = 'warn';
  let title = 'Aligné marché';
  if (diffPct <= -8) { tag = 'BONNE AFFAIRE'; toneClass = ''; title = `${Math.round(diffPct)} % sous la cote`; }
  else if (diffPct >= 8) { tag = 'ATTENTION'; toneClass = 'bad'; title = `+${Math.round(diffPct)} % au-dessus de la moy.`; }
  else { title = diffPct === 0 ? 'Aligné marché' : `${diffPct > 0 ? '+' : ''}${Math.round(diffPct)} % vs cote`; }

  const score = Math.max(5, Math.min(95, Math.round(50 - diffPct * 2)));
  const comparableCount = similarSold?.stats?.count ?? 0;
  const rangeLabel = `${formatShortPrice(rangeMin)} – ${formatShortPrice(rangeMax)}`;
  const compLabel = comparableCount
    ? `${comparableCount} comparable${comparableCount > 1 ? 's' : ''}`
    : 'base locale';

  // Tick marks at 5 evenly spaced values along the axis.
  const ticks: number[] = [];
  for (let i = 0; i < 5; i++) ticks.push(Math.round(axisLo + (axisSpan * i) / 4));

  const ledger: string[] = [];
  ledger.push(`
    <div class="ledger-row">
      <span class="k">Prix moyen adjugé</span>
      <span class="v">${formatPrice(market)}</span>
      <span class="d ${diffPct < 0 ? 'down' : diffPct > 0 ? 'up' : ''}">${diffPct === 0 ? 'réf.' : `${diffPct > 0 ? '+' : ''}${Math.round(diffPct)}%`}</span>
    </div>
  `);
  if (marketValue) {
    const diffVsCote = ((reference - marketValue) / marketValue) * 100;
    ledger.push(`
      <div class="ledger-row">
        <span class="k">Cote Argus</span>
        <span class="v">${formatPrice(marketValue)}</span>
        <span class="d ${diffVsCote < 0 ? 'down' : diffVsCote > 0 ? 'up' : ''}">${marketValue === market ? 'réf.' : `${diffVsCote > 0 ? '+' : ''}${Math.round(diffVsCote)}%`}</span>
      </div>
    `);
  }
  if (snapshot.newPrice) {
    const diffVsNew = ((reference - snapshot.newPrice) / snapshot.newPrice) * 100;
    ledger.push(`
      <div class="ledger-row">
        <span class="k">Prix neuf constructeur</span>
        <span class="v">${formatPrice(snapshot.newPrice)}</span>
        <span class="d down">${Math.round(diffVsNew)}%</span>
      </div>
    `);
  }
  if (snapshot.mileage && snapshot.year) {
    const age = Math.max(1, new Date().getFullYear() - snapshot.year);
    const perYear = Math.round(snapshot.mileage / age);
    ledger.push(`
      <div class="ledger-row">
        <span class="k">Km / an</span>
        <span class="v">${numberFormatter.format(perYear)}</span>
        <span class="d">moy. 14k</span>
      </div>
    `);
  }

  return `
    <div class="verdict${toneClass ? ` ${toneClass}` : ''}">
      <div class="verdict-head">
        <span class="verdict-tag">${esc(tag)}</span>
        <span class="verdict-score">Score <b>${score}</b>/100</span>
      </div>
      <div class="verdict-title">${esc(title)}</div>
      <div class="verdict-sub">Prix moyen adjugé <b class="mono">${formatPrice(market)}</b> · Fourchette <b class="mono">${esc(rangeLabel)}</b> · ${esc(compLabel)}</div>

      <div class="lgauge">
        <div class="lgauge-track"></div>
        <div class="lgauge-range" style="left:${rangeLeftPct.toFixed(1)}%; width:${rangeWidthPct.toFixed(1)}%;"></div>
        <div class="lgauge-mkt" style="left:${pct(market).toFixed(1)}%" data-label="MARCHÉ"></div>
        ${map ? `<div class="lgauge-mp" style="left:${pct(map).toFixed(1)}%" data-label="MISE À PRIX"></div>` : ''}
        <div class="lgauge-ticks">
          ${ticks.map((t) => `<span>${numberFormatter.format(t)}</span>`).join('')}
        </div>
      </div>

      <div class="ledger">${ledger.join('')}</div>
    </div>
  `;
}

function formatShortPrice(v: number): string {
  if (v >= 1000) return `${numberFormatter.format(Math.round(v))} €`;
  return formatPrice(v);
}

/**
 * Floating Tweaks panel — four controls (accent swatch, verdict preview,
 * density, paper mode). The panel is kept in the DOM on every render so
 * its open/close state is driven by a single `.on` class toggle; all
 * settings persist via CSS custom properties / data-attributes on the
 * document root.
 */
function renderTweaksPanel(): string {
  return `
    <div class="tweaks" id="tweaks" role="dialog" aria-label="Tweaks">
      <h3>Tweaks</h3>
      <div class="tweak">
        <span>Accent</span>
        <div class="swatches" data-swatches>
          <button class="sw on" type="button" style="background:#D64000" data-accent="#D64000" aria-label="Vermillon"></button>
          <button class="sw" type="button" style="background:#0F3D91" data-accent="#0F3D91" aria-label="Bleu"></button>
          <button class="sw" type="button" style="background:#1C6E4C" data-accent="#1C6E4C" aria-label="Vert"></button>
          <button class="sw" type="button" style="background:#14151A" data-accent="#14151A" aria-label="Encre"></button>
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
        <span>Papier</span>
        <select data-tweak="paper">
          <option value="warm">Warm paper</option>
          <option value="cool">Cool gray</option>
          <option value="pure">Pure white</option>
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
      <h2 class="card__title">Diagnostic</h2>
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
  return `
    <div class="metric">
      <div class="metric__icon">${iconMap[icon] || ''}</div>
      <div>
        <div class="metric__label">${esc(label)}</div>
        <div class="metric__value">${esc(value)}</div>
      </div>
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

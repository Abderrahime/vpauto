import { browser } from 'wxt/browser';
import type { MatchResult, VehicleBadge, VehicleHistory, VehicleSnapshot } from '@vpauto/shared';
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
    city: string;
    saleDate: string;
    status: string;
    startingPrice: number | null;
    soldPrice: number | null;
    lotNumber: number | null;
    mileage: number;
    scrapedAt: string;
    sourceUrl: string;
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
  detail: string;
  url: string;
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
            url,
          },
        };
  }

  const previousPrice = previous.startingPrice ?? null;
  const nextPrice = next.startingPrice ?? null;
  const previousStatus = previous.status || 'available';
  const nextStatus = next.status || 'available';

  const priceDelta = previousPrice != null && nextPrice != null && previousPrice !== nextPrice
    ? nextPrice - previousPrice
    : null;
  const priceDirection = priceDelta == null
    ? null
    : priceDelta > 0
      ? 'up'
      : priceDelta < 0
        ? 'down'
        : null;
  const statusChanged = previousStatus !== nextStatus;
  const soldPriceChanged = (previous.soldPrice ?? null) !== (next.soldPrice ?? null);
  const lotChanged = (previous.lotNumber ?? null) !== (next.lotNumber ?? null);
  const updated = priceDelta !== null || statusChanged || soldPriceChanged || lotChanged;

  let changeEntry: ImportChangeEntry | null = null;
  if (priceDelta !== null) {
    changeEntry = {
      label,
      kind: priceDelta > 0 ? 'price_up' : 'price_down',
      detail: `${priceDelta > 0 ? '+' : ''}${priceDelta.toLocaleString('fr-FR')} € sur la mise a prix`,
      url,
    };
  } else if (statusChanged) {
    changeEntry = {
      label,
      kind: 'status_change',
      detail: `Statut: ${formatStatus(previousStatus)} → ${formatStatus(nextStatus)}`,
      url,
    };
  } else if (updated) {
    changeEntry = {
      label,
      kind: 'updated',
      detail: 'Fiche enrichie avec de nouvelles informations.',
      url,
    };
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
          api.getSimilarSold(snapshot.brand, snapshot.model, snapshot.year, snapshot.hashId)
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

function bindActions(state: StoredPanelState): void {
  document.querySelector<HTMLButtonElement>('[data-action="refresh"]')
    ?.addEventListener('click', () => void refreshPanel());

  document.querySelector<HTMLButtonElement>('[data-action="open-source"]')
    ?.addEventListener('click', () => {
      const url = state.currentVehicle?.snapshot?.sourceUrl;
      if (url) void browser.tabs.create({ url });
    });

  document.querySelector<HTMLButtonElement>('[data-action="toggle-debug"]')
    ?.addEventListener('click', () => {
      showDebug = !showDebug;
      void refreshPanel();
    });

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

  // Recover startingPrice from multiple sources (sold pages hide "Mise à prix")
  let startingPrice = snapshot.startingPrice;
  // Source 1: cross-auction data
  if (!startingPrice && crossAuction?.firstStartingPrice) {
    startingPrice = crossAuction.firstStartingPrice;
  }
  // Source 2: history passages
  if (!startingPrice && history && history.passages.length > 0) {
    for (const p of history.passages) {
      if (p.startingPrice) { startingPrice = p.startingPrice; break; }
    }
  }
  // Source 3: same vehicle in current list (scraped with startingPrice on the card)
  if (!startingPrice && snapshot.hashId && currentList.length > 0) {
    const fromList = currentList.find(v => v.hashId === snapshot.hashId);
    if (fromList?.startingPrice) {
      startingPrice = fromList.startingPrice;
    }
  }

  // Find similar vehicles in current auction list
  const similarInAuction = findSimilarInList(snapshot, currentList);

  // Build metrics dynamically — only show metrics with real data
  const metrics: string[] = [];
  if (startingPrice) metrics.push(metricCard('Mise a prix', formatPrice(startingPrice), 'price'));
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
      ${renderHeader(title, subtitle, isApiOnline)}

      ${renderStatusBar(snapshot, vehicleId, isNew)}

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
      ${renderHistorySection(history, vehicleId, snapshot)}
      ${renderPriceChart(history)}
      ${renderActionsBar(true)}
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
      ${showDebug ? renderDebugCard(isApiOnline, list, debug, state.backgroundDebug) : ''}
    </div>
  `;
}

// ── Shared Components ────────────────────────────────────────────────────

function renderHeader(title: string, subtitle: string, isApiOnline: boolean): string {
  return `
    <header class="hero">
      <div class="hero__brand">
        <div class="hero__logo">VP</div>
        <div>
          <p class="hero__eyebrow">VPauto Assistant</p>
          <div class="hero__status">
            <span class="status-dot ${isApiOnline ? 'status-dot--ok' : 'status-dot--off'}"></span>
            <span class="hero__status-text">${isApiOnline ? 'Connecte' : 'Hors ligne'}</span>
          </div>
        </div>
      </div>
      <h1 class="hero__title">${esc(title)}</h1>
      <p class="hero__subtitle">${esc(subtitle)}</p>
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

function renderHistorySection(history: VehicleHistory | null, vehicleId: number | null | undefined, snapshot: VehicleSnapshot): string {
  const historicalPassages = history?.passages.filter((passage) => !isCurrentAuctionPassage(passage, snapshot)) || [];

  if (!history || historicalPassages.length === 0) {
    return `
      <section class="card">
        <h2 class="card__title"><span class="card__icon">&#128203;</span> Historique</h2>
        <div class="card__empty">
          ${vehicleId
            ? "Aucun passage precedent connu pour ce vehicule dans la base locale."
            : "Historique indisponible tant que le vehicule n'est pas rattache a un identifiant backend."}
        </div>
      </section>
    `;
  }

  const items = historicalPassages
    .slice(-5)
    .reverse()
    .map((p, i) => {
      const isFirst = i === 0;
      return `
        <div class="timeline-item ${isFirst ? 'timeline-item--current' : ''}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="timeline-date">${esc(formatDate(p.date))}</span>
              <span class="timeline-status">${esc(formatStatus(p.status))}</span>
            </div>
            <div class="timeline-body">
              ${esc(p.city)}${p.center ? ` - ${esc(p.center)}` : ''}
            </div>
            <div class="timeline-meta">
              Mise a prix: ${formatPrice(p.startingPrice)}${p.soldPrice ? ` \u2192 Adjuge: ${formatPrice(p.soldPrice)}` : ''}${p.mileage ? ` \u2022 ${formatDistance(p.mileage)}` : ''}
            </div>
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
  const previousPassages = data?.passages.filter((passage) => !isCurrentAuctionPassage(passage, snapshot)) || [];

  if (!data || previousPassages.length === 0) {
    return `
      <section class="card">
        <h2 class="card__title"><span class="card__icon">&#127758;</span> Parcours multi-encheres</h2>
        <div class="card__empty">
          Aucun passage precedent connu pour ce vehicule dans la base locale pour le moment.
        </div>
      </section>
    `;
  }

  const items = previousPassages.map(p => {
    const isCurrent = false;
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
          <span class="cross-item__city">${esc(p.city)}</span>
          <span class="chip chip--${statusColor}" style="font-size:9px;padding:2px 6px;">${statusLabel}</span>
        </div>
        <div class="cross-item__detail">
          <span>${esc(formatDate(p.saleDate))}</span>
          <span>${priceHtml}</span>
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
    const statusLabel = v.status === 'sold' ? 'Vendu' : v.status === 'unsold' ? 'Invendu' : '';
    const statusColor = v.status === 'sold' ? 'green' : v.status === 'unsold' ? 'red' : '';
    return `
      <div class="similar-item" data-vehicle-url="${esc(v.sourceUrl || '')}">
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(v.brand || '')} ${esc(v.model || '')}
            ${isModelMatch ? '<span class="badge-match">Match</span>' : ''}
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
      <div class="similar-item" data-vehicle-url="${esc(candidate.sourceUrl || '')}">
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(candidate.brand)} ${esc(candidate.model)}
            ${match.level === 'same_model' ? '<span class="badge-match">Match</span>' : ''}
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

  // Price recommendation
  let recommendHtml = '';
  if (stats.avgSoldPrice && stats.count >= 1) {
    const currentPrice = currentSnapshot.startingPrice || currentSnapshot.soldPrice;
    recommendHtml = `
      <div class="recommend-box">
        <div class="recommend-box__title">Estimation de prix</div>
        <div class="recommend-box__row">
          <span>Prix moyen adjuge (${stats.count} ventes)</span>
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
  }

  // Similar vehicles list
  const items = data.results.slice(0, 8).map(v => {
    const exactMatch = v.modelMatch && v.yearMatch;
    return `
      <div class="similar-item" data-vehicle-url="${esc(v.sourceUrl)}">
        <div class="similar-item__info">
          <div class="similar-item__name">
            ${esc(v.brand)} ${esc(v.model)}
            ${exactMatch ? '<span class="badge-match">Match</span>' : ''}
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

    const priceDisplay = isSold && v.soldPrice
      ? `<div class="vehicle-card__sold-price">Adjuge ${formatPrice(v.soldPrice)}</div><div class="vehicle-card__start-price">${formatPrice(v.startingPrice)}</div>`
      : isUnsold
      ? `<div class="vehicle-card__unsold">Invendu</div><div class="vehicle-card__start-price">${formatPrice(v.startingPrice)}</div>`
      : `<div class="vehicle-card__price">${formatPrice(v.startingPrice)}</div>`;

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
              <span>${esc(change.detail)}</span>
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
        &#8635; Rafraichir
      </button>
      ${hasSource ? '<button class="btn btn--ghost" type="button" data-action="open-source">Ouvrir la page &#8599;</button>' : ''}
      <button class="btn btn--ghost btn--small" type="button" data-action="toggle-debug">
        ${showDebug ? 'Masquer debug' : 'Debug'}
      </button>
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

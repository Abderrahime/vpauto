import type {
  ApiResponse,
  VehicleSnapshot,
  VehicleHistory,
  VehicleBadge,
  MatchResult,
  VehicleHistorySnapshotResponse,
} from '@vpauto/shared';
import { getAccessHeaders } from './access';
import type { VpautoAuthSession } from './access';
import { getApiBaseUrl } from './config';

const API_URL = getApiBaseUrl();
const DIRECT_FETCH_TIMEOUT_MS = 15000;

type ApiRequestResult<T> = {
  data: T | null;
  error: string | null;
};

/** A vehicle the user can capture in the running orchestrator session. */
export type CaptureCandidate = {
  vehicleId: number;
  /** Snapshot the screenshot will be attached to (always the latest). */
  snapshotId: number;
  hashId: string;
  reference: string | null;
  brand: string;
  model: string;
  version: string;
  year: number;
  city: string;
  saleDate: string | null;
  startingPrice: number | null;
  status: string;
  sourceUrl: string;
  /** First photo URL if available — used for the orchestrator thumbnail. */
  thumbUrl: string | null;
  /** Short FR sentence describing why this vehicle is in the bucket. */
  reason: string;
};

/** One row in the per-vehicle capture timeline. */
export type CaptureTimelineEntry = {
  snapshotId: number;
  scrapedAt: string;
  city: string;
  saleDate: string | null;
  saleTime: string | null;
  status: string;
  startingPrice: number | null;
  soldPrice: number | null;
  sourceUrl: string;
  hashId: string | null;
  /** Auto-generated label: "Première capture", "Prix 14 900 € → 13 500 €"… */
  reason: string;
};

let rpcCounter = 0;

function toQueryString(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    qs.set(key, String(value));
  }

  return qs.toString();
}

/**
 * Content scripts on https pages can't fetch http://localhost (mixed content).
 * Detect this and proxy through the background service worker.
 */
const isContentScript = typeof window !== 'undefined'
  && typeof location !== 'undefined'
  && !location.protocol.startsWith('chrome-extension')
  && !location.protocol.startsWith('moz-extension');

function mergeHeaders(base: Record<string, string>, extra?: HeadersInit): HeadersInit {
  const headers = new Headers(base);
  if (extra) {
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  if (options.signal) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), DIRECT_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T | null> {
  const result = await requestDetailed<T>(path, options);
  return result.data;
}

async function requestViaBackgroundPort<T>(
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ data?: T; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let port: chrome.runtime.Port | null = null;
    const requestId = `rpc_${Date.now()}_${++rpcCounter}`;

    const finish = (result: { data?: T; error?: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        port?.disconnect();
      } catch {}
      resolve(result);
    };

    const timeout = window.setTimeout(() => {
      finish({ error: 'background_port_timeout' });
    }, timeoutMs);

    try {
      port = chrome.runtime.connect({ name: 'vpauto-rpc' });
    } catch (error) {
      finish({
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    port.onMessage.addListener((response) => {
      if (response?.requestId !== requestId) {
        return;
      }

      finish({
        data: response?.data,
        error: response?.error,
      });
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      finish({
        error: chrome.runtime.lastError?.message || 'background_port_disconnected',
      });
    });

    try {
      port.postMessage({
        ...message,
        requestId,
      });
    } catch (error) {
      finish({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function requestViaBackgroundMessage<T>(
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ data?: T; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: { data?: T; error?: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(result);
    };

    const timeout = window.setTimeout(() => {
      finish({ error: 'background_message_timeout' });
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          finish({ error: chrome.runtime.lastError.message || 'sendMessage failed' });
          return;
        }

        finish({
          data: resp?.data,
          error: resp?.error,
        });
      });
    } catch (error) {
      finish({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function requestDetailed<T>(path: string, options?: RequestInit): Promise<ApiRequestResult<T>> {
  try {
    let json: ApiResponse<T>;
    const headers = {
      'Content-Type': 'application/json',
      ...await getAccessHeaders(),
    };

    if (isContentScript) {
      const bodyLen = options?.body ? String(options.body).length : 0;
      console.log(`[VPauto API proxy] → ${options?.method || 'GET'} ${path} (body: ${bodyLen} bytes, transport=port)`);

      let response = await requestViaBackgroundPort<ApiResponse<T>>({
        type: 'API_PROXY',
        path,
        options: options ? {
          method: options.method,
          headers,
          body: options.body,
        } : { headers },
      }, 15000);

      if (response.error) {
        console.warn(`[VPauto API proxy] ${path}: port failed (${response.error}), trying sendMessage fallback...`);
        response = await requestViaBackgroundMessage<ApiResponse<T>>({
          type: 'API_PROXY',
          path,
          options: options ? {
            method: options.method,
            headers,
            body: options.body,
          } : { headers },
        }, 15000);
      }

      if (response.error) {
        console.warn(`[VPauto API proxy] ${path}: ERROR =`, response.error);
        return {
          data: null,
          error: response.error === 'background_port_timeout' || response.error === 'background_message_timeout'
            ? 'background_proxy_timeout'
            : response.error,
        };
      }
      console.log(`[VPauto API proxy] ← ${path}: response received, hasData=${!!response.data}, hasError=${!!response.error}`);
      json = response.data!;
    } else {
      // Direct fetch from extension pages (side panel, popup)
      const res = await fetchWithTimeout(`${API_URL}${path}`, {
        ...options,
        headers: mergeHeaders(headers, options?.headers),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[VPauto API] ${path} HTTP ${res.status}:`, text.slice(0, 500));
        return { data: null, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      json = await res.json();
    }

    if (!json.success) {
      console.warn(`[VPauto API] ${path}: success=false, error=`, json.error);
      return { data: null, error: json.error || 'unknown_api_error' };
    }
    return { data: json.data ?? null, error: null };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`[VPauto API] ${path}: timeout after ${DIRECT_FETCH_TIMEOUT_MS}ms`);
      return { data: null, error: 'api_timeout' };
    }
    console.error(`[VPauto API] ${path}: EXCEPTION:`, err);
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export const api = {
  saveSnapshot(snapshot: VehicleSnapshot) {
    return request<{ vehicleId: number; snapshotId: number; duplicate: boolean; createdVehicle: boolean }>(
      '/api/vehicles/snapshot',
      { method: 'POST', body: JSON.stringify(snapshot) },
    );
  },

  saveSnapshotDetailed(snapshot: VehicleSnapshot) {
    return requestDetailed<{ vehicleId: number; snapshotId: number; duplicate: boolean; createdVehicle: boolean }>(
      '/api/vehicles/snapshot',
      { method: 'POST', body: JSON.stringify(snapshot) },
    );
  },

  lookup(params: { reference?: string; hashId?: string }) {
    const qs = toQueryString(params);
    return request<{ vehicleId: number; totalSnapshots: number; lastSnapshot: VehicleSnapshot | null }>(
      `/api/vehicles/lookup?${qs}`,
    );
  },

  getHistory(vehicleId: number) {
    return request<VehicleHistory>(`/api/vehicles/history/${vehicleId}`);
  },

  getHistorySnapshot(snapshotId: number) {
    return request<VehicleHistorySnapshotResponse>(`/api/vehicles/history-snapshot/${snapshotId}`);
  },

  getBadges(vehicleId: number) {
    return request<VehicleBadge[]>(`/api/vehicles/badges/${vehicleId}`);
  },

  findSimilar(snapshot: VehicleSnapshot, vehicleId?: number) {
    return request<MatchResult[]>('/api/vehicles/similar', {
      method: 'POST',
      body: JSON.stringify({ snapshot, vehicleId }),
    });
  },

  getSameModel(brand: string, model: string, excludeVehicleId?: number) {
    const qs = toQueryString({
      brand,
      model,
      ...(excludeVehicleId ? { excludeVehicleId: String(excludeVehicleId) } : {}),
    });
    return request<{ vehicleId: number; snapshot: VehicleSnapshot }[]>(`/api/vehicles/same-model?${qs}`);
  },

  addToWatchlist(vehicleId: number, notes?: string) {
    return request(`/api/watchlist/${vehicleId}`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    });
  },

  removeFromWatchlist(vehicleId: number) {
    return request(`/api/watchlist/${vehicleId}`, { method: 'DELETE' });
  },

  getWatchlist() {
    return request('/api/watchlist/');
  },

  batchSnapshot(vehicles: Partial<VehicleSnapshot>[]) {
    return request<{
      saved: number;
      newVehicles: number;
      priceChanges: { hashId: string; vehicleId: number; diff: number }[];
      disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
    }>('/api/vehicles/batch-snapshot', {
      method: 'POST',
      body: JSON.stringify({ vehicles }),
    });
  },

  batchSnapshotDetailed(vehicles: Partial<VehicleSnapshot>[]) {
    return requestDetailed<{
      saved: number;
      newVehicles: number;
      priceChanges: { hashId: string; vehicleId: number; diff: number }[];
      disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
    }>('/api/vehicles/batch-snapshot', {
      method: 'POST',
      body: JSON.stringify({ vehicles }),
    });
  },

  runBackgroundBatchSave(vehicles: Partial<VehicleSnapshot>[]) {
    return requestViaBackgroundPort<{
      saved: number;
      newVehicles: number;
      priceChanges: { hashId: string; vehicleId: number; diff: number }[];
      disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
      timestamp: string;
    }>({
      type: 'RUN_BATCH_SAVE',
      vehicles,
    }, 120000).then(async (response) => {
      if (!response.error) {
        return response;
      }

      console.warn(`[VPauto API proxy] RUN_BATCH_SAVE: port failed (${response.error}), trying sendMessage fallback...`);
      return requestViaBackgroundMessage<{
        saved: number;
        newVehicles: number;
        priceChanges: { hashId: string; vehicleId: number; diff: number }[];
        disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
        timestamp: string;
      }>({
        type: 'RUN_BATCH_SAVE',
        vehicles,
      }, 120000);
    });
  },

  pingBackground() {
    return requestViaBackgroundPort<{ ok: boolean; timestamp: string }>({
      type: 'PING_BG',
    }, 5000).then(async (response) => {
      if (!response.error) {
        return response;
      }

      return requestViaBackgroundMessage<{ ok: boolean; timestamp: string }>({
        type: 'PING_BG',
      }, 5000);
    });
  },

  /** Get cross-auction history for a vehicle (all its passages across cities) */
  getCrossAuction(hashId: string) {
    type CrossPassageDTO = {
      snapshotId: number;
      canonicalSnapshotId: number;
      /** VPauto hashId for THIS passage — used by the silent 404 prober. */
      hashId: string | null;
      /** True when an on-disk screenshot of the VPauto fiche is available. */
      hasScreenshot: boolean;
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
    };
    return request<{
      vehicleId: number;
      brand: string;
      model: string;
      year: number;
      passages: CrossPassageDTO[];
      firstStartingPrice: number | null;
      /** Post-sale orphan passages dropped server-side, kept here so the
       *  UI can render clickable chips toward their VPauto pages. */
      postSaleTruncatedPassages?: CrossPassageDTO[];
    }>(`/api/vehicles/cross-auction/${hashId}`);
  },

  /** Find similar vehicles that were sold recently (price intelligence) */
  getSimilarSold(brand: string, model?: string, year?: number, mileage?: number, excludeHashId?: string) {
    const qs = toQueryString({ brand, model, year, mileage, excludeHashId });
    return request<{
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
        photoUrls: string[];
        yearMatch: boolean;
        modelMatch: boolean;
        mileageMatch: boolean;
      }[];
      stats: {
        count: number;
        avgSoldPrice: number | null;
        minSoldPrice: number | null;
        maxSoldPrice: number | null;
      };
    }>(`/api/vehicles/similar-sold?${qs}`);
  },

  healthCheck() {
    return request<{ status: string }>('/api/health');
  },

  getMe() {
    return request<import('@vpauto/shared').VpautoAccessProfile>('/api/me');
  },

  login(email: string, password: string) {
    return requestDetailed<VpautoAuthSession>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  /**
   * Plan a batch capture run.
   *
   * Sends the hashIds of the vehicles currently visible in the VPauto
   * import list and gets back three buckets: vehicles never captured
   * before AND first seen after `since` (new), vehicles already
   * captured but with a relevant change (modified), and vehicles never
   * captured AND first seen before `since` (missing/rattrapage).
   *
   * Cooldown defaults to 60 minutes server-side.
   */
  getCapturePlan(hashIds: string[], since?: string, cooldownMinutes?: number) {
    return request<{
      new: CaptureCandidate[];
      modified: CaptureCandidate[];
      missing: CaptureCandidate[];
      skipped: number;
    }>('/api/vehicles/capture/plan', {
      method: 'POST',
      body: JSON.stringify({ hashIds, since, cooldownMinutes }),
    });
  },

  /** Timeline of all stored captures for a vehicle. */
  getCaptures(vehicleId: number) {
    return request<{
      vehicleId: number;
      captures: CaptureTimelineEntry[];
    }>(`/api/vehicles/captures/${vehicleId}`);
  },

  /**
   * Silently probe a VPauto vehicle URL via the background service worker.
   * Returns `{ is404, status }` on success, `{ error }` on network failure.
   *
   * The probe runs in the background (not in the side panel) because the
   * service worker has the host_permissions for vpauto.fr and the request
   * never leaves a visible trace in the user's tabs. Used by the sidepanel
   * to pre-flag dead "Parcours multi-enchères" passages without the user
   * having to click through them one by one.
   */
  probeVpautoUrl(url: string, hashId: string) {
    return requestViaBackgroundPort<{ hashId: string; url: string; is404: boolean; status: number }>({
      type: 'PROBE_VPAUTO_URL',
      url,
      hashId,
    }, 10000).then(async (response) => {
      if (!response.error) return response;
      // Port channel can sporadically fail under heavy refresh load; the
      // sendMessage fallback uses Chrome's native one-shot RPC API.
      return requestViaBackgroundMessage<{ hashId: string; url: string; is404: boolean; status: number }>({
        type: 'PROBE_VPAUTO_URL',
        url,
        hashId,
      }, 10000);
    });
  },
};

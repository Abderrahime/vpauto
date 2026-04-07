import { DEFAULT_API_URL } from '@vpauto/shared';
import type { ApiResponse, VehicleSnapshot, VehicleHistory, VehicleBadge, MatchResult } from '@vpauto/shared';

const API_URL = DEFAULT_API_URL;

type ApiRequestResult<T> = {
  data: T | null;
  error: string | null;
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

    if (isContentScript) {
      const bodyLen = options?.body ? String(options.body).length : 0;
      console.log(`[VPauto API proxy] → ${options?.method || 'GET'} ${path} (body: ${bodyLen} bytes, transport=port)`);

      let response = await requestViaBackgroundPort<ApiResponse<T>>({
        type: 'API_PROXY',
        path,
        options: options ? {
          method: options.method,
          body: options.body,
        } : undefined,
      }, 15000);

      if (response.error) {
        console.warn(`[VPauto API proxy] ${path}: port failed (${response.error}), trying sendMessage fallback...`);
        response = await requestViaBackgroundMessage<ApiResponse<T>>({
          type: 'API_PROXY',
          path,
          options: options ? {
            method: options.method,
            body: options.body,
          } : undefined,
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
      const res = await fetch(`${API_URL}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
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
    return request<{
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
    }>(`/api/vehicles/cross-auction/${hashId}`);
  },

  /** Find similar vehicles that were sold recently (price intelligence) */
  getSimilarSold(brand: string, model?: string, year?: number, excludeHashId?: string) {
    const qs = toQueryString({ brand, model, year, excludeHashId });
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
        yearMatch: boolean;
        modelMatch: boolean;
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
};

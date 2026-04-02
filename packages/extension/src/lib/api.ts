import { DEFAULT_API_URL } from '@vpauto/shared';
import type { ApiResponse, VehicleSnapshot, VehicleHistory, VehicleBadge, MatchResult } from '@vpauto/shared';

const API_URL = DEFAULT_API_URL;

async function request<T>(path: string, options?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const json: ApiResponse<T> = await res.json();
    if (!json.success) {
      console.warn(`[VPauto API] ${path}:`, json.error);
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    console.error(`[VPauto API] ${path}:`, err);
    return null;
  }
}

export const api = {
  saveSnapshot(snapshot: VehicleSnapshot) {
    return request<{ vehicleId: number; snapshotId: number; duplicate: boolean }>(
      '/api/vehicles/snapshot',
      { method: 'POST', body: JSON.stringify(snapshot) },
    );
  },

  lookup(params: { reference?: string; hashId?: string }) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
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
    const qs = new URLSearchParams({
      brand,
      model,
      ...(excludeVehicleId ? { excludeVehicleId: String(excludeVehicleId) } : {}),
    }).toString();
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

  healthCheck() {
    return request<{ status: string }>('/api/health');
  },
};

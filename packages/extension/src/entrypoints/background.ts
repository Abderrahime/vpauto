import { DEFAULT_API_URL } from '@vpauto/shared';
import type { VehicleSnapshot } from '@vpauto/shared';

const API = DEFAULT_API_URL;

type BatchTrackingResult = {
  saved: number;
  newVehicles: number;
  priceChanges: { hashId: string; vehicleId: number; diff: number }[];
  disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
  timestamp: string;
};

type BackgroundDebugState = {
  startedAt?: string;
  status?: string;
  updatedAt?: string;
  lastStage?: string;
  lastMethod?: string;
  lastPath?: string;
  lastError?: string | null;
  lastRequestId?: string;
};

async function fetchApi<T>(path: string, options?: RequestInit): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { data: null, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    const json = await res.json() as { success?: boolean; data?: T; error?: string };
    if (!json.success) {
      return { data: null, error: json.error || 'unknown_api_error' };
    }

    return { data: json.data ?? null, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runBatchSave(vehicles: Partial<VehicleSnapshot>[]): Promise<BatchTrackingResult> {
  const chunkSize = 50;
  const totalChunks = Math.ceil(vehicles.length / chunkSize);
  let saved = 0;
  let newVehicles = 0;
  const priceChanges: BatchTrackingResult['priceChanges'] = [];
  const disappearedByHash = new Map<string, BatchTrackingResult['disappeared'][number]>();

  for (let i = 0; i < vehicles.length; i += chunkSize) {
    const chunk = vehicles.slice(i, i + chunkSize);
    const chunkIndex = Math.floor(i / chunkSize) + 1;
    const result = await fetchApi<{
      saved: number;
      newVehicles: number;
      priceChanges: BatchTrackingResult['priceChanges'];
      disappeared: BatchTrackingResult['disappeared'];
    }>('/api/vehicles/batch-snapshot', {
      method: 'POST',
      body: JSON.stringify({ vehicles: chunk }),
    });

    if (!result.data) {
      throw new Error(`batch chunk ${chunkIndex}/${totalChunks}: ${result.error || 'unknown_batch_error'}`);
    }

    saved += result.data.saved || 0;
    newVehicles += result.data.newVehicles || 0;
    priceChanges.push(...(result.data.priceChanges || []));

    for (const vehicle of result.data.disappeared || []) {
      disappearedByHash.set(vehicle.hashId, vehicle);
    }
  }

  const tracking: BatchTrackingResult = {
    saved,
    newVehicles,
    priceChanges,
    disappeared: [...disappearedByHash.values()],
    timestamp: new Date().toISOString(),
  };

  await chrome.storage.local.set({ batchTrackingResult: tracking });
  return tracking;
}

function setBackgroundDebug(patch: Partial<BackgroundDebugState>): void {
  chrome.storage.local.get('backgroundDebug', (items) => {
    const current = (items.backgroundDebug && typeof items.backgroundDebug === 'object')
      ? items.backgroundDebug as BackgroundDebugState
      : {};

    chrome.storage.local.set({
      backgroundDebug: {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    });
  });
}

async function handleRpcMessage(message: any): Promise<{ data?: any; error?: string }> {
  if (message.type === 'PING_BG') {
    setBackgroundDebug({
      status: 'ping_ok',
      lastStage: 'ping_ok',
      lastError: null,
      lastRequestId: message.requestId,
    });
    return {
      data: {
        ok: true,
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (message.type === 'API_PROXY') {
    const { path, options } = message;
    const method = options?.method || 'GET';
    const bodyLen = options?.body ? String(options.body).length : 0;

    setBackgroundDebug({
      status: 'proxy_received',
      lastStage: 'proxy_received',
      lastMethod: method,
      lastPath: path,
      lastError: null,
      lastRequestId: message.requestId,
    });
    console.log(`[VPauto BG] API_PROXY ${method} ${path} (body: ${bodyLen} bytes)`);

    setBackgroundDebug({
      status: 'proxy_fetch_started',
      lastStage: 'proxy_fetch_started',
      lastMethod: method,
      lastPath: path,
      lastError: null,
      lastRequestId: message.requestId,
    });

    const result = await fetchApi(path, options);

    if (result.error) {
      setBackgroundDebug({
        status: 'proxy_error',
        lastStage: 'proxy_error',
        lastMethod: method,
        lastPath: path,
        lastError: result.error,
        lastRequestId: message.requestId,
      });
      console.warn(`[VPauto BG] API_PROXY error for ${path}: ${result.error}`);
      return { error: result.error };
    }

    setBackgroundDebug({
      status: 'proxy_success',
      lastStage: 'proxy_success',
      lastMethod: method,
      lastPath: path,
      lastError: null,
      lastRequestId: message.requestId,
    });
    console.log(`[VPauto BG] API_PROXY success for ${path}:`, JSON.stringify(result.data).slice(0, 200));
    return { data: { success: true, data: result.data } };
  }

  if (message.type === 'RUN_BATCH_SAVE') {
    const vehicles = Array.isArray(message.vehicles) ? message.vehicles as Partial<VehicleSnapshot>[] : [];

    setBackgroundDebug({
      status: 'batch_started',
      lastStage: 'batch_started',
      lastError: null,
      lastRequestId: message.requestId,
    });
    console.log(`[VPauto BG] RUN_BATCH_SAVE ${vehicles.length} vehicles`);

    try {
      const tracking = await runBatchSave(vehicles);
      setBackgroundDebug({
        status: 'batch_success',
        lastStage: 'batch_success',
        lastError: null,
        lastRequestId: message.requestId,
      });
      return { data: tracking };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackgroundDebug({
        status: 'batch_error',
        lastStage: 'batch_error',
        lastError: reason,
        lastRequestId: message.requestId,
      });
      console.warn('[VPauto BG] RUN_BATCH_SAVE failed:', reason);
      return { error: reason };
    }
  }

  return { error: `unsupported_rpc_type:${String(message?.type || 'unknown')}` };
}

export default defineBackground(() => {
  console.log('[VPauto] Background service worker started');
  setBackgroundDebug({
    startedAt: new Date().toISOString(),
    status: 'started',
    lastStage: 'started',
    lastError: null,
  });

  // Open side panel when clicking the extension icon
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch {
        console.log('[VPauto] Side panel not available');
      }
    }
  });

  // ── Message handler — Chrome native API for proper async sendResponse ──
  chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (r?: any) => void) => {
    if (message.type === 'API_PROXY' || message.type === 'RUN_BATCH_SAVE' || message.type === 'PING_BG') {
      void handleRpcMessage(message)
        .then((result) => sendResponse(result))
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          setBackgroundDebug({
            status: 'rpc_unhandled_error',
            lastStage: 'rpc_unhandled_error',
            lastError: reason,
            lastRequestId: message.requestId,
          });
          sendResponse({ error: reason });
        });
      return true; // Keep channel open
    }

    // ── Batch chunk: content script sends 50 vehicles at a time ──
    if (message.type === 'BATCH_CHUNK') {
      const { vehicles, chunkIndex, totalChunks } = message;
      console.log(`[VPauto BG] BATCH_CHUNK ${chunkIndex + 1}/${totalChunks}: ${vehicles.length} vehicles`);
      fetchApi<{
        saved: number;
        newVehicles: number;
        priceChanges: BatchTrackingResult['priceChanges'];
        disappeared: BatchTrackingResult['disappeared'];
      }>('/api/vehicles/batch-snapshot', {
        method: 'POST',
        body: JSON.stringify({ vehicles }),
      })
        .then((result) => {
          if (result.error || !result.data) {
            console.warn(`[VPauto BG] Chunk ${chunkIndex + 1} failed: ${result.error}`);
            sendResponse({ error: result.error || 'chunk_failed' });
            return;
          }
          console.log(`[VPauto BG] Chunk ${chunkIndex + 1}/${totalChunks}: saved=${result.data.saved}, new=${result.data.newVehicles}`);
          sendResponse({ data: result.data });
        })
        .catch((err) => {
          console.warn(`[VPauto BG] Chunk ${chunkIndex + 1} fetch error:`, String(err));
          sendResponse({ error: String(err) });
        });
      return true; // Keep channel open
    }

    // ── Storage updates (synchronous — no return true needed) ──
    if (message.type === 'OPEN_SIDE_PANEL' && sender.tab?.id) {
      try {
        // @ts-expect-error
        chrome.sidePanel.open({ tabId: sender.tab.id });
      } catch {}
    }

    if (message.type === 'VEHICLE_DETECTED') {
      chrome.storage.local.set({
        currentVehicle: message.payload,
        currentTabId: sender.tab?.id,
      });
    }

    if (message.type === 'VEHICLE_LIST_DETECTED') {
      chrome.storage.local.set({
        currentVehicleList: message.payload,
        currentTabId: sender.tab?.id,
      });
    }

    if (message.type === 'SCRAPE_DEBUG') {
      chrome.storage.local.set({
        scrapeDebug: {
          ...message.payload,
          tabId: sender.tab?.id,
          timestamp: new Date().toISOString(),
        },
        currentTabId: sender.tab?.id,
      });
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'vpauto-rpc') {
      return;
    }

    setBackgroundDebug({
      status: 'port_connected',
      lastStage: 'port_connected',
      lastError: null,
    });

    port.onMessage.addListener((message) => {
      void handleRpcMessage(message)
        .then((result) => {
          port.postMessage({
            requestId: message?.requestId,
            ...result,
          });
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          setBackgroundDebug({
            status: 'port_error',
            lastStage: 'port_error',
            lastError: reason,
            lastRequestId: message?.requestId,
          });
          port.postMessage({
            requestId: message?.requestId,
            error: reason,
          });
        });
    });

    port.onDisconnect.addListener(() => {
      const errorMessage = chrome.runtime.lastError?.message || null;
      setBackgroundDebug({
        status: errorMessage ? 'port_disconnected_with_error' : 'port_disconnected',
        lastStage: errorMessage ? 'port_disconnected_with_error' : 'port_disconnected',
        lastError: errorMessage,
      });
    });
  });

  // Enable side panel on VPauto pages
  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    if (tab.url?.includes('vpauto.fr')) {
      try {
        chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
      } catch {}
    }
  });
});

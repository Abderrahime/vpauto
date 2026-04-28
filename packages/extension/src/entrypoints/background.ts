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

async function captureAndUploadScreenshot(input: {
  tabId: number | undefined;
  windowId: number | undefined;
  snapshotId: number;
}): Promise<{ data?: { snapshotId: number; bytes: number }; error?: string }> {
  if (!Number.isFinite(input.snapshotId)) {
    return { error: 'invalid_snapshot_id' };
  }
  if (input.tabId == null) {
    return { error: 'missing_tab_id' };
  }

  // Sanity-check: only capture VPauto detail pages so we never accidentally
  // upload, say, a banking tab opened in a parallel window.
  let windowId = input.windowId;
  try {
    const tab = await chrome.tabs.get(input.tabId);
    const url = tab.url || '';
    if (!/^https:\/\/(www\.)?vpauto\.fr\//.test(url)) {
      return { error: `tab_not_on_vpauto:${url}` };
    }
    if (windowId == null) windowId = tab.windowId;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // chrome.tabs.captureVisibleTab requires the target window to actually be
  // rendered. macOS in particular stops painting backgrounded popup windows,
  // so even though we open the popup focused, the user may have clicked back
  // to their main window between iterations. Re-asserting `focused: true`
  // forces macOS to paint the popup again before we capture.
  //
  // Wrapped in a 2 s timeout because chrome.windows.update has been observed
  // to hang on macOS when the target window is in a transitional state — we
  // don't want a stuck windows.update to cascade into the orchestrator's
  // 30 s iteration timeout and look like a captureVisibleTab problem.
  try {
    await Promise.race([
      chrome.windows.update(windowId!, { state: 'normal', focused: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('windows.update timeout')), 2000)),
    ]);
  } catch (error) {
    console.warn(`[VPauto BG] windows.update before capture failed:`, error);
  }

  let dataUrl: string;
  try {
    // captureVisibleTab is documented to be synchronous-ish but observed to
    // hang silently on macOS when the target window is occluded. Race it
    // against an 8 s timeout so a stuck call surfaces as an error instead of
    // dragging out to the orchestrator's full 30 s budget.
    dataUrl = await Promise.race<string>([
      chrome.tabs.captureVisibleTab(windowId!, { format: 'jpeg', quality: 75 }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('captureVisibleTab timeout')), 8000)),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[VPauto BG] captureVisibleTab failed for snapshot ${input.snapshotId} on window ${windowId}:`, reason);
    return { error: `captureVisibleTab: ${reason}` };
  }

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    console.warn(`[VPauto BG] captureVisibleTab returned invalid payload for snapshot ${input.snapshotId}; type=${typeof dataUrl}, len=${typeof dataUrl === 'string' ? dataUrl.length : 'n/a'}`);
    return { error: 'capture_returned_invalid_payload' };
  }

  console.log(`[VPauto BG] captureVisibleTab ok for snapshot ${input.snapshotId} (${dataUrl.length} chars), uploading…`);
  const upload = await fetchApi<{ snapshotId: number; bytes: number }>(
    `/api/vehicles/screenshot/${input.snapshotId}`,
    {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl }),
    },
  );
  if (upload.error || !upload.data) {
    console.warn(`[VPauto BG] Screenshot upload failed for snapshot ${input.snapshotId}: ${upload.error}`);
    return { error: upload.error || 'screenshot_upload_failed' };
  }
  console.log(`[VPauto BG] Screenshot uploaded for snapshot ${input.snapshotId} (${upload.data.bytes} bytes)`);
  return { data: upload.data };
}

async function handleRpcMessage(message: any, sender?: chrome.runtime.MessageSender): Promise<{ data?: any; error?: string }> {
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

  if (message.type === 'CAPTURE_SCREENSHOT') {
    setBackgroundDebug({
      status: 'screenshot_started',
      lastStage: 'screenshot_started',
      lastError: null,
      lastRequestId: message.requestId,
    });
    const result = await captureAndUploadScreenshot({
      tabId: sender?.tab?.id,
      windowId: sender?.tab?.windowId,
      snapshotId: Number(message.snapshotId),
    });
    if (result.error) {
      setBackgroundDebug({
        status: 'screenshot_error',
        lastStage: 'screenshot_error',
        lastError: result.error,
        lastRequestId: message.requestId,
      });
      console.warn(`[VPauto BG] CAPTURE_SCREENSHOT failed: ${result.error}`);
      return { error: result.error };
    }
    setBackgroundDebug({
      status: 'screenshot_success',
      lastStage: 'screenshot_success',
      lastError: null,
      lastRequestId: message.requestId,
    });
    return { data: result.data };
  }

  if (message.type === 'ORCHESTRATED_CAPTURE') {
    // Variant of CAPTURE_SCREENSHOT used by the side-panel-driven orchestrator
    // that drives a separate popup window through a list of vehicles. The
    // sender is the side panel (extension page, no `sender.tab`), so the
    // tab/window ids must come from the message payload.
    setBackgroundDebug({
      status: 'orchestrated_capture_started',
      lastStage: 'orchestrated_capture_started',
      lastError: null,
      lastRequestId: message.requestId,
    });
    const result = await captureAndUploadScreenshot({
      tabId: Number(message.tabId),
      windowId: Number(message.windowId),
      snapshotId: Number(message.snapshotId),
    });
    if (result.error) {
      setBackgroundDebug({
        status: 'orchestrated_capture_error',
        lastStage: 'orchestrated_capture_error',
        lastError: result.error,
        lastRequestId: message.requestId,
      });
      console.warn(`[VPauto BG] ORCHESTRATED_CAPTURE failed: ${result.error}`);
      return { error: result.error };
    }
    setBackgroundDebug({
      status: 'orchestrated_capture_success',
      lastStage: 'orchestrated_capture_success',
      lastError: null,
      lastRequestId: message.requestId,
    });
    return { data: result.data };
  }

  if (message.type === 'PROBE_VPAUTO_URL') {
    // Silent active probe of a VPauto vehicle URL — used by the sidepanel to
    // pre-flag "Parcours multi-enchères" passages whose VPauto fiche has been
    // taken down (404). We use HEAD because VPauto returns a clean HTTP 404
    // status for missing vehicles (verified curl); no body needed.
    //
    // Runs in the background service worker (not in the content script) so
    // the host_permissions include cookies/CORS for vpauto.fr and a probe
    // never blocks the page or leaves UI traces in the user's tabs.
    const url = String(message.url || '');
    const hashId = String(message.hashId || '');

    setBackgroundDebug({
      status: 'probe_started',
      lastStage: 'probe_started',
      lastMethod: 'HEAD',
      lastPath: url,
      lastError: null,
      lastRequestId: message.requestId,
    });

    if (!/^https:\/\/(?:www\.)?vpauto\.fr\/vehicule\//.test(url)) {
      const reason = 'invalid_vpauto_url';
      setBackgroundDebug({
        status: 'probe_error',
        lastStage: 'probe_error',
        lastError: reason,
        lastRequestId: message.requestId,
      });
      return { error: reason };
    }

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        credentials: 'omit',
        cache: 'no-cache',
        redirect: 'follow',
      });
      const is404 = response.status === 404;
      setBackgroundDebug({
        status: 'probe_success',
        lastStage: is404 ? 'probe_404' : 'probe_alive',
        lastMethod: 'HEAD',
        lastPath: url,
        lastError: null,
        lastRequestId: message.requestId,
      });
      return { data: { hashId, url, is404, status: response.status } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackgroundDebug({
        status: 'probe_error',
        lastStage: 'probe_error',
        lastError: reason,
        lastRequestId: message.requestId,
      });
      // Network errors are NOT 404s — return the error so the caller can
      // decide whether to retry. We deliberately do not flip is404=true
      // on a transient failure.
      return { error: reason };
    }
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
    if (
      message.type === 'API_PROXY' ||
      message.type === 'RUN_BATCH_SAVE' ||
      message.type === 'PING_BG' ||
      message.type === 'CAPTURE_SCREENSHOT' ||
      message.type === 'ORCHESTRATED_CAPTURE' ||
      message.type === 'PROBE_VPAUTO_URL'
    ) {
      void handleRpcMessage(message, sender)
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

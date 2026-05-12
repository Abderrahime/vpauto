import type { VehicleSnapshot, VpautoPermission } from '@vpauto/shared';
import { canAccess, getAccessHeaders, getExtensionAccess } from '../lib/access';
import { getApiBaseUrl } from '../lib/config';

const API = getApiBaseUrl();
const BACKGROUND_FETCH_TIMEOUT_MS = 15000;
const MAX_CT_PDF_BYTES = 8 * 1024 * 1024;

// ── SW log relay ──────────────────────────────────────────────────────────
// Opening the SW DevTools by clicking "service worker" in chrome://extensions
// is unreliable when the SW is in the "Inactive" state — the link is greyed
// out in recent Chrome builds. So we mirror every BG log into
// `chrome.storage.local.vpautoSwLog` (a 300-entry ring buffer). Read it from
// any page console with:
//     chrome.storage.local.get('vpautoSwLog', d => console.table(d.vpautoSwLog))
const SW_LOG_KEY = 'vpautoSwLog';
const SW_LOG_MAX = 300;

function swLog(level: 'log' | 'warn' | 'error', message: string): void {
  if (level === 'warn') console.warn(message);
  else if (level === 'error') console.error(message);
  else console.log(message);
  // Fire-and-forget ring-buffer append. We deliberately don't await — the
  // SW handler must not block on storage I/O for every log line.
  chrome.storage.local.get(SW_LOG_KEY, (items) => {
    const existing = Array.isArray(items[SW_LOG_KEY])
      ? (items[SW_LOG_KEY] as Array<{ t: number; level: string; message: string }>)
      : [];
    existing.push({ t: Date.now(), level, message });
    while (existing.length > SW_LOG_MAX) existing.shift();
    chrome.storage.local.set({ [SW_LOG_KEY]: existing }).catch(() => {});
  });
}

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

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = BACKGROUND_FETCH_TIMEOUT_MS): Promise<Response> {
  if (init.signal) {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function mergeHeaders(base: Record<string, string>, extra?: HeadersInit): HeadersInit {
  const headers = new Headers(base);
  if (extra) {
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<{ data: T | null; error: string | null }> {
  try {
    const accessHeaders = await getAccessHeaders();
    const res = await fetchWithTimeout(`${API}${path}`, {
      ...options,
      headers: mergeHeaders({ 'Content-Type': 'application/json', ...accessHeaders }, options?.headers),
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

function requiredProxyPermission(path: string, method: string): VpautoPermission | null {
  const upperMethod = method.toUpperCase();
  if (upperMethod !== 'GET' && path.startsWith('/api/vehicles/snapshot')) return 'vehicles:write';
  if (path.startsWith('/api/vehicles/batch-snapshot')) return 'vehicles:import';
  if (path.startsWith('/api/vehicles/capture/plan')) return 'captures:plan';
  if (path.startsWith('/api/vehicles/screenshot/')) return 'captures:run';
  return null;
}

function isAllowedCtPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'cdn.vpauto.fr'
      && /_CT\.pdf$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchCtPdf(url: string): Promise<{
  base64: string;
  bytes: number;
  contentType: string;
}> {
  if (!isAllowedCtPdfUrl(url)) {
    throw new Error('invalid_ct_pdf_url');
  }

  // Per-phase timing — the content side reports `background_message_timeout`
  // at 30 s and we want to know whether the 30 s budget was eaten by the
  // network fetch, the arrayBuffer read, or the base64 encode. The SW
  // console (chrome://extensions → Inspect views: service worker) shows
  // these logs; they cost almost nothing and disambiguate the failure
  // modes that used to look identical from the content side.
  const t0 = performance.now();
  // `cache: 'force-cache'` previously forced the browser HTTP cache to
  // serve stale entries without revalidation. Inside an MV3 service
  // worker that cache layer is unreliable — observed as fetches that
  // hang forever when the SW's process is reused after suspension and
  // the cached entry has been GC'd. Default cache behaviour is fine
  // here: CT PDFs are content-addressed (URL contains a hash) and we
  // already short-circuit at the badge level via `ctPdfSummaryCache`.
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'omit',
  });
  const tFetched = performance.now();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > MAX_CT_PDF_BYTES) {
    throw new Error(`ct_pdf_too_large:${contentLength}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_CT_PDF_BYTES) {
    throw new Error(`ct_pdf_too_large:${buffer.byteLength}`);
  }
  const tBuffered = performance.now();

  const base64 = arrayBufferToBase64(buffer);
  const tEncoded = performance.now();

  swLog(
    'log',
    `[VPauto BG] FETCH_CT_PDF ${url} — `
    + `fetch=${Math.round(tFetched - t0)}ms `
    + `read=${Math.round(tBuffered - tFetched)}ms `
    + `base64=${Math.round(tEncoded - tBuffered)}ms `
    + `bytes=${buffer.byteLength} `
    + `base64len=${base64.length}`,
  );

  return {
    base64,
    bytes: buffer.byteLength,
    contentType: response.headers.get('content-type') || 'application/pdf',
  };
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
    const access = await getExtensionAccess();
    const requiredPermission = requiredProxyPermission(String(path || ''), String(method || 'GET'));

    if (requiredPermission && !canAccess(access, requiredPermission)) {
      return { error: `forbidden:${access.role}` };
    }

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
    const access = await getExtensionAccess();
    if (!canAccess(access, 'captures:run')) {
      return { error: `forbidden:${access.role}` };
    }

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
      const response = await fetchWithTimeout(url, {
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

  if (message.type === 'FETCH_CT_PDF') {
    const url = String(message.url || '');
    // Cheap synchronous receipt log — confirms the SW saw the message and
    // entered the handler even if the fetch path later hangs. If you see
    // `received` but never `done`/`error`, the SW was killed mid-fetch.
    swLog('log', `[VPauto BG] FETCH_CT_PDF received url=${url}`);
    const handlerStart = performance.now();

    try {
      // Race the actual fetch against a hard wall-clock timeout. The
      // AbortController inside `fetchWithTimeout` *should* fire at 15 s,
      // but in MV3 service workers `setTimeout` is occasionally swallowed
      // when Chrome briefly suspends/resumes the SW between fetches. The
      // hard race guarantees we never burn the content-side 30 s budget.
      const pdf = await Promise.race([
        fetchCtPdf(url),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('sw_hard_timeout_25s')),
            25_000,
          ),
        ),
      ]);
      swLog(
        'log',
        `[VPauto BG] FETCH_CT_PDF done url=${url} `
        + `total=${Math.round(performance.now() - handlerStart)}ms `
        + `bytes=${pdf.bytes}`,
      );
      return { data: pdf };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      swLog(
        'warn',
        `[VPauto BG] FETCH_CT_PDF error url=${url} `
        + `after=${Math.round(performance.now() - handlerStart)}ms `
        + `reason=${reason}`,
      );
      return { error: reason };
    }
  }

  if (message.type === 'RUN_BATCH_SAVE') {
    const access = await getExtensionAccess();
    if (!canAccess(access, 'vehicles:import')) {
      return { error: `forbidden:${access.role}` };
    }

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
  swLog('log', `[VPauto BG] service worker started at ${new Date().toISOString()}`);
  setBackgroundDebug({
    startedAt: new Date().toISOString(),
    status: 'started',
    lastStage: 'started',
    lastError: null,
  });

  // ── Keep-alive ─────────────────────────────────────────────────────────
  // MV3 evicts idle service workers after ~30 s, which breaks our CT
  // pipeline (50 vehicles × ~2 s = ~100 s of work). The `chrome.alarms`
  // API survives SW eviction and respawns the SW when it fires, so
  // scheduling a 25 s alarm functionally pins the SW alive while the
  // extension is enabled. The listener is a no-op — the alarm event
  // itself counts as "activity" and resets Chrome's idle timer.
  try {
    chrome.alarms.create('vpauto-keep-alive', {
      periodInMinutes: 25 / 60, // ~25 s
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'vpauto-keep-alive') {
        // Intentional no-op. Just touching `performance.now()` here
        // ensures the V8 engine doesn't optimise the listener away.
        void performance.now();
      }
    });
  } catch (error) {
    swLog('warn', `[VPauto BG] keep-alive setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Open side panel when clicking the extension icon.
  //
  // Guard: `chrome.action` is only defined when the manifest declares an
  // `"action"` key. The user role used to ship without that key, which
  // turned this line into a synchronous TypeError ("Cannot read
  // properties of undefined (reading 'onClicked')"). MV3 treats any
  // synchronous throw during SW startup as registration failure (status
  // code 15) — the SW never registers, every `chrome.runtime.sendMessage`
  // from the content script then sits unanswered until the 30 s timeout
  // fires. The manifest now declares `action` unconditionally, but we
  // keep the guard so future builds without it degrade gracefully.
  if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(async (tab) => {
      if (tab.id) {
        try {
          await chrome.sidePanel.open({ tabId: tab.id });
        } catch {
          swLog('log', '[VPauto BG] Side panel not available');
        }
      }
    });
  } else {
    swLog('warn', '[VPauto BG] chrome.action is undefined — manifest is missing the "action" key');
  }

  // ── Message handler — Chrome native API for proper async sendResponse ──
  chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (r?: any) => void) => {
    if (
      message.type === 'API_PROXY' ||
      message.type === 'RUN_BATCH_SAVE' ||
      message.type === 'PING_BG' ||
      message.type === 'CAPTURE_SCREENSHOT' ||
      message.type === 'PROBE_VPAUTO_URL' ||
      message.type === 'FETCH_CT_PDF'
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

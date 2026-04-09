import type { VehicleSnapshot, VehicleBadge } from '@vpauto/shared';
import { api } from './api';
import { probeVehicleDocuments, type VehicleDocProbeResult } from './scraper';

// ── Document probe cache + concurrency limiter ─────────────────────────────
//
// We scrape each vehicle detail page to confirm whether a CT or a
// Bilan Expert document exists. Results are cached in memory and persisted
// to chrome.storage.local so that subsequent list pages (pagination, SPA
// navigation) reuse the probe result without refetching.
//
// Probing is eager (kicks off as soon as a card is processed) but rate-
// limited to MAX_CONCURRENT_PROBES simultaneous fetches to avoid hammering
// the server. The CT button is rendered in a non-clickable "checking" state
// until the probe confirms or denies presence — we never render a clickable
// button on top of an unverified URL (which previously caused black 404
// iframes for vehicles without CT, e.g. EVs).

type ProbeState = 'pending' | 'done' | 'error';

type ProbeEntry = {
  state: ProbeState;
  result: VehicleDocProbeResult | null;
  waiters: ((r: VehicleDocProbeResult | null) => void)[];
};

const probeCache = new Map<string, ProbeEntry>();
// Bumped when the probe schema changes so old cached entries are ignored.
// v2: switched from tentative-URL optimism to state-machine buttons.
// v3: added Suivi d'Entretien (`hasSuiviEntretien` / `suiviEntretienUrl`).
// v4: added Diagnostic batterie (`hasDiagnosticBatterie` / `diagnosticBatterieUrl`).
const PROBE_STORAGE_KEY = 'vpautoDocProbe.v4';
const PROBE_TTL_MS = 24 * 3600 * 1000; // 24 h
const MAX_CONCURRENT_PROBES = 3;
let activeProbes = 0;
const probeQueue: (() => void)[] = [];
let storageHydrated = false;

/** Hydrate in-memory probe cache from chrome.storage.local once per session. */
async function hydrateProbeCache(): Promise<void> {
  if (storageHydrated) return;
  storageHydrated = true;
  try {
    // Drop legacy cache keys so we don't carry over stale entries from
    // previous installs of the extension (older probe schemas).
    chrome.storage.local.remove([
      'vpautoDocProbe',
      'vpautoDocProbe.v2',
      'vpautoDocProbe.v3',
    ]).catch(() => {});

    const stored = await chrome.storage.local.get(PROBE_STORAGE_KEY);
    const raw = (stored[PROBE_STORAGE_KEY] || {}) as Record<string, VehicleDocProbeResult>;
    const now = Date.now();
    for (const [hashId, result] of Object.entries(raw)) {
      const age = now - new Date(result.probedAt).getTime();
      if (age < PROBE_TTL_MS) {
        probeCache.set(hashId, { state: 'done', result, waiters: [] });
      }
    }
  } catch {}
}

/** Persist one probe result back to chrome.storage.local. */
async function persistProbeResult(hashId: string, result: VehicleDocProbeResult): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(PROBE_STORAGE_KEY);
    const raw = (stored[PROBE_STORAGE_KEY] || {}) as Record<string, VehicleDocProbeResult>;
    raw[hashId] = result;
    await chrome.storage.local.set({ [PROBE_STORAGE_KEY]: raw });
  } catch {}
}

/** Pull next probe task from the queue if there is spare concurrency. */
function runNextProbe(): void {
  while (activeProbes < MAX_CONCURRENT_PROBES && probeQueue.length > 0) {
    const next = probeQueue.shift();
    if (next) next();
  }
}

/**
 * Get a cached probe result or run a new one. Multiple callers for the same
 * hashId share a single in-flight probe. Rate-limited to
 * MAX_CONCURRENT_PROBES simultaneous fetches.
 */
async function getOrProbe(hashId: string, detailPageUrl: string): Promise<VehicleDocProbeResult | null> {
  await hydrateProbeCache();

  const existing = probeCache.get(hashId);
  if (existing) {
    if (existing.state === 'done' || existing.state === 'error') {
      return existing.result;
    }
    // In-flight: wait for it
    return new Promise((resolve) => {
      existing.waiters.push(resolve);
    });
  }

  // Create pending entry immediately so subsequent callers share it
  const entry: ProbeEntry = { state: 'pending', result: null, waiters: [] };
  probeCache.set(hashId, entry);

  return new Promise<VehicleDocProbeResult | null>((resolve) => {
    entry.waiters.push(resolve);

    const task = async () => {
      activeProbes++;
      try {
        const result = await probeVehicleDocuments(detailPageUrl);
        entry.result = result;
        entry.state = result ? 'done' : 'error';
        if (result) void persistProbeResult(hashId, result);
      } catch {
        entry.state = 'error';
      } finally {
        activeProbes--;
        // Drain waiters
        const waiters = entry.waiters.slice();
        entry.waiters.length = 0;
        for (const w of waiters) w(entry.result);
        runNextProbe();
      }
    };

    if (activeProbes < MAX_CONCURRENT_PROBES) {
      void task();
    } else {
      probeQueue.push(() => void task());
    }
  });
}

/**
 * Inject badges, status overlays, and CT hover popups on vehicle cards in the list page.
 */
export async function injectBadges(vehicles: Partial<VehicleSnapshot>[]): Promise<void> {
  const listItems = document.querySelectorAll('a[href*="/vehicule/"]');

  for (const item of listItems) {
    const href = (item as HTMLAnchorElement).getAttribute('href') || '';
    const hashMatch = href.match(/\/vehicule\/([a-f0-9]+)\//);
    if (!hashMatch) continue;

    const hashId = hashMatch[1];
    const vehicleData = vehicles.find((v) => v.hashId === hashId);
    if (!vehicleData) continue;

    const card = item.closest('li') as HTMLElement | null;
    if (!card || card.dataset.vpautoProcessed) continue;
    card.dataset.vpautoProcessed = '1';
    card.style.position = 'relative';
    card.style.overflow = 'hidden';

    // Inject status + info overlay on the card
    injectStatusOverlay(card, vehicleData);

    // Build the detail page URL for the probe.
    // CRITICAL: always derive from location.origin (the document the content
    // script is running in) — NOT from vehicleData.sourceUrl which is built
    // with the apex `https://vpauto.fr`. The user typically browses
    // `www.vpauto.fr`, so the apex URL would trigger a cross-origin fetch
    // that the server CORS-blocks → false negative greying.
    const detailPageUrl = new URL(href, location.origin).href;

    // Add document buttons (CT + Bilan Expert) with eager probing
    addDocumentButtons(card, vehicleData, hashId, detailPageUrl);

    // Try to add badges from API (non-blocking)
    api.lookup({ hashId }).then(async (lookup) => {
      if (!lookup) return;

      const badges = await api.getBadges(lookup.vehicleId);
      if (badges && badges.length > 0) {
        injectBadgeOverlay(card, badges);
      }
    }).catch(() => {});
  }
}

/**
 * Inject a status overlay on the card bottom showing:
 * - Sold price vs starting price comparison
 * - Non-roulant warning
 */
function injectStatusOverlay(card: HTMLElement, v: Partial<VehicleSnapshot>): void {
  const isSold = v.status === 'sold';
  const isNonRoulant = /non\s*roulant/i.test(v.observations || '') || /non\s*roulant/i.test(v.model || '');

  if (!isSold && !isNonRoulant) return;

  const overlay = document.createElement('div');
  overlay.className = 'vpauto-status-overlay';
  overlay.style.cssText = `
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 4px 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11px;
    z-index: 5;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(4px);
    pointer-events: none;
  `;

  const parts: string[] = [];

  if (isSold && v.soldPrice && v.startingPrice) {
    const diff = v.soldPrice - v.startingPrice;
    const pct = ((diff / v.startingPrice) * 100).toFixed(0);
    const arrow = diff >= 0 ? '▲' : '▼';
    const color = diff >= 0 ? '#ef4444' : '#22c55e';
    parts.push(`<span style="color:${color};font-weight:700;">${arrow} ${diff >= 0 ? '+' : ''}${diff.toLocaleString('fr-FR')} € (${diff >= 0 ? '+' : ''}${pct}%)</span>`);
  }

  if (isNonRoulant) {
    parts.push(`<span style="color:#f59e0b;font-weight:700;">⚠ NON ROULANT</span>`);
  }

  overlay.innerHTML = parts.join('');
  card.appendChild(overlay);
}

function injectBadgeOverlay(card: HTMLElement, badges: VehicleBadge[]): void {
  if (card.querySelector('.vpauto-badges')) return;

  const container = document.createElement('div');
  container.className = 'vpauto-badges';
  container.style.cssText = `
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    z-index: 10;
    pointer-events: none;
  `;

  for (const badge of badges) {
    const el = document.createElement('span');
    el.style.cssText = `
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      ${getBadgeColors(badge.type)}
      pointer-events: auto;
      cursor: default;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    `;
    el.textContent = badge.detail ? `${badge.label} (${badge.detail})` : badge.label;
    el.title = badge.detail || badge.label;
    container.appendChild(el);
  }

  card.appendChild(container);
}

// ── Document buttons (CT + Bilan Expert) ───────────────────────────────────

type DocKind = 'ct' | 'be' | 'se' | 'db';
type DocButtonState = 'checking' | 'confirmed' | 'missing' | 'fallback';

type DocButtonConfig = {
  kind: DocKind;
  label: string;
  tooltip: string;
  confirmedUrl: string | null;
  state: DocButtonState;
  /** Detail page URL — used as a fallback "open in new tab" target. */
  detailPageUrl: string;
};

/** Close any open doc popup on other cards (or on this one if not excluded). */
function closeAllDocPopups(exceptCard?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.vpauto-doc-popup').forEach((popup) => {
    const owner = popup.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    popup.remove();
  });

  document.querySelectorAll<HTMLElement>('.vpauto-doc-toggle').forEach((button) => {
    const owner = button.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    button.setAttribute('aria-expanded', 'false');
    const defaultLabel = button.dataset.vpautoDefaultLabel;
    if (defaultLabel) button.textContent = defaultLabel;
  });
}

/**
 * Add CT (and, if confirmed, Bilan Expert) buttons to a vehicle card.
 *
 * Important: the CT button is NEVER rendered as clickable on top of an
 * unverified URL — that previously caused black 404 iframes for vehicles
 * without CT. The button starts in a non-clickable "checking" state and
 * transitions to either "confirmed" (clickable) or "missing" (greyed,
 * "CT indisponible") once the eager probe of the detail page resolves.
 *
 * The Bilan Expert button is created only after the probe positively
 * confirms a `_BE.pdf` link in the detail page.
 */
function addDocumentButtons(
  card: HTMLElement,
  v: Partial<VehicleSnapshot>,
  hashId: string,
  detailPageUrl: string,
): void {
  // Container that hosts all doc buttons (CT, Bilan, ...)
  const dock = document.createElement('div');
  dock.className = 'vpauto-doc-dock';
  dock.style.cssText = `
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 18;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
  `;
  card.appendChild(dock);

  // CT button starts in "checking" state — non-clickable, no URL.
  const ctConfig: DocButtonConfig = {
    kind: 'ct',
    label: 'Voir le CT',
    tooltip: 'Afficher le contrôle technique',
    confirmedUrl: null,
    state: 'checking',
    detailPageUrl,
  };
  const ctButton = createDocButton(card, dock, v, ctConfig);
  applyCheckingState(ctButton, ctConfig);

  // Eagerly run the probe (rate-limited to MAX_CONCURRENT_PROBES).
  // We do not wait for the card to be in viewport: a vehicle in the list
  // might be clicked at any moment, including by keyboard nav.
  void getOrProbe(hashId, detailPageUrl).then((result) => {
    if (!result) {
      // Network/parse failure → DEGRADED MODE, NOT a false negative.
      // We can't prove absence, so we don't grey. We can't prove presence,
      // so we don't link to a guessed PDF URL. Instead, the button becomes
      // a "Voir la fiche ↗" link that opens the detail page in a new tab,
      // where the user can manually access whatever docs exist.
      applyFallbackState(ctButton, ctConfig);
      return;
    }

    // ── CT handling ──
    if (result.hasCt && result.ctUrl) {
      ctConfig.confirmedUrl = result.ctUrl;
      applyConfirmedState(ctButton, ctConfig);
    } else {
      // Probe ran successfully and confirmed no `_CT.pdf` link in the page →
      // genuine absence, safe to grey.
      applyMissingState(ctButton, ctConfig);
    }

    // ── Bilan Expert handling ──
    // Only add a BE button if a `_BE.pdf` was positively found. We deliberately
    // do NOT render a "missing" BE button when absent — the absence of a Bilan
    // Expert is the norm (most cars don't have one) and a greyed-out button
    // would add visual noise on every card.
    if (result.hasBilanExpert && result.bilanExpertUrl) {
      const beConfig: DocButtonConfig = {
        kind: 'be',
        label: 'Voir bilan',
        tooltip: 'Afficher le Bilan Expert',
        confirmedUrl: result.bilanExpertUrl,
        state: 'confirmed',
        detailPageUrl,
      };
      const beButton = createDocButton(card, dock, v, beConfig);
      applyConfirmedState(beButton, beConfig);
    }

    // ── Suivi d'Entretien handling ──
    // Same philosophy as BE: only render the button when the document is
    // positively present. The "Suivi d'Entretien : Non" metadata field is
    // also the norm, and silencing it visually keeps cards clean.
    if (result.hasSuiviEntretien && result.suiviEntretienUrl) {
      const seConfig: DocButtonConfig = {
        kind: 'se',
        label: 'Voir entretien',
        tooltip: 'Afficher le Suivi d\'Entretien',
        confirmedUrl: result.suiviEntretienUrl,
        state: 'confirmed',
        detailPageUrl,
      };
      const seButton = createDocButton(card, dock, v, seConfig);
      applyConfirmedState(seButton, seConfig);
    }

    // ── Diagnostic batterie handling ──
    // Only for EVs and PHEVs — ICE cars will never have a `_TB.pdf`, so
    // rendering a greyed "Diagnostic batterie indisponible" button on every
    // petrol car would be pure noise. Present-only rendering.
    if (result.hasDiagnosticBatterie && result.diagnosticBatterieUrl) {
      const dbConfig: DocButtonConfig = {
        kind: 'db',
        label: 'Voir batterie',
        tooltip: 'Afficher le Diagnostic batterie',
        confirmedUrl: result.diagnosticBatterieUrl,
        state: 'confirmed',
        detailPageUrl,
      };
      const dbButton = createDocButton(card, dock, v, dbConfig);
      applyConfirmedState(dbButton, dbConfig);
    }
  });
}

/** Build one doc button shell and wire its click handler. State is applied separately. */
function createDocButton(
  card: HTMLElement,
  dock: HTMLElement,
  v: Partial<VehicleSnapshot>,
  config: DocButtonConfig,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `vpauto-doc-toggle vpauto-doc-toggle-${config.kind}`;
  button.setAttribute('aria-expanded', 'false');
  button.dataset.vpautoDefaultLabel = config.label;
  button.dataset.vpautoDocKind = config.kind;
  button.style.cssText = `
    border: none;
    color: #f8fafc;
    padding: 7px 11px;
    border-radius: 999px;
    font: 700 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    letter-spacing: 0.01em;
    box-shadow: 0 6px 18px rgba(0,0,0,0.28);
    backdrop-filter: blur(8px);
    transition: opacity 150ms, filter 150ms, background 150ms;
  `;
  dock.appendChild(button);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    // Fallback (probe failed): just open the detail page in a new tab —
    // no popup, no iframe, no risk of a black 404 preview.
    if (config.state === 'fallback') {
      window.open(config.detailPageUrl, '_blank', 'noopener');
      return;
    }

    // Only confirmed buttons open a popup. checking + missing → no-op.
    if (config.state !== 'confirmed' || !config.confirmedUrl) return;

    // Toggle: if a popup of this kind is already open, close it
    const existing = card.querySelector<HTMLElement>(`.vpauto-doc-popup[data-vpauto-doc-kind="${config.kind}"]`);
    if (existing) {
      removeDocPopup(button);
      return;
    }

    closeAllDocPopups(card);
    openDocPopup(card, button, config, config.confirmedUrl, v);
  });

  return button;
}

/** Apply "checking" visuals — greyed out + non-clickable, "Vérification…" label. */
function applyCheckingState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'checking';
  button.disabled = true;
  button.textContent = config.kind === 'be' ? 'Bilan…' : 'Vérification CT…';
  button.title = 'Vérification du document sur la fiche véhicule';
  button.style.background = 'rgba(60,64,75,0.78)';
  button.style.opacity = '0.65';
  button.style.cursor = 'progress';
  button.dataset.vpautoCtState = 'checking';
  button.setAttribute('aria-disabled', 'true');
}

/** Apply "confirmed" visuals — coloured background, clickable. */
function applyConfirmedState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'confirmed';
  button.disabled = false;
  button.textContent = config.label;
  button.title = config.tooltip;
  button.style.background = confirmedBackground(config.kind);
  button.style.opacity = '1';
  button.style.filter = 'none';
  button.style.cursor = 'pointer';
  button.dataset.vpautoCtState = 'confirmed';
  button.removeAttribute('aria-disabled');
}

/** Colour used for the confirmed state of each document kind. */
function confirmedBackground(kind: DocKind): string {
  switch (kind) {
    case 'be': return 'rgba(244,121,32,0.92)';  // orange — Bilan Expert
    case 'se': return 'rgba(34,197,94,0.92)';   // green  — Suivi d'Entretien
    case 'db': return 'rgba(59,130,246,0.92)';  // blue   — Diagnostic batterie
    case 'ct':
    default:   return 'rgba(15,17,23,0.85)';    // dark   — Contrôle Technique
  }
}

/** Apply "missing" visuals — fully greyed, "indisponible", non-clickable. */
function applyMissingState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'missing';
  button.disabled = true;
  button.textContent = config.kind === 'be' ? 'Bilan indisponible' : 'CT indisponible';
  button.title = config.kind === 'be'
    ? 'Aucun bilan expert disponible sur la fiche véhicule'
    : 'Absence de contrôle technique confirmée sur la fiche véhicule';
  button.style.background = 'rgba(60,64,75,0.78)';
  button.style.opacity = '0.55';
  button.style.filter = 'grayscale(0.8)';
  button.style.cursor = 'not-allowed';
  button.dataset.vpautoCtState = 'missing';
  button.setAttribute('aria-disabled', 'true');
}

/**
 * Apply "fallback" visuals — used only when the probe fetch failed (network,
 * CORS, parse error). The button stays clickable but opens the detail page
 * in a new tab instead of showing a popup. This avoids both the black 404
 * iframe (no guessed PDF URL) and the false-negative greying (we never
 * confirmed the absence of CT).
 */
function applyFallbackState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'fallback';
  button.disabled = false;
  button.textContent = 'Voir la fiche ↗';
  button.title = 'Vérification du document indisponible — ouvrir la fiche véhicule';
  button.style.background = 'rgba(15,17,23,0.85)';
  button.style.opacity = '1';
  button.style.filter = 'none';
  button.style.cursor = 'pointer';
  button.dataset.vpautoCtState = 'fallback';
  button.removeAttribute('aria-disabled');
}

function removeDocPopup(button: HTMLButtonElement): void {
  const card = button.closest('li');
  if (!card) return;
  const popup = card.querySelector<HTMLElement>(`.vpauto-doc-popup[data-vpauto-doc-kind="${button.dataset.vpautoDocKind}"]`);
  if (popup) popup.remove();
  button.setAttribute('aria-expanded', 'false');
  const defaultLabel = button.dataset.vpautoDefaultLabel;
  if (defaultLabel) button.textContent = defaultLabel;
}

function openDocPopup(
  card: HTMLElement,
  button: HTMLButtonElement,
  config: DocButtonConfig,
  url: string,
  v: Partial<VehicleSnapshot>,
): void {
  const popup = document.createElement('div');
  popup.className = 'vpauto-doc-popup';
  popup.dataset.vpautoDocKind = config.kind;
  popup.style.cssText = `
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(12,16,24,0.96) 0%, rgba(15,17,23,0.98) 100%);
    padding: 0;
    z-index: 30;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    color: #f0f0f5;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: vpauto-ct-fade-in 140ms ease-out;
    backdrop-filter: blur(3px);
  `;

  const brand = v.brand || '';
  const model = v.model || '';
  const isSold = v.status === 'sold';
  const isNonRoulant = /non\s*roulant/i.test(v.observations || '') || /non\s*roulant/i.test(v.model || '');

  let priceHtml = '';
  if (isSold && v.soldPrice) {
    priceHtml += `<span style="color:#22c55e;font-weight:700;">Adjuge: ${v.soldPrice.toLocaleString('fr-FR')} €</span>`;
    if (v.startingPrice) {
      priceHtml += `<span style="color:#8b8fa3;text-decoration:line-through;margin-left:8px;">${v.startingPrice.toLocaleString('fr-FR')} €</span>`;
    }
  } else if (v.startingPrice) {
    priceHtml = `<span style="color:#f47920;font-weight:700;">${v.startingPrice.toLocaleString('fr-FR')} €</span>`;
  }

  const km = v.mileage ? v.mileage.toLocaleString('fr-FR') + ' km' : '';
  const city = v.city || '';
  const year = v.year || '';

  let tagsHtml = '';
  if (isNonRoulant) {
    tagsHtml += `<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">NON ROULANT</span>`;
  }
  if (isSold) {
    tagsHtml += `<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">VENDU</span>`;
  }

  const headerHtml = `
    <div style="padding:10px 12px; background:linear-gradient(135deg,rgba(30,42,58,0.96),rgba(15,21,32,0.98)); border-bottom:1px solid rgba(255,255,255,0.08); flex:0 0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
        <div style="font-weight:700; color:#f0f0f5; font-size:13px; line-height:1.25;">${esc(brand)} ${esc(model)}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${tagsHtml}</div>
      </div>
      <div style="display:flex; gap:12px; margin-top:6px; color:#dbe4ee; font-size:11px; flex-wrap:wrap;">
        ${priceHtml ? `<span>${priceHtml}</span>` : ''}
      </div>
      <div style="display:flex; gap:10px; margin-top:4px; color:#8b8fa3; font-size:10px; flex-wrap:wrap;">
        ${year ? `<span>${year}</span>` : ''}
        ${km ? `<span>${km}</span>` : ''}
        ${city ? `<span>${city}</span>` : ''}
      </div>
    </div>
  `;

  const badgeLabel =
    config.kind === 'be' ? 'Aperçu Bilan Expert'
    : config.kind === 'se' ? 'Aperçu Suivi d\'Entretien'
    : config.kind === 'db' ? 'Aperçu Diagnostic batterie'
    : 'Aperçu CT';
  const openLabel =
    config.kind === 'be' ? 'Ouvrir le Bilan ↗'
    : config.kind === 'se' ? 'Ouvrir le Suivi ↗'
    : config.kind === 'db' ? 'Ouvrir le Diagnostic ↗'
    : 'Ouvrir le CT ↗';

  const docHtml = `
    <div style="position:relative; flex:1 1 auto; min-height:220px; background:#0f1117;">
      <button type="button"
              class="vpauto-doc-close"
              style="position:absolute; right:10px; bottom:10px; z-index:3; border:none; border-radius:999px;
                     background:rgba(15,17,23,0.85); color:#f8fafc; cursor:pointer; font-size:11px; font-weight:700;
                     padding:7px 11px; letter-spacing:0.01em; box-shadow:0 6px 18px rgba(0,0,0,0.28); backdrop-filter:blur(8px);"
              aria-label="Fermer l'aperçu">
        Fermer
      </button>
      <iframe
        src="${esc(url)}#toolbar=0&navpanes=0&scrollbar=0"
        style="width:100%; height:100%; border:none;"
        loading="lazy"
      ></iframe>
      <a href="${esc(url)}" target="_blank" rel="noopener"
         style="position:absolute; left:10px; bottom:10px; background:linear-gradient(135deg,#f47920,#e06510); color:white;
                padding:7px 12px; border-radius:999px; font-size:11px; font-weight:700; text-decoration:none;
                box-shadow:0 4px 14px rgba(244,121,32,0.35); z-index:2;">
        ${openLabel}
      </a>
      <div style="position:absolute; left:10px; top:10px; z-index:2; background:rgba(15,17,23,0.78); color:#cbd5e1;
                  padding:6px 10px; border-radius:999px; font-size:10px; font-weight:600; letter-spacing:0.02em;
                  backdrop-filter:blur(6px);">
        ${badgeLabel}
      </div>
    </div>
  `;

  popup.innerHTML = headerHtml + docHtml;
  card.appendChild(popup);
  button.setAttribute('aria-expanded', 'true');
  button.textContent =
    config.kind === 'be' ? 'Masquer bilan'
    : config.kind === 'se' ? 'Masquer entretien'
    : config.kind === 'db' ? 'Masquer batterie'
    : 'Masquer le CT';

  popup.querySelector<HTMLButtonElement>('.vpauto-doc-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeDocPopup(button);
  });
}

function getBadgeColors(type: string): string {
  switch (type) {
    case 'new': return 'background: #22c55e; color: white;';
    case 'seen': return 'background: #3b82f6; color: white;';
    case 'price_drop': return 'background: #16a34a; color: white;';
    case 'price_up': return 'background: #ef4444; color: white;';
    case 'reappeared': return 'background: #f59e0b; color: #333;';
    default: return 'background: #6b7280; color: white;';
  }
}

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

if (!document.getElementById('vpauto-ct-popup-style')) {
  const style = document.createElement('style');
  style.id = 'vpauto-ct-popup-style';
  style.textContent = `
    @keyframes vpauto-ct-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

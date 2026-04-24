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
// v5: added text sections — Observations, Equipements/Options,
//     Caractéristiques techniques (extracted from the detail-page HTML,
//     no PDF involved). Old v4 entries don't carry those fields.
const PROBE_STORAGE_KEY = 'vpautoDocProbe.v5';
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
      'vpautoDocProbe.v4',
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
  card.dataset.vpautoHasStatus = 'true';

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

type DocKind = 'ct' | 'be' | 'se' | 'db' | 'obs' | 'eq' | 'tech';
type DocButtonState = 'checking' | 'confirmed' | 'missing' | 'fallback';
type DocButtonVariant = 'badge' | 'menu';

type DocButtonConfig = {
  kind: DocKind;
  label: string;
  tooltip: string;
  /** URL of the PDF to render in an iframe. `null` for text-only kinds. */
  confirmedUrl: string | null;
  /**
   * Raw text content (multi-line) extracted from the detail page, used by
   * the three text-only kinds ('obs', 'eq', 'tech'). `null` for PDF kinds.
   */
  confirmedText: string | null;
  state: DocButtonState;
  /** Detail page URL — used as a fallback "open in new tab" target. */
  detailPageUrl: string;
};

/** True for kinds whose preview is text extracted from the detail page. */
function isTextKind(kind: DocKind): boolean {
  return kind === 'obs' || kind === 'eq' || kind === 'tech';
}

function shortDocLabel(kind: DocKind): string {
  switch (kind) {
    case 'be': return 'BE';
    case 'se': return 'SE';
    case 'db': return 'BAT';
    case 'obs': return 'OBS';
    case 'eq': return 'EQ';
    case 'tech': return 'TECH';
    case 'ct':
    default: return 'CT';
  }
}

function docIcon(kind: DocKind): string {
  switch (kind) {
    case 'ct': return 'CT';
    case 'be': return 'BE';
    case 'se': return 'SE';
    case 'db': return 'BAT';
    case 'obs': return 'OBS';
    case 'eq': return 'EQ';
    case 'tech': return 'CAR';
    default: return shortDocLabel(kind);
  }
}

function badgeLabelForState(state: DocButtonState): string {
  switch (state) {
    case 'confirmed': return 'CT disponible';
    case 'missing': return 'CT indisponible';
    case 'fallback': return 'Vérifier sur la fiche';
    case 'checking':
    default: return 'Analyse CT…';
  }
}

function menuMetaForState(kind: DocKind, state: DocButtonState): string {
  if (state === 'checking') return 'Analyse…';
  if (state === 'missing') return 'Indisponible';
  if (state === 'fallback') return 'Ouvrir la fiche';

  switch (kind) {
    case 'obs':
    case 'eq':
      return 'Texte';
    case 'tech':
      return 'Données';
    case 'ct':
    case 'be':
    case 'se':
    case 'db':
    default:
      return 'PDF';
  }
}

function buttonTitleForState(config: DocButtonConfig): string {
  switch (config.state) {
    case 'confirmed':
      return config.tooltip;
    case 'missing':
      return missingTooltip(config.kind);
    case 'fallback':
      return 'Vérification indisponible — ouvrir la fiche véhicule';
    case 'checking':
    default:
      return 'Vérification du document sur la fiche véhicule';
  }
}

function renderDocButtonState(button: HTMLButtonElement, config: DocButtonConfig): void {
  const variant = (button.dataset.vpautoVariant as DocButtonVariant | undefined) || 'menu';
  const isDisabled = config.state === 'checking' || config.state === 'missing';

  button.dataset.vpautoState = config.state;
  button.dataset.vpautoCtState = config.state;
  button.disabled = isDisabled;
  button.title = buttonTitleForState(config);
  button.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');

  if (variant === 'badge') {
    const label = button.querySelector<HTMLElement>('.vpauto-ct-badge__label');
    if (label) label.textContent = badgeLabelForState(config.state);
  } else {
    const label = button.querySelector<HTMLElement>('.vpauto-doc-menu-item__label');
    const meta = button.querySelector<HTMLElement>('.vpauto-doc-menu-item__meta');
    const arrow = button.querySelector<HTMLElement>('.vpauto-doc-menu-item__arrow');

    if (label) label.textContent = config.label;
    if (meta) meta.textContent = menuMetaForState(config.kind, config.state);
    if (arrow) {
      arrow.textContent = config.state === 'fallback' ? '↗' : '›';
      arrow.setAttribute('aria-hidden', config.state === 'missing' ? 'true' : 'false');
    }
  }

  syncDocDockSummary(button);
}

/** Close any open doc popup on other cards (or on this one if not excluded). */
function closeAllDocPopups(exceptCard?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.vpauto-doc-popup').forEach((popup) => {
    const owner = popup.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    popup.remove();
  });

  document.querySelectorAll<HTMLElement>('.vpauto-doc-toggle[aria-expanded="true"]').forEach((button) => {
    const owner = button.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    button.setAttribute('aria-expanded', 'false');
  });
}

function closeAllDocMenus(exceptCard?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.vpauto-doc-dock[data-vpauto-open="true"]').forEach((dock) => {
    const owner = dock.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;

    dock.dataset.vpautoOpen = 'false';
    dock.querySelector<HTMLButtonElement>('.vpauto-doc-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function setDocMenuOpen(card: HTMLElement, open: boolean): void {
  const dock = card.querySelector<HTMLElement>('.vpauto-doc-dock');
  if (!dock) return;

  if (open) {
    closeAllDocMenus(card);
  }

  dock.dataset.vpautoOpen = open ? 'true' : 'false';
  dock.querySelector<HTMLButtonElement>('.vpauto-doc-trigger')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function buildActionTriggerMessage(counts: {
  total: number;
  confirmed: number;
  checking: number;
  missing: number;
  fallback: number;
}): string {
  const { total, confirmed, checking, missing, fallback } = counts;

  if (fallback === total && total > 0) {
    return 'Vérification indisponible. Ouvrez la fiche pour accéder aux documents.';
  }

  if (confirmed > 0) {
    return `${confirmed} action${confirmed > 1 ? 's' : ''} disponible${confirmed > 1 ? 's' : ''}`;
  }

  if (checking > 0) {
    return 'Analyse de la fiche en cours…';
  }

  if (missing === total && total > 0) {
    return 'Aucune action disponible pour le moment.';
  }

  return 'Actions rapides';
}

function syncDocDockSummary(target: HTMLElement): void {
  const dock = target.closest<HTMLElement>('.vpauto-doc-dock');
  if (!dock) return;

  const trigger = dock.querySelector<HTMLButtonElement>('.vpauto-doc-trigger');
  const buttons = [...dock.querySelectorAll<HTMLButtonElement>('.vpauto-doc-toggle')];

  if (!trigger || buttons.length === 0) return;

  const counts = buttons.reduce(
    (acc, button) => {
      const state = button.dataset.vpautoState as DocButtonState | undefined;
      acc.total += 1;
      if (state === 'confirmed') acc.confirmed += 1;
      else if (state === 'checking') acc.checking += 1;
      else if (state === 'fallback') acc.fallback += 1;
      else acc.missing += 1;
      return acc;
    },
    { total: 0, confirmed: 0, checking: 0, missing: 0, fallback: 0 },
  );

  let summaryState: 'ready' | 'checking' | 'missing' | 'fallback' = 'missing';
  if (counts.fallback === counts.total && counts.total > 0) {
    summaryState = 'fallback';
  } else if (counts.confirmed > 0) {
    summaryState = 'ready';
  } else if (counts.checking > 0) {
    summaryState = 'checking';
  }

  trigger.dataset.vpautoSummaryState = summaryState;
  trigger.title = buildActionTriggerMessage(counts);
  trigger.dataset.vpautoAvailableCount = String(counts.confirmed);
}

/**
 * Add the list-card quick actions UI:
 * - one always-visible CT badge
 * - one compact "Actions" trigger
 * - a floating menu for text sections and extra docs
 *
 * Important: the CT button is NEVER rendered as clickable on top of an
 * unverified URL — that previously caused black 404 iframes for vehicles
 * without CT. The button starts in a non-clickable "checking" state and
 * transitions to either "confirmed" (clickable) or "missing" (greyed,
 * "CT indisponible") once the eager probe of the detail page resolves.
 *
 * Optional docs like Bilan Expert and Diagnostic batterie are only added
 * when the probe positively confirms them on the detail page.
 */
function addDocumentButtons(
  card: HTMLElement,
  v: Partial<VehicleSnapshot>,
  hashId: string,
  detailPageUrl: string,
): void {
  const dock = document.createElement('div');
  dock.className = 'vpauto-doc-dock';
  dock.dataset.vpautoOpen = 'false';
  dock.dataset.vpautoHasStatus = card.dataset.vpautoHasStatus === 'true' ? 'true' : 'false';

  const ctConfig: DocButtonConfig = {
    kind: 'ct',
    label: 'Voir le CT',
    tooltip: 'Afficher le contrôle technique',
    confirmedUrl: null,
    confirmedText: null,
    state: 'checking',
    detailPageUrl,
  };
  const ctButton = createDocButton(card, dock, v, ctConfig, 'badge');
  applyCheckingState(ctButton, ctConfig);

  const triggerWrap = document.createElement('div');
  triggerWrap.className = 'vpauto-doc-trigger-wrap';
  dock.appendChild(triggerWrap);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'vpauto-doc-trigger';
  trigger.dataset.vpautoDetailUrl = detailPageUrl;
  trigger.dataset.vpautoSummaryState = 'checking';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `
    <span class="vpauto-doc-trigger__icon" aria-hidden="true">•••</span>
    <span class="vpauto-doc-trigger__label">Actions</span>
  `;
  triggerWrap.appendChild(trigger);

  const panel = document.createElement('div');
  panel.className = 'vpauto-doc-panel';
  triggerWrap.appendChild(panel);

  const menuList = document.createElement('div');
  menuList.className = 'vpauto-doc-panel__list';
  panel.appendChild(menuList);

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const open = dock.dataset.vpautoOpen === 'true';
    if (!open) {
      closeAllDocPopups(card);
    }
    setDocMenuOpen(card, !open);
  });

  panel.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  const obsConfig: DocButtonConfig = {
    kind: 'obs',
    label: 'Observations',
    tooltip: 'Afficher les observations de la fiche véhicule',
    confirmedUrl: null,
    confirmedText: null,
    state: 'checking',
    detailPageUrl,
  };
  const obsButton = createDocButton(card, menuList, v, obsConfig, 'menu');
  applyCheckingState(obsButton, obsConfig);

  const eqConfig: DocButtonConfig = {
    kind: 'eq',
    label: 'Équipements',
    tooltip: 'Afficher les équipements et options',
    confirmedUrl: null,
    confirmedText: null,
    state: 'checking',
    detailPageUrl,
  };
  const eqButton = createDocButton(card, menuList, v, eqConfig, 'menu');
  applyCheckingState(eqButton, eqConfig);

  menuList.appendChild(document.createElement('div')).className = 'vpauto-doc-menu-separator';

  const techConfig: DocButtonConfig = {
    kind: 'tech',
    label: 'Caractéristiques',
    tooltip: 'Afficher les caractéristiques techniques',
    confirmedUrl: null,
    confirmedText: null,
    state: 'checking',
    detailPageUrl,
  };
  const techButton = createDocButton(card, menuList, v, techConfig, 'menu');
  applyCheckingState(techButton, techConfig);

  const seConfig: DocButtonConfig = {
    kind: 'se',
    label: 'Voir entretien',
    tooltip: 'Afficher le Suivi d\'Entretien',
    confirmedUrl: null,
    confirmedText: null,
    state: 'checking',
    detailPageUrl,
  };
  const seButton = createDocButton(card, menuList, v, seConfig, 'menu');
  applyCheckingState(seButton, seConfig);

  const optionalSeparator = document.createElement('div');
  optionalSeparator.className = 'vpauto-doc-menu-separator';
  optionalSeparator.hidden = true;
  panel.appendChild(optionalSeparator);

  const optionalList = document.createElement('div');
  optionalList.className = 'vpauto-doc-panel__list';
  panel.appendChild(optionalList);

  const appendOptionalButton = (config: DocButtonConfig) => {
    if (optionalSeparator.hidden) optionalSeparator.hidden = false;
    const button = createDocButton(card, optionalList, v, config, 'menu');
    applyConfirmedState(button, config);
  };

  card.appendChild(dock);

  void getOrProbe(hashId, detailPageUrl).then((result) => {
    if (!result) {
      applyFallbackState(ctButton, ctConfig);
      applyFallbackState(obsButton, obsConfig);
      applyFallbackState(eqButton, eqConfig);
      applyFallbackState(techButton, techConfig);
      applyFallbackState(seButton, seConfig);
      return;
    }

    if (result.hasCt && result.ctUrl) {
      ctConfig.confirmedUrl = result.ctUrl;
      applyConfirmedState(ctButton, ctConfig);
    } else {
      applyMissingState(ctButton, ctConfig);
    }

    if (result.hasObservationsText && result.observationsText) {
      obsConfig.confirmedText = result.observationsText;
      applyConfirmedState(obsButton, obsConfig);
    } else {
      applyMissingState(obsButton, obsConfig);
    }

    if (result.hasEquipmentText && result.equipmentText) {
      eqConfig.confirmedText = result.equipmentText;
      applyConfirmedState(eqButton, eqConfig);
    } else {
      applyMissingState(eqButton, eqConfig);
    }

    if (result.hasTechnicalSpecsText && result.technicalSpecsText) {
      techConfig.confirmedText = result.technicalSpecsText;
      applyConfirmedState(techButton, techConfig);
    } else {
      applyMissingState(techButton, techConfig);
    }

    if (result.hasSuiviEntretien && result.suiviEntretienUrl) {
      seConfig.confirmedUrl = result.suiviEntretienUrl;
      applyConfirmedState(seButton, seConfig);
    } else {
      applyMissingState(seButton, seConfig);
    }

    if (result.hasBilanExpert && result.bilanExpertUrl) {
      const beConfig: DocButtonConfig = {
        kind: 'be',
        label: 'Voir bilan',
        tooltip: 'Afficher le Bilan Expert',
        confirmedUrl: result.bilanExpertUrl,
        confirmedText: null,
        state: 'confirmed',
        detailPageUrl,
      };
      appendOptionalButton(beConfig);
    }

    if (result.hasDiagnosticBatterie && result.diagnosticBatterieUrl) {
      const dbConfig: DocButtonConfig = {
        kind: 'db',
        label: 'Voir batterie',
        tooltip: 'Afficher le Diagnostic batterie',
        confirmedUrl: result.diagnosticBatterieUrl,
        confirmedText: null,
        state: 'confirmed',
        detailPageUrl,
      };
      appendOptionalButton(dbConfig);
    }
  });
}

/** Build one doc button shell and wire its click handler. State is applied separately. */
function createDocButton(
  card: HTMLElement,
  container: HTMLElement,
  v: Partial<VehicleSnapshot>,
  config: DocButtonConfig,
  variant: DocButtonVariant,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = variant === 'badge'
    ? 'vpauto-doc-toggle vpauto-ct-badge'
    : 'vpauto-doc-toggle vpauto-doc-menu-item';
  button.setAttribute('aria-expanded', 'false');
  button.dataset.vpautoDocKind = config.kind;
  button.dataset.vpautoVariant = variant;
  button.dataset.vpautoShort = shortDocLabel(config.kind);
  button.dataset.vpautoState = config.state;
  if (variant === 'badge') {
    button.innerHTML = `
      <span class="vpauto-ct-badge__dot" aria-hidden="true"></span>
      <span class="vpauto-ct-badge__label"></span>
    `;
  } else {
    button.innerHTML = `
      <span class="vpauto-doc-menu-item__icon" aria-hidden="true">${docIcon(config.kind)}</span>
      <span class="vpauto-doc-menu-item__body">
        <span class="vpauto-doc-menu-item__label"></span>
        <span class="vpauto-doc-menu-item__meta"></span>
      </span>
      <span class="vpauto-doc-menu-item__arrow" aria-hidden="true">›</span>
    `;
  }
  container.appendChild(button);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (config.state === 'fallback') {
      setDocMenuOpen(card, false);
      window.open(config.detailPageUrl, '_blank', 'noopener');
      return;
    }

    if (config.state !== 'confirmed') return;

    const existing = card.querySelector<HTMLElement>(`.vpauto-doc-popup[data-vpauto-doc-kind="${config.kind}"]`);
    if (existing) {
      removeDocPopup(button);
      return;
    }

    setDocMenuOpen(card, false);
    closeAllDocPopups(card);

    if (isTextKind(config.kind)) {
      if (!config.confirmedText) return;
      openTextPopup(card, button, config, config.confirmedText, v);
    } else {
      if (!config.confirmedUrl) return;
      openDocPopup(card, button, config, config.confirmedUrl, v);
    }
  });

  return button;
}

/** Apply "checking" visuals — greyed out + non-clickable, "Vérification…" label. */
function applyCheckingState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'checking';
  renderDocButtonState(button, config);
}

/** Apply "confirmed" visuals — coloured background, clickable. */
function applyConfirmedState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'confirmed';
  renderDocButtonState(button, config);
}

/** Apply "missing" visuals — fully greyed, "indisponible", non-clickable. */
function applyMissingState(button: HTMLButtonElement, config: DocButtonConfig): void {
  config.state = 'missing';
  renderDocButtonState(button, config);
}

function missingTooltip(kind: DocKind): string {
  switch (kind) {
    case 'be':   return 'Aucun bilan expert disponible sur la fiche véhicule';
    case 'se':   return 'Aucun suivi d\'entretien disponible sur la fiche véhicule';
    case 'db':   return 'Aucun diagnostic batterie disponible sur la fiche véhicule';
    case 'obs':  return 'Aucune observation trouvée sur la fiche véhicule';
    case 'eq':   return 'Aucun équipement/option listé sur la fiche véhicule';
    case 'tech': return 'Aucune caractéristique technique listée sur la fiche véhicule';
    case 'ct':
    default:     return 'Absence de contrôle technique confirmée sur la fiche véhicule';
  }
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
  renderDocButtonState(button, config);
}

function removeDocPopup(button: HTMLButtonElement): void {
  const card = button.closest('li');
  if (!card) return;
  const popup = card.querySelector<HTMLElement>(`.vpauto-doc-popup[data-vpauto-doc-kind="${button.dataset.vpautoDocKind}"]`);
  if (popup) popup.remove();
  button.setAttribute('aria-expanded', 'false');
}

function popupTitle(kind: DocKind): string {
  switch (kind) {
    case 'ct': return 'Contrôle technique';
    case 'be': return 'Bilan expert';
    case 'se': return 'Suivi d’entretien';
    case 'db': return 'Diagnostic batterie';
    case 'obs': return 'Observations';
    case 'eq': return 'Équipements';
    case 'tech': return 'Caractéristiques';
    default: return 'Document';
  }
}

function popupPrimaryLabel(kind: DocKind): string {
  switch (kind) {
    case 'ct': return 'Ouvrir le CT';
    case 'be': return 'Ouvrir le bilan';
    case 'se': return 'Ouvrir l’entretien';
    case 'db': return 'Ouvrir le diagnostic';
    case 'obs':
    case 'eq':
    case 'tech':
    default:
      return 'Ouvrir la fiche';
  }
}

function popupSubtitle(kind: DocKind): string {
  switch (kind) {
    case 'ct': return 'Document PDF confirmé sur la fiche VPauto';
    case 'be': return 'Rapport d’expertise confirmé sur la fiche';
    case 'se': return 'Document d’entretien confirmé sur la fiche';
    case 'db': return 'Rapport batterie confirmé sur la fiche';
    case 'obs': return 'Extrait texte récupéré sur la fiche VPauto';
    case 'eq': return 'Liste d’équipements extraite de la fiche';
    case 'tech': return 'Caractéristiques techniques extraites de la fiche';
    default: return 'Accès rapide depuis la liste';
  }
}

function vehicleMetaLine(v: Partial<VehicleSnapshot>): string {
  const parts: string[] = [];
  const name = [v.brand, v.model].filter(Boolean).join(' ');
  if (name) parts.push(name);
  if (v.year) parts.push(String(v.year));
  if (v.mileage) parts.push(`${v.mileage.toLocaleString('fr-FR')} km`);
  if (v.city) parts.push(v.city);
  return parts.join(' • ');
}

function buildPopupHeader(v: Partial<VehicleSnapshot>, kind: DocKind): string {
  return `
    <div class="vpauto-doc-popup__head">
      <div class="vpauto-doc-popup__icon" aria-hidden="true">${docIcon(kind)}</div>
      <div class="vpauto-doc-popup__titleblock">
        <div class="vpauto-doc-popup__title">${esc(popupTitle(kind))}</div>
        <div class="vpauto-doc-popup__meta">${esc(vehicleMetaLine(v) || popupSubtitle(kind))}</div>
      </div>
      <button type="button" class="vpauto-doc-close vpauto-doc-popup__close" aria-label="Fermer l’aperçu">×</button>
    </div>
  `;
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
  const resultTone = config.kind === 'ct' ? 'vpauto-doc-result--ok' : 'vpauto-doc-result--info';
  popup.innerHTML = `
    <div class="vpauto-doc-popup__surface">
      ${buildPopupHeader(v, config.kind)}
      <div class="vpauto-doc-popup__body">
        <div class="vpauto-doc-result ${resultTone}">
          <div class="vpauto-doc-result__icon" aria-hidden="true">${docIcon(config.kind)}</div>
          <div class="vpauto-doc-result__copy">
            <strong>${esc(popupTitle(config.kind))}</strong>
            <span>${esc(popupSubtitle(config.kind))}</span>
          </div>
        </div>
        <div class="vpauto-doc-preview-frame-shell">
          <iframe
            src="${esc(url)}#toolbar=0&navpanes=0&scrollbar=0"
            class="vpauto-doc-preview-frame"
            loading="lazy"
          ></iframe>
        </div>
      </div>
      <div class="vpauto-doc-popup__foot">
        <a href="${esc(url)}" target="_blank" rel="noopener" class="vpauto-doc-panel-btn vpauto-doc-panel-btn--primary">
          ${esc(popupPrimaryLabel(config.kind))} ↗
        </a>
        <button type="button" class="vpauto-doc-panel-btn vpauto-doc-panel-btn--secondary vpauto-doc-close">
          Fermer
        </button>
      </div>
    </div>
  `;
  card.appendChild(popup);
  button.setAttribute('aria-expanded', 'true');

  popup.querySelector<HTMLButtonElement>('.vpauto-doc-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeDocPopup(button);
  });
}

/**
 * Render a popup showing text content extracted from the detail page, used
 * by the Observations / Équipements / Caractéristiques buttons. Unlike
 * `openDocPopup` (which embeds a PDF via iframe), this renders a scrollable
 * list. Each line from `text` (separated by `\n`) becomes one item.
 */
function openTextPopup(
  card: HTMLElement,
  button: HTMLButtonElement,
  config: DocButtonConfig,
  text: string,
  v: Partial<VehicleSnapshot>,
): void {
  const popup = document.createElement('div');
  popup.className = 'vpauto-doc-popup vpauto-doc-popup--text';
  popup.dataset.vpautoDocKind = config.kind;
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const bodyRows = lines.map((line) => renderTextRow(line, config.kind)).join('');
  popup.innerHTML = `
    <div class="vpauto-doc-popup__surface">
      ${buildPopupHeader(v, config.kind)}
      <div class="vpauto-doc-popup__body">
        <div class="vpauto-doc-result vpauto-doc-result--info">
          <div class="vpauto-doc-result__icon" aria-hidden="true">${docIcon(config.kind)}</div>
          <div class="vpauto-doc-result__copy">
            <strong>${esc(popupTitle(config.kind))}</strong>
            <span>${esc(popupSubtitle(config.kind))}</span>
          </div>
        </div>
        <div class="vpauto-doc-text-list">
          ${bodyRows || '<div class="vpauto-doc-empty">Aucun contenu.</div>'}
        </div>
      </div>
      <div class="vpauto-doc-popup__foot">
        <a href="${esc(config.detailPageUrl)}" target="_blank" rel="noopener" class="vpauto-doc-panel-btn vpauto-doc-panel-btn--primary">
          Ouvrir la fiche ↗
        </a>
        <button type="button" class="vpauto-doc-panel-btn vpauto-doc-panel-btn--secondary vpauto-doc-close">
          Fermer
        </button>
      </div>
    </div>
  `;
  card.appendChild(popup);
  button.setAttribute('aria-expanded', 'true');

  popup.querySelector<HTMLButtonElement>('.vpauto-doc-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeDocPopup(button);
  });
}

/**
 * Render one text row. "tech" rows look like `Label : Value` — render a
 * two-column key/value layout. Observations and Equipements are free text,
 * render as a bullet list.
 */
function renderTextRow(line: string, kind: DocKind): string {
  if (kind === 'tech') {
    const m = line.match(/^(.*?)\s*:\s*(.+)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim();
      return `
        <div class="vpauto-doc-kv-row">
          <span class="vpauto-doc-kv-row__key">${esc(key)}</span>
          <span class="vpauto-doc-kv-row__value">${esc(val)}</span>
        </div>
      `;
    }
  }

  const clean = line.replace(/^[-–—•·]\s*/, '').trim();

  return `
    <div class="vpauto-doc-bullet-row">
      <span class="vpauto-doc-bullet-row__dot" aria-hidden="true">•</span>
      <span class="vpauto-doc-bullet-row__text">${esc(clean)}</span>
    </div>
  `;
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
    .vpauto-doc-dock {
      position: absolute;
      right: 10px;
      bottom: 10px;
      z-index: 18;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100% - 20px);
      font-family: 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .vpauto-doc-dock[data-vpauto-has-status="true"] {
      bottom: 36px;
    }

    .vpauto-doc-trigger-wrap {
      position: relative;
      flex: 0 0 auto;
    }

    .vpauto-ct-badge,
    .vpauto-doc-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      border: 2px solid #e2e5ea;
      border-radius: 999px;
      padding: 6px 11px;
      font: 800 11px/1 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: 0 2px 0 #d8dde4;
      transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease, background 140ms ease, border-color 140ms ease;
    }

    .vpauto-ct-badge:hover:not(:disabled),
    .vpauto-doc-trigger:hover {
      filter: brightness(0.98);
      transform: translateY(-1px);
    }

    .vpauto-ct-badge:active:not(:disabled),
    .vpauto-doc-trigger:active {
      transform: translateY(1px);
      box-shadow: 0 1px 0 #d8dde4;
    }

    .vpauto-ct-badge {
      max-width: min(180px, 100%);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: #fff0d6;
      color: #cc6f00;
      border-color: #cc6f00;
      box-shadow: 0 2px 0 #cc6f00;
    }

    .vpauto-ct-badge__dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      flex: 0 0 auto;
    }

    .vpauto-ct-badge__label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .vpauto-ct-badge[data-vpauto-state="confirmed"] {
      background: #e6f9eb;
      color: #1e8a37;
      border-color: #1e8a37;
      box-shadow: 0 2px 0 #1e8a37;
    }

    .vpauto-ct-badge[data-vpauto-state="missing"] {
      background: #fde8e5;
      color: #b5200a;
      border-color: #b5200a;
      box-shadow: 0 2px 0 #b5200a;
    }

    .vpauto-ct-badge[data-vpauto-state="checking"] {
      background: #fff0d6;
      color: #cc6f00;
      border-color: #cc6f00;
      box-shadow: 0 2px 0 #cc6f00;
      cursor: progress;
    }

    .vpauto-ct-badge[data-vpauto-state="fallback"] {
      background: #fff4e8;
      color: #b66911;
      border-color: #e5b165;
      box-shadow: 0 2px 0 #e5b165;
    }

    .vpauto-doc-trigger {
      background: #ffffff;
      color: #4a4a5a;
      white-space: nowrap;
      position: relative;
      padding-right: 12px;
    }

    .vpauto-doc-trigger__icon {
      font-size: 13px;
      line-height: 1;
      color: #6b7280;
    }

    .vpauto-doc-trigger[data-vpauto-summary-state="ready"] {
      border-color: #cfe7d6;
      box-shadow: 0 2px 0 #cfe7d6;
    }

    .vpauto-doc-trigger[data-vpauto-summary-state="checking"] {
      border-color: #f0d7aa;
      box-shadow: 0 2px 0 #f0d7aa;
    }

    .vpauto-doc-trigger[data-vpauto-summary-state="missing"] {
      color: #6b7280;
      background: #f8fafc;
    }

    .vpauto-doc-trigger[data-vpauto-summary-state="fallback"] {
      border-color: #f0d7aa;
      box-shadow: 0 2px 0 #f0d7aa;
      color: #b66911;
    }

    .vpauto-doc-panel {
      display: none;
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      min-width: 220px;
      max-width: min(280px, calc(100vw - 40px));
      padding: 6px;
      border: 2px solid #e2e5ea;
      border-radius: 14px;
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.16), 0 4px 0 #e2e5ea;
      color: #1a1a2e;
      animation: vpauto-ct-fade-in 140ms ease-out;
    }

    .vpauto-doc-dock[data-vpauto-open="true"] .vpauto-doc-panel {
      display: block;
    }

    .vpauto-doc-panel__list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .vpauto-doc-panel__list:empty {
      display: none;
    }

    .vpauto-doc-menu-separator {
      height: 1px;
      margin: 6px 2px;
      background: #e2e5ea;
    }

    .vpauto-doc-menu-separator[hidden] {
      display: none;
    }

    .vpauto-doc-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 9px 10px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: #1a1a2e;
      text-align: left;
      box-shadow: none;
      min-height: 0;
    }

    .vpauto-doc-menu-item:hover:not(:disabled) {
      background: #f3f4f6;
      transform: none;
    }

    .vpauto-doc-menu-item__icon {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: #f3f4f6;
      color: #4a4a5a;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.06em;
      flex: 0 0 auto;
    }

    .vpauto-doc-menu-item__body {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1 1 auto;
    }

    .vpauto-doc-menu-item__label {
      font-size: 13px;
      font-weight: 800;
      color: #1a1a2e;
    }

    .vpauto-doc-menu-item__meta {
      font-size: 11px;
      font-weight: 700;
      color: #6b7280;
    }

    .vpauto-doc-menu-item__arrow {
      color: #9aa1ab;
      font-size: 14px;
      font-weight: 900;
      flex: 0 0 auto;
    }

    .vpauto-doc-menu-item[data-vpauto-state="checking"] {
      background: #fff8ea;
      cursor: progress;
    }

    .vpauto-doc-menu-item[data-vpauto-state="checking"] .vpauto-doc-menu-item__icon {
      background: #fff0d6;
      color: #cc6f00;
    }

    .vpauto-doc-menu-item[data-vpauto-state="confirmed"] .vpauto-doc-menu-item__icon {
      background: #eaf5ff;
      color: #1f6fa9;
    }

    .vpauto-doc-menu-item[data-vpauto-state="confirmed"][data-vpauto-doc-kind="se"] .vpauto-doc-menu-item__icon {
      background: #e6f9eb;
      color: #1e8a37;
    }

    .vpauto-doc-menu-item[data-vpauto-state="confirmed"][data-vpauto-doc-kind="obs"] .vpauto-doc-menu-item__icon {
      background: #fff0f5;
      color: #c13584;
    }

    .vpauto-doc-menu-item[data-vpauto-state="confirmed"][data-vpauto-doc-kind="eq"] .vpauto-doc-menu-item__icon {
      background: #f0f8ff;
      color: #2665a8;
    }

    .vpauto-doc-menu-item[data-vpauto-state="confirmed"][data-vpauto-doc-kind="tech"] .vpauto-doc-menu-item__icon {
      background: #f5f0ff;
      color: #6840d6;
    }

    .vpauto-doc-menu-item[data-vpauto-state="missing"] {
      opacity: 0.58;
      filter: grayscale(0.2);
      cursor: not-allowed;
    }

    .vpauto-doc-menu-item[data-vpauto-state="missing"] .vpauto-doc-menu-item__icon {
      background: #f3f4f6;
      color: #9aa1ab;
    }

    .vpauto-doc-menu-item[data-vpauto-state="fallback"] {
      background: #fff8ea;
      color: #b66911;
    }

    .vpauto-doc-menu-item[data-vpauto-state="fallback"] .vpauto-doc-menu-item__icon {
      background: #fff0d6;
      color: #b66911;
    }

    .vpauto-doc-toggle[aria-expanded="true"] {
      outline: 2px solid rgba(31, 164, 201, 0.24);
      outline-offset: 0;
    }

    .vpauto-doc-popup {
      position: absolute;
      inset: 0;
      z-index: 30;
      padding: 0;
      background: rgba(15, 23, 42, 0.12);
      backdrop-filter: blur(2px);
      animation: vpauto-ct-fade-in 140ms ease-out;
    }

    .vpauto-doc-popup__surface {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 14px 40px rgba(15, 23, 42, 0.18);
      color: #1a1a2e;
    }

    .vpauto-doc-popup__head {
      padding: 10px 12px;
      background: #1a1a2e;
      color: #ffffff;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      border-bottom: 2px solid #111827;
    }

    .vpauto-doc-popup__icon {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.12);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.06em;
      flex: 0 0 auto;
    }

    .vpauto-doc-popup__titleblock {
      min-width: 0;
      flex: 1 1 auto;
    }

    .vpauto-doc-popup__title {
      font-size: 13px;
      font-weight: 900;
      line-height: 1.2;
    }

    .vpauto-doc-popup__meta {
      margin-top: 2px;
      color: rgba(255, 255, 255, 0.72);
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .vpauto-doc-popup__close {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 0;
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
      box-shadow: none;
      padding: 0;
      font-size: 16px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .vpauto-doc-popup__close:hover {
      background: rgba(255, 255, 255, 0.22);
      transform: none;
    }

    .vpauto-doc-popup__body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      background: #ffffff;
    }

    .vpauto-doc-popup__foot {
      padding: 10px 12px;
      border-top: 2px solid #e2e5ea;
      display: flex;
      gap: 8px;
      background: #ffffff;
    }

    .vpauto-doc-panel-btn {
      flex: 1 1 0;
      min-height: 36px;
      border-radius: 10px;
      border: 2px solid #e2e5ea;
      font: 800 12px/1 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      text-decoration: none;
      transition: transform 140ms ease, filter 140ms ease;
      box-shadow: 0 3px 0 #e2e5ea;
    }

    .vpauto-doc-panel-btn:hover {
      filter: brightness(0.97);
      transform: translateY(-1px);
    }

    .vpauto-doc-panel-btn--primary {
      background: #1fa4c9;
      color: #ffffff;
      border-color: #1787a8;
      box-shadow: 0 3px 0 #1787a8;
    }

    .vpauto-doc-panel-btn--secondary {
      background: #ffffff;
      color: #1a1a2e;
    }

    .vpauto-doc-result {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 2px solid #e2e5ea;
      margin-bottom: 10px;
    }

    .vpauto-doc-result--ok {
      background: #e6f9eb;
      border-color: #1e8a37;
      color: #1e8a37;
    }

    .vpauto-doc-result--info {
      background: #eef8fc;
      border-color: #1fa4c9;
      color: #177f9d;
    }

    .vpauto-doc-result__icon {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.6);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.06em;
      flex: 0 0 auto;
    }

    .vpauto-doc-result__copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .vpauto-doc-result__copy strong {
      font-size: 13px;
      font-weight: 900;
      line-height: 1.2;
    }

    .vpauto-doc-result__copy span {
      font-size: 11px;
      font-weight: 700;
      opacity: 0.9;
      line-height: 1.35;
    }

    .vpauto-doc-preview-frame-shell {
      min-height: 220px;
      height: calc(100% - 64px);
      border: 2px solid #e2e5ea;
      border-radius: 10px;
      overflow: hidden;
      background: #f3f4f6;
    }

    .vpauto-doc-preview-frame {
      width: 100%;
      height: 100%;
      min-height: 220px;
      border: 0;
      background: #ffffff;
    }

    .vpauto-doc-text-list {
      border: 2px solid #e2e5ea;
      border-radius: 10px;
      background: #ffffff;
      overflow: hidden;
    }

    .vpauto-doc-kv-row,
    .vpauto-doc-bullet-row {
      display: grid;
      gap: 8px;
      padding: 9px 11px;
      border-bottom: 1px solid #edf0f4;
    }

    .vpauto-doc-kv-row:last-child,
    .vpauto-doc-bullet-row:last-child {
      border-bottom: 0;
    }

    .vpauto-doc-kv-row {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
    }

    .vpauto-doc-kv-row__key {
      color: #4a4a5a;
      font-size: 12px;
      font-weight: 700;
    }

    .vpauto-doc-kv-row__value {
      color: #1a1a2e;
      font-size: 12px;
      font-weight: 900;
      text-align: right;
    }

    .vpauto-doc-bullet-row {
      grid-template-columns: 10px minmax(0, 1fr);
      align-items: start;
    }

    .vpauto-doc-bullet-row__dot {
      color: #1fa4c9;
      font-size: 14px;
      line-height: 1;
      transform: translateY(1px);
    }

    .vpauto-doc-bullet-row__text {
      color: #1a1a2e;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.45;
    }

    .vpauto-doc-empty {
      padding: 12px;
      color: #6b7280;
      font-size: 12px;
      font-weight: 700;
    }

    @media (max-width: 960px) {
      .vpauto-doc-panel {
        min-width: 200px;
        max-width: min(250px, calc(100vw - 28px));
      }

      .vpauto-doc-popup__foot {
        flex-direction: column;
      }

      .vpauto-doc-panel-btn {
        width: 100%;
      }
    }

    @keyframes vpauto-ct-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

if (!document.documentElement.dataset.vpautoDocUiBound) {
  document.documentElement.dataset.vpautoDocUiBound = '1';

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.vpauto-doc-dock')) return;
    closeAllDocMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAllDocMenus();
    closeAllDocPopups();
  });
}

import { browser } from 'wxt/browser';
import type { VehicleBadge, VehicleHistory, VehicleSnapshot } from '@vpauto/shared';
import { api } from '../../lib/api';
import './style.css';

interface CurrentVehicleState {
  snapshot: VehicleSnapshot;
  vehicleId?: number;
  snapshotId?: number;
  isNew?: boolean;
}

interface StoredPanelState {
  currentVehicle?: CurrentVehicleState;
  currentVehicleList?: Partial<VehicleSnapshot>[];
  scrapeDebug?: ScrapeDebugState;
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

void refreshPanel();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!changes.currentVehicle && !changes.currentVehicleList && !changes.scrapeDebug) {
    return;
  }

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    void refreshPanel();
  }, 150);
});

async function refreshPanel(): Promise<void> {
  root.innerHTML = renderLoading();

  const [storage, health] = await Promise.all([
    browser.storage.local.get(['currentVehicle', 'currentVehicleList', 'scrapeDebug']),
    api.healthCheck(),
  ]);

  const state = storage as StoredPanelState;
  const isApiOnline = health !== null;
  const isListContext = state.scrapeDebug?.pageType === 'list';

  if (isListContext || !state.currentVehicle?.snapshot) {
    root.innerHTML = renderEmptyState(state.currentVehicleList, state.scrapeDebug, isApiOnline);
    bindCommonActions();
    return;
  }

  const currentVehicle = state.currentVehicle;
  const snapshot = currentVehicle.snapshot;

  let history: VehicleHistory | null = null;
  let badges: VehicleBadge[] | null = null;

  if (currentVehicle.vehicleId) {
    [history, badges] = await Promise.all([
      api.getHistory(currentVehicle.vehicleId),
      api.getBadges(currentVehicle.vehicleId),
    ]);
  }

  root.innerHTML = renderVehicleState({
    currentVehicle,
    currentVehicleList: state.currentVehicleList,
    scrapeDebug: state.scrapeDebug,
    history,
    badges,
    isApiOnline,
  });

  bindCommonActions(snapshot.sourceUrl);
}

function bindCommonActions(sourceUrl?: string): void {
  const refreshButton = document.querySelector<HTMLButtonElement>('[data-action="refresh"]');
  refreshButton?.addEventListener('click', () => {
    void refreshPanel();
  });

  const openButton = document.querySelector<HTMLButtonElement>('[data-action="open-source"]');
  openButton?.addEventListener('click', () => {
    if (!sourceUrl) {
      return;
    }

    void browser.tabs.create({ url: sourceUrl });
  });
}

function renderVehicleState(input: {
  currentVehicle: CurrentVehicleState;
  currentVehicleList?: Partial<VehicleSnapshot>[];
  scrapeDebug?: ScrapeDebugState;
  history: VehicleHistory | null;
  badges: VehicleBadge[] | null;
  isApiOnline: boolean;
}): string {
  const { currentVehicle, currentVehicleList, scrapeDebug, history, badges, isApiOnline } = input;
  const { snapshot, vehicleId, isNew } = currentVehicle;
  const title = [snapshot.brand, snapshot.model].filter(Boolean).join(' ').trim() || 'Vehicule VPauto';
  const subtitle = [snapshot.year || undefined, snapshot.city || undefined, snapshot.reference || undefined]
    .filter(Boolean)
    .join(' - ');

  const metricCards = [
    metricCard('Mise a prix', formatPrice(snapshot.startingPrice)),
    metricCard('Kilometrage', formatDistance(snapshot.mileage)),
    metricCard('Centre', escapeHtml(snapshot.center || snapshot.city || 'N/D')),
    metricCard('Passages', history ? String(history.totalPassages) : vehicleId ? '1+' : 'N/D'),
  ].join('');

  const notices: string[] = [];
  if (!isApiOnline) {
    notices.push(notice('Le backend est hors ligne. Les donnees viennent seulement du stockage local.', 'danger'));
  } else if (!vehicleId) {
    notices.push(notice('La page a ete detectee, mais aucun identifiant vehicule n\'a encore ete confirme par le backend.', 'warn'));
  }

  if (isNew) {
    notices.push(notice('Ce vehicule vient d\'etre vu pour la premiere fois dans cette session.', 'warn'));
  }

  const badgeMarkup = badges && badges.length > 0
    ? badges.map((badge) => `<span class="chip">${escapeHtml(formatBadge(badge))}</span>`).join('')
    : '<span class="chip">Aucun badge calcule</span>';

  const historyMarkup = history && history.passages.length > 0
    ? history.passages
        .slice(-5)
        .reverse()
        .map((passage) => `
          <div class="timeline__item">
            <div class="timeline__row">
              <span class="timeline__date">${escapeHtml(formatDate(passage.date))}</span>
              <span class="timeline__meta">${escapeHtml(formatStatus(passage.status))}</span>
            </div>
            <div>${escapeHtml(passage.city)}${passage.center ? ` - ${escapeHtml(passage.center)}` : ''}</div>
            <div class="timeline__meta">
              ${escapeHtml(formatPrice(passage.startingPrice))}
              ${passage.mileage ? ` - ${escapeHtml(formatDistance(passage.mileage))}` : ''}
            </div>
          </div>
        `)
        .join('')
    : '<div class="timeline__item"><div class="timeline__meta">Aucun historique detaille disponible.</div></div>';

  const listMarkup = renderListPreview(currentVehicleList);

  return `
    <div class="panel">
      <section class="hero">
        <div class="hero__top">
          <p class="hero__eyebrow">VPauto Assistant</p>
          <h1 class="hero__title">${escapeHtml(title)}</h1>
          <p class="hero__subtitle">${escapeHtml(subtitle || 'Analyse en direct depuis la page en cours')}</p>
        </div>
        <div class="hero__bottom">
          <span class="chip chip--ghost">${escapeHtml(isApiOnline ? 'API connectee' : 'API indisponible')}</span>
          <span class="chip chip--ghost">${escapeHtml(formatStatus(snapshot.status))}</span>
          ${snapshot.lotNumber ? `<span class="chip chip--ghost">Lot ${escapeHtml(String(snapshot.lotNumber))}</span>` : ''}
          ${snapshot.saleDate ? `<span class="chip chip--ghost">${escapeHtml(formatDate(snapshot.saleDate))}</span>` : ''}
        </div>
      </section>

      <section class="grid">
        ${metricCards}
      </section>

      ${notices.join('')}

      <section class="card">
        <h2 class="card__title">Badges</h2>
        <div class="hero__bottom">${badgeMarkup}</div>
      </section>

      <section class="card">
        <h2 class="card__title">Historique recent</h2>
        <div class="timeline">${historyMarkup}</div>
      </section>

      ${listMarkup}
      ${renderDebugCard(isApiOnline, currentVehicleList, scrapeDebug)}

      <section class="card">
        <h2 class="card__title">Actions</h2>
        <div class="actions">
          <button class="button" type="button" data-action="refresh">Rafraichir</button>
          <button class="button button--secondary" type="button" data-action="open-source">Ouvrir la page source</button>
        </div>
      </section>
    </div>
  `;
}

function renderEmptyState(
  list: Partial<VehicleSnapshot>[] | undefined,
  debug: ScrapeDebugState | undefined,
  isApiOnline: boolean,
): string {
  const listMarkup = renderListPreview(list);

  return `
    <div class="panel">
      <section class="empty-state">
        <h2>Aucun vehicule actif</h2>
        <p>Ouvre une fiche vehicule VPauto ou une liste de resultats pour alimenter la side panel.</p>
        <p>${escapeHtml(isApiOnline ? 'Le backend repond.' : 'Le backend ne repond pas encore.')}</p>
      </section>
      ${listMarkup}
      ${renderDebugCard(isApiOnline, list, debug)}
      <section class="card">
        <h2 class="card__title">Actions</h2>
        <div class="actions">
          <button class="button" type="button" data-action="refresh">Rafraichir</button>
        </div>
      </section>
    </div>
  `;
}

function renderDebugCard(
  isApiOnline: boolean,
  list: Partial<VehicleSnapshot>[] | undefined,
  debug: ScrapeDebugState | undefined,
): string {
  const rows: Array<[string, string]> = [
    ['API', isApiOnline ? 'connectee' : 'hors ligne'],
    ['Liste memoire', list?.length ? `${list.length} vehicules` : 'vide'],
    ['Derniere etape', debug?.stage || 'aucune'],
    ['Type de page', debug?.pageType || 'inconnu'],
    ['Compteur detecte', typeof debug?.vehicleCount === 'number' ? String(debug.vehicleCount) : 'n/d'],
    ['Vehicule', [debug?.brand, debug?.model].filter(Boolean).join(' ') || debug?.hashId || 'n/d'],
    ['Backend vehicleId', debug?.backendVehicleId != null ? String(debug.backendVehicleId) : 'n/d'],
    ['Raison', debug?.reason || 'n/d'],
    ['Maj', debug?.timestamp ? formatDateTime(debug.timestamp) : 'n/d'],
  ];

  const urlMarkup = debug?.url
    ? `<div class="timeline__meta">${escapeHtml(debug.url)}</div>`
    : '<div class="timeline__meta">Aucune URL capturee.</div>';

  return `
    <section class="card">
      <h2 class="card__title">Diagnostic</h2>
      <div class="timeline">
        ${rows.map(([label, value]) => `
          <div class="timeline__item">
            <div class="timeline__row">
              <span>${escapeHtml(label)}</span>
              <span class="timeline__meta">${escapeHtml(value)}</span>
            </div>
          </div>
        `).join('')}
        <div class="timeline__item">
          <div class="timeline__row">
            <span>URL</span>
          </div>
          ${urlMarkup}
        </div>
      </div>
    </section>
  `;
}

function renderListPreview(list: Partial<VehicleSnapshot>[] | undefined): string {
  if (!list || list.length === 0) {
    return '';
  }

  const items = list.slice(0, 5).map((vehicle) => `
    <div class="list-preview__item">
      <div>
        <strong>${escapeHtml([vehicle.brand, vehicle.model].filter(Boolean).join(' ') || 'Vehicule')}</strong>
        <div class="timeline__meta">${escapeHtml(vehicle.city || 'Ville inconnue')}</div>
      </div>
      <div class="timeline__meta">
        ${escapeHtml(formatPrice(vehicle.startingPrice))}
      </div>
    </div>
  `).join('');

  return `
    <section class="card">
      <h2 class="card__title">Derniere liste detectee</h2>
      <div class="list-preview">
        <div class="notice">${escapeHtml(`${list.length} vehicules detectes sur la derniere page liste analysee.`)}</div>
        ${items}
      </div>
    </section>
  `;
}

function renderLoading(): string {
  return `
    <div class="panel">
      <section class="empty-state">
        <h2>Chargement</h2>
        <p>Lecture du stockage local et synchronisation avec le backend.</p>
      </section>
    </div>
  `;
}

function metricCard(label: string, value: string): string {
  return `
    <section class="metric">
      <p class="metric__label">${escapeHtml(label)}</p>
      <p class="metric__value">${escapeHtml(value)}</p>
    </section>
  `;
}

function notice(message: string, tone: 'warn' | 'danger'): string {
  return `<section class="notice notice--${tone}">${escapeHtml(message)}</section>`;
}

function formatPrice(value?: number): string {
  if (value == null || Number.isNaN(value)) {
    return 'N/D';
  }

  return currencyFormatter.format(value);
}

function formatDistance(value?: number): string {
  if (value == null || Number.isNaN(value)) {
    return 'N/D';
  }

  return `${numberFormatter.format(value)} km`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return dateFormatter.format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('fr-FR');
}

function formatStatus(status?: string): string {
  switch (status) {
    case 'auction_live':
      return 'Enchere en cours';
    case 'sold':
      return 'Vendu';
    case 'unsold':
      return 'Invendu';
    case 'removed':
      return 'Retire';
    case 'available':
      return 'Disponible';
    default:
      return status || 'Statut inconnu';
  }
}

function formatBadge(badge: VehicleBadge): string {
  return badge.detail ? `${badge.label} - ${badge.detail}` : badge.label;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

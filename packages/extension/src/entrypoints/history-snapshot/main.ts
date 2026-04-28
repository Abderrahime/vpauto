import type { VehicleHistorySnapshotResponse } from '@vpauto/shared';
import { api } from '../../lib/api';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing history snapshot root element.');
}

const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('fr-FR');
const dateFormatter = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

void bootstrap();

async function bootstrap(): Promise<void> {
  const snapshotId = new URLSearchParams(window.location.search).get('snapshotId');
  const parsedId = snapshotId ? parseInt(snapshotId, 10) : NaN;

  if (!Number.isFinite(parsedId)) {
    renderError("Le parametre 'snapshotId' est manquant ou invalide.");
    return;
  }

  renderLoading(parsedId);

  const data = await api.getHistorySnapshot(parsedId);
  if (!data) {
    renderError("Impossible de charger cette fiche historique depuis la base locale.");
    return;
  }

  renderSnapshot(data);
}

function renderLoading(snapshotId: number): void {
  root.innerHTML = `
    <main class="page">
      <section class="hero">
        <div>
          <div class="hero__eyebrow">Fiche historique locale</div>
          <h1 class="hero__title">Chargement du snapshot #${snapshotId}</h1>
          <p class="hero__subtitle">Reconstruction exacte depuis la base locale VPauto Assistant.</p>
        </div>
      </section>
    </main>
  `;
}

function renderError(message: string): void {
  root.innerHTML = `
    <main class="page">
      <section class="hero">
        <div>
          <div class="hero__eyebrow">Fiche historique locale</div>
          <h1 class="hero__title">Fiche indisponible</h1>
          <p class="hero__subtitle">${esc(message)}</p>
        </div>
      </section>
    </main>
  `;
}

function renderSnapshot(data: VehicleHistorySnapshotResponse): void {
  const { identity, snapshot, passageNumber, totalPassages, meta } = data;
  document.title = `Historique · ${identity.brand} ${identity.model}`;

  const photos = snapshot.photoUrls.length > 0
    ? snapshot.photoUrls.map((url, index) => `
        <figure class="photo">
          <img src="${esc(url)}" alt="Photo ${index + 1} du snapshot historique" loading="lazy" />
        </figure>
      `).join('')
    : `<div class="empty">Aucune photo n'a ete stockee pour ce snapshot.</div>`;

  const chips = [
    chip(`Passage ${passageNumber}/${totalPassages}`),
    chip(`Snapshot #${snapshot.id ?? 'N/D'}`),
    chip(`Ref ${identity.reference || 'N/D'}`),
    chip(`Hash ${identity.hashId || 'N/D'}`),
    chip(meta.city || 'Ville inconnue'),
    meta.center ? chip(meta.center) : '',
    meta.saleDate ? chip(formatMoment(meta.saleDate, meta.saleTime)) : '',
    chip(formatStatus(snapshot.status), statusTone(snapshot.status)),
  ].filter(Boolean).join('');

  root.innerHTML = `
    <main class="page">
      <section class="hero">
        <div class="hero__copy">
          <div class="hero__eyebrow">Fiche historique locale</div>
          <h1 class="hero__title">${esc(`${identity.brand} ${identity.model}`)}</h1>
          <p class="hero__subtitle">${esc(identity.version || 'Version non renseignee')}</p>
          <div class="chips">${chips}</div>
        </div>
        <aside class="hero__note">
          <strong>Important</strong>
          <p>Cette fiche est reconstruite depuis le snapshot stocke localement. Elle sert de fallback quand la page VPauto historique exacte n'est pas fiable ou n'est plus disponible.</p>
        </aside>
      </section>

      <section class="grid">
        <article class="card card--prices">
          <h2>Prix</h2>
          <div class="price-grid">
            ${metric('Mise a prix', formatPrice(snapshot.startingPrice))}
            ${metric('Enchere en cours', formatPrice(snapshot.currentAuctionPrice))}
            ${metric('Adjuge', formatPrice(snapshot.soldPrice))}
            ${metric('Valeur de marche', formatPrice(snapshot.marketValue))}
            ${metric('Prix neuf', formatPrice(snapshot.newPrice))}
          </div>
        </article>

        <article class="card">
          <h2>Contexte vente</h2>
          <dl class="facts">
            ${fact('Centre', meta.center || 'N/D')}
            ${fact('Ville', meta.city || 'N/D')}
            ${fact('Date vente', meta.saleDate ? formatDate(meta.saleDate) : 'N/D')}
            ${fact('Heure vente', meta.saleTime || 'N/D')}
            ${fact('Lot', snapshot.lotNumber != null ? String(snapshot.lotNumber) : 'N/D')}
            ${fact('Kilometrage', formatDistance(snapshot.mileage))}
            ${fact('Statut', formatStatus(snapshot.status))}
            ${fact('Capturee le', formatDateTime(snapshot.scrapedAt))}
          </dl>
        </article>

        <article class="card">
          <h2>Identite vehicule</h2>
          <dl class="facts">
            ${fact('Reference', identity.reference || 'N/D')}
            ${fact('Hash', identity.hashId || 'N/D')}
            ${fact('Marque', identity.brand)}
            ${fact('Modele', identity.model)}
            ${fact('Version', identity.version || 'N/D')}
            ${fact('Annee', identity.year ? String(identity.year) : 'N/D')}
            ${fact('Carburant', identity.fuel || 'N/D')}
            ${fact('Transmission', identity.transmission || 'N/D')}
          </dl>
        </article>

        <article class="card">
          <h2>Observations et liens</h2>
          <div class="stack">
            <div class="note">${snapshot.observations ? esc(snapshot.observations) : 'Aucune observation enregistree dans ce snapshot.'}</div>
            ${snapshot.technicalCheckUrl ? `<a class="action" href="${esc(snapshot.technicalCheckUrl)}" target="_blank" rel="noreferrer">Ouvrir le controle technique</a>` : '<div class="muted">Controle technique non disponible.</div>'}
            ${snapshot.sourceUrl ? `<a class="action action--secondary" href="${esc(snapshot.sourceUrl)}" target="_blank" rel="noreferrer">Voir l'URL VPauto enregistree</a>` : ''}
          </div>
        </article>
      </section>

      <section class="card">
        <h2>Photos du snapshot</h2>
        <div class="photos">${photos}</div>
      </section>
    </main>
  `;
}

function metric(label: string, value: string): string {
  return `
    <div class="metric">
      <div class="metric__label">${esc(label)}</div>
      <div class="metric__value">${esc(value)}</div>
    </div>
  `;
}

function fact(label: string, value: string): string {
  return `
    <div class="fact">
      <dt>${esc(label)}</dt>
      <dd>${esc(value)}</dd>
    </div>
  `;
}

function chip(label: string, tone: 'neutral' | 'green' | 'red' | 'amber' = 'neutral'): string {
  return `<span class="chip chip--${tone}">${esc(label)}</span>`;
}

function statusTone(status?: string): 'neutral' | 'green' | 'red' | 'amber' {
  if (status === 'sold') return 'green';
  if (status === 'unsold' || status === 'removed') return 'red';
  if (status === 'auction_live') return 'amber';
  return 'neutral';
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

function formatMoment(date?: string, time?: string): string {
  if (!date) return 'N/D';
  return `${formatDate(date)}${time ? ` · ${time}` : ''}`;
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

import type { VehicleHistorySnapshotResponse } from '@vpauto/shared';
import { DEFAULT_API_URL } from '@vpauto/shared';
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
  const params = new URLSearchParams(window.location.search);
  const snapshotId = params.get('snapshotId');
  const fromVpauto404 = params.get('fromVpauto404') === '1';
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

  renderSnapshot(data, { fromVpauto404 });
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

function renderSnapshot(
  data: VehicleHistorySnapshotResponse,
  options: { fromVpauto404: boolean },
): void {
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

  // The hero capture is shown ONLY when VPauto returned 404 AND we have a
  // local screenshot to display. When VPauto is reachable, the user is on
  // the real page, so we don't pollute the local fiche with redundant
  // imagery. When 404 but no screenshot exists, we keep the banner alone
  // (we don't fabricate a fallback).
  const screenshotUrl = options.fromVpauto404 && snapshot.hasScreenshot && snapshot.id
    ? `${DEFAULT_API_URL}/api/vehicles/screenshot/${snapshot.id}`
    : null;
  const heroImage = screenshotUrl
    ? renderHeroImage({
        src: screenshotUrl,
        alt: `Capture VPauto du snapshot #${snapshot.id ?? ''}`,
        caption: 'Capture VPauto au moment du scrape · cliquer pour agrandir',
      })
    : '';

  const vpauto404Banner = options.fromVpauto404
    ? renderVpauto404Banner(snapshot.sourceUrl)
    : '';

  root.innerHTML = `
    <main class="page">
      ${vpauto404Banner}
      ${heroImage}
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
    ${renderLightbox()}
  `;

  if (screenshotUrl) {
    wireHeroLightbox(screenshotUrl);
  }
}

function renderHeroImage(input: { src: string; alt: string; caption: string }): string {
  return `
    <figure class="hero-image">
      <button class="hero-image__trigger" type="button" data-hero-lightbox aria-label="Agrandir la capture VPauto">
        <img class="hero-image__img" src="${esc(input.src)}" alt="${esc(input.alt)}" />
        <span class="hero-image__zoom" aria-hidden="true">⤢</span>
      </button>
      <figcaption class="hero-image__caption">${esc(input.caption)}</figcaption>
    </figure>
  `;
}

function renderVpauto404Banner(sourceUrl: string | undefined): string {
  const link = sourceUrl
    ? `<a class="banner__link" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">Réessayer le lien VPauto ↗</a>`
    : '';
  return `
    <aside class="banner banner--warn">
      <strong>La fiche VPauto n'est plus disponible</strong>
      <p>VPauto a renvoyé un 404 pour ce passage. Voici la version reconstruite depuis la capture locale réalisée au moment du scrape.</p>
      ${link}
    </aside>
  `;
}

function renderLightbox(): string {
  return `
    <div class="lightbox" data-lightbox role="dialog" aria-modal="true" aria-label="Capture VPauto agrandie" hidden>
      <button class="lightbox__close" type="button" data-lightbox-close aria-label="Fermer">×</button>
      <img class="lightbox__img" data-lightbox-img alt="Capture VPauto en grand" />
      <a class="lightbox__open-tab" data-lightbox-open-tab href="#" target="_blank" rel="noreferrer">Ouvrir dans un nouvel onglet ↗</a>
    </div>
  `;
}

function wireHeroLightbox(src: string): void {
  const overlay = document.querySelector<HTMLDivElement>('[data-lightbox]');
  const overlayImg = document.querySelector<HTMLImageElement>('[data-lightbox-img]');
  const overlayLink = document.querySelector<HTMLAnchorElement>('[data-lightbox-open-tab]');
  const closeBtn = document.querySelector<HTMLButtonElement>('[data-lightbox-close]');
  const trigger = document.querySelector<HTMLButtonElement>('[data-hero-lightbox]');

  if (!overlay || !overlayImg || !closeBtn || !trigger) return;

  if (overlayLink) overlayLink.href = src;
  overlayImg.src = src;

  const open = (): void => {
    overlay.hidden = false;
    document.body.classList.add('lightbox-open');
    closeBtn.focus();
  };
  const close = (): void => {
    overlay.hidden = true;
    document.body.classList.remove('lightbox-open');
    trigger.focus();
  };

  trigger.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    // Click on the backdrop (not on the image or the open-tab link) closes.
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });
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

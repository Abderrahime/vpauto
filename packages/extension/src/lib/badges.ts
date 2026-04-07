import type { VehicleSnapshot, VehicleBadge } from '@vpauto/shared';
import { api } from './api';

const CT_PDF_BASE = 'https://cdn.vpauto.fr/d/';

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

    // Extract cdnHash from the vehicle's image
    const cdnHash = vehicleData.cdnHash
      || item.querySelector('img')?.src?.match(/cdn\.vpauto\.fr\/([^_/]+)/)?.[1];

    // Add CT hover popup (no API needed)
    if (cdnHash) {
      addCtHoverPopup(card, cdnHash, vehicleData);
    }

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

function closeAllCtPopups(exceptCard?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.vpauto-ct-popup').forEach((popup) => {
    const owner = popup.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    popup.remove();
  });

  document.querySelectorAll<HTMLElement>('.vpauto-ct-toggle').forEach((button) => {
    const owner = button.closest('li') as HTMLElement | null;
    if (exceptCard && owner === exceptCard) return;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'Voir le CT';
  });
}

/**
 * Add a click-triggered popup that shows the CT (Contrôle Technique) PDF preview
 * and key vehicle info inside the same card.
 */
function addCtHoverPopup(
  card: HTMLElement,
  cdnHash: string,
  v: Partial<VehicleSnapshot>,
): void {
  const ctUrl = `${CT_PDF_BASE}${cdnHash}_CT.pdf`;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'vpauto-ct-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.style.cssText = `
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 18;
    border: none;
    background: rgba(15,17,23,0.85);
    color: #f8fafc;
    padding: 7px 11px;
    border-radius: 999px;
    font: 700 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    letter-spacing: 0.01em;
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,0.28);
    backdrop-filter: blur(8px);
  `;
  toggle.textContent = 'Voir le CT';
  toggle.title = 'Afficher le contrôle technique';
  card.appendChild(toggle);

  const removePopup = (): void => {
    const popup = card.querySelector('.vpauto-ct-popup');
    if (popup) popup.remove();
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Voir le CT';
  };

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (card.querySelector('.vpauto-ct-popup')) {
      removePopup();
      return;
    }

    closeAllCtPopups(card);

    const popup = document.createElement('div');
    popup.className = 'vpauto-ct-popup';
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

    const ctHtml = `
      <div style="position:relative; flex:1 1 auto; min-height:220px; background:#0f1117;">
        <button type="button"
                class="vpauto-ct-close"
                style="position:absolute; right:10px; bottom:10px; z-index:3; border:none; border-radius:999px;
                       background:rgba(15,17,23,0.85); color:#f8fafc; cursor:pointer; font-size:11px; font-weight:700;
                       padding:7px 11px; letter-spacing:0.01em; box-shadow:0 6px 18px rgba(0,0,0,0.28); backdrop-filter:blur(8px);"
                aria-label="Fermer l'aperçu CT">
          Fermer
        </button>
        <iframe
          src="${ctUrl}#toolbar=0&navpanes=0&scrollbar=0"
          style="width:100%; height:100%; border:none;"
          loading="lazy"
        ></iframe>
        <a href="${ctUrl}" target="_blank" rel="noopener"
           style="position:absolute; left:10px; bottom:10px; background:linear-gradient(135deg,#f47920,#e06510); color:white;
                  padding:7px 12px; border-radius:999px; font-size:11px; font-weight:700; text-decoration:none;
                  box-shadow:0 4px 14px rgba(244,121,32,0.35); z-index:2;"
           onclick="event.stopPropagation();">
          Ouvrir le CT ↗
        </a>
        <div style="position:absolute; left:10px; top:10px; z-index:2; background:rgba(15,17,23,0.78); color:#cbd5e1;
                    padding:6px 10px; border-radius:999px; font-size:10px; font-weight:600; letter-spacing:0.02em;
                    backdrop-filter:blur(6px);">
          Aperçu CT
        </div>
      </div>
    `;

    popup.innerHTML = headerHtml + ctHtml;
    card.appendChild(popup);
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = 'Masquer le CT';

    popup.querySelector<HTMLButtonElement>('.vpauto-ct-close')?.addEventListener('click', (closeEvent) => {
      closeEvent.preventDefault();
      closeEvent.stopPropagation();
      removePopup();
    });
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

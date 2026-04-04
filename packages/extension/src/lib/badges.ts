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

/**
 * Add a hover popup that shows the CT (Contrôle Technique) PDF preview
 * and key vehicle info when hovering over a card.
 */
function addCtHoverPopup(
  card: HTMLElement,
  cdnHash: string,
  v: Partial<VehicleSnapshot>,
): void {
  let popup: HTMLElement | null = null;
  let timeout: ReturnType<typeof setTimeout>;
  const ctUrl = `${CT_PDF_BASE}${cdnHash}_CT.pdf`;

  card.addEventListener('mouseenter', () => {
    timeout = setTimeout(() => {
      if (popup) return;

      popup = document.createElement('div');
      popup.className = 'vpauto-ct-popup';
      popup.style.cssText = `
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: #1a1d27;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        padding: 0;
        z-index: 1000;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        color: #f0f0f5;
        overflow: hidden;
        min-height: 200px;
      `;

      // Header with vehicle info
      const brand = v.brand || '';
      const model = v.model || '';
      const isSold = v.status === 'sold';
      const isNonRoulant = /non\s*roulant/i.test(v.observations || '') || /non\s*roulant/i.test(v.model || '');

      // Price section
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
        <div style="padding:12px 14px; background:linear-gradient(135deg,#1e2a3a,#0f1520); border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <div style="font-weight:700; color:#f0f0f5; font-size:14px;">${esc(brand)} ${esc(model)}</div>
            <div style="display:flex;gap:4px;">${tagsHtml}</div>
          </div>
          <div style="display:flex; gap:12px; margin-top:6px; color:#8b8fa3; font-size:11px;">
            ${priceHtml ? `<span>${priceHtml}</span>` : ''}
          </div>
          <div style="display:flex; gap:10px; margin-top:4px; color:#5c6070; font-size:10px;">
            ${year ? `<span>${year}</span>` : ''}
            ${km ? `<span>${km}</span>` : ''}
            ${city ? `<span>${city}</span>` : ''}
          </div>
        </div>
      `;

      // CT PDF embed
      const ctHtml = `
        <div style="position:relative; height:350px; background:#0f1117;">
          <iframe
            src="${ctUrl}#toolbar=0&navpanes=0&scrollbar=0"
            style="width:100%; height:100%; border:none;"
            loading="lazy"
          ></iframe>
          <a href="${ctUrl}" target="_blank" rel="noopener"
             style="position:absolute; bottom:8px; right:8px; background:linear-gradient(135deg,#f47920,#e06510); color:white;
                    padding:5px 12px; border-radius:6px; font-size:11px; font-weight:600; text-decoration:none;
                    box-shadow:0 2px 8px rgba(244,121,32,0.3); z-index:2;"
             onclick="event.stopPropagation();">
            Ouvrir le CT ↗
          </a>
        </div>
      `;

      popup.innerHTML = headerHtml + ctHtml;
      card.appendChild(popup);
    }, 400);
  });

  card.addEventListener('mouseleave', () => {
    clearTimeout(timeout);
    if (popup) {
      popup.remove();
      popup = null;
    }
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

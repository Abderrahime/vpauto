import type { VehicleSnapshot, VehicleBadge } from '@vpauto/shared';
import { api } from './api';

/**
 * Inject badges on vehicle cards in the list page.
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

    // Lookup vehicle in our database
    const lookup = await api.lookup({ hashId });
    if (!lookup) continue;

    const badges = await api.getBadges(lookup.vehicleId);
    if (!badges || badges.length === 0) continue;

    // Create badge container
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

    // Make the card's parent relative for absolute positioning
    const card = item.closest('li');
    if (card) {
      (card as HTMLElement).style.position = 'relative';
      card.appendChild(container);
    }

    // Add hover popup
    addHoverPopup(card as HTMLElement, lookup.vehicleId, vehicleData);
  }
}

function addHoverPopup(card: HTMLElement, vehicleId: number, vehicleData: Partial<VehicleSnapshot>): void {
  let popup: HTMLElement | null = null;
  let timeout: ReturnType<typeof setTimeout>;

  card.addEventListener('mouseenter', () => {
    timeout = setTimeout(async () => {
      const history = await api.getHistory(vehicleId);
      if (!history) return;

      popup = document.createElement('div');
      popup.className = 'vpauto-popup';
      popup.style.cssText = `
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        color: #333;
        max-width: 350px;
      `;

      let html = `<div style="font-weight:600; margin-bottom:8px; color:#003366;">📋 Historique VPauto</div>`;

      html += `<div style="margin-bottom:6px;">Passages: <strong>${history.totalPassages}</strong></div>`;
      html += `<div style="margin-bottom:6px;">Premier vu: ${history.firstSeen.split('T')[0]}</div>`;

      if (history.priceHistory.length > 0) {
        const lastPrice = history.priceHistory[history.priceHistory.length - 1];
        html += `<div style="margin-bottom:6px;">Dernière mise à prix: <strong>${lastPrice.price.toLocaleString('fr-FR')} €</strong></div>`;
      }

      if (history.passages.length > 0) {
        html += `<div style="margin-top:8px; font-weight:600; margin-bottom:4px;">Derniers passages:</div>`;
        for (const p of history.passages.slice(-3).reverse()) {
          html += `<div style="padding:4px 0; border-bottom:1px solid #f0f0f0;">
            ${p.date} — ${p.city}
            ${p.startingPrice ? `— ${p.startingPrice.toLocaleString('fr-FR')} €` : ''}
            ${p.mileage ? `— ${p.mileage.toLocaleString('fr-FR')} km` : ''}
          </div>`;
        }
      }

      popup.innerHTML = html;
      card.appendChild(popup);
    }, 500);
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

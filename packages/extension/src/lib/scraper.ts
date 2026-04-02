import type { VehicleSnapshot, VehicleStatus } from '@vpauto/shared';
import { VPAUTO_BASE_URL, VPAUTO_VEHICLE_URL_PATTERN } from '@vpauto/shared';

// ── List page scraper ──────────────────────────────────────────────────────

/**
 * Wait until at least one vehicle card is present in the DOM.
 * VPauto is a SPA — cards are injected client-side after page load.
 */
export function waitForVehicleCards(timeout = 8000): Promise<NodeListOf<Element>> {
  return new Promise((resolve, reject) => {
    // Already there?
    const initial = document.querySelectorAll('a[href*="/vehicule/"]');
    if (initial.length > 0) { resolve(initial); return; }

    const deadline = Date.now() + timeout;
    const obs = new MutationObserver(() => {
      const cards = document.querySelectorAll('a[href*="/vehicule/"]');
      if (cards.length > 0) {
        obs.disconnect();
        resolve(cards);
      } else if (Date.now() > deadline) {
        obs.disconnect();
        reject(new Error('Timeout waiting for vehicle cards'));
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Safety timeout
    setTimeout(() => { obs.disconnect(); reject(new Error('Timeout')); }, timeout);
  });
}

/**
 * Extract basic vehicle data from list page cards.
 * VPauto HTML structure (confirmed April 2026):
 *   <li>
 *     <div>Ajout à ma liste</div>
 *     <a href="/vehicule/{hashId}/{slug}">
 *       <img src="cdn.vpauto.fr/...">
 *       <div>RENAULT</div>             ← brand (all-caps)
 *       <div>N° 1 Bordeaux</div>       ← lot/city
 *       <h3>Clio E-Tech ...</h3>       ← model
 *       <div>2022 - 21440 Km</div>     ← year/mileage
 *       <div>Mise à prix 14900€</div>  ← price
 *     </a>
 *   </li>
 */
export function scrapeVehicleList(): Partial<VehicleSnapshot>[] {
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/vehicule/"]');
  const vehicles: Partial<VehicleSnapshot>[] = [];
  const seen = new Set<string>();

  console.log(`[VPauto] scrapeVehicleList: found ${links.length} links with /vehicule/`);

  for (const a of links) {
    try {
      const href = a.getAttribute('href') || '';
      const hashMatch = href.match(/\/vehicule\/([a-f0-9]+)\//);
      if (!hashMatch) continue;
      const hashId = hashMatch[1];
      if (seen.has(hashId)) continue;
      seen.add(hashId);

      // Model: <h3> element (this is reliable)
      const model = a.querySelector('h3')?.textContent?.trim() || '';

      // Image
      const img = a.querySelector('img')?.getAttribute('src') || '';

      // Collect ALL direct child divs' text content for pattern matching
      const childTexts: string[] = [];
      for (const child of a.children) {
        const text = child.textContent?.trim() || '';
        if (text && child.tagName !== 'IMG') {
          childTexts.push(text);
        }
      }

      // Full text of the card
      const fullText = a.textContent || '';

      // Brand: first all-caps word/line (e.g. "RENAULT", "BMW", "TESLA")
      let brand = '';
      for (const text of childTexts) {
        if (text === text.toUpperCase() && /^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ\s-]+$/.test(text) && text.length >= 2 && text.length <= 30) {
          brand = text.trim();
          break;
        }
      }

      // Year + km: pattern "2022 - 21440 Km" from child divs
      let year = 0;
      let mileage = 0;
      for (const text of childTexts) {
        const yearMatch = text.match(/(\d{4})/);
        const kmMatch = text.replace(/\s/g, '').match(/(\d+)\s*[Kk]m/);
        if (yearMatch && kmMatch) {
          year = parseInt(yearMatch[1]);
          mileage = parseInt(kmMatch[1]);
          break;
        }
      }
      // Fallback from full text
      if (!year) {
        const ym = fullText.match(/(\d{4})\s*[-–]/);
        if (ym) year = parseInt(ym[1]);
      }
      if (!mileage) {
        const km = fullText.replace(/\s/g, '').match(/(\d+)\s*[Kk]m/);
        if (km) mileage = parseInt(km[1]);
      }

      // Price: "Mise à prix 14900€" or any "XXXXX€" pattern from child divs
      let startingPrice: number | undefined;
      for (const text of childTexts) {
        const priceMatch = text.replace(/\s/g, '').match(/([\d]+)\s*€/);
        if (priceMatch) {
          startingPrice = parseInt(priceMatch[1]);
          break;
        }
      }
      // Fallback
      if (startingPrice === undefined) {
        const pm = fullText.replace(/\s/g, '').match(/([\d]+)€/);
        if (pm) startingPrice = parseInt(pm[1]);
      }

      // Lot + city: "N° 1 Bordeaux" or "N° 1 DEPT : 69"
      const lotMatch = fullText.match(/N°?\s*(\d+)\s+([\wéèêëàâäôöùûüïîç\s:.-]+)/i);
      const lotNumber = lotMatch ? parseInt(lotMatch[1]) : undefined;
      let city = lotMatch ? lotMatch[2].replace(/DEPT\s*:\s*/i, 'Dept ').trim() : '';
      // Clean city: stop at first non-city character pattern
      city = city.split(/\d{4}/)[0].trim(); // Stop before year if merged

      // CDN hash from thumbnail URL
      const cdnHashMatch = img.match(/cdn\.vpauto\.fr\/([^_/]+)/);
      const cdnHash = cdnHashMatch?.[1];

      vehicles.push({
        hashId,
        brand,
        model,
        version: model,
        year,
        mileage,
        city,
        lotNumber,
        startingPrice,
        photoUrls: img ? [img] : [],
        cdnHash,
        sourceUrl: `${VPAUTO_BASE_URL}${href}`,
        fuel: '',
        transmission: '',
        color: '',
        vatRecoverable: false,
        scrapedAt: new Date().toISOString(),
        status: 'available',
      });
    } catch {
      continue;
    }
  }

  console.log(`[VPauto] scrapeVehicleList: extracted ${vehicles.length} vehicles`);
  return vehicles;
}

// ── Detail page scraper ────────────────────────────────────────────────────

/**
 * Extract full vehicle data from a VPauto vehicle detail page.
 */
export function scrapeVehicleDetail(): VehicleSnapshot | null {
  try {
    const url = window.location.href;
    const urlMatch = url.match(VPAUTO_VEHICLE_URL_PATTERN);
    if (!urlMatch) return null;
    const hashId = urlMatch[1];

    // ── Key/value extraction from <dt>/<dd>, <th>/<td>, and labelled spans ──
    const kv = extractKeyValues(document.body);

    // ── Title / brand / model ──
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    // Brand is usually in a dedicated span or the first all-caps word
    const brandEl = document.querySelector('span.marque, .brand, [class*="marque"]');
    const brand = (brandEl?.textContent?.trim() || extractBrand(h1)).toUpperCase();
    const version = h1.replace(new RegExp(brand, 'i'), '').trim() || h1;
    const model = extractModel(version);

    // ── Reference (7+ digit number) ──
    const bodyText = document.body.innerText;
    const refMatch = bodyText.match(/(?:Ref\.?\s*:?\s*|Référence\s*:?\s*|N°\s*lot\s*:?\s*)(\d{7,})/i)
      || bodyText.match(/\b(\d{8,})\b/);
    const reference = refMatch?.[1] || '';

    // ── Specs from key/value pairs ──
    const year         = parseYear(kv['année'] || kv['annee'] || kv['mise en circulation'] || '');
    const mileage      = parseKm(kv['kilométrage'] || kv['kilometrage'] || '');
    const color        = kv['couleur'] || '';
    const fuel         = kv['énergie'] || kv['energie'] || kv['carburant'] || '';
    const transmission = kv['boîte'] || kv['boite'] || kv['transmission'] || '';
    const engineSize   = parseInt(kv['cylindrée']?.match(/(\d+)/)?.[1] || '0') || undefined;
    const powerMatch   = (kv['puissance'] || '').match(/(\d+)\s*ch/i);
    const power        = powerMatch ? parseInt(powerMatch[1]) : undefined;
    const fiscalMatch  = (kv['puissance'] || '').match(/(\d+)\s*cv/i);
    const fiscalPower  = fiscalMatch ? parseInt(fiscalMatch[1]) : undefined;
    const doors        = parseInt(kv['portes']?.match(/(\d)/)?.[1] || '0') || undefined;
    const seats        = parseInt(kv['places']?.match(/(\d)/)?.[1] || '0') || undefined;
    const co2          = parseInt(kv['co2']?.match(/(\d+)/)?.[1] || '0') || undefined;
    const critair      = kv["crit'air"] || kv['critair'] || undefined;
    const euroStandard = kv['norme euro'] || kv['euro'] || undefined;
    const bodyType     = kv['carrosserie'] || undefined;

    // ── Pricing ──
    const startingPrice  = parsePrice(bodyText, /mise\s*(?:à|a)\s*prix[^€\d]*([\d\s]+)\s*€/i);
    const startingPriceHT = parsePrice(bodyText, /prix\s+ht[^€\d]*([\d\s]+)\s*€/i);
    const marketValue    = parsePrice(bodyText, /cote[^€\d]*([\d\s]+)\s*€/i);
    const newPrice       = parsePrice(bodyText, /prix\s+neuf[^€\d]*([\d\s]+)\s*€/i);
    const vatRecoverable = /tva\s+récupérable|tva\s+recuperable/i.test(bodyText);

    // ── Sale info ──
    const city       = extractCity(kv, bodyText);
    const department = bodyText.match(/\b(\d{2,3})\s*[-–]\s*[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜ]/)?.[1];
    const saleDate   = extractSaleDate(kv, bodyText);
    const saleTime   = bodyText.match(/(\d{1,2}h\d{2})/)?.[1];
    const lotNumber  = parseInt(bodyText.match(/lot\s+n°?\s*(\d+)/i)?.[1] || '0') || undefined;

    // ── Condition ──
    const technicalCheckUrl = (document.querySelector('a[href*="_CT.pdf"]') as HTMLAnchorElement)?.href;
    const conditionImageUrl = (document.querySelector('img[src*="_ET."]') as HTMLImageElement)?.src;
    const observations      = extractObservations(document.body);
    const maintenanceStatus = kv['entretien'] || undefined;
    const serviceHistory    = /carnet.*oui|oui.*carnet/i.test(bodyText) || undefined;
    const firstOwner        = /1[eè]re?\s*main|premi[eè]re?\s*main/i.test(bodyText) || undefined;
    const warranty          = kv['garantie'] || undefined;
    const equipment         = extractEquipment(document.body);

    // ── Photos ──
    // CDN pattern: cdn.vpauto.fr/{hash}_{number}-80.jpg (e.g. YbUnrKP_01-80.jpg)
    const photoUrls: string[] = [];
    const cdnHashes = new Set<string>();
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="cdn.vpauto.fr"]')) {
      const src = img.src;
      if (src.includes('_ET.') || src.includes('_CT')) continue;
      if (!photoUrls.includes(src)) photoUrls.push(src);
      const m = src.match(/cdn\.vpauto\.fr\/([^_/]+)/);
      if (m) cdnHashes.add(m[1]);
    }
    const cdnHash = [...cdnHashes][0];

    // ── Status ──
    let status: VehicleStatus = 'available';
    if (/enchère\s+en\s+cours/i.test(bodyText)) status = 'auction_live';

    return {
      reference, hashId, brand, model, version,
      year, mileage, color, fuel, transmission,
      engineSize, power, fiscalPower, doors, seats, co2,
      critair, euroStandard, bodyType,
      startingPrice, startingPriceHT, marketValue, newPrice, vatRecoverable,
      city, center: city, department,
      saleDate, saleTime, lotNumber,
      technicalCheckUrl, conditionImageUrl,
      observations, maintenanceStatus, serviceHistory, firstOwner, warranty,
      equipment, photoUrls, cdnHash,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      status,
    };
  } catch (err) {
    console.error('[VPauto] scrapeVehicleDetail error:', err);
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractKeyValues(root: Element): Record<string, string> {
  const kv: Record<string, string> = {};
  const norm = (s: string) => s.toLowerCase().replace(/[:\s]+/g, ' ').trim();

  // <dt>/<dd>
  root.querySelectorAll('dt').forEach(dt => {
    const dd = dt.nextElementSibling;
    if (dd?.tagName === 'DD') kv[norm(dt.textContent || '')] = dd.textContent?.trim() || '';
  });
  // <th>/<td>
  root.querySelectorAll('th').forEach(th => {
    const td = th.nextElementSibling;
    if (td?.tagName === 'TD') kv[norm(th.textContent || '')] = td.textContent?.trim() || '';
  });
  // Labelled spans / divs
  root.querySelectorAll('[class*="label"], [class*="title"], .field-label').forEach(lbl => {
    const val = lbl.nextElementSibling;
    if (val) kv[norm(lbl.textContent || '')] = val.textContent?.trim() || '';
  });
  // <li> elements with "Label : Value" pattern (VPauto uses this format)
  root.querySelectorAll('li').forEach(li => {
    const text = li.textContent?.trim() || '';
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 40) {
      const key = text.slice(0, colonIdx).trim();
      const val = text.slice(colonIdx + 1).trim();
      if (key && val && !kv[norm(key)]) {
        kv[norm(key)] = val;
      }
    }
  });
  return kv;
}

function extractBrand(title: string): string {
  return title.split(/\s+/).find(w => w === w.toUpperCase() && w.length > 1) || title.split(' ')[0];
}

function extractModel(version: string): string {
  // First 1-2 significant words
  return version.split(/\s+/).slice(0, 2).join(' ');
}

function parseYear(s: string): number {
  return parseInt(s.match(/(\d{4})/)?.[1] || '0');
}

function parseKm(s: string): number {
  return parseInt(s.replace(/\s/g, '').match(/(\d+)/)?.[1] || '0');
}

function parsePrice(text: string, re: RegExp): number | undefined {
  const m = text.replace(/\s/g, '').match(re);
  return m ? parseInt(m[1]) : undefined;
}

function extractCity(kv: Record<string, string>, bodyText: string): string {
  const from_kv = kv['lieu de vente'] || kv['centre'] || kv['localisation'] || '';
  if (from_kv) return from_kv.replace(/^\d+\s*[-–]\s*/, '').trim();
  const cities = ['Bordeaux','Lyon','Paris','Marseille','Lille','Rennes','Strasbourg','Toulouse','Nantes','Rouen','Montpellier','Grenoble','Caen'];
  return cities.find(c => new RegExp(c, 'i').test(bodyText)) || '';
}

function extractSaleDate(kv: Record<string, string>, bodyText: string): string | undefined {
  const raw = kv['date de vente'] || kv['date'] || '';
  if (raw) return formatDate(raw);
  // Match "Le 02/04/26" or "Le 02/04/2026" or standalone date
  const m = bodyText.match(/(?:Le\s+)?(\d{2}\/\d{2}\/\d{2,4})/i);
  return m ? formatDate(m[1]) : undefined;
}

function formatDate(s: string): string {
  const p = s.split('/');
  if (p.length !== 3) return s;
  let [d, mo, y] = p;
  if (y.length === 2) y = `20${y}`;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function extractObservations(root: Element): string {
  for (const h of root.querySelectorAll('h2, h3, h4, [class*="section"], [class*="title"]')) {
    if (/observation|défaut|remarque|état/i.test(h.textContent || '')) {
      const parent = h.closest('section, div, article');
      if (parent) {
        const items = [...parent.querySelectorAll('li, p')].map(el => el.textContent?.trim()).filter(Boolean);
        if (items.length) return items.join(' | ');
      }
    }
  }
  return '';
}

function extractEquipment(root: Element): string[] {
  const eq: string[] = [];
  for (const h of root.querySelectorAll('h2, h3, h4, [class*="equip"]')) {
    if (/équipement|option|dotation/i.test(h.textContent || '')) {
      const parent = h.closest('section, div, article');
      if (parent) parent.querySelectorAll('li').forEach(li => { const t = li.textContent?.trim(); if (t) eq.push(t); });
    }
  }
  return eq;
}

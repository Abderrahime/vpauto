import type { VehicleSnapshot, VehicleStatus } from '@vpauto/shared';
import { VPAUTO_BASE_URL, VPAUTO_VEHICLE_URL_PATTERN } from '@vpauto/shared';

const UNSOLD_TEXT_RE = /n[''\u2019]a\s*pas\s*[eé]t[eé]\s*adjug[eé]|pas\s*[eé]t[eé]\s*adjug[eé]|pas\s*adjug[eé]|non\s*adjug[eé]|invendu|apr[eè]s[\s-]*vente|ordre\s+d[''\u2019]achat\s+d[''\u2019]apr[eè]s[\s-]*vente/i;

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
  return scrapeVehicleListFromDocument(document);
}

/**
 * Detect pagination info from the current list page.
 * Returns { currentPage, totalPages, baseUrl }
 */
export function detectPagination(): { currentPage: number; totalPages: number; baseUrl: string } {
  const url = new URL(window.location.href);
  const currentPage = parseInt(url.searchParams.get('page') || '1');

  // Find the last page number from pagination links
  let totalPages = 1;
  const paginationLinks = document.querySelectorAll('a[href*="page="]');
  for (const link of paginationLinks) {
    const href = link.getAttribute('href') || '';
    const pageMatch = href.match(/page=(\d+)/);
    if (pageMatch) {
      const p = parseInt(pageMatch[1]);
      if (p > totalPages) totalPages = p;
    }
  }

  // Base URL without page param
  url.searchParams.delete('page');
  const baseUrl = url.toString();

  console.log(`[VPauto] Pagination: page ${currentPage}/${totalPages}`);
  return { currentPage, totalPages, baseUrl };
}

/**
 * Scrape vehicles from a remote page by fetching its HTML.
 * Uses fetch() + DOMParser to extract vehicle data without navigating.
 */
export async function scrapeRemotePage(pageUrl: string): Promise<Partial<VehicleSnapshot>[]> {
  try {
    const res = await fetch(pageUrl, { credentials: 'include' });
    if (!res.ok) {
      console.warn(`[VPauto] Failed to fetch page: ${res.status} ${pageUrl}`);
      return [];
    }
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return scrapeVehicleListFromDocument(doc);
  } catch (err) {
    console.warn(`[VPauto] Error fetching page ${pageUrl}:`, err);
    return [];
  }
}

/**
 * Scrape vehicle list from a given Document (current page or parsed remote page).
 */
export function scrapeVehicleListFromDocument(doc: Document): Partial<VehicleSnapshot>[] {
  const links = doc.querySelectorAll<HTMLAnchorElement>('a[href*="/vehicule/"]');
  const vehicles: Partial<VehicleSnapshot>[] = [];
  const seen = new Set<string>();

  for (const a of links) {
    try {
      const href = a.getAttribute('href') || '';
      const hashMatch = href.match(/\/vehicule\/([a-f0-9]+)\//);
      if (!hashMatch) continue;
      const hashId = hashMatch[1];
      if (seen.has(hashId)) continue;
      seen.add(hashId);

      const model = a.querySelector('h3')?.textContent?.trim() || '';
      const img = a.querySelector('img')?.getAttribute('src') || '';

      const childTexts: string[] = [];
      for (const child of a.children) {
        const text = child.textContent?.trim() || '';
        if (text && child.tagName !== 'IMG') {
          childTexts.push(text);
        }
      }

      const fullText = a.textContent || '';

      let brand = '';
      for (const text of childTexts) {
        if (text === text.toUpperCase() && /^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ\s-]+$/.test(text) && text.length >= 2 && text.length <= 30) {
          brand = text.trim();
          break;
        }
      }

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
      if (!year) {
        const ym = fullText.match(/(\d{4})\s*[-–]/);
        if (ym) year = parseInt(ym[1]);
      }
      if (!mileage) {
        const km = fullText.replace(/\s/g, '').match(/(\d+)\s*[Kk]m/);
        if (km) mileage = parseInt(km[1]);
      }

      // ── Starting price: specifically from "Mise à prix" text ──
      // IMPORTANT: Don't just take the first price — that could be the ADJUGÉ sold price
      let startingPrice: number | undefined;
      for (const text of childTexts) {
        const miseAPrix = text.replace(/\s/g, '').match(/[Mm]ise\s*(?:à|a)\s*prix\s*([\d]+)\s*€?/i)
          || text.replace(/\s/g, '').match(/Miseàprix([\d]+)€/i);
        if (miseAPrix) {
          startingPrice = parseInt(miseAPrix[1]);
          break;
        }
      }
      // Fallback: search fullText for "Mise à prix" line
      if (startingPrice === undefined) {
        const miseMatch = fullText.replace(/\s/g, '').match(/[Mm]ise(?:à|a)prix([\d]+)€/i);
        if (miseMatch) {
          startingPrice = parseInt(miseMatch[1]);
        }
      }
      // Last resort: take a price that is NOT from ADJUGÉ section
      if (startingPrice === undefined) {
        for (const text of childTexts) {
          if (/adjug[eé]/i.test(text)) continue; // Skip ADJUGÉ line
          const priceMatch = text.replace(/\s/g, '').match(/([\d]+)\s*€/);
          if (priceMatch) {
            startingPrice = parseInt(priceMatch[1]);
            break;
          }
        }
      }

      const lotMatch = fullText.match(/N°?\s*(\d+)\s+([\wéèêëàâäôöùûüïîç\s:.-]+)/i);
      const lotNumber = lotMatch ? parseInt(lotMatch[1]) : undefined;
      let city = lotMatch ? lotMatch[2].replace(/DEPT\s*:\s*/i, 'Dept ').trim() : '';
      city = city.split(/\d{4}/)[0].trim();

      const cdnHashMatch = img.match(/cdn\.vpauto\.fr\/([^_/]+)/);
      const cdnHash = cdnHashMatch?.[1];

      // ── Detect auction status ──
      let status: VehicleStatus = 'available';
      let soldPrice: number | undefined;
      const cardText = fullText;

      // Check "pas adjugé" / "non adjugé" FIRST (before "adjugé")
      if (UNSOLD_TEXT_RE.test(cardText)) {
        status = 'unsold';
      } else if (/adjug[eé]/i.test(cardText)) {
        status = 'sold';
        // Price near "adjugé" — check up to 100 chars after (DOM text may have extra content between)
        const adjMatch = cardText.match(/adjug[eé][\s\S]{0,100}?([\d][\d\s]*)\s*€/i);
        if (adjMatch) {
          soldPrice = parseInt(adjMatch[1].replace(/\s/g, ''));
        }
        // Fallback: look for a child div/span with a price that is NOT the "Mise à prix"
        if (!soldPrice) {
          for (const child of a.children) {
            const text = child.textContent?.trim() || '';
            if (/adjug[eé]/i.test(text)) {
              const priceMatch = text.replace(/\s/g, '').match(/([\d]+)\s*€/);
              if (priceMatch) {
                soldPrice = parseInt(priceMatch[1]);
                break;
              }
            }
          }
        }
      }

      // ── Detect "véhicule non roulant" ──
      const isNonRoulant = /non\s*roulant|hors\s*d[''\u2019]usage|[eé]pave|accident[eé]/i.test(fullText);
      const observations = isNonRoulant ? 'Véhicule non roulant' : '';

      const vehicle: Partial<VehicleSnapshot> = {
        hashId, brand, model, version: model,
        year, mileage, city, lotNumber, startingPrice,
        photoUrls: img ? [img] : [], cdnHash,
        sourceUrl: `${VPAUTO_BASE_URL}${href}`,
        fuel: '', transmission: '', color: '',
        vatRecoverable: false,
        scrapedAt: new Date().toISOString(),
        status,
      };
      if (soldPrice) vehicle.soldPrice = soldPrice;
      if (observations) vehicle.observations = observations;

      vehicles.push(vehicle);
    } catch {
      continue;
    }
  }

  return vehicles;
}

// ── Detail page scraper ────────────────────────────────────────────────────

/**
 * Extract full vehicle data from a VPauto vehicle detail page.
 */
export function scrapeVehicleDetail(): VehicleSnapshot | null {
  return scrapeVehicleDetailFromDocument(document, window.location.href);
}

export function scrapeVehicleDetailFromHtml(html: string, pageUrl: string): VehicleSnapshot | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return scrapeVehicleDetailFromDocument(doc, pageUrl);
  } catch (err) {
    console.error('[VPauto] scrapeVehicleDetailFromHtml error:', err);
    return null;
  }
}

export function scrapeVehicleDetailFromDocument(doc: Document, pageUrl: string): VehicleSnapshot | null {
  try {
    const url = pageUrl;
    const urlMatch = url.match(VPAUTO_VEHICLE_URL_PATTERN);
    if (!urlMatch) return null;
    const hashId = urlMatch[1];

    // ── Key/value extraction from <dt>/<dd>, <th>/<td>, and labelled spans ──
    const kv = extractKeyValues(doc.body);

    // ── Title / brand / model ──
    // Most reliable source: document.title = "TESLA MODEL 3 Standard Range Plus RWD Bleu foncé métal | VPauto.fr"
    // Extract vehicle name by removing " | VPauto.fr" suffix and optional color suffix
    let titleText = '';
    const pageTitle = doc.title || '';
    const titleClean = pageTitle.replace(/\s*\|\s*VPauto\.fr$/i, '').trim();
    if (titleClean && titleClean.length > 3) {
      titleText = titleClean;
    }
    // Fallback: try URL slug
    if (!titleText) {
      const slugMatch = url.match(/\/vehicule\/[a-f0-9]+\/(.+?)(?:\?|$)/);
      if (slugMatch) {
        titleText = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    const brand = extractBrand(titleText).toUpperCase();
    // Remove brand prefix from title to get version
    let version = titleText.replace(new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim() || titleText;
    // Remove color suffix if present (colors from KV will be extracted later)
    // Common patterns: "Bleu foncé métal", "Gris médium métal", "Noir", "Blanc nacré"
    const colorSuffixPattern = /\s+(Noir|Blanc|Bleu|Rouge|Gris|Vert|Jaune|Orange|Marron|Beige|Argent|Bronze|Bordeaux|Violet)[\wéèêëàâäôöùûüïîç\s]*$/i;
    version = version.replace(colorSuffixPattern, '').trim();
    const model = extractModel(version);

    // ── Reference (from subtitle line "2021 - 72429 km ... Ref. : 11396385") ──
    const bodyText = (doc.body as HTMLElement).innerText || doc.body.textContent || '';
    const refMatch = bodyText.match(/Ref\.?\s*:?\s*(\d{7,})/i);
    const reference = refMatch?.[1] || '';

    // ── Year / mileage from subtitle line or kv ──
    // Subtitle: "2021 - 72429 km  Vente à partir de 11:00  Ref. : 11396385"
    const subtitleMatch = bodyText.match(/(\d{4})\s*[-–]\s*([\d\s]+)\s*km/i);
    const yearFromSubtitle = subtitleMatch ? parseInt(subtitleMatch[1]) : 0;
    const mileageFromSubtitle = subtitleMatch ? parseInt(subtitleMatch[2].replace(/\s/g, '')) : 0;

    // ── Specs from key/value pairs ──
    const year         = parseYear(kv['année'] || kv['annee'] || kv['mise en circulation'] || '') || yearFromSubtitle;
    const mileage      = parseKm(kv['kilométrage'] || kv['kilometrage'] || '') || mileageFromSubtitle;
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
    // VPauto shows "Mise à prix¹" with a footnote superscript, then "19400 €" on next line
    // Use a targeted approach: find the price amount near "Mise à prix"
    const startingPrice  = parsePriceFromPage(bodyText);
    const startingPriceHT = parsePrice(bodyText, /(?:[\d\s]+),?\d*\s*€\s*HT|(\d[\d\s]*)\s*€\s*HT/i)
      || parsePrice(bodyText, /([\d\s]+),?\d*\s*€\s*HT/i);
    const marketValue    = parseLabelledPrice(bodyText, 'cote');
    const newPrice       = parseLabelledPrice(bodyText, 'prix neuf');
    const vatRecoverable = /tva\s*:\s*oui|tva\s+récupérable|tva\s+recuperable/i.test(bodyText);

    // ── Sale info ──
    const city       = extractCity(kv, bodyText);
    const department = bodyText.match(/\b(\d{2,3})\s*[-–]\s*[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜ]/)?.[1];
    const saleDate   = extractSaleDate(kv, bodyText);
    const saleTime   = bodyText.match(/(\d{1,2}h\d{2})/)?.[1];
    const lotNumber  = parseInt(bodyText.match(/lot\s+n°?\s*(\d+)/i)?.[1] || '0') || undefined;

    // ── Condition ──
    const technicalCheckUrl = (doc.querySelector('a[href*="_CT.pdf"]') as HTMLAnchorElement)?.href;
    const conditionImageUrl = (doc.querySelector('img[src*="_ET."]') as HTMLImageElement)?.src;
    const isNonRoulant      = /non\s*roulant|hors\s*d[''\u2019]usage|[eé]pave|accident[eé]/i.test(bodyText);
    const baseObservations  = extractObservations(doc.body);
    const observations      = isNonRoulant
      ? (baseObservations ? `Véhicule non roulant | ${baseObservations}` : 'Véhicule non roulant')
      : baseObservations;
    const maintenanceStatus = kv['entretien'] || undefined;
    const serviceHistory    = /carnet.*oui|oui.*carnet/i.test(bodyText) || undefined;
    const firstOwner        = /1[eè]re?\s*main|premi[eè]re?\s*main/i.test(bodyText) || undefined;
    const warranty          = kv['garantie'] || undefined;
    const equipment         = extractEquipment(doc.body);

    // ── Photos ──
    // CDN pattern: cdn.vpauto.fr/{hash}_{number}-80.jpg (e.g. YbUnrKP_01-80.jpg)
    const photoUrls: string[] = [];
    const cdnHashes = new Set<string>();
    for (const img of doc.querySelectorAll<HTMLImageElement>('img[src*="cdn.vpauto.fr"]')) {
      const src = img.src;
      if (src.includes('_ET.') || src.includes('_CT')) continue;
      if (!photoUrls.includes(src)) photoUrls.push(src);
      const m = src.match(/cdn\.vpauto\.fr\/([^_/]+)/);
      if (m) cdnHashes.add(m[1]);
    }
    const cdnHash = [...cdnHashes][0];

    // ── Status & sold price ──
    // IMPORTANT: Check NEGATIVE ("n'a pas été adjugé") BEFORE positive ("adjugé")
    // because the word "adjugé" appears in both cases
    let status: VehicleStatus = 'available';
    let soldPrice: number | undefined;

    if (UNSOLD_TEXT_RE.test(bodyText)) {
      // "Ce véhicule n'a pas été adjugé." → unsold
      status = 'unsold';
    } else if (/adjug[eé]/i.test(bodyText)) {
      // "ADJUGÉ 24300 €" or "Véhicule adjugé\n24300 €" → sold
      status = 'sold';
      const adjugeMatch = bodyText.match(/adjug[eé][\s\S]{0,30}?([\d][\d\s]*)\s*€/i);
      if (adjugeMatch) {
        soldPrice = parseInt(adjugeMatch[1].replace(/\s/g, ''));
      }
    } else if (/vente\s+en\s+cours|ench[eè]re\s+en\s+cours/i.test(bodyText)) {
      status = 'auction_live';
    }

    // Build snapshot, stripping undefined/null optional fields to avoid Zod issues
    const snapshot: VehicleSnapshot = {
      reference, hashId, brand, model, version,
      year, mileage, color, fuel, transmission,
      city: city || '', center: city || '',
      photoUrls, sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      status, vatRecoverable,
    };
    // Only add optional fields if they have actual values
    if (engineSize) snapshot.engineSize = engineSize;
    if (power) snapshot.power = power;
    if (fiscalPower) snapshot.fiscalPower = fiscalPower;
    if (doors) snapshot.doors = doors;
    if (seats) snapshot.seats = seats;
    if (co2) snapshot.co2 = co2;
    if (critair) snapshot.critair = critair;
    if (euroStandard) snapshot.euroStandard = euroStandard;
    if (bodyType) snapshot.bodyType = bodyType;
    if (startingPrice) snapshot.startingPrice = startingPrice;
    if (startingPriceHT) snapshot.startingPriceHT = startingPriceHT;
    if (marketValue) snapshot.marketValue = marketValue;
    if (newPrice) snapshot.newPrice = newPrice;
    if (department) snapshot.department = department;
    if (saleDate) snapshot.saleDate = saleDate;
    if (saleTime) snapshot.saleTime = saleTime;
    if (lotNumber) snapshot.lotNumber = lotNumber;
    if (technicalCheckUrl) snapshot.technicalCheckUrl = technicalCheckUrl;
    if (conditionImageUrl) snapshot.conditionImageUrl = conditionImageUrl;
    if (observations) snapshot.observations = observations;
    if (maintenanceStatus) snapshot.maintenanceStatus = maintenanceStatus;
    if (serviceHistory !== undefined) snapshot.serviceHistory = serviceHistory;
    if (firstOwner !== undefined) snapshot.firstOwner = firstOwner;
    if (warranty) snapshot.warranty = warranty;
    if (equipment?.length) snapshot.equipment = equipment;
    if (cdnHash) snapshot.cdnHash = cdnHash;
    if (soldPrice) snapshot.soldPrice = soldPrice;

    return snapshot;
  } catch (err) {
    console.error('[VPauto] scrapeVehicleDetailFromDocument error:', err);
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
  // The first all-caps word (2+ chars) in the title is the brand
  // e.g. "TESLA MODEL 3 Standard Range Plus RWD Bleu foncé métal" → "TESLA"
  // e.g. "MV AGUSTA DRAGSTER 800 RR" → "MV" (we'll catch multi-word brands below)
  const words = title.split(/\s+/);
  // Check for multi-word brands first
  const twoWord = (words[0] + ' ' + words[1]).toUpperCase();
  const multiWordBrands = ['MV AGUSTA', 'LAND ROVER', 'ALFA ROMEO', 'ASTON MARTIN', 'CAN-AM'];
  for (const mb of multiWordBrands) {
    if (title.toUpperCase().startsWith(mb)) return mb;
  }
  return words.find(w => w === w.toUpperCase() && w.length > 1 && /^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ0-9-]+$/.test(w)) || words[0];
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

/**
 * Extract a price that follows a label like "Cote² : 27600 €" or "Prix neuf³ : 41350 €"
 * Uses line-by-line approach to handle footnote superscripts correctly.
 * Also handles "NC" (non communiqué) → returns undefined.
 */
function parseLabelledPrice(bodyText: string, label: string): number | undefined {
  const lines = bodyText.split('\n');
  const labelRe = new RegExp(label, 'i');

  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;

    // Try same line: "Cote² : 27600 €" or "Prix neuf³ : 41350 €"
    const sameLine = lines[i].match(new RegExp(label + '[^:]*:\\s*([\\d][\\d\\s]*)\\s*€', 'i'));
    if (sameLine) {
      const val = parseInt(sameLine[1].replace(/\s/g, ''));
      if (val > 0) return val;
    }

    // Also try: label on one line, price on next
    for (let j = i; j <= i + 2 && j < lines.length; j++) {
      const line = lines[j].trim();
      const m = line.match(/^([\d][\d\s]*)\s*€/);
      if (m) {
        const val = parseInt(m[1].replace(/\s/g, ''));
        if (val > 0) return val;
      }
    }
  }
  return undefined;
}

/**
 * Extract the "Mise à prix" amount from VPauto detail page.
 *
 * The page shows "Mise à prix¹" with a footnote superscript <sup>1</sup>,
 * and the actual price "6500 €" is on the NEXT line in innerText.
 *
 * Using a line-by-line approach to avoid the footnote "1" being
 * concatenated with the price digits (e.g. "16500" instead of "6500").
 */
function parsePriceFromPage(bodyText: string): number | undefined {
  const lines = bodyText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (/mise\s*(?:à|a)\s*prix/i.test(lines[i])) {
      // Found "Mise à prix" line. The actual price is on a SUBSEQUENT line.
      // The current line may end with a footnote digit like "Mise à prix1"
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line) continue;
        // Match "6500 €" or "6 500 €" or "19400€"
        const m = line.match(/^([\d][\d\s]*)\s*€/);
        if (m) {
          return parseInt(m[1].replace(/\s/g, ''));
        }
      }

      // Fallback: price on the SAME line as "Mise à prix", e.g. "Mise à prix 6500€"
      const sameLine = lines[i].match(/mise\s*(?:à|a)\s*prix\s+([\d][\d\s]*)\s*€/i);
      if (sameLine) {
        return parseInt(sameLine[1].replace(/\s/g, ''));
      }
    }
  }

  return undefined;
}

function extractCity(kv: Record<string, string>, bodyText: string): string {
  const from_kv = kv['lieu de vente'] || kv['centre'] || kv['localisation'] || '';
  if (from_kv) return from_kv.replace(/^\d+\s*[-–]\s*/, '').trim();
  // VPauto shows "59 - LILLE" or "33 - BORDEAUX" near "Localisation"
  const locMatch = bodyText.match(/Localisation\s*(\d{2,3})\s*[-–]\s*([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]+)/i);
  if (locMatch) return locMatch[2].charAt(0) + locMatch[2].slice(1).toLowerCase();
  // Fallback: look for "DEPT - CITY" pattern anywhere
  const deptCity = bodyText.match(/\b(\d{2})\s*[-–]\s*([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]{3,})\b/);
  if (deptCity) return deptCity[2].charAt(0) + deptCity[2].slice(1).toLowerCase();
  // Last resort: known city names
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

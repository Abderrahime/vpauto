import type { VehicleSnapshot, VehicleStatus } from '@vpauto/shared';
import { VPAUTO_BASE_URL, VPAUTO_VEHICLE_URL_PATTERN } from '@vpauto/shared';

const UNSOLD_TEXT_RE = /n[''\u2019]a\s*pas\s*[eé]t[eé]\s*adjug[eé]|pas\s*[eé]t[eé]\s*adjug[eé]|pas\s*adjug[eé]|non\s*adjug[eé]|invendu|apr[eè]s[\s-]*vente|ordre\s+d[''\u2019]achat\s+d[''\u2019]apr[eè]s[\s-]*vente/i;
const REMOTE_FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = REMOTE_FETCH_TIMEOUT_MS): Promise<Response> {
  if (init.signal) {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Strict "véhicule non roulant" detector.
 *
 * Previous regex `/non\s*roulant|hors\s*d'usage|[eé]pave|accident[eé]/i`
 * was too permissive: phrases like "véhicule non accidenté", "pas d'épave
 * déclarée", or a legal disclaimer mentioning "épave" would falsely flag
 * a healthy car. We require VPauto's canonical phrasing (a "véhicule"
 * qualifier before the state descriptor, or the explicit "NON ROULANT"
 * status label) to avoid the false positive that was sending thousands
 * of normal cars down the 100 € non-roulant branch.
 */
const NON_ROULANT_RE = /v[ée]hicule\s+non\s*roulant\b|v[ée]hicule\s+hors\s+d['\u2019]\s*usage\b|v[ée]hicule\s+[eé]pave\b|v[ée]hicule\s+accident[eé]\b|(?:^|\s)NON\s+ROULANT\b|mention\s+[eé]pave\b|\bstatut\s*:\s*[eé]pave\b/;
function isVehiculeNonRoulant(bodyText: string): boolean {
  return NON_ROULANT_RE.test(bodyText);
}

/**
 * "Mise à prix" call-to-action buttons (not actual prices).
 *
 * When VPauto hasn't published the MAP yet for an upcoming auction, the
 * page/card shows a CTA button like "RECEVOIR LA MISE À PRIX" instead of
 * the value. We must NOT match this as a price label — or we'd latch onto
 * whatever € amount is nearest (typically the Cote or Prix neuf rendered
 * on the same card) and store it as the MAP. Used by both the detail-page
 * `parsePriceFromPage` and the list-card last-resort fallback.
 */
const MAP_CTA_RE = /\b(?:recevoir|demander|obtenir|voir|consulter|acc[eé]der(?:\s+[aà])?)\s+(?:la\s+)?mise\s*(?:à|a)\s*prix/i;

/**
 * Reject VPauto's "Mise à prix: 100 €" placeholder.
 *
 * Observed in Nantes 20/04/26 auction (ref 11402222 Kodiaq, 11406192 Ioniq 5,
 * and 64 others): when a seller has not published a real MAP before the
 * auction goes live, VPauto's list card starts displaying "Mise à prix 100 €"
 * (the legal minimum) as a placeholder, next to the real "Enchère en cours
 * 35 500 €". The scraper had no way to tell this 100 € apart from a real
 * scooter/épave MAP, so it was stored as the lot's starting price — wildly
 * misleading the user.
 *
 * Rule (matches the Phase C-2 DB cleanup thresholds so scraper and DB agree):
 * if `startingPrice === 100` AND any of the same-card discriminators shows
 * the lot is clearly above that level, we treat the 100 as a placeholder
 * and drop it. The user then sees "Mise à prix : Inconnue" with the real
 * live bid rendered separately as "Enchère en cours".
 *
 *   currentAuctionPrice ≥ 500   — live bid past a 100 € scooter ceiling
 *   soldPrice           ≥ 500   — final hammer past a 100 € scooter ceiling
 *   marketValue         ≥ 1000  — Cote betrays a valuable car
 *   newPrice            ≥ 1000  — Prix neuf betrays a valuable car
 *
 * Conservative: a real 100 € scooter/épave MAP (currentAuctionPrice < 500
 * and no cote) is preserved intact.
 */
const MAP_PLACEHOLDER_VALUE = 100;
const MAP_LIVE_BID_FLOOR = 500;
const MAP_VALUATION_FLOOR = 1000;

function isSpuriousStartingPrice(
  startingPrice: number | undefined,
  signals: {
    currentAuctionPrice?: number;
    soldPrice?: number;
    marketValue?: number;
    newPrice?: number;
  },
): boolean {
  if (startingPrice !== MAP_PLACEHOLDER_VALUE) return false;
  if ((signals.currentAuctionPrice ?? 0) >= MAP_LIVE_BID_FLOOR) return true;
  if ((signals.soldPrice ?? 0) >= MAP_LIVE_BID_FLOOR) return true;
  if ((signals.marketValue ?? 0) >= MAP_VALUATION_FLOOR) return true;
  if ((signals.newPrice ?? 0) >= MAP_VALUATION_FLOOR) return true;
  return false;
}

// Re-exported for the backend's write-path defense-in-depth and for unit tests.
export { isSpuriousStartingPrice };

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
    const res = await fetchWithTimeout(pageUrl, { credentials: 'include' });
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

// ── Vehicle detail document probe (CT + BE + SE + Diagnostic batterie) ─────

export type VehicleDocProbeResult = {
  ctUrl: string | null;
  bilanExpertUrl: string | null;
  suiviEntretienUrl: string | null;
  diagnosticBatterieUrl: string | null;
  hasCt: boolean;
  hasBilanExpert: boolean;
  hasSuiviEntretien: boolean;
  hasDiagnosticBatterie: boolean;
  /**
   * Raw-text content extracted from three dedicated sections on the detail
   * page. Stored as a single joined string with `\n` separators between
   * bullet items. `null` means the section wasn't found on the page
   * (vs empty string which would mean an empty but present section).
   */
  observationsText: string | null;
  equipmentText: string | null;
  technicalSpecsText: string | null;
  hasObservationsText: boolean;
  hasEquipmentText: boolean;
  hasTechnicalSpecsText: boolean;
  probedAt: string;
};

/**
 * Extract document URLs (Contrôle Technique, Bilan Expert, Suivi d'Entretien,
 * Diagnostic batterie) from a parsed VPauto vehicle detail Document.
 *
 * VPauto structure observed (April 2026):
 *   <h2>Etat du véhicule</h2>
 *   <ul class="liens00">
 *     <li><a href=".../{hash}_CT.pdf">Contrôle Technique</a></li>
 *     <li><a href=".../{hash}_BE.pdf">Bilan Expert</a></li>
 *     <li><a href=".../{hash}_SE.pdf">Suivi d'Entretien</a></li>
 *     <li><a href=".../{hash}_TB.pdf">Diagnostic batterie</a></li>
 *   </ul>
 *
 * Any item may be absent. Absence of a given suffix is a reliable signal
 * that the corresponding document is not on file for that vehicle (verified
 * empirically: `_TB.pdf` only appears on EVs, `_CT.pdf` absent on some EVs
 * and <4-year-old cars, `_SE.pdf` correlates with the "Oui/Non" meta field).
 */
export function extractVehicleDocsFromDocument(doc: Document): VehicleDocProbeResult {
  // We use getAttribute('href') rather than `.href` because DOMParser-created
  // documents have no base URI — `.href` can return weird resolved values
  // for some attribute serialisations. The CDN URLs we look for are
  // always absolute (`https://cdn.vpauto.fr/...`), so the literal value
  // is exactly what we want.
  const allLinks = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));

  // Generic extractor: primary by href pattern, fallback by visible text.
  const findDoc = (
    hrefPattern: RegExp,
    textPattern: RegExp,
  ): string | null => {
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      if (hrefPattern.test(href)) return href;
    }
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      if (!/\.pdf(?:\?|$)/i.test(href)) continue;
      const text = (a.textContent || '').trim();
      if (textPattern.test(text)) return href;
    }
    return null;
  };

  const ctUrl = findDoc(/_CT\.pdf(?:\?|$)/i, /contr[oô]le\s*technique/i);
  const bilanExpertUrl = findDoc(/_BE\.pdf(?:\?|$)/i, /bilan\s*expert/i);
  const suiviEntretienUrl = findDoc(/_SE\.pdf(?:\?|$)/i, /suivi\s*d['’]?\s*entretien/i);
  const diagnosticBatterieUrl = findDoc(/_TB\.pdf(?:\?|$)/i, /diagnostic\s*batterie/i);

  // ── Extract three text-only sections ───────────────────────────────────
  // VPauto renders these as a <h2> heading followed by a <ul><li>…</li></ul>.
  // There are no stable class/id hooks, so we locate each section by
  // matching the heading text (case + accent insensitive) and then
  // collect the immediately-following list items.
  const observationsText = extractSectionText(doc, /^\s*observation/i);
  const equipmentText = extractSectionText(doc, /^\s*[eé]quipements?\s*[/\-]?\s*options?/i);
  const technicalSpecsText = extractSectionText(doc, /^\s*caract[eé]ristiques?\s*techniques?/i);

  return {
    ctUrl,
    bilanExpertUrl,
    suiviEntretienUrl,
    diagnosticBatterieUrl,
    hasCt: !!ctUrl,
    hasBilanExpert: !!bilanExpertUrl,
    hasSuiviEntretien: !!suiviEntretienUrl,
    hasDiagnosticBatterie: !!diagnosticBatterieUrl,
    observationsText,
    equipmentText,
    technicalSpecsText,
    hasObservationsText: !!observationsText && observationsText.trim().length > 0,
    hasEquipmentText: !!equipmentText && equipmentText.trim().length > 0,
    hasTechnicalSpecsText: !!technicalSpecsText && technicalSpecsText.trim().length > 0,
    probedAt: new Date().toISOString(),
  };
}

/**
 * Find a <h2>/<h3>/<h4> whose text matches `headingRe` and return the
 * visible text of the following <ul>/<ol>/<dl>/<p> block, joined with
 * newlines between list items. Returns null if no matching heading is found.
 *
 * VPauto detail-page layout (April 2026):
 *   <h2>Observation(s)</h2>
 *   <ul>
 *     <li>- Export impossible — …</li>
 *     <li>- Garantie 3 mois …</li>
 *   </ul>
 * Same shape for "Equipements/Options" and "Caractéristiques techniques".
 */
function extractSectionText(doc: Document, headingRe: RegExp): string | null {
  // Normalize a string: strip accents, collapse whitespace, lowercase.
  const normalize = (s: string) => s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const headingReNorm = new RegExp(
    headingRe.source
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
    headingRe.flags,
  );

  const headings = Array.from(doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
  for (const h of headings) {
    const text = normalize(h.textContent || '');
    if (!headingReNorm.test(text)) continue;

    // Walk siblings forward to find the first list/paragraph block.
    // Stops at the next heading so we don't bleed into another section.
    const items: string[] = [];
    let sib: Element | null = h.nextElementSibling;
    while (sib) {
      const tag = sib.tagName.toUpperCase();
      if (/^H[1-6]$/.test(tag)) break;

      if (tag === 'UL' || tag === 'OL') {
        sib.querySelectorAll('li').forEach((li) => {
          const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) items.push(t);
        });
        break;
      }

      if (tag === 'DL') {
        const dts = sib.querySelectorAll('dt');
        dts.forEach((dt) => {
          const dd = dt.nextElementSibling;
          const k = (dt.textContent || '').replace(/\s+/g, ' ').trim();
          const v = dd?.tagName === 'DD'
            ? (dd.textContent || '').replace(/\s+/g, ' ').trim()
            : '';
          if (k && v) items.push(`${k} : ${v}`);
          else if (k) items.push(k);
        });
        break;
      }

      if (tag === 'TABLE') {
        sib.querySelectorAll('tr').forEach((tr) => {
          const cells = Array.from(tr.children).map(
            (c) => (c.textContent || '').replace(/\s+/g, ' ').trim(),
          ).filter(Boolean);
          if (cells.length === 2) items.push(`${cells[0]} : ${cells[1]}`);
          else if (cells.length > 0) items.push(cells.join(' | '));
        });
        break;
      }

      if (tag === 'P' || tag === 'DIV') {
        // Some sections are plain text paragraphs; collect until we hit a
        // heading, list, or another block-level container with lots of
        // unrelated content.
        const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) items.push(t);
        // If this DIV contains a nested UL, dig into it.
        const nestedUl = sib.querySelector('ul, ol');
        if (nestedUl) {
          nestedUl.querySelectorAll('li').forEach((li) => {
            const lt = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (lt) items.push(lt);
          });
          break;
        }
      }

      sib = sib.nextElementSibling;
    }

    if (items.length === 0) {
      // Fallback: dig inside the heading's parent container (some layouts
      // wrap the <h2> and <ul> in a shared <div> rather than siblings).
      const parent = h.parentElement;
      if (parent) {
        const nestedList = parent.querySelector('ul, ol, dl');
        if (nestedList) {
          nestedList.querySelectorAll('li').forEach((li) => {
            const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) items.push(t);
          });
        }
      }
    }

    if (items.length === 0) return null;

    // Deduplicate while preserving order (some VPauto pages duplicate items).
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const it of items) {
      const key = it.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
    }

    return deduped.join('\n');
  }

  return null;
}

/**
 * Fetch a VPauto vehicle detail page and probe for CT + Bilan Expert links.
 * Returns null on network error. Used by list card enhancement.
 */
export async function probeVehicleDocuments(detailPageUrl: string): Promise<VehicleDocProbeResult | null> {
  try {
    const res = await fetchWithTimeout(detailPageUrl, { credentials: 'include' });
    if (!res.ok) {
      console.warn(`[VPauto] probeVehicleDocuments: HTTP ${res.status} for ${detailPageUrl}`);
      return null;
    }
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const result = extractVehicleDocsFromDocument(doc);
    console.log(`[VPauto] probe ${detailPageUrl} → CT=${result.hasCt} BE=${result.hasBilanExpert} SE=${result.hasSuiviEntretien} TB=${result.hasDiagnosticBatterie}`);
    return result;
  } catch (err) {
    console.warn(`[VPauto] probeVehicleDocuments error for ${detailPageUrl}:`, err);
    return null;
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

      // ── Starting price (Mise à prix) ──
      // Explicitly pattern-matched on the "Mise à prix" label to avoid
      // accidentally capturing the ADJUGÉ sold price or the live bid.
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

      // ── Live auction bid ("Enchère en cours") ──
      // Bug #1 fix: list cards for live auctions show "Enchère en cours
      // 28 000 €" instead of (or next to) "Mise à prix". Before this fix,
      // the fallback below captured that live-bid value as `startingPrice`,
      // which the sidepanel then displayed as "MISE A PRIX 28 000 €" even
      // though the true MAP was different. Route it to currentAuctionPrice.
      let currentAuctionPrice: number | undefined;
      for (const text of childTexts) {
        const live = text.replace(/\s/g, '').match(/[Ee]nch[eè]reencours([\d]+)€?/);
        if (live) {
          currentAuctionPrice = parseInt(live[1]);
          break;
        }
      }
      if (currentAuctionPrice === undefined) {
        const live = fullText.replace(/\s/g, '').match(/[Ee]nch[eè]reencours([\d]+)€/);
        if (live) currentAuctionPrice = parseInt(live[1]);
      }

      // Last resort for startingPrice: take a price that is NOT from an
      // ADJUGÉ, "Enchère en cours", Cote, Prix neuf, or Estimation section.
      //
      // BUG FIX (Qashqai-like cards): when the MAP hasn't been published,
      // VPauto shows a CTA "RECEVOIR LA MISE À PRIX" and the only € amounts
      // on the card are the Cote / Prix neuf / Estimation. Without these
      // guards, the fallback used to latch onto the Cote (e.g. 28 500 €)
      // and store it as startingPrice — completely wrong. If we detect a
      // "recevoir la mise à prix" CTA anywhere on the card, we refuse to
      // guess a MAP and leave startingPrice undefined.
      const hasMapCta = childTexts.some((t) => MAP_CTA_RE.test(t)) || MAP_CTA_RE.test(fullText);
      if (startingPrice === undefined && !hasMapCta) {
        for (const text of childTexts) {
          if (/adjug[eé]/i.test(text)) continue;
          if (/ench[eè]re\s+en\s+cours/i.test(text)) continue;
          if (/cote\b|prix\s+neuf|estimation/i.test(text)) continue;
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
      // Uses the strict detector so FAQ/legal blurb or "non accidenté"
      // phrasing no longer triggers a false positive (Bug: 1449 vehicles
      // had been falsely tagged non-roulant with 100 € MAP).
      const isNonRoulant = isVehiculeNonRoulant(fullText);
      const observations = isNonRoulant ? 'Véhicule non roulant' : '';

      // ── Extract identity discriminators from the card ──
      // When the list page exposes the VPauto reference (e.g. "Ref. : 11404642")
      // or the engine power ("75 ch") or the transmission code ("BVA8"),
      // persisting them alongside the hashId prevents the Bug #3 pollution
      // where a list-only Vehicle row with reference=null was later merged
      // with a different detail-page car by the attribute-only matcher.
      const refMatch = fullText.match(/Ref\.?\s*:?\s*(\d{7,})/i);
      const reference = refMatch?.[1] || undefined;

      const powerMatch = fullText.match(/(\d{2,4})\s*ch\b/i);
      const power = powerMatch ? parseInt(powerMatch[1]) : undefined;

      // Recognise VPauto transmission abbreviations. We keep the matched
      // string as-is (e.g. "BVA8", "DCT7") so downstream equality checks
      // stay consistent with the detail scraper's `kv['boîte']` values.
      const transMatch = fullText.match(/\b(BVA\d?|BVM\d?|EAT\d|DCT\d?|DSG\d?|CVT|PDK\d?|TCT\d?|BVR\d?)\b/i);
      const transmission = transMatch ? transMatch[1].toUpperCase() : '';

      // Nantes 20/04/26 regression: VPauto started showing "Mise à prix 100 €"
      // as a placeholder when the seller never published a real MAP and the
      // auction is live. Reject the 100 € MAP whenever the same card's
      // `currentAuctionPrice`/`soldPrice` proves it can't be a real scooter-
      // level MAP. See isSpuriousStartingPrice() for the full rule set.
      const scrubbedStartingPrice = isSpuriousStartingPrice(startingPrice, {
        currentAuctionPrice,
        soldPrice,
      })
        ? undefined
        : startingPrice;

      // ── Contrôle Technique badge ──
      // VPauto list cards expose a binary CT pill ("CT disponible" green /
      // "CT indisponible" red) next to the "Actions" button. The pill is
      // typically rendered OUTSIDE the `<a>` link wrapper (inside the same
      // card container, but as a sibling div), so reading from `fullText`
      // alone misses it. Walk up to the closest plausible card root and
      // search there. Order matters: check "indisponible" first because
      // "disponible" is a substring of it.
      const cardRoot = a.closest('article, li, [class*="card"], [class*="vehicule"], [class*="lot"]') || a.parentElement;
      const ctSearchText = cardRoot?.textContent || fullText;
      let ctAvailable: boolean | null | undefined;
      if (/CT\s+indisponible/i.test(ctSearchText)) {
        ctAvailable = false;
      } else if (/CT\s+disponible/i.test(ctSearchText)) {
        ctAvailable = true;
      }

      const vehicle: Partial<VehicleSnapshot> = {
        hashId, brand, model, version: model,
        year, mileage, city, lotNumber,
        startingPrice: scrubbedStartingPrice,
        photoUrls: img ? [img] : [], cdnHash,
        sourceUrl: `${VPAUTO_BASE_URL}${href}`,
        fuel: '', transmission, color: '',
        vatRecoverable: false,
        scrapedAt: new Date().toISOString(),
        status,
      };
      if (reference) vehicle.reference = reference;
      if (power) vehicle.power = power;
      if (currentAuctionPrice) vehicle.currentAuctionPrice = currentAuctionPrice;
      if (soldPrice) vehicle.soldPrice = soldPrice;
      if (observations) vehicle.observations = observations;
      if (ctAvailable !== undefined) vehicle.ctAvailable = ctAvailable;

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
    const rawStartingPrice     = parsePriceFromPage(bodyText);
    // Live auction: "Enchère en cours 5 400 €" — distinct from MAP.
    const currentAuctionPrice  = parseCurrentAuctionPrice(bodyText);
    const startingPriceHT = parsePrice(bodyText, /(?:[\d\s]+),?\d*\s*€\s*HT|(\d[\d\s]*)\s*€\s*HT/i)
      || parsePrice(bodyText, /([\d\s]+),?\d*\s*€\s*HT/i);
    const marketValue    = parseLabelledPrice(bodyText, 'cote');
    const newPrice       = parseLabelledPrice(bodyText, 'prix neuf');
    const vatRecoverable = /tva\s*:\s*oui|tva\s+récupérable|tva\s+recuperable/i.test(bodyText);

    // Reject VPauto's "Mise à prix 100 €" placeholder that appears on live
    // auction pages when the seller never published a real MAP. See the
    // isSpuriousStartingPrice() helper for the full rule set. We compute
    // soldPrice below; pre-check only the signals already resolved here,
    // then re-check after soldPrice is known and drop again if needed.
    let startingPrice = isSpuriousStartingPrice(rawStartingPrice, {
      currentAuctionPrice,
      marketValue,
      newPrice,
    })
      ? undefined
      : rawStartingPrice;

    // ── Sale info ──
    const city       = extractCity(kv, bodyText);
    const department = bodyText.match(/\b(\d{2,3})\s*[-–]\s*[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜ]/)?.[1];
    const saleDate   = extractSaleDate(kv, bodyText);
    const saleTime   = bodyText.match(/(\d{1,2}h\d{2})/)?.[1];
    const lotNumber  = parseInt(bodyText.match(/lot\s+n°?\s*(\d+)/i)?.[1] || '0') || undefined;

    // ── Condition ──
    const technicalCheckUrl = (doc.querySelector('a[href*="_CT.pdf"]') as HTMLAnchorElement)?.href;
    const conditionImageUrl = (doc.querySelector('img[src*="_ET."]') as HTMLImageElement)?.src;
    const isNonRoulant      = isVehiculeNonRoulant(bodyText);
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

    // Second-pass MAP scrub once soldPrice is resolved: reject a lingering
    // 100 € placeholder when the final hammer price is above the scooter
    // ceiling. We already dropped the MAP on the first pass for live bids
    // and cote/prix-neuf evidence; this pass catches sold-page cases.
    if (isSpuriousStartingPrice(startingPrice, {
      currentAuctionPrice,
      soldPrice,
      marketValue,
      newPrice,
    })) {
      startingPrice = undefined;
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
    if (currentAuctionPrice) snapshot.currentAuctionPrice = currentAuctionPrice;
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
 *
 * BUG FIX (100 € anomaly): We now collect ALL candidates and return the
 * MAX. VPauto pages sometimes include a FAQ/legal blurb with a phrase like
 * "la mise à prix démarre à 100 €" before the real MAP block. The previous
 * version picked the first match and returned 100 € for thousands of
 * healthy cars. The real MAP is always the higher of the two (a legal
 * minimum is, by definition, lower than the actual seller's reserve).
 * When there's only one match, we return it as-is so genuinely cheap
 * lots (scooter, épave) retain their legitimate 100 € MAP.
 *
 * BUG FIX (CTA button): when the MAP hasn't been published yet (upcoming
 * auction), VPauto shows a CTA button "RECEVOIR LA MISE À PRIX" instead
 * of the price. Our regex used to match that button text, then grab the
 * next nearby € amount — which was actually the Cote or Prix neuf on the
 * rendered card. We now skip any line whose "mise à prix" appears inside
 * a call-to-action verb (recevoir / demander / obtenir / voir / consulter).
 * See MAP_CTA_RE at the top of the file.
 */
function parsePriceFromPage(bodyText: string): number | undefined {
  const lines = bodyText.split('\n');
  const candidates: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/mise\s*(?:à|a)\s*prix/i.test(lines[i])) continue;
    // Skip CTA button "RECEVOIR LA MISE À PRIX" (unpublished MAP — would
    // otherwise latch onto the Cote/Prix-neuf € amount nearby on the card).
    if (MAP_CTA_RE.test(lines[i])) continue;

    let found = false;
    // Price on a subsequent line (most common VPauto layout)
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      const m = line.match(/^([\d][\d\s]*)\s*€/);
      if (m) {
        const val = parseInt(m[1].replace(/\s/g, ''));
        if (val > 0) {
          candidates.push(val);
          found = true;
          break;
        }
      }
    }
    if (found) continue;

    // Fallback: price on the SAME line, e.g. "Mise à prix 6500€"
    const sameLine = lines[i].match(/mise\s*(?:à|a)\s*prix[^\d\n]{0,40}?([\d][\d\s]*)\s*€/i);
    if (sameLine) {
      const val = parseInt(sameLine[1].replace(/\s/g, ''));
      if (val > 0) candidates.push(val);
    }
  }

  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

/**
 * Extract the "Enchère en cours" amount from VPauto detail page.
 *
 * Distinct from "Mise à prix": during a live auction, VPauto shows the
 * current highest bid as "Enchère en cours¹ 5 400 €" above or next to the
 * "Mise à prix¹" block. Before this was extracted, the MAP parser would
 * sometimes pick up the live bid as the MAP — polluting the price history
 * chart and displaying a misleading "MISE À PRIX: 5 400 €" in the sidepanel
 * for a car whose real MAP was 6 000 €.
 */
function parseCurrentAuctionPrice(bodyText: string): number | undefined {
  const lines = bodyText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/ench[eè]re\s+en\s+cours/i.test(lines[i])) continue;

    // Price on a subsequent line
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      const m = line.match(/^([\d][\d\s]*)\s*€/);
      if (m) {
        const val = parseInt(m[1].replace(/\s/g, ''));
        if (val > 0) return val;
      }
    }

    // Fallback: same line, e.g. "Enchère en cours 5400 €"
    const sameLine = lines[i].match(/ench[eè]re\s+en\s+cours[^\d\n]{0,40}?([\d][\d\s]*)\s*€/i);
    if (sameLine) {
      const val = parseInt(sameLine[1].replace(/\s/g, ''));
      if (val > 0) return val;
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
  // Fallback regex: match "Le 02/04/26" or "Le 02/04/2026" or standalone date.
  //
  // HAZARD: bodyText on auction_live / detail pages can contain the vehicle's
  // registration date (e.g. "1ère MEC 19/08/2019") long before any real
  // auction date appears. If we naively pick the first DD/MM/YYYY match we end
  // up stamping saleDate = 2019-08-19 on the snapshot, which poisons passage
  // grouping (the snapshot becomes the "canonical" for a phantom ancient
  // passage). See packages/backend/src/history.ts `pickPassageSaleDate` for
  // the backend-side MODE consensus guard. Here we scan ALL DD/MM/YYYY
  // matches in order and return the first one that plausibly corresponds to
  // an auction date: within ~14 days in the past or ~120 days in the future
  // relative to scrape time. Real VPauto auctions are always close to "now".
  const iter = bodyText.matchAll(/(?:Le\s+)?(\d{2}\/\d{2}\/\d{2,4})/gi);
  const nowMs = Date.now();
  const MAX_PAST_MS = 14 * 86_400_000; // 2 weeks — generous for post-auction scrapes
  const MAX_FUTURE_MS = 120 * 86_400_000; // 4 months — auctions are posted ahead
  for (const match of iter) {
    const iso = formatDate(match[1]);
    const t = new Date(`${iso}T00:00:00Z`).getTime();
    if (Number.isNaN(t)) continue;
    const delta = t - nowMs;
    if (delta < -MAX_PAST_MS) continue; // stale — likely a registration/MEC date
    if (delta > MAX_FUTURE_MS) continue; // nonsense — likely an expiration/warranty date
    return iso;
  }
  return undefined;
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

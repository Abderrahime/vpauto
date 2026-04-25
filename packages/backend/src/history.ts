/**
 * Pure helpers for building a vehicle's history (passages, price chart,
 * evolution) from its raw snapshots. Extracted from the /history route so
 * they can be unit-tested without a DB.
 */
import type { VehiclePassage } from '@vpauto/shared';
import { isSpuriousStartingPrice, parsePhotoUrls } from './utils.js';

// Re-export the pure passage→chart/evolution helpers from shared. Keeping
// them re-exported here lets callers of this module (routes, tests) continue
// to treat `history.ts` as the single entry point.
export { buildPriceHistory, computeEvolution } from '@vpauto/shared';

export const HISTORY_OPEN_REASON_STABLE = 'URL historique stable';
export const HISTORY_OPEN_REASON_REUSED = 'URL réutilisée par un passage ultérieur';
export const HISTORY_OPEN_REASON_INTERMEDIATE = 'Snapshot intermédiaire d’un même passage';
export const HISTORY_OPEN_REASON_UNAVAILABLE = 'URL historique indisponible';

export interface SnapshotForHistory {
  id: number;
  hashId: string | null;
  city: string;
  center: string | null;
  status: string;
  saleDate: string | null;
  saleTime: string | null;
  scrapedAt: Date;
  startingPrice: number | null;
  /**
   * Live bid observed at scrape time. Separate dimension from startingPrice
   * (real MAP / reserve) and soldPrice (final hammer). Carried through the
   * history chain so passages can expose a real evolution even when the
   * seller never published a MAP (Toyota Yaris Cross ref 11403878 case).
   */
  currentAuctionPrice: number | null;
  soldPrice: number | null;
  /**
   * Cote (estimated market value) and prix neuf (OEM new price). Only used
   * by the passage-level placeholder scrub to retroactively reject a stored
   * 100 € MAP when a later snapshot in the same passage proves it was
   * VPauto's default placeholder (CITROEN C3 ref 11404446 regression).
   */
  marketValue?: number | null;
  newPrice?: number | null;
  mileage: number;
  lotNumber: number | null;
  observations: string | null;
  technicalCheckUrl: string | null;
  sourceUrl: string;
  photoUrls: string; // JSON array string
}

type Group = { snapshots: SnapshotForHistory[]; canonical: SnapshotForHistory };

function getPassageOrderingDate(snapshot: SnapshotForHistory): string {
  return snapshot.saleDate || snapshot.scrapedAt.toISOString().split('T')[0];
}

/**
 * Consensus saleDate for a group of sibling snapshots (same hashId bucket).
 * Returns the MODE (most frequent non-null saleDate) — robust against a single
 * aberrant saleDate written by a misparsing scrape.
 *
 * Regression: CITROEN C3 ref 11404446 had 11 siblings correctly saying
 * saleDate=2026-04-24 plus 1 sibling saying 2019-08-19 (the car's registration
 * date mis-parsed by the scraper on a live-auction page). The outlier ended up
 * being the canonical (latest scrapedAt) and dragged the whole passage into
 * 2019, producing a phantom "old passage" and breaking the chart evolution.
 *
 * Tie-breaker: when multiple saleDates share the top count, prefer the later
 * date (most recent auction wins over a legacy one). Fallback: canonical's
 * saleDate, then scrapedAt's day.
 */
export function pickPassageSaleDate(
  snaps: SnapshotForHistory[],
  fallback?: SnapshotForHistory,
): string {
  const counts = new Map<string, number>();
  for (const s of snaps) {
    if (!s.saleDate) continue;
    counts.set(s.saleDate, (counts.get(s.saleDate) ?? 0) + 1);
  }
  let mode: string | null = null;
  let modeCount = 0;
  for (const [date, count] of counts) {
    if (count > modeCount || (count === modeCount && mode !== null && date > mode)) {
      mode = date;
      modeCount = count;
    }
  }
  if (mode) return mode;
  if (fallback) return getPassageOrderingDate(fallback);
  if (snaps[0]) return getPassageOrderingDate(snaps[0]);
  return '';
}

/** True while the auction is still ongoing, so `startingPrice` reflects the live reserve. */
function isPreSale(s: SnapshotForHistory): boolean {
  return s.status === 'available' || s.status === 'auction_live';
}

/** Final auction states — once reached, the passage is over. */
function isTerminalStatus(status: string): boolean {
  return status === 'sold' || status === 'unsold';
}

/**
 * Group snapshots into passages.
 *
 * VPauto reuses the same listing URL (hashId) when a vehicle is relisted
 * after a failed or successful auction — same physical car, but the
 * *auction event* is distinct. A naïve grouping by hashId therefore
 * collapses multiple real passages into one, which hides history and
 * "évolution de prix" for any re-sold car (observed on ~617 vehicles).
 *
 * Algorithm (two-phase):
 *   1. Bucket snapshots by hashId (or (city, saleDate) for legacy rows
 *      without hashId) — a bucket is the chain of scrapes for one listing.
 *   2. Walk each bucket chronologically and split on RELIST events:
 *      when a snapshot carries a strictly later saleDate than the last
 *      observed terminal (sold/unsold) state. Snapshots captured after a
 *      sale with the SAME saleDate are treated as post-sale linger and
 *      stay in the same passage.
 *
 * The canonical snapshot per group is the one with a soldPrice (final
 * truth) or otherwise the most recent scrape — never displaced by a
 * later non-sold scrape (which can happen when a listing lingers in the
 * "available" feed after sale).
 */
export function groupSnapshotsIntoPassages(
  snapshots: SnapshotForHistory[],
): Group[] {
  // Phase 1 — bucket by listing identity.
  const buckets = new Map<string, SnapshotForHistory[]>();
  for (const s of snapshots) {
    const key = s.hashId
      ? `hash|${s.hashId}`
      : `loc|${s.city || 'unknown'}|${s.saleDate || s.scrapedAt.toISOString().split('T')[0]}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(s);
    else buckets.set(key, [s]);
  }

  // Phase 2 — within each bucket, split on relist events.
  const groups: Group[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const bySaleDate = getPassageOrderingDate(a).localeCompare(getPassageOrderingDate(b));
      if (bySaleDate !== 0) return bySaleDate;
      return a.scrapedAt.getTime() - b.scrapedAt.getTime();
    });

    let current: SnapshotForHistory[] = [];
    let lastTerminalSaleDate: string | null = null;

    for (const s of bucket) {
      // Split rule: after we've observed a terminal (sold/unsold) snapshot
      // with a known saleDate, any snapshot carrying a STRICTLY LATER
      // saleDate is part of a new passage. This keeps the Audi A4 case
      // (same auction rescheduled, no intervening terminal) as ONE passage,
      // while correctly splitting the Symbioz case (sold then relisted)
      // into TWO. Null saleDate → conservative: stay in the current passage.
      const shouldSplit =
        lastTerminalSaleDate !== null &&
        s.saleDate != null &&
        s.saleDate > lastTerminalSaleDate;

      if (shouldSplit) {
        groups.push(makeGroupFromChain(current));
        current = [];
        lastTerminalSaleDate = null;
      }

      current.push(s);
      if (isTerminalStatus(s.status) && s.saleDate) {
        lastTerminalSaleDate = s.saleDate;
      }
    }
    if (current.length > 0) {
      groups.push(makeGroupFromChain(current));
    }
  }

  return groups.sort((a, b) => {
    // Use the CONSENSUS saleDate (mode of siblings) rather than the canonical's
    // raw saleDate. Prevents a single misparsed outlier (e.g. ref 11404446's
    // saleDate=2019-08-19 row) from shoving the whole passage into the past.
    const aDate = pickPassageSaleDate(a.snapshots, a.canonical);
    const bDate = pickPassageSaleDate(b.snapshots, b.canonical);
    return aDate.localeCompare(bDate);
  });
}

/**
 * Pick the canonical snapshot for a passage chain. Sold snapshots win
 * over non-sold (final truth), and within a sold-state the most recent
 * scrape wins.
 */
function makeGroupFromChain(snaps: SnapshotForHistory[]): Group {
  let canonical = snaps[0];
  let canonHasSold = canonical.soldPrice != null;
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i];
    const sHasSold = s.soldPrice != null;
    if (sHasSold && !canonHasSold) {
      canonical = s;
      canonHasSold = true;
    } else if (sHasSold === canonHasSold && s.scrapedAt > canonical.scrapedAt) {
      canonical = s;
    }
  }
  return { snapshots: snaps, canonical };
}

export interface PlaceholderScrubSignals {
  currentAuctionPrice: number | null;
  soldPrice: number | null;
  marketValue: number | null;
  newPrice: number | null;
}

/**
 * Aggregate the strongest non-null signals seen anywhere in a set of snapshots.
 * Used to retroactively disprove a stored 100 € placeholder MAP: older snapshots
 * may have captured MAP=100 before any live/cote/newPrice arrived, but by
 * the time we render the passage, a later snapshot (in the SAME passage OR in
 * another passage of the same vehicle) may carry those signals. Using them at
 * render time auto-heals the display without requiring a DB migration.
 *
 * Returns the maximum value seen for each signal so a single high-value
 * observation (cote=28 500 €) wins over zero/null noise from other snaps.
 */
export function aggregatePlaceholderSignals(
  snaps: SnapshotForHistory[],
): PlaceholderScrubSignals {
  let live = 0, sold = 0, cote = 0, neuf = 0;
  for (const s of snaps) {
    if ((s.currentAuctionPrice ?? 0) > live) live = s.currentAuctionPrice!;
    if ((s.soldPrice ?? 0) > sold) sold = s.soldPrice!;
    if ((s.marketValue ?? 0) > cote) cote = s.marketValue!;
    if ((s.newPrice ?? 0) > neuf) neuf = s.newPrice!;
  }
  return {
    currentAuctionPrice: live > 0 ? live : null,
    soldPrice: sold > 0 ? sold : null,
    marketValue: cote > 0 ? cote : null,
    newPrice: neuf > 0 ? neuf : null,
  };
}

/**
 * Merge two sets of placeholder-scrub signals by taking the max of each
 * channel. Used to combine per-passage signals with vehicle-wide signals so
 * late-arriving evidence on ANY passage of the vehicle retroactively scrubs
 * 100 € placeholders everywhere (ref 11402626 regression: a 100 € MAP stored
 * on the 24/04 passage survived because cote=21 200 € / neuf=38 500 € were
 * captured only on the 02/05 passage).
 */
function mergeSignals(
  a: PlaceholderScrubSignals,
  b: PlaceholderScrubSignals | null | undefined,
): PlaceholderScrubSignals {
  if (!b) return a;
  return {
    currentAuctionPrice: Math.max(a.currentAuctionPrice ?? 0, b.currentAuctionPrice ?? 0) || null,
    soldPrice: Math.max(a.soldPrice ?? 0, b.soldPrice ?? 0) || null,
    marketValue: Math.max(a.marketValue ?? 0, b.marketValue ?? 0) || null,
    newPrice: Math.max(a.newPrice ?? 0, b.newPrice ?? 0) || null,
  };
}

/**
 * Backward-compat alias kept for historical test imports; same behaviour as
 * aggregatePlaceholderSignals.
 */
function aggregatePassageSignals(snaps: SnapshotForHistory[]): PlaceholderScrubSignals {
  return aggregatePlaceholderSignals(snaps);
}

/**
 * Within a passage, compute the ordered sequence of DISTINCT MAP values
 * observed while the listing was active. Consecutive equal values collapse.
 * Returns [] when no pre-sale snapshot has a startingPrice.
 *
 * Retroactive placeholder scrub: if the passage taken as a whole (merged
 * with the optional `externalSignals` seen elsewhere on the same vehicle)
 * carries a live bid ≥ 500 €, a sold price ≥ 500 €, a cote ≥ 1000 € or a
 * prix neuf ≥ 1000 €, every stored MAP=100 € inside it is rejected — it
 * cannot be a real scooter/épave reserve. This is the same rule the write-path
 * and scraper use, applied across ALL snapshots of the vehicle so a late-arriving
 * signal heals earlier rows (CITROEN C3 ref 11404446: 13 snaps with MAP=100 €
 * persisted before the live bid appeared; once live=1500 € arrived the display
 * must not show them as a real reserve drop 100 € → 1 200 €) and even
 * cross-passage (ref 11402626: cote=21 200 € captured on the 02/05 passage
 * scrubs MAP=100 € stored on the earlier 24/04 passage).
 */
export function buildMapTrajectory(
  snaps: SnapshotForHistory[],
  externalSignals?: PlaceholderScrubSignals | null,
): number[] {
  const signals = mergeSignals(aggregatePassageSignals(snaps), externalSignals);
  const preSale = snaps
    .filter((s) => isPreSale(s) && s.startingPrice != null)
    .filter((s) => !isSpuriousStartingPrice(s.startingPrice, signals))
    .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime());
  const traj: number[] = [];
  for (const s of preSale) {
    if (traj[traj.length - 1] !== s.startingPrice) {
      traj.push(s.startingPrice!);
    }
  }
  return traj;
}

/**
 * Ordered sequence of DISTINCT currentAuctionPrice values observed during a
 * passage, oldest first. Collapses consecutive duplicates. Returns [] when
 * no snapshot ever reported a live bid.
 *
 * Used to materialise a real "évolution de prix" when the seller never
 * published a MAP — e.g. Toyota Yaris Cross ref 11403878 where startingPrice
 * is null across all 27 snapshots but currentAuctionPrice walked
 * 17 900 → 18 000 → 18 400, then soldPrice=19 800 on sale.
 */
export function buildLiveBidTrajectory(snaps: SnapshotForHistory[]): number[] {
  const withBid = snaps
    .filter((s) => s.currentAuctionPrice != null && s.currentAuctionPrice > 0)
    .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime());
  const traj: number[] = [];
  for (const s of withBid) {
    if (traj[traj.length - 1] !== s.currentAuctionPrice) {
      traj.push(s.currentAuctionPrice!);
    }
  }
  return traj;
}

/** Latest observed currentAuctionPrice across a passage's snapshots, or undefined. */
export function pickLatestLiveBid(snaps: SnapshotForHistory[]): number | undefined {
  const withBid = snaps
    .filter((s) => s.currentAuctionPrice != null && s.currentAuctionPrice > 0)
    .sort((a, b) => b.scrapedAt.getTime() - a.scrapedAt.getTime());
  return withBid[0]?.currentAuctionPrice ?? undefined;
}

/**
 * Pick the "auction-time" MAP for a passage. Prefers the latest pre-sale
 * snapshot (most reliable reserve at time of sale). Falls back to the mode
 * (most-frequent non-null value) to reject spurious one-off values like a
 * single sold-page scrape reporting 21 700 € while 4 list-page scrapes saw
 * 21 300 €.
 *
 * Applies the same placeholder scrub as buildMapTrajectory: any stored
 * MAP=100 € that is contradicted by a later live/sold/cote/neuf signal in
 * the SAME passage (or anywhere on the vehicle via externalSignals) is
 * rejected before the pick.
 */
export function pickStartingPrice(
  snaps: SnapshotForHistory[],
  externalSignals?: PlaceholderScrubSignals | null,
): number | undefined {
  const signals = mergeSignals(aggregatePassageSignals(snaps), externalSignals);
  const clean = snaps.filter((s) => !isSpuriousStartingPrice(s.startingPrice, signals));
  const preSale = clean
    .filter((s) => isPreSale(s) && s.startingPrice != null)
    .sort((a, b) => b.scrapedAt.getTime() - a.scrapedAt.getTime());
  if (preSale.length > 0) return preSale[0].startingPrice ?? undefined;
  const counts = new Map<number, number>();
  for (const s of clean) {
    if (s.startingPrice == null) continue;
    counts.set(s.startingPrice, (counts.get(s.startingPrice) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let mode: number | undefined;
  let modeCount = 0;
  for (const [price, count] of counts) {
    if (count > modeCount) {
      mode = price;
      modeCount = count;
    }
  }
  return mode;
}

function hasMeaningfulPassageChange(
  previous: SnapshotForHistory,
  current: SnapshotForHistory,
): boolean {
  return (
    (previous.startingPrice ?? null) !== (current.startingPrice ?? null) ||
    (previous.currentAuctionPrice ?? null) !== (current.currentAuctionPrice ?? null) ||
    (previous.soldPrice ?? null) !== (current.soldPrice ?? null) ||
    previous.status !== current.status ||
    (previous.saleDate ?? null) !== (current.saleDate ?? null) ||
    (previous.saleTime ?? null) !== (current.saleTime ?? null) ||
    previous.mileage !== current.mileage ||
    previous.sourceUrl !== current.sourceUrl
  );
}

export function buildPassageEvents(
  snaps: SnapshotForHistory[],
  externalSignals?: PlaceholderScrubSignals | null,
): VehiclePassage['events'] {
  const signals = mergeSignals(aggregatePassageSignals(snaps), externalSignals);
  // Scrub the stored 100 € placeholder on each event when passage-level
  // (or vehicle-wide) signals disprove it. We do NOT drop the snapshot itself
  // (status/mileage may still be interesting), we only blank the fake MAP so
  // it never surfaces in the timeline as a "real" reserve.
  const scrubbed = snaps.map((s) => ({
    ...s,
    startingPrice: isSpuriousStartingPrice(s.startingPrice, signals)
      ? null
      : s.startingPrice,
  }));

  const ordered = scrubbed
    .slice()
    .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime());

  const distinct: SnapshotForHistory[] = [];
  for (const snapshot of ordered) {
    const previous = distinct[distinct.length - 1];
    if (!previous || hasMeaningfulPassageChange(previous, snapshot)) {
      distinct.push(snapshot);
    }
  }

  return distinct.map((snapshot) => ({
    snapshotId: snapshot.id,
    scrapedAt: snapshot.scrapedAt.toISOString(),
    saleDate: snapshot.saleDate ?? undefined,
    saleTime: snapshot.saleTime ?? undefined,
    status: snapshot.status as VehiclePassage['status'],
    startingPrice: snapshot.startingPrice ?? undefined,
    currentAuctionPrice: snapshot.currentAuctionPrice ?? undefined,
    soldPrice: snapshot.soldPrice ?? undefined,
    mileage: snapshot.mileage,
    sourceUrl: snapshot.sourceUrl,
    openMode: 'local',
    openReason: HISTORY_OPEN_REASON_UNAVAILABLE,
  }));
}

function normalizeSourceUrl(raw: string | null | undefined): string {
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    const query = url.search || '';
    return `${host}${path}${query}`;
  } catch {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
}

function isCanonicalIdentityReusedLater(
  current: SnapshotForHistory,
  laterSnapshots: SnapshotForHistory[],
): boolean {
  const currentUrl = normalizeSourceUrl(current.sourceUrl);

  return laterSnapshots.some((later) => {
    if (current.hashId && later.hashId && current.hashId === later.hashId) {
      return true;
    }

    const laterUrl = normalizeSourceUrl(later.sourceUrl);
    return currentUrl.length > 0 && currentUrl === laterUrl;
  });
}

export function applyPassageNavigation(groups: Group[], passages: VehiclePassage[]): VehiclePassage[] {
  return passages.map((passage, index) => {
    const canonical = groups[index]?.canonical;
    const canonicalSnapshotId = passage.snapshotId;
    const reusedLater = canonical
      ? isCanonicalIdentityReusedLater(
          canonical,
          groups.slice(index + 1).map((group) => group.canonical),
        )
      : false;
    const hasSourceUrl = Boolean(canonical?.sourceUrl || passage.sourceUrl);
    const isSourceUrlStable = hasSourceUrl && !reusedLater;
    const openMode: VehiclePassage['openMode'] = isSourceUrlStable ? 'vpauto' : 'local';
    const openReason = !hasSourceUrl
      ? HISTORY_OPEN_REASON_UNAVAILABLE
      : reusedLater
      ? HISTORY_OPEN_REASON_REUSED
      : HISTORY_OPEN_REASON_STABLE;

    return {
      ...passage,
      canonicalSnapshotId,
      isSourceUrlStable,
      openMode,
      openReason,
      events: passage.events.map((event) => {
        if (event.snapshotId !== canonicalSnapshotId) {
          return {
            ...event,
            openMode: 'local',
            openReason: HISTORY_OPEN_REASON_INTERMEDIATE,
          };
        }

        return {
          ...event,
          openMode,
          openReason,
        };
      }),
    };
  });
}

function pickBest<T>(
  snaps: SnapshotForHistory[],
  pick: (s: SnapshotForHistory) => T | null | undefined,
): T | undefined {
  for (const s of snaps) {
    const v = pick(s);
    if (v != null) return v;
  }
  return undefined;
}

export function buildPassageFromGroup(
  g: Group,
  idx: number,
  externalSignals?: PlaceholderScrubSignals | null,
): VehiclePassage {
  const s = g.canonical;
  const firstPhoto = parsePhotoUrls(s.photoUrls)[0];
  const traj = buildMapTrajectory(g.snapshots, externalSignals);
  // Compute the full scrub signals ONCE for this passage so the canonical
  // fallback (below) also benefits from vehicle-wide evidence — without this,
  // a 100 € on the canonical snapshot would leak when the trajectory is empty
  // (ref 11402626: 24/04 passage has only 100 € snaps, cote=21 200 € lives on
  // another passage — the canonical's raw 100 € must still be rejected).
  const passageSignals = mergeSignals(
    aggregatePlaceholderSignals(g.snapshots),
    externalSignals,
  );
  const canonicalStarting = isSpuriousStartingPrice(s.startingPrice, passageSignals)
    ? undefined
    : s.startingPrice ?? undefined;
  const finalMap = traj.length > 0
    ? traj[traj.length - 1]
    : pickStartingPrice(g.snapshots, externalSignals) ?? canonicalStarting;
  const liveBidTraj = buildLiveBidTrajectory(g.snapshots);
  const latestLiveBid = pickLatestLiveBid(g.snapshots);

  return {
    passageNumber: idx + 1,
    snapshotId: s.id,
    canonicalSnapshotId: s.id,
    // Consensus saleDate across the bucket — outlier-resistant.
    date: pickPassageSaleDate(g.snapshots, s),
    saleTime: s.saleTime ?? pickBest(g.snapshots, (x) => x.saleTime) ?? undefined,
    city: s.city,
    center: s.center ?? pickBest(g.snapshots, (x) => x.center) ?? undefined,
    status: s.status as VehiclePassage['status'],
    startingPrice: finalMap,
    currentAuctionPrice: latestLiveBid,
    soldPrice: s.soldPrice ?? pickBest(g.snapshots, (x) => x.soldPrice),
    mileage: s.mileage || pickBest(g.snapshots, (x) => (x.mileage > 0 ? x.mileage : null)) || 0,
    lotNumber: s.lotNumber ?? pickBest(g.snapshots, (x) => x.lotNumber) ?? undefined,
    observations: s.observations ?? pickBest(g.snapshots, (x) => x.observations),
    technicalCheckUrl: s.technicalCheckUrl ?? pickBest(g.snapshots, (x) => x.technicalCheckUrl),
    sourceUrl: s.sourceUrl,
    isSourceUrlStable: false,
    openMode: 'local',
    openReason: HISTORY_OPEN_REASON_UNAVAILABLE,
    photoUrl: firstPhoto,
    events: buildPassageEvents(g.snapshots, externalSignals),
    mapTrajectory: traj.length > 1 ? traj : undefined,
    liveBidTrajectory: liveBidTraj.length > 0 ? liveBidTraj : undefined,
  };
}

/**
 * Convenience wrapper that builds every passage for a vehicle while threading
 * VEHICLE-WIDE placeholder-scrub signals through each one. Prefer this over
 * mapping `buildPassageFromGroup` by hand whenever you have the full snapshot
 * list — it guarantees that a cote / prix neuf captured on one passage will
 * retroactively scrub a 100 € placeholder stored on another passage.
 */
export function buildPassagesForVehicle(
  groups: Group[],
  allSnapshots: SnapshotForHistory[],
): VehiclePassage[] {
  const vehicleSignals = aggregatePlaceholderSignals(allSnapshots);
  return groups.map((g, idx) => buildPassageFromGroup(g, idx, vehicleSignals));
}

/**
 * VPauto regularly keeps a vehicle's listing page reachable for a few days
 * after the auction ends — same hashId, but the page now reads
 * "Vente Live terminée / Véhicule non disponible". Our scrapers happily
 * record those orphan snapshots, so a sold vehicle can end up with later
 * "Disponible" passages on top of its real adjudication.
 *
 * This helper drops any passage strictly newer than the most recent
 * `status === 'sold'` passage. The cutoff is the LATEST sale date (handles
 * the rare re-sale case where the same physical car is re-listed weeks
 * later and re-sold — we keep both sales and only trim what comes after
 * the second one). Ties on the same saleDate are kept (we drop only what's
 * strictly after the cutoff).
 *
 * Returns the kept passages plus the count of dropped entries so the UI
 * can surface a "+N passage post-vente masqué" mention.
 */
export function findFinalSoldDate(passages: VehiclePassage[]): string | null {
  let cutoff: string | null = null;
  for (const p of passages) {
    if (p.status !== 'sold') continue;
    if (!p.date) continue;
    if (cutoff === null || p.date > cutoff) {
      cutoff = p.date;
    }
  }
  return cutoff;
}

export function truncateAfterFinalSale(passages: VehiclePassage[]): {
  passages: VehiclePassage[];
  truncatedPassages: VehiclePassage[];
} {
  const cutoff = findFinalSoldDate(passages);
  if (!cutoff) {
    return { passages, truncatedPassages: [] };
  }
  const kept: VehiclePassage[] = [];
  const truncated: VehiclePassage[] = [];
  for (const p of passages) {
    if (p.date && p.date > cutoff) {
      truncated.push(p);
    } else {
      kept.push(p);
    }
  }
  return { passages: kept, truncatedPassages: truncated };
}

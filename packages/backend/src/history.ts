/**
 * Pure helpers for building a vehicle's history (passages, price chart,
 * evolution) from its raw snapshots. Extracted from the /history route so
 * they can be unit-tested without a DB.
 */
import type { VehiclePassage } from '@vpauto/shared';
import { parsePhotoUrls } from './utils.js';

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
  soldPrice: number | null;
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
    const aDate = getPassageOrderingDate(a.canonical);
    const bDate = getPassageOrderingDate(b.canonical);
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

/**
 * Within a passage, compute the ordered sequence of DISTINCT MAP values
 * observed while the listing was active. Consecutive equal values collapse.
 * Returns [] when no pre-sale snapshot has a startingPrice.
 */
export function buildMapTrajectory(snaps: SnapshotForHistory[]): number[] {
  const preSale = snaps
    .filter((s) => isPreSale(s) && s.startingPrice != null)
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
 * Pick the "auction-time" MAP for a passage. Prefers the latest pre-sale
 * snapshot (most reliable reserve at time of sale). Falls back to the mode
 * (most-frequent non-null value) to reject spurious one-off values like a
 * single sold-page scrape reporting 21 700 € while 4 list-page scrapes saw
 * 21 300 €.
 */
export function pickStartingPrice(snaps: SnapshotForHistory[]): number | undefined {
  const preSale = snaps
    .filter((s) => isPreSale(s) && s.startingPrice != null)
    .sort((a, b) => b.scrapedAt.getTime() - a.scrapedAt.getTime());
  if (preSale.length > 0) return preSale[0].startingPrice ?? undefined;
  const counts = new Map<number, number>();
  for (const s of snaps) {
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
    (previous.soldPrice ?? null) !== (current.soldPrice ?? null) ||
    previous.status !== current.status ||
    (previous.saleDate ?? null) !== (current.saleDate ?? null) ||
    (previous.saleTime ?? null) !== (current.saleTime ?? null) ||
    previous.mileage !== current.mileage ||
    previous.sourceUrl !== current.sourceUrl
  );
}

export function buildPassageEvents(snaps: SnapshotForHistory[]): VehiclePassage['events'] {
  const ordered = snaps
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

export function buildPassageFromGroup(g: Group, idx: number): VehiclePassage {
  const s = g.canonical;
  const firstPhoto = parsePhotoUrls(s.photoUrls)[0];
  const traj = buildMapTrajectory(g.snapshots);
  const finalMap = traj.length > 0
    ? traj[traj.length - 1]
    : pickStartingPrice(g.snapshots) ?? s.startingPrice ?? undefined;

  return {
    passageNumber: idx + 1,
    snapshotId: s.id,
    canonicalSnapshotId: s.id,
    date: s.saleDate || s.scrapedAt.toISOString().split('T')[0],
    saleTime: s.saleTime ?? pickBest(g.snapshots, (x) => x.saleTime) ?? undefined,
    city: s.city,
    center: s.center ?? pickBest(g.snapshots, (x) => x.center) ?? undefined,
    status: s.status as VehiclePassage['status'],
    startingPrice: finalMap,
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
    events: buildPassageEvents(g.snapshots),
    mapTrajectory: traj.length > 1 ? traj : undefined,
  };
}

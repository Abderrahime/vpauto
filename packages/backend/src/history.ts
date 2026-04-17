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

export interface SnapshotForHistory {
  id: number;
  hashId: string | null;
  city: string;
  center: string | null;
  status: string;
  saleDate: string | null;
  scrapedAt: Date;
  startingPrice: number | null;
  soldPrice: number | null;
  mileage: number;
  observations: string | null;
  technicalCheckUrl: string | null;
  sourceUrl: string;
  photoUrls: string; // JSON array string
}

type Group = { snapshots: SnapshotForHistory[]; canonical: SnapshotForHistory };

/** True while the auction is still ongoing, so `startingPrice` reflects the live reserve. */
function isPreSale(s: SnapshotForHistory): boolean {
  return s.status === 'available' || s.status === 'auction_live';
}

/**
 * Group snapshots into passages. Primary key: hashId (one VPauto listing =
 * one passage). Fallback key: (city, saleDate) for legacy snapshots without
 * hashId. The canonical snapshot per group is the one with a soldPrice
 * (final state) or otherwise the most recent scrape.
 */
export function groupSnapshotsIntoPassages(
  snapshots: SnapshotForHistory[],
): Group[] {
  const groups = new Map<string, Group>();
  for (const s of snapshots) {
    const key = s.hashId
      ? `hash|${s.hashId}`
      : `loc|${s.city || 'unknown'}|${s.saleDate || s.scrapedAt.toISOString().split('T')[0]}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { snapshots: [s], canonical: s });
      continue;
    }
    existing.snapshots.push(s);
    const incomingHasSold = s.soldPrice != null;
    const canonHasSold = existing.canonical.soldPrice != null;
    // Sold snapshots are the final truth for a passage and must never be
    // displaced by a later non-sold scrape (can happen when a listing lingers
    // in the "available" feed after sale). Within the same sold-state, pick
    // the most recent scrape.
    if (incomingHasSold && !canonHasSold) {
      existing.canonical = s;
    } else if (incomingHasSold === canonHasSold && s.scrapedAt > existing.canonical.scrapedAt) {
      existing.canonical = s;
    }
  }
  return Array.from(groups.values()).sort((a, b) => {
    const aDate = a.canonical.saleDate || a.canonical.scrapedAt.toISOString();
    const bDate = b.canonical.saleDate || b.canonical.scrapedAt.toISOString();
    return aDate.localeCompare(bDate);
  });
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
    date: s.saleDate || s.scrapedAt.toISOString().split('T')[0],
    city: s.city,
    center: s.center ?? pickBest(g.snapshots, (x) => x.center) ?? undefined,
    status: s.status as VehiclePassage['status'],
    startingPrice: finalMap,
    soldPrice: s.soldPrice ?? pickBest(g.snapshots, (x) => x.soldPrice),
    mileage: s.mileage || pickBest(g.snapshots, (x) => (x.mileage > 0 ? x.mileage : null)) || 0,
    observations: s.observations ?? pickBest(g.snapshots, (x) => x.observations),
    technicalCheckUrl: s.technicalCheckUrl ?? pickBest(g.snapshots, (x) => x.technicalCheckUrl),
    sourceUrl: s.sourceUrl,
    photoUrl: firstPhoto,
    mapTrajectory: traj.length > 1 ? traj : undefined,
  };
}


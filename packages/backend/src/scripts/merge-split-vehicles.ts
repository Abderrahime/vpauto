/**
 * Cleanup script: merges Vehicle rows that describe the same physical car but
 * got split because of differing VPauto references. VPauto was observed
 * reusing a fresh reference on re-listing (e.g. non-roulant Ford Transit
 * Custom in Nantes: ref 11372975 on 07/04 then ref 11409453 on 20/04, same
 * VIN, same odometer, same specs). The old matcher filtered candidates by
 * reference at the SQL layer, so attribute-based matching never got a chance
 * to bridge them. The fix in matching.ts removes that SQL filter and adds a
 * cross-reference gate to `computeIdentityScore`. This script applies the new
 * matching rules retroactively to the existing DB.
 *
 * Strategy:
 *  - Load every Vehicle with its most-recent Snapshot (used to build the
 *    synthetic VehicleSnapshot input).
 *  - For every (brand, year ± 1) bucket, pair-compare vehicles with
 *    `computeIdentityScore`. Apply the same "strong match" threshold as
 *    `findExactVehicle`: score ≥ 70, or score ≥ 55 with mileageDiff ≤ 3000.
 *  - Union-find the resulting matches into clusters of ≥ 2 vehicles.
 *  - For each cluster, keep the vehicle with the earliest `firstSeenAt`
 *    (oldest history) as canonical, and reassign all other vehicles'
 *    snapshots to it. Preserve the canonical vehicle's reference.
 *  - Delete emptied vehicle rows.
 *
 * Usage:
 *   tsx src/scripts/merge-split-vehicles.ts           # dry-run
 *   tsx src/scripts/merge-split-vehicles.ts --apply   # actually write
 */
import { prisma } from '../db.js';
import { computeIdentityScore } from '../matching.js';
import type { VehicleSnapshot } from '@vpauto/shared';

const APPLY = process.argv.includes('--apply');

type VehicleWithLatest = {
  id: number;
  reference: string | null;
  hashId: string | null;
  brand: string;
  model: string;
  version: string;
  year: number;
  color: string;
  fuel: string;
  transmission: string;
  engineSize: number | null;
  power: number | null;
  fiscalPower: number | null;
  firstSeenAt: Date;
  snapshots: Array<{
    mileage: number;
    color: string;
    fuel: string;
    transmission: string;
    engineSize: number | null;
    power: number | null;
    fiscalPower: number | null;
    technicalCheckUrl: string | null;
    conditionImageUrl: string | null;
    cdnHash: string | null;
    saleDate: string | null;
    city: string;
    scrapedAt: Date;
  }>;
};

/** Build a synthetic input snapshot from a vehicle's latest Snapshot. */
function toInput(v: VehicleWithLatest): VehicleSnapshot {
  const s = v.snapshots[0];
  return {
    reference: v.reference ?? '',
    hashId: v.hashId ?? '',
    brand: v.brand,
    model: v.model,
    version: v.version,
    year: v.year,
    mileage: s?.mileage ?? 0,
    color: s?.color ?? v.color,
    fuel: s?.fuel ?? v.fuel,
    transmission: s?.transmission ?? v.transmission,
    engineSize: s?.engineSize ?? v.engineSize ?? undefined,
    power: s?.power ?? v.power ?? undefined,
    fiscalPower: s?.fiscalPower ?? v.fiscalPower ?? undefined,
    city: s?.city ?? '',
    photoUrls: [],
    vatRecoverable: false,
    sourceUrl: '',
    technicalCheckUrl: s?.technicalCheckUrl ?? undefined,
    conditionImageUrl: s?.conditionImageUrl ?? undefined,
    cdnHash: s?.cdnHash ?? undefined,
    saleDate: s?.saleDate ?? undefined,
  } as unknown as VehicleSnapshot;
}

/** Same threshold rule as `findExactVehicle` in matching.ts. */
function isStrongDetailsMatch(score: number, mileageDiff: number): boolean {
  return score >= 70
    || (score >= 55 && Number.isFinite(mileageDiff) && mileageDiff <= 3000);
}

// Minimal union-find for clustering vehicles.
class UnionFind {
  parent = new Map<number, number>();
  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined || p === x) {
      this.parent.set(x, x);
      return x;
    }
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

async function main() {
  console.log(APPLY ? '>>> APPLY MODE — will mutate DB' : '>>> DRY RUN — no writes');

  const vehicles = (await prisma.vehicle.findMany({
    include: {
      snapshots: {
        orderBy: { scrapedAt: 'desc' },
        take: 1,
      },
    },
  })) as VehicleWithLatest[];
  console.log(`Loaded ${vehicles.length} vehicles.`);

  // Bucket by brand for cheap O(n²)-within-bucket pair search.
  const byBrand = new Map<string, VehicleWithLatest[]>();
  for (const v of vehicles) {
    const key = v.brand.toUpperCase();
    const arr = byBrand.get(key) ?? [];
    arr.push(v);
    byBrand.set(key, arr);
  }

  const uf = new UnionFind();
  let pairChecks = 0;
  let matches = 0;

  for (const [brand, list] of byBrand) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.snapshots[0]) continue;
      const input = toInput(a);
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (Math.abs(a.year - b.year) > 1) continue;
        if (!b.snapshots[0]) continue;
        pairChecks++;
        const scored = computeIdentityScore(input, b);
        if (scored.score === 0) continue;
        if (!isStrongDetailsMatch(scored.score, scored.mileageDiff)) continue;
        matches++;
        uf.union(a.id, b.id);
        console.log(
          `Match: ${a.id} (ref=${a.reference ?? '-'}, km=${a.snapshots[0].mileage}) `
          + `↔ ${b.id} (ref=${b.reference ?? '-'}, km=${b.snapshots[0].mileage}) `
          + `[${brand} ${a.model} ${a.year}] score=${scored.score} kmΔ=${scored.mileageDiff} `
          + `reasons=[${scored.reasons.join(', ')}]`,
        );
      }
    }
  }

  // Build clusters from union-find.
  const clusters = new Map<number, number[]>();
  for (const v of vehicles) {
    const root = uf.find(v.id);
    if (root !== v.id || clusters.has(root)) {
      const arr = clusters.get(root) ?? [];
      arr.push(v.id);
      clusters.set(root, arr);
    }
  }
  for (const [root, members] of clusters) {
    if (!members.includes(root)) members.unshift(root);
  }

  const nonTrivial = [...clusters.values()].filter((m) => m.length > 1);
  console.log('');
  console.log(`Pair-checks          : ${pairChecks}`);
  console.log(`Strong matches       : ${matches}`);
  console.log(`Merge clusters (≥ 2) : ${nonTrivial.length}`);

  let totalSnapshotsMoved = 0;
  let totalDeleted = 0;

  for (const members of nonTrivial) {
    // Canonical selection — rules, in order:
    //   1. Prefer a row that HAS a reference (strongest public ID).
    //   2. Among ref-carrying rows, prefer the LOWEST reference: VPauto
    //      reference numbers are monotonically increasing, so the lower one
    //      is the older listing (the first time this car was auctioned).
    //   3. Tie-break by lowest Vehicle.id (earliest created).
    const rows = members
      .map((id) => vehicles.find((v) => v.id === id)!)
      .sort((a, b) => {
        const aHas = a.reference != null;
        const bHas = b.reference != null;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && bHas) {
          const aRef = Number(a.reference);
          const bRef = Number(b.reference);
          if (Number.isFinite(aRef) && Number.isFinite(bRef) && aRef !== bRef) {
            return aRef - bRef;
          }
        }
        return a.id - b.id;
      });
    const canonical = rows[0];
    const others = rows.slice(1);

    console.log(
      `\nCluster → canonical ${canonical.id} (ref=${canonical.reference ?? '-'}, `
      + `firstSeen=${canonical.firstSeenAt.toISOString().slice(0, 10)}) `
      + `+ merging [${others.map((o) => `${o.id}(ref=${o.reference ?? '-'})`).join(', ')}] `
      + `— ${canonical.brand} ${canonical.model} ${canonical.year}`,
    );

    for (const o of others) {
      const snapCount = await prisma.snapshot.count({ where: { vehicleId: o.id } });
      console.log(`  → move ${snapCount} snapshot(s) from ${o.id} to ${canonical.id}, then delete ${o.id}`);
      if (APPLY) {
        await prisma.snapshot.updateMany({
          where: { vehicleId: o.id },
          data: { vehicleId: canonical.id },
        });
        await prisma.vehicle.delete({ where: { id: o.id } });

        // Refresh canonical's lastSeenAt to latest scrapedAt of its (now-enlarged) snapshot set.
        const latest = await prisma.snapshot.findFirst({
          where: { vehicleId: canonical.id },
          orderBy: { scrapedAt: 'desc' },
          select: { scrapedAt: true },
        });
        if (latest) {
          await prisma.vehicle.update({
            where: { id: canonical.id },
            data: { lastSeenAt: latest.scrapedAt },
          });
        }
      }
      totalSnapshotsMoved += snapCount;
      totalDeleted++;
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Snapshots reassigned: ${totalSnapshotsMoved}`);
  console.log(`Vehicles deleted    : ${totalDeleted}`);
  console.log(APPLY ? 'APPLIED.' : 'Dry run — re-run with --apply to commit.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Cleanup script: splits Vehicles that have snapshots with multiple distinct
 * hashIds (which means several physical cars were fused into one Vehicle by
 * the previous too-permissive matcher).
 *
 * Strategy:
 *  - For each Vehicle, group its snapshots by hashId.
 *  - The canonical hashId is Vehicle.hashId (or the most-recent snapshot's
 *    hashId if the Vehicle has none).
 *  - Snapshots with the canonical hashId stay on the current Vehicle.
 *  - For each foreign hashId:
 *      * If an existing Vehicle already has that hashId, migrate snapshots to it.
 *      * Else create a new Vehicle row (copy of current Vehicle but
 *        reference=null and hashId=foreign), then migrate snapshots to it.
 *  - Snapshots with hashId=null stay attached to their current Vehicle.
 *
 * Usage:
 *   tsx src/scripts/split-polluted-vehicles.ts           # dry-run
 *   tsx src/scripts/split-polluted-vehicles.ts --apply   # actually write
 */
import { prisma } from '../db.js';

const APPLY = process.argv.includes('--apply');

type VehicleRow = {
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
  lastSeenAt: Date;
};

async function main() {
  console.log(APPLY ? '>>> APPLY MODE — will mutate DB' : '>>> DRY RUN — no writes');

  // Find polluted vehicles: those whose snapshots span ≥ 2 distinct non-null hashIds.
  const polluted = await prisma.$queryRaw<Array<{ vehicleId: number; distinctHashes: number }>>`
    SELECT s.vehicleId AS vehicleId, COUNT(DISTINCT s.hashId) AS distinctHashes
    FROM Snapshot s
    WHERE s.hashId IS NOT NULL
    GROUP BY s.vehicleId
    HAVING COUNT(DISTINCT s.hashId) > 1
    ORDER BY COUNT(DISTINCT s.hashId) DESC
  `;

  console.log(`Found ${polluted.length} polluted vehicles.`);

  let totalCreated = 0;
  let totalMigrated = 0;
  let totalSnapshotsMoved = 0;

  for (const { vehicleId } of polluted) {
    const vehicle = (await prisma.vehicle.findUnique({
      where: { id: vehicleId },
    })) as VehicleRow | null;
    if (!vehicle) continue;

    const snaps = await prisma.snapshot.findMany({
      where: { vehicleId },
      select: { id: true, hashId: true, scrapedAt: true, city: true, mileage: true, saleDate: true },
      orderBy: { scrapedAt: 'desc' },
    });

    // Group snapshots by hashId (null goes into its own "null" bucket that stays on canonical)
    const byHash = new Map<string, typeof snaps>();
    for (const s of snaps) {
      if (!s.hashId) continue;
      const arr = byHash.get(s.hashId) ?? [];
      arr.push(s);
      byHash.set(s.hashId, arr);
    }

    if (byHash.size <= 1) continue;

    // Canonical = Vehicle.hashId if present in snapshots, else most-recent snapshot's hashId.
    let canonical: string | null = vehicle.hashId && byHash.has(vehicle.hashId) ? vehicle.hashId : null;
    if (!canonical) {
      const latestWithHash = snaps.find((s) => !!s.hashId);
      canonical = latestWithHash?.hashId ?? null;
    }
    if (!canonical) continue;

    const foreignHashes = [...byHash.keys()].filter((h) => h !== canonical);
    if (foreignHashes.length === 0) continue;

    console.log(
      `Vehicle ${vehicle.id} [${vehicle.brand} ${vehicle.model} ref=${vehicle.reference ?? '-'}] `
      + `canonical=${canonical} foreign=[${foreignHashes.join(', ')}]`,
    );

    for (const foreignHash of foreignHashes) {
      const foreignSnaps = byHash.get(foreignHash)!;
      const ids = foreignSnaps.map((s) => s.id);

      // Is there already a Vehicle with that hashId?
      const existing = await prisma.vehicle.findFirst({
        where: { hashId: foreignHash, id: { not: vehicle.id } },
        select: { id: true, reference: true, brand: true, model: true },
      });

      if (existing) {
        console.log(
          `  → migrate ${ids.length} snapshots (hashId=${foreignHash}) `
          + `to existing Vehicle ${existing.id} [${existing.brand} ${existing.model} ref=${existing.reference ?? '-'}]`,
        );
        if (APPLY) {
          await prisma.snapshot.updateMany({
            where: { id: { in: ids } },
            data: { vehicleId: existing.id },
          });
        }
        totalMigrated++;
      } else {
        // Create a new Vehicle cloned from source, but reference=null, hashId=foreignHash
        const firstSnap = foreignSnaps[foreignSnaps.length - 1];
        const lastSnap = foreignSnaps[0];
        console.log(
          `  → create NEW Vehicle for hashId=${foreignHash} (${ids.length} snapshots, `
          + `city=${lastSnap.city}, km=${lastSnap.mileage})`,
        );
        if (APPLY) {
          const created = await prisma.vehicle.create({
            data: {
              reference: null,
              hashId: foreignHash,
              brand: vehicle.brand,
              model: vehicle.model,
              version: vehicle.version,
              year: vehicle.year,
              color: vehicle.color,
              fuel: vehicle.fuel,
              transmission: vehicle.transmission,
              engineSize: vehicle.engineSize,
              power: vehicle.power,
              fiscalPower: vehicle.fiscalPower,
              firstSeenAt: firstSnap.scrapedAt,
              lastSeenAt: lastSnap.scrapedAt,
            },
          });
          await prisma.snapshot.updateMany({
            where: { id: { in: ids } },
            data: { vehicleId: created.id },
          });
        }
        totalCreated++;
      }
      totalSnapshotsMoved += ids.length;
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Polluted vehicles processed : ${polluted.length}`);
  console.log(`Snapshots reassigned        : ${totalSnapshotsMoved}`);
  console.log(`Migrated to existing Vehicle: ${totalMigrated}`);
  console.log(`New Vehicles created        : ${totalCreated}`);
  console.log(APPLY ? 'APPLIED.' : 'Dry run — re-run with --apply to commit.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Clean up bogus `startingPrice = 100` snapshots introduced by the too-broad
 * "véhicule non roulant" detector. When a page contained legal/FAQ text
 * matching /épave|accident[eé]/ (even in a negation), the scraper flagged
 * the listing as non-roulant and the downstream `parsePriceFromPage` picked
 * up a symbolic 100 € minimum instead of the real MAP.
 *
 * Two cleanup rules, both conservative. A snapshot is cleared if EITHER
 * rule fires:
 *
 *   Rule A — Sibling proof (vehicle-scoped):
 *     vehicleId has at least one sibling snapshot with startingPrice
 *     ≥ SIBLING_MAP_FLOOR (500 €). Proof the 100 € value is bogus for
 *     THIS vehicle: a real scooter MAP wouldn't coexist with a real
 *     price > 500 € on the same vehicle.
 *
 *   Rule B — Ratio proof (snapshot-scoped):
 *     the same snapshot row carries marketValue ≥ VALUATION_FLOOR (1000 €)
 *     or newPrice ≥ VALUATION_FLOOR. A cote of 28 500 € next to a MAP of
 *     100 € yields a 285× ratio — impossible for a real vehicle. Catches
 *     cases where the vehicle has ONLY bogus 100 € snapshots (no sibling
 *     proof) but the cote/prix neuf betray the pollution (e.g. NISSAN
 *     Qashqai ref 11407209 — 11 pre-bug NULL snapshots + 6 bogus 100 €
 *     snapshots with marketValue=28500 and newPrice=45350).
 *
 *   Rule C — Live-bid proof (snapshot-scoped):
 *     the same snapshot row carries currentAuctionPrice ≥ VALUATION_FLOOR.
 *     If bidding is already above 1000 € for a car whose MAP is supposedly
 *     100 €, the MAP is clearly bogus — no sane auction ladder jumps from
 *     100 € to a 4-figure live bid in one step.
 *
 * Safe to re-run. Writes a timestamped backup first. Dry-run by default;
 * pass `--apply` to actually mutate rows.
 *
 *   tsx src/scripts/clean-bogus-starting-prices.ts           # dry run
 *   tsx src/scripts/clean-bogus-starting-prices.ts --apply   # mutate
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const prisma = new PrismaClient();

const SIBLING_MAP_FLOOR = 500;  // € — rule A
const VALUATION_FLOOR = 1000;   // € — rule B (cote/prix neuf)
const TARGET_VALUE = 100;        // €

async function main() {
  const apply = process.argv.includes('--apply');

  // Rule A: snapshots where startingPrice=100 AND the vehicle has a sibling
  // snapshot with startingPrice >= SIBLING_MAP_FLOOR.
  const ruleARows = await prisma.$queryRawUnsafe<{ id: number }[]>(`
    SELECT s1.id AS id
    FROM Snapshot s1
    WHERE s1.startingPrice = ${TARGET_VALUE}
    AND EXISTS (
      SELECT 1 FROM Snapshot s2
      WHERE s2.vehicleId = s1.vehicleId
      AND s2.startingPrice >= ${SIBLING_MAP_FLOOR}
    );
  `);

  // Rule B: snapshots where startingPrice=100 AND the same row carries
  // marketValue >= VALUATION_FLOOR OR newPrice >= VALUATION_FLOOR.
  const ruleBRows = await prisma.$queryRawUnsafe<{ id: number }[]>(`
    SELECT id FROM Snapshot
    WHERE startingPrice = ${TARGET_VALUE}
    AND (marketValue >= ${VALUATION_FLOOR} OR newPrice >= ${VALUATION_FLOOR});
  `);

  // Rule C: snapshots where startingPrice=100 AND the live auction price is
  // already ≥ VALUATION_FLOOR. A real 100 € MAP would never coexist with a
  // 4-figure live bid (the ladder jumps would be visible on the page and
  // the MAP would have been updated).
  const ruleCRows = await prisma.$queryRawUnsafe<{ id: number }[]>(`
    SELECT id FROM Snapshot
    WHERE startingPrice = ${TARGET_VALUE}
    AND currentAuctionPrice >= ${VALUATION_FLOOR};
  `);

  const ruleASet = new Set(ruleARows.map((r) => r.id));
  const ruleBSet = new Set(ruleBRows.map((r) => r.id));
  const ruleCSet = new Set(ruleCRows.map((r) => r.id));
  const union = new Set<number>([...ruleASet, ...ruleBSet, ...ruleCSet]);
  const overlapAB = [...ruleASet].filter((id) => ruleBSet.has(id)).length;
  const overlapAC = [...ruleASet].filter((id) => ruleCSet.has(id)).length;
  const overlapBC = [...ruleBSet].filter((id) => ruleCSet.has(id)).length;

  console.log(`[clean-100] Rule A (sibling ≥ ${SIBLING_MAP_FLOOR} €): ${ruleASet.size} snapshots.`);
  console.log(`[clean-100] Rule B (marketValue/newPrice ≥ ${VALUATION_FLOOR} €): ${ruleBSet.size} snapshots.`);
  console.log(`[clean-100] Rule C (currentAuctionPrice ≥ ${VALUATION_FLOOR} €): ${ruleCSet.size} snapshots.`);
  console.log(`[clean-100] Overlaps A∩B=${overlapAB} A∩C=${overlapAC} B∩C=${overlapBC}.`);
  console.log(`[clean-100] Union to clear: ${union.size} snapshots.`);

  if (union.size === 0) {
    console.log('[clean-100] Nothing to clean. Exiting.');
    await prisma.$disconnect();
    return;
  }

  const idsToClean = [...union];

  // Preview a handful of victims so we can eyeball the scope.
  const preview = await prisma.snapshot.findMany({
    where: { id: { in: idsToClean.slice(0, 10) } },
    select: {
      id: true,
      vehicleId: true,
      brand: true,
      model: true,
      saleDate: true,
      city: true,
      marketValue: true,
      newPrice: true,
    },
  });
  for (const s of preview) {
    const ruleTags: string[] = [];
    if (ruleASet.has(s.id)) ruleTags.push('A');
    if (ruleBSet.has(s.id)) ruleTags.push('B');
    if (ruleCSet.has(s.id)) ruleTags.push('C');
    console.log(
      `  - snap ${s.id} [${ruleTags.join(',')}] vehicle=${s.vehicleId} ${s.brand} ${s.model} @ ${s.city} ${s.saleDate ?? '(no date)'} cote=${s.marketValue ?? '—'} neuf=${s.newPrice ?? '—'}`,
    );
  }
  if (idsToClean.length > 10) console.log(`  … and ${idsToClean.length - 10} more.`);

  if (!apply) {
    console.log('\n[clean-100] Dry run — no changes written. Re-run with --apply to mutate.');
    await prisma.$disconnect();
    return;
  }

  // Backup the DB before writing.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dbPath = join(process.cwd(), 'prisma', 'vpauto.db');
  const backupPath = `${dbPath}.pre-clean100-${stamp}`;
  if (existsSync(dbPath)) {
    execSync(`cp "${dbPath}" "${backupPath}"`);
    console.log(`[clean-100] DB backup written to ${backupPath}`);
  }

  // Apply — chunk to keep the SQLite parameter count within limits.
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < idsToClean.length; i += CHUNK) {
    const chunk = idsToClean.slice(i, i + CHUNK);
    const res = await prisma.snapshot.updateMany({
      where: { id: { in: chunk } },
      data: { startingPrice: null },
    });
    total += res.count;
  }
  console.log(`[clean-100] Updated ${total} snapshots: startingPrice 100 → NULL.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[clean-100] Fatal:', err);
  process.exit(1);
});

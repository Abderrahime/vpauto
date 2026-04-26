import type { Snapshot } from '@prisma/client';
import type { VehicleSnapshot, VehicleStatus } from '@vpauto/shared';

/**
 * Decode a `photoUrls` column. The DB stores photos as a JSON array string
 * (SQLite doesn't have a native array type). Returns [] for null, empty,
 * or malformed values so callers never need a try/catch.
 */
export function parsePhotoUrls(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Spurious "Mise à prix 100 €" placeholder detection ────────────────────
//
// Keep these thresholds IN SYNC with the scraper's isSpuriousStartingPrice
// (packages/extension/src/lib/scraper.ts) and the DB cleanup Rule C in
// scripts/clean-bogus-starting-prices.ts. The backend enforces the same
// rule on every write path so that even an older/compromised extension
// can't insert a polluted 100 € MAP.
//
// See scraper.ts for the full rationale (Nantes 20/04/26 regression).
export const MAP_PLACEHOLDER_VALUE = 100;
export const MAP_LIVE_BID_FLOOR = 500;
export const MAP_VALUATION_FLOOR = 1000;

export function isSpuriousStartingPrice(
  startingPrice: number | null | undefined,
  signals: {
    currentAuctionPrice?: number | null;
    soldPrice?: number | null;
    marketValue?: number | null;
    newPrice?: number | null;
  },
): boolean {
  if (startingPrice !== MAP_PLACEHOLDER_VALUE) return false;
  if ((signals.currentAuctionPrice ?? 0) >= MAP_LIVE_BID_FLOOR) return true;
  if ((signals.soldPrice ?? 0) >= MAP_LIVE_BID_FLOOR) return true;
  if ((signals.marketValue ?? 0) >= MAP_VALUATION_FLOOR) return true;
  if ((signals.newPrice ?? 0) >= MAP_VALUATION_FLOOR) return true;
  return false;
}

/**
 * Convenience wrapper: returns the startingPrice to persist, substituting
 * null when the value is the spurious 100 € VPauto placeholder. Use this
 * at every DB write site so the scrubbing logic stays consistent.
 */
export function scrubStartingPriceForWrite(
  startingPrice: number | null | undefined,
  signals: {
    currentAuctionPrice?: number | null;
    soldPrice?: number | null;
    marketValue?: number | null;
    newPrice?: number | null;
  },
): number | null {
  if (startingPrice == null) return null;
  if (isSpuriousStartingPrice(startingPrice, signals)) return null;
  return startingPrice;
}

export function snapshotToApi(s: Snapshot): VehicleSnapshot {
  return {
    id: s.id,
    vehicleId: s.vehicleId,
    reference: s.reference ?? '',
    hashId: s.hashId ?? '',
    brand: s.brand,
    model: s.model,
    version: s.version,
    year: s.year,
    mileage: s.mileage,
    color: s.color,
    fuel: s.fuel,
    transmission: s.transmission,
    engineSize: s.engineSize ?? undefined,
    power: s.power ?? undefined,
    fiscalPower: s.fiscalPower ?? undefined,
    doors: s.doors ?? undefined,
    seats: s.seats ?? undefined,
    co2: s.co2 ?? undefined,
    critair: s.critair ?? undefined,
    euroStandard: s.euroStandard ?? undefined,
    bodyType: s.bodyType ?? undefined,
    startingPrice: s.startingPrice ?? undefined,
    startingPriceHT: s.startingPriceHT ?? undefined,
    marketValue: s.marketValue ?? undefined,
    newPrice: s.newPrice ?? undefined,
    vatRecoverable: s.vatRecoverable,
    currentAuctionPrice: s.currentAuctionPrice ?? undefined,
    city: s.city,
    center: s.center ?? undefined,
    department: s.department ?? undefined,
    saleDate: s.saleDate ?? undefined,
    saleTime: s.saleTime ?? undefined,
    lotNumber: s.lotNumber ?? undefined,
    technicalCheckUrl: s.technicalCheckUrl ?? undefined,
    conditionImageUrl: s.conditionImageUrl ?? undefined,
    observations: s.observations ?? undefined,
    maintenanceStatus: s.maintenanceStatus ?? undefined,
    serviceHistory: s.serviceHistory ?? undefined,
    firstOwner: s.firstOwner ?? undefined,
    warranty: s.warranty ?? undefined,
    equipment: s.equipment ? JSON.parse(s.equipment) : undefined,
    photoUrls: parsePhotoUrls(s.photoUrls),
    cdnHash: s.cdnHash ?? undefined,
    sourceUrl: s.sourceUrl,
    scrapedAt: s.scrapedAt.toISOString(),
    status: s.status as VehicleStatus,
    soldPrice: s.soldPrice ?? undefined,
    hasScreenshot: s.hasScreenshot,
  };
}

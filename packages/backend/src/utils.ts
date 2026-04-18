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
  };
}

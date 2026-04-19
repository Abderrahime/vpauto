import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import {
  applyPassageNavigation,
  buildPassageFromGroup,
  buildPriceHistory,
  computeEvolution,
  groupSnapshotsIntoPassages,
} from '../history.js';
import { findExactVehicle, findMatches } from '../matching.js';
import { parsePhotoUrls, snapshotToApi } from '../utils.js';
import type {
  VehicleSnapshot,
  VehicleHistory,
  VehiclePassage,
  VehiclePriceEvolution,
  VehicleBadge,
  BadgeType,
  ApiResponse,
  VehicleHistorySnapshotResponse,
} from '@vpauto/shared';

const app = new Hono();

function buildVehicleIdentity(vehicle: {
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
}, overrides?: { reference?: string | null; hashId?: string | null }) {
  return {
    reference: overrides?.reference ?? vehicle.reference ?? '',
    hashId: overrides?.hashId ?? vehicle.hashId ?? '',
    brand: vehicle.brand,
    model: vehicle.model,
    version: vehicle.version,
    year: vehicle.year,
    color: vehicle.color,
    fuel: vehicle.fuel,
    transmission: vehicle.transmission,
    engineSize: vehicle.engineSize ?? undefined,
    power: vehicle.power ?? undefined,
    fiscalPower: vehicle.fiscalPower ?? undefined,
  };
}

async function loadHistorySnapshotsForIdentity(input: {
  vehicleId: number;
  reference?: string | null;
  hashId?: string | null;
}) {
  const or = [{ vehicleId: input.vehicleId }] as { vehicleId?: number; reference?: string; hashId?: string }[];

  if (input.reference) {
    or.push({ reference: input.reference });
  }

  if (input.hashId) {
    or.push({ hashId: input.hashId });
  }

  return prisma.snapshot.findMany({
    where: { OR: or },
    orderBy: { scrapedAt: 'asc' },
  });
}

function toSnapshotWriteData(vehicleId: number, data: VehicleSnapshot) {
  return {
    vehicleId,
    reference: data.reference || null,
    hashId: data.hashId || null,
    brand: data.brand,
    model: data.model,
    version: data.version,
    year: data.year,
    mileage: data.mileage,
    color: data.color,
    fuel: data.fuel,
    transmission: data.transmission,
    engineSize: data.engineSize,
    power: data.power,
    fiscalPower: data.fiscalPower,
    doors: data.doors,
    seats: data.seats,
    co2: data.co2,
    critair: data.critair,
    euroStandard: data.euroStandard,
    bodyType: data.bodyType,
    startingPrice: data.startingPrice,
    startingPriceHT: data.startingPriceHT,
    marketValue: data.marketValue,
    newPrice: data.newPrice,
    vatRecoverable: data.vatRecoverable,
    currentAuctionPrice: data.currentAuctionPrice,
    city: data.city,
    center: data.center,
    department: data.department,
    saleDate: data.saleDate,
    saleTime: data.saleTime,
    lotNumber: data.lotNumber,
    technicalCheckUrl: data.technicalCheckUrl,
    conditionImageUrl: data.conditionImageUrl,
    observations: data.observations,
    maintenanceStatus: data.maintenanceStatus,
    serviceHistory: data.serviceHistory,
    firstOwner: data.firstOwner,
    warranty: data.warranty,
    equipment: data.equipment ? JSON.stringify(data.equipment) : null,
    photoUrls: JSON.stringify(data.photoUrls),
    cdnHash: data.cdnHash,
    sourceUrl: data.sourceUrl,
    status: data.status ?? 'available',
    soldPrice: data.soldPrice,
    scrapedAt: new Date(),
  };
}

/**
 * When enriching an existing snapshot, never let an incoming null/undefined/empty
 * clobber an already-stored fact. Reason: a second scrape on a sold detail page
 * no longer shows "Mise à prix", so the detail scraper returns startingPrice=undefined.
 * Before this fix, the enrichment wrote null over the previously-saved 21 300 € and
 * the MAP was lost forever. Facts (prices, CT/BE URLs, observations, maintenance,
 * vehicle identity fields) are preserved; dynamic fields (status, soldPrice,
 * saleDate, lotNumber, mileage, photos, sourceUrl, scrapedAt) are overwritten as before.
 */
function mergeSnapshotForEnrichment(
  existing: {
    reference: string | null;
    hashId: string | null;
    version: string;
    startingPrice: number | null;
    startingPriceHT: number | null;
    marketValue: number | null;
    newPrice: number | null;
    currentAuctionPrice: number | null;
    technicalCheckUrl: string | null;
    conditionImageUrl: string | null;
    observations: string | null;
    maintenanceStatus: string | null;
    serviceHistory: boolean | null;
    firstOwner: boolean | null;
    warranty: string | null;
    city: string;
    center: string | null;
    department: string | null;
    color: string;
    fuel: string;
    transmission: string;
    engineSize: number | null;
    power: number | null;
    fiscalPower: number | null;
    photoUrls: string;
    cdnHash: string | null;
  },
  vehicleId: number,
  data: VehicleSnapshot,
) {
  const base = toSnapshotWriteData(vehicleId, data);
  const pickFact = <T>(incoming: T | null | undefined, current: T | null | undefined): T | null =>
    (incoming ?? null) !== null ? (incoming as T) : (current ?? null);
  const pickString = (incoming: string | null | undefined, current: string | null | undefined) =>
    incoming && incoming.length > 0 ? incoming : (current && current.length > 0 ? current : incoming ?? null);

  // Preserve pre-existing photos when incoming has fewer/none
  const incomingPhotos = data.photoUrls || [];
  const existingPhotos = parsePhotoUrls(existing.photoUrls);
  const mergedPhotos = existingPhotos.length > incomingPhotos.length ? existingPhotos : incomingPhotos;

  return {
    ...base,
    reference: pickString(data.reference, existing.reference),
    hashId: pickString(data.hashId, existing.hashId),
    version: data.version && data.version.length > 0 ? data.version : existing.version,
    startingPrice: pickFact(data.startingPrice, existing.startingPrice),
    startingPriceHT: pickFact(data.startingPriceHT, existing.startingPriceHT),
    marketValue: pickFact(data.marketValue, existing.marketValue),
    newPrice: pickFact(data.newPrice, existing.newPrice),
    // currentAuctionPrice is dynamic (live bidding) — overwrite with the
    // latest scrape, don't preserve a stale value the way we do for the MAP.
    currentAuctionPrice: data.currentAuctionPrice ?? existing.currentAuctionPrice ?? null,
    technicalCheckUrl: pickString(data.technicalCheckUrl, existing.technicalCheckUrl),
    conditionImageUrl: pickString(data.conditionImageUrl, existing.conditionImageUrl),
    observations: pickString(data.observations, existing.observations),
    maintenanceStatus: pickString(data.maintenanceStatus, existing.maintenanceStatus),
    serviceHistory: pickFact(data.serviceHistory, existing.serviceHistory),
    firstOwner: pickFact(data.firstOwner, existing.firstOwner),
    warranty: pickString(data.warranty, existing.warranty),
    color: data.color && data.color.length > 0 ? data.color : existing.color,
    fuel: data.fuel && data.fuel.length > 0 ? data.fuel : existing.fuel,
    transmission: data.transmission && data.transmission.length > 0 ? data.transmission : existing.transmission,
    engineSize: pickFact(data.engineSize, existing.engineSize),
    power: pickFact(data.power, existing.power),
    fiscalPower: pickFact(data.fiscalPower, existing.fiscalPower),
    cdnHash: pickString(data.cdnHash, existing.cdnHash),
    photoUrls: JSON.stringify(mergedPhotos),
  };
}

function shouldEnrichRecentSnapshot(
  recentSnapshot: {
    reference: string | null;
    hashId: string | null;
    version: string;
    startingPrice: number | null;
    startingPriceHT: number | null;
    marketValue: number | null;
    newPrice: number | null;
    currentAuctionPrice: number | null;
    city: string;
    center: string | null;
    department: string | null;
    saleDate: string | null;
    saleTime: string | null;
    technicalCheckUrl: string | null;
    conditionImageUrl: string | null;
    observations: string | null;
    maintenanceStatus: string | null;
    serviceHistory: boolean | null;
    firstOwner: boolean | null;
    warranty: string | null;
    photoUrls: string;
    cdnHash: string | null;
    status: string;
    soldPrice: number | null;
  },
  data: VehicleSnapshot,
): boolean {
  const recentPhotoCount = parsePhotoUrls(recentSnapshot.photoUrls).length;
  const nextPhotoCount = data.photoUrls.length;

  return Boolean(
    (!recentSnapshot.reference && data.reference) ||
    (!recentSnapshot.hashId && data.hashId) ||
    (!recentSnapshot.version && data.version) ||
    recentSnapshot.startingPrice !== (data.startingPrice ?? null) ||
    recentSnapshot.startingPriceHT !== (data.startingPriceHT ?? null) ||
    recentSnapshot.marketValue !== (data.marketValue ?? null) ||
    recentSnapshot.newPrice !== (data.newPrice ?? null) ||
    recentSnapshot.currentAuctionPrice !== (data.currentAuctionPrice ?? null) ||
    recentSnapshot.city !== data.city ||
    recentSnapshot.center !== (data.center ?? null) ||
    recentSnapshot.department !== (data.department ?? null) ||
    recentSnapshot.saleDate !== (data.saleDate ?? null) ||
    recentSnapshot.saleTime !== (data.saleTime ?? null) ||
    recentSnapshot.technicalCheckUrl !== (data.technicalCheckUrl ?? null) ||
    recentSnapshot.conditionImageUrl !== (data.conditionImageUrl ?? null) ||
    recentSnapshot.observations !== (data.observations ?? null) ||
    recentSnapshot.maintenanceStatus !== (data.maintenanceStatus ?? null) ||
    recentSnapshot.serviceHistory !== (data.serviceHistory ?? null) ||
    recentSnapshot.firstOwner !== (data.firstOwner ?? null) ||
    recentSnapshot.warranty !== (data.warranty ?? null) ||
    recentSnapshot.cdnHash !== (data.cdnHash ?? null) ||
    recentSnapshot.status !== (data.status ?? 'available') ||
    recentSnapshot.soldPrice !== (data.soldPrice ?? null) ||
    nextPhotoCount > recentPhotoCount
  );
}

function toVehicleUpdateData(existing: {
  reference: string | null;
  hashId: string | null;
  version: string;
  color: string;
  fuel: string;
  transmission: string;
  engineSize: number | null;
  power: number | null;
  fiscalPower: number | null;
}, data: VehicleSnapshot) {
  return {
    lastSeenAt: new Date(),
    reference: data.reference || existing.reference || null,
    hashId: data.hashId || existing.hashId || null,
    version: data.version || existing.version,
    color: data.color || existing.color,
    fuel: data.fuel || existing.fuel,
    transmission: data.transmission || existing.transmission,
    engineSize: existing.engineSize ?? data.engineSize ?? null,
    power: existing.power ?? data.power ?? null,
    fiscalPower: existing.fiscalPower ?? data.fiscalPower ?? null,
  };
}

async function mergeVehicleIntoCanonical(sourceVehicleId: number, targetVehicleId: number): Promise<void> {
  if (!sourceVehicleId || !targetVehicleId || sourceVehicleId === targetVehicleId) return;

  await prisma.$transaction(async (tx) => {
    const [sourceVehicle, sourceWatchlist, targetWatchlist] = await Promise.all([
      tx.vehicle.findUnique({
        where: { id: sourceVehicleId },
        select: { id: true },
      }),
      tx.watchlist.findUnique({
        where: { vehicleId: sourceVehicleId },
        select: { id: true },
      }),
      tx.watchlist.findUnique({
        where: { vehicleId: targetVehicleId },
        select: { id: true },
      }),
    ]);

    if (!sourceVehicle) return;

    await tx.snapshot.updateMany({
      where: { vehicleId: sourceVehicleId },
      data: { vehicleId: targetVehicleId },
    });

    if (sourceWatchlist && !targetWatchlist) {
      await tx.watchlist.update({
        where: { vehicleId: sourceVehicleId },
        data: { vehicleId: targetVehicleId },
      });
    } else if (sourceWatchlist && targetWatchlist) {
      await tx.watchlist.delete({
        where: { vehicleId: sourceVehicleId },
      });
    }

    await tx.vehicle.delete({
      where: { id: sourceVehicleId },
    });
  });
}

// ── Save a snapshot (called by the extension when a vehicle page is visited) ──
const snapshotSchema = z.object({
  reference: z.string().optional(),
  hashId: z.string().optional(),
  brand: z.string(),
  model: z.string(),
  version: z.string().default(''),
  year: z.number(),
  mileage: z.number(),
  color: z.string().default(''),
  fuel: z.string().default(''),
  transmission: z.string().default(''),
  engineSize: z.number().optional(),
  power: z.number().optional(),
  fiscalPower: z.number().optional(),
  doors: z.number().optional(),
  seats: z.number().optional(),
  co2: z.number().optional(),
  critair: z.string().optional(),
  euroStandard: z.string().optional(),
  bodyType: z.string().optional(),
  startingPrice: z.number().optional(),
  startingPriceHT: z.number().optional(),
  marketValue: z.number().optional(),
  newPrice: z.number().optional(),
  currentAuctionPrice: z.number().optional(),
  vatRecoverable: z.boolean().default(false),
  city: z.string().default(''),
  center: z.string().optional(),
  department: z.string().optional(),
  saleDate: z.string().optional(),
  saleTime: z.string().optional(),
  lotNumber: z.number().optional(),
  technicalCheckUrl: z.string().optional(),
  conditionImageUrl: z.string().optional(),
  observations: z.string().optional(),
  maintenanceStatus: z.string().optional(),
  serviceHistory: z.boolean().optional(),
  firstOwner: z.boolean().optional(),
  warranty: z.string().optional(),
  equipment: z.array(z.string()).optional(),
  photoUrls: z.array(z.string()).default([]),
  cdnHash: z.string().optional(),
  sourceUrl: z.string(),
  status: z.string().default('available'),
  soldPrice: z.number().optional(),
});

app.post('/snapshot', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    console.error('[VPauto] Snapshot: Failed to parse JSON body:', err);
    return c.json<ApiResponse<null>>({ success: false, error: 'invalid_json_body' }, 400);
  }

  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message} (got ${JSON.stringify((body as Record<string,unknown>)[String(i.path[0])])})`).join(', ');
    console.error('[VPauto] Snapshot validation failed:', issues);
    return c.json<ApiResponse<null>>({ success: false, error: issues }, 400);
  }
  const data = parsed.data as VehicleSnapshot;
  console.log(`[VPauto] Snapshot: brand=${data.brand} model=${data.model} hashId=${data.hashId || 'N/A'} ref=${data.reference || 'N/A'}`);

  try {
    // Find or create the vehicle
    const vehicleMatch = await findExactVehicle(data);
    let vehicleId = vehicleMatch.vehicleId;
    const createdVehicle = !vehicleId;

    if (vehicleMatch.duplicateVehicleId && vehicleId && vehicleMatch.duplicateVehicleId !== vehicleId) {
      await mergeVehicleIntoCanonical(vehicleMatch.duplicateVehicleId, vehicleId);
      console.log(`[VPauto] Snapshot: Merged duplicate vehicle ${vehicleMatch.duplicateVehicleId} into canonical vehicle ${vehicleId} (${vehicleMatch.matchedBy || 'details'})`);
    }

    if (!vehicleId) {
      const vehicle = await prisma.vehicle.create({
        data: {
          reference: data.reference || null,
          hashId: data.hashId || null,
          brand: data.brand,
          model: data.model,
          version: data.version,
          year: data.year,
          color: data.color,
          fuel: data.fuel,
          transmission: data.transmission,
          engineSize: data.engineSize,
          power: data.power,
          fiscalPower: data.fiscalPower,
        },
      });
      vehicleId = vehicle.id;
      console.log(`[VPauto] Snapshot: Created new vehicle id=${vehicleId}`);
    } else {
      const existingVehicle = await prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: {
          reference: true,
          hashId: true,
          version: true,
          color: true,
          fuel: true,
          transmission: true,
          engineSize: true,
          power: true,
          fiscalPower: true,
        },
      });
      await prisma.vehicle.update({
        where: { id: vehicleId },
        data: existingVehicle ? toVehicleUpdateData(existingVehicle, data) : { lastSeenAt: new Date() },
      });
      console.log(`[VPauto] Snapshot: Found existing vehicle id=${vehicleId} via ${vehicleMatch.matchedBy || 'unknown'}`);
    }

    // Check if we already have a recent snapshot (within 1 hour) to avoid duplicates
    const recentSnapshot = await prisma.snapshot.findFirst({
      where: {
        vehicleId,
        scrapedAt: { gte: new Date(Date.now() - 3600000) },
      },
      orderBy: { scrapedAt: 'desc' },
    });

    if (recentSnapshot) {
      if (shouldEnrichRecentSnapshot(recentSnapshot, data)) {
        const enriched = await prisma.snapshot.update({
          where: { id: recentSnapshot.id },
          data: mergeSnapshotForEnrichment(recentSnapshot, vehicleId, data),
        });
        console.log(`[VPauto] Snapshot: Enriched recent snapshot id=${enriched.id} for vehicle=${vehicleId}`);

        return c.json<ApiResponse<{ vehicleId: number; snapshotId: number; duplicate: boolean; createdVehicle: boolean }>>({
          success: true,
          data: { vehicleId, snapshotId: enriched.id, duplicate: false, createdVehicle },
        });
      }

      console.log(`[VPauto] Snapshot: Duplicate (recent snapshot id=${recentSnapshot.id}) for vehicle=${vehicleId}`);
      return c.json<ApiResponse<{ vehicleId: number; snapshotId: number; duplicate: boolean; createdVehicle: boolean }>>({
        success: true,
        data: { vehicleId, snapshotId: recentSnapshot.id, duplicate: true, createdVehicle },
      });
    }

    const snapshot = await prisma.snapshot.create({
      data: toSnapshotWriteData(vehicleId, data),
    });
    console.log(`[VPauto] Snapshot: Created snapshot id=${snapshot.id} for vehicle=${vehicleId}`);

    return c.json<ApiResponse<{ vehicleId: number; snapshotId: number; duplicate: boolean; createdVehicle: boolean }>>({
      success: true,
      data: { vehicleId, snapshotId: snapshot.id, duplicate: false, createdVehicle },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VPauto] Snapshot: DB error for ${data.brand} ${data.model}:`, msg);
    return c.json<ApiResponse<null>>({ success: false, error: `db_error: ${msg}` }, 500);
  }
});

// ── Get vehicle history ──
app.get('/history/:vehicleId', async (c) => {
  const vehicleId = parseInt(c.req.param('vehicleId'));
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      snapshots: { orderBy: { scrapedAt: 'asc' } },
    },
  });

  if (!vehicle) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Vehicle not found' }, 404);
  }

  const historyReference = vehicle.reference || vehicle.snapshots.find((item) => item.reference)?.reference || null;

  // Delegate to pure helpers so the logic is unit-testable without a DB.
  const historySnapshots = await loadHistorySnapshotsForIdentity({
    vehicleId: vehicle.id,
    reference: historyReference,
    hashId: vehicle.hashId,
  });
  const sortedGroups = groupSnapshotsIntoPassages(historySnapshots);
  const rawPassages: VehiclePassage[] = sortedGroups.map((g, idx) => buildPassageFromGroup(g, idx));
  const passages = applyPassageNavigation(sortedGroups, rawPassages);
  const priceHistory = buildPriceHistory(passages);
  const mileageHistory = passages.map((p) => ({ date: p.date, mileage: p.mileage }));
  const evolution = computeEvolution(passages);

  const history: VehicleHistory = {
    vehicleId: vehicle.id,
    identity: buildVehicleIdentity(vehicle, { reference: historyReference, hashId: vehicle.hashId }),
    passages,
    totalPassages: passages.length,
    firstSeen: vehicle.firstSeenAt.toISOString(),
    lastSeen: vehicle.lastSeenAt.toISOString(),
    priceHistory,
    mileageHistory,
    evolution,
  };

  return c.json<ApiResponse<VehicleHistory>>({ success: true, data: history });
});

// ── Get one exact historical snapshot, reconstructed from the local DB ──
app.get('/history-snapshot/:snapshotId', async (c) => {
  const snapshotId = parseInt(c.req.param('snapshotId'));

  if (!Number.isFinite(snapshotId)) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Invalid snapshotId' }, 400);
  }

  const snapshot = await prisma.snapshot.findUnique({
    where: { id: snapshotId },
    include: { vehicle: true },
  });

  if (!snapshot || !snapshot.vehicle) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Snapshot not found' }, 404);
  }

  const relatedSnapshots = await prisma.snapshot.findMany({
    where: {
      OR: [
        { vehicleId: snapshot.vehicleId },
        ...(snapshot.reference ? [{ reference: snapshot.reference }] : []),
        ...(snapshot.hashId ? [{ hashId: snapshot.hashId }] : []),
      ],
    },
    orderBy: { scrapedAt: 'asc' },
  });

  const groups = groupSnapshotsIntoPassages(relatedSnapshots);
  const passageIndex = groups.findIndex((group) =>
    group.snapshots.some((item) => item.id === snapshot.id),
  );

  if (passageIndex < 0) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Snapshot passage not found' }, 404);
  }

  const response: VehicleHistorySnapshotResponse = {
    vehicleId: snapshot.vehicle.id,
    identity: buildVehicleIdentity(snapshot.vehicle, {
      reference: snapshot.reference ?? snapshot.vehicle.reference,
      hashId: snapshot.hashId ?? snapshot.vehicle.hashId,
    }),
    snapshot: snapshotToApi(snapshot),
    passageNumber: passageIndex + 1,
    totalPassages: groups.length,
    meta: {
      city: snapshot.city,
      center: snapshot.center ?? undefined,
      status: snapshot.status as VehicleHistorySnapshotResponse['meta']['status'],
      saleDate: snapshot.saleDate ?? undefined,
      saleTime: snapshot.saleTime ?? undefined,
    },
  };

  return c.json<ApiResponse<VehicleHistorySnapshotResponse>>({ success: true, data: response });
});

// ── Get vehicle by reference or hashId ──
app.get('/lookup', async (c) => {
  const reference = c.req.query('reference');
  const hashId = c.req.query('hashId');

  if (!reference && !hashId) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Provide reference or hashId' }, 400);
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: reference ? { reference } : { hashId },
    include: {
      snapshots: { orderBy: { scrapedAt: 'desc' }, take: 1 },
    },
  });

  if (!vehicle) {
    return c.json<ApiResponse<null>>({ success: true, data: null });
  }

  return c.json<ApiResponse<{ vehicleId: number; totalSnapshots: number; lastSnapshot: VehicleSnapshot | null }>>({
    success: true,
    data: {
      vehicleId: vehicle.id,
      totalSnapshots: await prisma.snapshot.count({ where: { vehicleId: vehicle.id } }),
      lastSnapshot: vehicle.snapshots[0] ? snapshotToApi(vehicle.snapshots[0]) : null,
    },
  });
});

// ── Get badges for a vehicle ──
app.get('/badges/:vehicleId', async (c) => {
  const vehicleId = parseInt(c.req.param('vehicleId'));
  const snapshots = await prisma.snapshot.findMany({
    where: { vehicleId },
    orderBy: { scrapedAt: 'asc' },
  });

  const badges: VehicleBadge[] = [];

  // Deduplicate by (city, saleDate) so "Vu X fois" counts real auction passages,
  // not raw scrape events (one passage usually has 4-8 scrapes).
  const passageKeys = new Set<string>();
  for (const s of snapshots) {
    const dateKey = s.saleDate || s.scrapedAt.toISOString().split('T')[0];
    passageKeys.add(`${s.city || 'unknown'}|${dateKey}`);
  }
  const passageCount = passageKeys.size;

  if (passageCount === 1) {
    badges.push({ type: 'new', label: 'Nouveau' });
  } else if (passageCount > 1) {
    badges.push({
      type: 'seen',
      label: `Vu ${passageCount} fois`,
      detail: `${passageCount} passages`,
    });

    // Check price changes
    const prices = snapshots.filter((s) => s.startingPrice != null).map((s) => s.startingPrice!);
    if (prices.length >= 2) {
      const lastPrice = prices[prices.length - 1];
      const prevPrice = prices[prices.length - 2];
      const diff = lastPrice - prevPrice;
      if (diff < 0) {
        badges.push({
          type: 'price_drop',
          label: 'Baisse de prix',
          detail: `${diff.toFixed(0)} €`,
        });
      } else if (diff > 0) {
        badges.push({
          type: 'price_up',
          label: 'Hausse de prix',
          detail: `+${diff.toFixed(0)} €`,
        });
      }
    }

    // Check reappearance (last snapshot was marked removed/unsold)
    const prevStatus = snapshots[snapshots.length - 2]?.status;
    if (prevStatus === 'removed' || prevStatus === 'unsold') {
      badges.push({ type: 'reappeared', label: 'Repasse en vente' });
    }
  }

  return c.json<ApiResponse<VehicleBadge[]>>({ success: true, data: badges });
});

// ── Find similar vehicles ──
app.post('/similar', async (c) => {
  const body = await c.req.json();
  const vehicleId = body.vehicleId as number | undefined;
  const snapshot = body.snapshot as VehicleSnapshot;

  const matches = await findMatches(snapshot, vehicleId);

  return c.json<ApiResponse<typeof matches>>({ success: true, data: matches });
});

// ── Find same model vehicles ──
app.get('/same-model', async (c) => {
  const brand = c.req.query('brand');
  const model = c.req.query('model');
  const excludeId = c.req.query('excludeVehicleId');

  if (!brand || !model) {
    return c.json<ApiResponse<null>>({ success: false, error: 'brand and model required' }, 400);
  }

  const vehicles = await prisma.vehicle.findMany({
    where: {
      brand: { equals: brand.toUpperCase() },
      model: { contains: model.toUpperCase() },
      ...(excludeId ? { id: { not: parseInt(excludeId) } } : {}),
    },
    include: {
      snapshots: { orderBy: { scrapedAt: 'desc' }, take: 1 },
    },
    take: 50,
  });

  const results = vehicles
    .filter((v) => v.snapshots.length > 0)
    .map((v) => ({
      vehicleId: v.id,
      snapshot: snapshotToApi(v.snapshots[0]),
    }));

  return c.json<ApiResponse<typeof results>>({ success: true, data: results });
});

// ── Batch save snapshots from list page (lightweight, for tracking) ──
// List cards expose a few extra identity signals when present: the VPauto
// reference (7+ digit number), motor power (ch), and transmission code
// (BVA/BVM/EAT/DSG…). We accept them optionally so that a newly-created
// Vehicle row from a list scrape carries enough identity to prevent the
// Bug #3 pollution (list-only Vehicle with reference=null was getting
// merged with the wrong detail-page car).
const listItemSchema = z.object({
  hashId: z.string(),
  reference: z.string().nullable().optional().transform(v => v ?? undefined),
  brand: z.string().default(''),
  model: z.string().default(''),
  version: z.string().default(''),
  year: z.coerce.number().default(0),
  mileage: z.coerce.number().default(0),
  power: z.number().nullable().optional().transform(v => v ?? undefined),
  transmission: z.string().nullable().optional().transform(v => v ?? undefined),
  city: z.string().default(''),
  startingPrice: z.number().nullable().optional().transform(v => v ?? undefined),
  currentAuctionPrice: z.number().nullable().optional().transform(v => v ?? undefined),
  soldPrice: z.number().nullable().optional().transform(v => v ?? undefined),
  status: z.string().default('available'),
  observations: z.string().nullable().optional().transform(v => v ?? undefined),
  lotNumber: z.number().nullable().optional().transform(v => v ?? undefined),
  sourceUrl: z.string().default(''),
  cdnHash: z.string().nullable().optional().transform(v => v ?? undefined),
  photoUrls: z.array(z.string()).default([]),
});

app.post('/batch-snapshot', async (c) => {
  let body: { vehicles: unknown[] };
  try {
    body = await c.req.json() as { vehicles: unknown[] };
  } catch (err) {
    console.error('[VPauto] Batch: Failed to parse JSON body:', err);
    return c.json<ApiResponse<null>>({ success: false, error: 'invalid_json_body' }, 400);
  }

  if (!Array.isArray(body.vehicles)) {
    console.error('[VPauto] Batch: vehicles is not an array, got:', typeof body.vehicles);
    return c.json<ApiResponse<null>>({ success: false, error: 'vehicles array required' }, 400);
  }

  console.log(`[VPauto] Batch: Received ${body.vehicles.length} vehicles`);

  const results: { hashId: string; vehicleId: number; isNew: boolean; priceChanged: number | null }[] = [];
  const now = new Date();
  const sixHoursAgo = new Date(now.getTime() - 6 * 3600000);

  // Parse and validate all items first
  const validItems: { hashId: string; data: z.infer<typeof listItemSchema> }[] = [];
  let skipped = 0;
  for (const raw of body.vehicles) {
    const parsed = listItemSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.hashId) {
      skipped++;
      continue;
    }
    validItems.push({ hashId: parsed.data.hashId, data: parsed.data });
  }
  console.log(`[VPauto] Batch: ${validItems.length} valid, ${skipped} skipped`);

  try {
    // Process in a transaction for much faster SQLite performance
    await prisma.$transaction(async (tx) => {
      for (const { hashId, data: v } of validItems) {
        // Find or create vehicle. We try BOTH by hashId and by reference (when
        // present on the list card) so that a detail-page-created Vehicle
        // (reference set, hashId set) is reused rather than duplicated when
        // the same car shows up on a list scrape.
        let vehicle = await tx.vehicle.findFirst({ where: { hashId } });
        if (!vehicle && v.reference) {
          vehicle = await tx.vehicle.findFirst({ where: { reference: v.reference } });
        }
        const isNew = !vehicle;

        if (!vehicle) {
          vehicle = await tx.vehicle.create({
            data: {
              hashId,
              reference: v.reference || null,
              brand: v.brand,
              model: v.model,
              version: v.version,
              year: v.year,
              color: '',
              fuel: '',
              // Keep transmission from the list card when the discriminator
              // regex caught something (e.g. "BVA8"). Empty string otherwise
              // (the detail scrape will populate it later).
              transmission: v.transmission || '',
              power: v.power ?? null,
            },
          });
        } else {
          // Fill gaps on the existing Vehicle row without overwriting facts
          // the detail scrape may have captured earlier.
          await tx.vehicle.update({
            where: { id: vehicle.id },
            data: {
              lastSeenAt: now,
              reference: vehicle.reference ?? v.reference ?? null,
              hashId: vehicle.hashId ?? hashId,
              power: vehicle.power ?? v.power ?? null,
              transmission: vehicle.transmission && vehicle.transmission.length > 0
                ? vehicle.transmission
                : (v.transmission || ''),
            },
          });
        }

        // Check for recent snapshot (within 6 hours to avoid flooding)
        const recentSnapshot = await tx.snapshot.findFirst({
          where: {
            vehicleId: vehicle.id,
            scrapedAt: { gte: sixHoursAgo },
          },
          orderBy: { scrapedAt: 'desc' },
        });

        let priceChanged: number | null = null;

        if (!recentSnapshot) {
          // Get previous snapshot for price comparison
          const prevSnapshot = await tx.snapshot.findFirst({
            where: { vehicleId: vehicle.id },
            orderBy: { scrapedAt: 'desc' },
          });

          if (prevSnapshot && v.startingPrice && prevSnapshot.startingPrice) {
            const diff = v.startingPrice - prevSnapshot.startingPrice;
            if (diff !== 0) priceChanged = diff;
          }

          await tx.snapshot.create({
            data: {
              vehicleId: vehicle.id,
              hashId,
              reference: v.reference || null,
              brand: v.brand,
              model: v.model,
              version: v.version,
              year: v.year,
              mileage: v.mileage,
              color: '',
              fuel: '',
              transmission: v.transmission || '',
              power: v.power ?? null,
              city: v.city,
              startingPrice: v.startingPrice,
              currentAuctionPrice: v.currentAuctionPrice,
              soldPrice: v.soldPrice,
              lotNumber: v.lotNumber,
              sourceUrl: v.sourceUrl,
              photoUrls: JSON.stringify(v.photoUrls),
              cdnHash: v.cdnHash,
              status: v.status || 'available',
              observations: v.observations,
              vatRecoverable: false,
            },
          });
        }

        results.push({
          hashId,
          vehicleId: vehicle.id,
          isNew,
          priceChanged,
        });
      }
    }, { timeout: 120000 }); // 2 min timeout for large batches
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VPauto] Batch: Transaction error:`, msg);
    return c.json<ApiResponse<null>>({ success: false, error: `batch_db_error: ${msg}` }, 500);
  }

  // Detect disappeared vehicles: those in DB with status 'available' but NOT in current list
  const currentHashIds = body.vehicles
    .map((v: any) => v.hashId)
    .filter(Boolean) as string[];

  const disappeared = await prisma.vehicle.findMany({
    where: {
      hashId: { notIn: currentHashIds },
      // Only flag recently active vehicles (seen in last 7 days)
      lastSeenAt: { gte: new Date(now.getTime() - 7 * 24 * 3600000) },
    },
    include: {
      snapshots: { orderBy: { scrapedAt: 'desc' }, take: 1 },
    },
  });

  const disappearedList = disappeared
    .filter(v => v.snapshots[0]?.status === 'available')
    .map(v => ({
      vehicleId: v.id,
      hashId: v.hashId || '',
      brand: v.brand,
      model: v.model,
      lastCity: v.snapshots[0]?.city || '',
      lastPrice: v.snapshots[0]?.startingPrice || 0,
    }));

  const newCount = results.filter(r => r.isNew).length;
  const priceChanges = results.filter(r => r.priceChanged !== null);

  console.log(`[VPauto] Batch: Done — saved=${results.length}, new=${newCount}, priceChanges=${priceChanges.length}, disappeared=${disappearedList.length}`);

  return c.json<ApiResponse<{
    saved: number;
    newVehicles: number;
    priceChanges: { hashId: string; vehicleId: number; diff: number }[];
    disappeared: { vehicleId: number; hashId: string; brand: string; model: string; lastCity: string; lastPrice: number }[];
  }>>({
    success: true,
    data: {
      saved: results.length,
      newVehicles: newCount,
      priceChanges: priceChanges.map(r => ({
        hashId: r.hashId,
        vehicleId: r.vehicleId,
        diff: r.priceChanged!,
      })),
      disappeared: disappearedList,
    },
  });
});

// ── Cross-auction history: all snapshots of a vehicle across cities ──
app.get('/cross-auction/:hashId', async (c) => {
  const hashId = c.req.param('hashId');
  const vehicle = await prisma.vehicle.findFirst({
    where: { hashId },
    include: {
      snapshots: { orderBy: { scrapedAt: 'desc' } },
    },
  });

  if (!vehicle) {
    return c.json<ApiResponse<null>>({ success: true, data: null });
  }

  const historyReference = vehicle.reference || vehicle.snapshots.find((item) => item.reference)?.reference || null;
  const historySnapshots = await loadHistorySnapshotsForIdentity({
    vehicleId: vehicle.id,
    reference: historyReference,
    hashId: vehicle.hashId,
  });
  const groups = groupSnapshotsIntoPassages(historySnapshots);
  const rawPassages = groups.map((group, index) => buildPassageFromGroup(group, index));
  const resolvedPassages = applyPassageNavigation(groups, rawPassages);

  const passages: {
    snapshotId: number;
    canonicalSnapshotId: number;
    city: string;
    saleDate: string;
    saleTime: string | null;
    status: string;
    startingPrice: number | null;
    soldPrice: number | null;
    lotNumber: number | null;
    mileage: number;
    scrapedAt: string;
    sourceUrl: string;
    isSourceUrlStable: boolean;
    openMode: VehiclePassage['openMode'];
    openReason: string;
  }[] = [];

  for (const [index, group] of groups.entries()) {
    const passage = resolvedPassages[index];
    const s = group.canonical;
    passages.push({
      snapshotId: passage.snapshotId,
      canonicalSnapshotId: passage.canonicalSnapshotId,
      city: passage.city,
      saleDate: passage.date,
      saleTime: passage.saleTime ?? null,
      status: passage.status,
      startingPrice: passage.startingPrice ?? null,
      soldPrice: passage.soldPrice ?? null,
      lotNumber: passage.lotNumber ?? null,
      mileage: passage.mileage,
      scrapedAt: s.scrapedAt.toISOString(),
      sourceUrl: passage.sourceUrl,
      isSourceUrlStable: passage.isSourceUrlStable,
      openMode: passage.openMode,
      openReason: passage.openReason,
    });
  }

  return c.json<ApiResponse<{
    vehicleId: number;
    brand: string;
    model: string;
    year: number;
    passages: typeof passages;
    firstStartingPrice: number | null;
  }>>({
    success: true,
    data: {
      vehicleId: vehicle.id,
      brand: vehicle.brand,
      model: vehicle.model,
      year: vehicle.year,
      passages,
      // The first ever starting price we recorded
      firstStartingPrice: historySnapshots
        .filter(s => s.startingPrice != null)
        .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime())[0]?.startingPrice || null,
    },
  });
});

// ── Similar vehicles sold recently (for price intelligence) ──
app.get('/similar-sold', async (c) => {
  const brand = c.req.query('brand');
  const model = c.req.query('model');
  const year = c.req.query('year') ? parseInt(c.req.query('year')!) : undefined;
  const mileage = c.req.query('mileage') ? parseInt(c.req.query('mileage')!) : undefined;
  const excludeHashId = c.req.query('excludeHashId');

  // Tolerance windows for "comparable" (used in the price-average sample).
  // Loose enough to accumulate data, tight enough that a 2020/144 k km van
  // can never be used as a comparable for a 2025/34 km van of the same model.
  const YEAR_TOLERANCE = 2;   // ± years
  const MILEAGE_TOLERANCE = 50_000; // ± km

  if (!brand) {
    return c.json<ApiResponse<null>>({ success: false, error: 'brand required' }, 400);
  }

  // Find sold vehicles of same brand (and optionally model)
  // Brands are stored as UPPERCASE — normalize the query
  const brandUpper = brand.toUpperCase();
  const where: any = {
    brand: { equals: brandUpper },
    status: 'sold',
    soldPrice: { not: null },
  };

  if (model) {
    const modelFirst = model.split(/\s+/)[0].toUpperCase();
    where.model = { contains: modelFirst };
  }

  if (excludeHashId) {
    where.hashId = { not: excludeHashId };
  }

  const soldSnapshots = await prisma.snapshot.findMany({
    where,
    orderBy: { scrapedAt: 'desc' },
    take: 50,
  });

  // Deduplicate by vehicle (keep most recent)
  const vehicleSeen = new Set<string>();
  const results: {
    hashId: string;
    brand: string;
    model: string;
    version: string;
    year: number;
    mileage: number;
    city: string;
    startingPrice: number | null;
    soldPrice: number;
    saleDate: string | null;
    sourceUrl: string;
    observations: string | null;
    yearMatch: boolean;
    modelMatch: boolean;
    mileageMatch: boolean;
  }[] = [];

  for (const s of soldSnapshots) {
    const key = s.hashId || `${s.brand}-${s.model}-${s.year}`;
    if (vehicleSeen.has(key)) continue;
    vehicleSeen.add(key);

    results.push({
      hashId: s.hashId || '',
      brand: s.brand,
      model: s.model,
      version: s.version,
      year: s.year,
      mileage: s.mileage,
      city: s.city,
      startingPrice: s.startingPrice,
      soldPrice: s.soldPrice!,
      saleDate: s.saleDate,
      sourceUrl: s.sourceUrl,
      observations: s.observations,
      yearMatch: year !== undefined ? Math.abs(s.year - year) <= YEAR_TOLERANCE : false,
      modelMatch: model ? s.model.toLowerCase().includes(model.split(/\s+/)[0].toLowerCase()) : false,
      mileageMatch: mileage !== undefined ? Math.abs(s.mileage - mileage) <= MILEAGE_TOLERANCE : false,
    });
  }

  // Sort: best overall match first (model + year + mileage), then degrade.
  results.sort((a, b) => {
    const scoreA = (a.modelMatch ? 4 : 0) + (a.yearMatch ? 2 : 0) + (a.mileageMatch ? 1 : 0);
    const scoreB = (b.modelMatch ? 4 : 0) + (b.yearMatch ? 2 : 0) + (b.mileageMatch ? 1 : 0);
    return scoreB - scoreA;
  });

  // Stats: only include results that are TRULY comparable — same model,
  // same year bracket, same mileage bracket, and drivable. No fallback to
  // looser pools: a single "Transit Custom 2020 144 k km" adjugé at 19 000 €
  // must not become the implied price target for a 2025 34 km Transit Custom
  // (user-reported bug). When no comparable sample exists, we return
  // count=0 / avg=null so the UI can tell the user the estimate is not
  // available rather than show a misleading number.
  const nonRoulantPattern = /non\s*roulant|hors\s*d[''\u2019]usage|[eé]pave|accident[eé]/i;
  const isDrivable = (r: { observations: string | null; model: string }) =>
    !nonRoulantPattern.test(r.observations || '') && !nonRoulantPattern.test(r.model || '');
  const isComparable = (r: typeof results[number]) => {
    if (!isDrivable(r)) return false;
    if (!r.modelMatch) return false;
    if (year !== undefined && !r.yearMatch) return false;
    if (mileage !== undefined && !r.mileageMatch) return false;
    return true;
  };
  const soldPrices = results.filter(isComparable).map((r) => r.soldPrice);
  const avgSoldPrice = soldPrices.length > 0
    ? Math.round(soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length)
    : null;
  const minSoldPrice = soldPrices.length > 0 ? Math.min(...soldPrices) : null;
  const maxSoldPrice = soldPrices.length > 0 ? Math.max(...soldPrices) : null;

  return c.json<ApiResponse<{
    results: typeof results;
    stats: {
      count: number;
      avgSoldPrice: number | null;
      minSoldPrice: number | null;
      maxSoldPrice: number | null;
    };
  }>>({
    success: true,
    data: {
      results: results.slice(0, 20),
      stats: {
        count: soldPrices.length,
        avgSoldPrice,
        minSoldPrice,
        maxSoldPrice,
      },
    },
  });
});

// ── Stats ──
app.get('/stats', async (c) => {
  const totalVehicles = await prisma.vehicle.count();
  const totalSnapshots = await prisma.snapshot.count();
  const cities = await prisma.snapshot.groupBy({
    by: ['city'],
    _count: true,
  });

  return c.json<ApiResponse<{ totalVehicles: number; totalSnapshots: number; cities: { city: string; count: number }[] }>>({
    success: true,
    data: {
      totalVehicles,
      totalSnapshots,
      cities: cities.map((c) => ({ city: c.city, count: c._count })),
    },
  });
});

export default app;

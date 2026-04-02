import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { findExactVehicle, findMatches } from '../matching.js';
import { snapshotToApi } from '../utils.js';
import type { VehicleSnapshot, VehicleHistory, VehiclePassage, VehicleBadge, BadgeType, ApiResponse } from '@vpauto/shared';

const app = new Hono();

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
  vatRecoverable: z.boolean().default(false),
  city: z.string(),
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
  const body = await c.req.json();
  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json<ApiResponse<null>>({ success: false, error: parsed.error.message }, 400);
  }
  const data = parsed.data as VehicleSnapshot;

  // Find or create the vehicle
  let vehicleId = await findExactVehicle(data);

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
  } else {
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { lastSeenAt: new Date() },
    });
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
    return c.json<ApiResponse<{ vehicleId: number; snapshotId: number; duplicate: boolean }>>({
      success: true,
      data: { vehicleId, snapshotId: recentSnapshot.id, duplicate: true },
    });
  }

  const snapshot = await prisma.snapshot.create({
    data: {
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
    },
  });

  return c.json<ApiResponse<{ vehicleId: number; snapshotId: number; duplicate: boolean }>>({
    success: true,
    data: { vehicleId, snapshotId: snapshot.id, duplicate: false },
  });
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

  const passages: VehiclePassage[] = vehicle.snapshots.map((s) => ({
    snapshotId: s.id,
    date: s.saleDate || s.scrapedAt.toISOString().split('T')[0],
    city: s.city,
    center: s.center ?? undefined,
    status: s.status as VehiclePassage['status'],
    startingPrice: s.startingPrice ?? undefined,
    soldPrice: s.soldPrice ?? undefined,
    mileage: s.mileage,
    observations: s.observations ?? undefined,
    technicalCheckUrl: s.technicalCheckUrl ?? undefined,
    sourceUrl: s.sourceUrl,
    photoUrl: JSON.parse(s.photoUrls)[0] ?? undefined,
  }));

  const priceHistory = vehicle.snapshots
    .filter((s) => s.startingPrice != null)
    .map((s) => ({
      date: s.saleDate || s.scrapedAt.toISOString().split('T')[0],
      price: s.startingPrice!,
    }));

  const mileageHistory = vehicle.snapshots.map((s) => ({
    date: s.saleDate || s.scrapedAt.toISOString().split('T')[0],
    mileage: s.mileage,
  }));

  const history: VehicleHistory = {
    vehicleId: vehicle.id,
    identity: {
      reference: vehicle.reference ?? '',
      hashId: vehicle.hashId ?? '',
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
    },
    passages,
    totalPassages: passages.length,
    firstSeen: vehicle.firstSeenAt.toISOString(),
    lastSeen: vehicle.lastSeenAt.toISOString(),
    priceHistory,
    mileageHistory,
  };

  return c.json<ApiResponse<VehicleHistory>>({ success: true, data: history });
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

  if (snapshots.length === 1) {
    badges.push({ type: 'new', label: 'Nouveau' });
  } else if (snapshots.length > 1) {
    badges.push({
      type: 'seen',
      label: `Vu ${snapshots.length} fois`,
      detail: `${snapshots.length} passages`,
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
      brand: { equals: brand, mode: 'insensitive' },
      model: { contains: model, mode: 'insensitive' },
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

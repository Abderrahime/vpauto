import type { Snapshot } from '@prisma/client';
import { EXACT_MATCH_THRESHOLD, MODEL_MATCH_THRESHOLD, SIMILAR_MATCH_THRESHOLD } from '@vpauto/shared';
import type { MatchLevel, MatchResult, VehicleSnapshot } from '@vpauto/shared';
import { prisma } from './db.js';
import { snapshotToApi } from './utils.js';

/**
 * Find the best matching vehicle for a given snapshot.
 * Priority: reference match > attribute match
 */
export async function findExactVehicle(data: VehicleSnapshot): Promise<number | null> {
  // 1. Try matching by reference (strongest signal)
  if (data.reference) {
    const byRef = await prisma.vehicle.findUnique({
      where: { reference: data.reference },
    });
    if (byRef) return byRef.id;
  }

  // 2. Try matching by hashId
  if (data.hashId) {
    const byHash = await prisma.vehicle.findFirst({
      where: { hashId: data.hashId },
    });
    if (byHash) return byHash.id;
  }

  // 3. Try matching by brand+model+year+color+similar mileage
  const candidates = await prisma.vehicle.findMany({
    where: {
      brand: data.brand,
      model: data.model,
      year: data.year,
      color: data.color,
    },
    include: {
      snapshots: {
        orderBy: { scrapedAt: 'desc' },
        take: 1,
      },
    },
  });

  for (const candidate of candidates) {
    const lastSnapshot = candidate.snapshots[0];
    if (!lastSnapshot) continue;
    // Mileage within 2000 km → likely same vehicle
    if (Math.abs(lastSnapshot.mileage - data.mileage) <= 2000) {
      return candidate.id;
    }
  }

  return null;
}

/**
 * Calculate similarity score between two vehicle snapshots.
 */
export function calculateSimilarityScore(
  a: { brand: string; model: string; version: string; year: number; mileage: number; color: string; fuel: string; transmission: string; engineSize?: number | null; power?: number | null },
  b: { brand: string; model: string; version: string; year: number; mileage: number; color: string; fuel: string; transmission: string; engineSize?: number | null; power?: number | null },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Brand (required for any match)
  if (a.brand.toLowerCase() === b.brand.toLowerCase()) {
    score += 15;
    reasons.push('Même marque');
  } else {
    return { score: 0, reasons: ['Marque différente'] };
  }

  // Model
  if (a.model.toLowerCase() === b.model.toLowerCase()) {
    score += 25;
    reasons.push('Même modèle');
  } else if (a.model.toLowerCase().includes(b.model.toLowerCase()) || b.model.toLowerCase().includes(a.model.toLowerCase())) {
    score += 15;
    reasons.push('Modèle similaire');
  } else {
    return { score, reasons: [...reasons, 'Modèle différent'] };
  }

  // Version/trim
  if (a.version && b.version && a.version.toLowerCase() === b.version.toLowerCase()) {
    score += 10;
    reasons.push('Même finition');
  }

  // Year (within 2 years)
  const yearDiff = Math.abs(a.year - b.year);
  if (yearDiff === 0) {
    score += 15;
    reasons.push('Même année');
  } else if (yearDiff <= 1) {
    score += 10;
    reasons.push('Année proche (±1)');
  } else if (yearDiff <= 2) {
    score += 5;
    reasons.push('Année proche (±2)');
  }

  // Mileage (within 30k km)
  const kmDiff = Math.abs(a.mileage - b.mileage);
  if (kmDiff <= 5000) {
    score += 10;
    reasons.push('Kilométrage très proche');
  } else if (kmDiff <= 15000) {
    score += 7;
    reasons.push('Kilométrage proche');
  } else if (kmDiff <= 30000) {
    score += 3;
    reasons.push('Kilométrage comparable');
  }

  // Fuel
  if (a.fuel.toLowerCase() === b.fuel.toLowerCase()) {
    score += 8;
    reasons.push('Même carburant');
  }

  // Transmission
  if (a.transmission.toLowerCase() === b.transmission.toLowerCase()) {
    score += 7;
    reasons.push('Même boîte');
  }

  // Color
  if (a.color.toLowerCase() === b.color.toLowerCase()) {
    score += 5;
    reasons.push('Même couleur');
  }

  // Engine
  if (a.engineSize && b.engineSize && a.engineSize === b.engineSize) {
    score += 3;
    reasons.push('Même cylindrée');
  }

  if (a.power && b.power && a.power === b.power) {
    score += 2;
    reasons.push('Même puissance');
  }

  return { score: Math.min(score, 100), reasons };
}

/**
 * Find vehicles matching at different levels.
 */
export async function findMatches(
  snapshot: VehicleSnapshot,
  excludeVehicleId?: number,
): Promise<MatchResult[]> {
  const results: MatchResult[] = [];

  // Find all snapshots of the same brand+model (latest per vehicle)
  const candidates = await prisma.vehicle.findMany({
    where: {
      brand: snapshot.brand,
      ...(excludeVehicleId ? { id: { not: excludeVehicleId } } : {}),
    },
    include: {
      snapshots: {
        orderBy: { scrapedAt: 'desc' },
        take: 1,
      },
    },
  });

  for (const candidate of candidates) {
    const lastSnap = candidate.snapshots[0];
    if (!lastSnap) continue;

    const { score, reasons } = calculateSimilarityScore(
      snapshot as unknown as Parameters<typeof calculateSimilarityScore>[0],
      lastSnap,
    );

    let level: MatchLevel;
    if (score >= EXACT_MATCH_THRESHOLD) {
      level = 'exact';
    } else if (score >= MODEL_MATCH_THRESHOLD) {
      level = 'same_model';
    } else if (score >= SIMILAR_MATCH_THRESHOLD) {
      level = 'similar';
    } else {
      continue;
    }

    results.push({
      level,
      score,
      vehicleId: candidate.id,
      snapshot: snapshotToApi(lastSnap),
      reasons,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

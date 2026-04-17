import type { Snapshot } from '@prisma/client';
import { EXACT_MATCH_THRESHOLD, MODEL_MATCH_THRESHOLD, SIMILAR_MATCH_THRESHOLD } from '@vpauto/shared';
import type { MatchLevel, MatchResult, VehicleSnapshot } from '@vpauto/shared';
import { prisma } from './db.js';
import { snapshotToApi } from './utils.js';

export interface ExactVehicleMatch {
  vehicleId: number | null;
  matchedBy: 'reference' | 'hash' | 'details' | null;
  duplicateVehicleId?: number | null;
  score?: number;
  reasons?: string[];
}

function normalize(value?: string | null): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlap(a?: string | null, b?: string | null): number {
  const aTokens = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const bTokens = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared++;
  }
  return shared / Math.max(aTokens.size, bTokens.size);
}

export function computeIdentityScore(
  input: VehicleSnapshot,
  candidate: {
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
  },
): { score: number; reasons: string[]; mileageDiff: number } {
  const lastSnapshot = candidate.snapshots[0];
  const reasons: string[] = [];
  let score = 0;

  if (normalize(candidate.brand) !== normalize(input.brand)) {
    return { score: 0, reasons: ['brand_mismatch'], mileageDiff: Number.POSITIVE_INFINITY };
  }

  const modelOverlap = tokenOverlap(candidate.model, input.model);
  if (modelOverlap >= 1) {
    score += 28;
    reasons.push('same_model');
  } else if (modelOverlap >= 0.6) {
    score += 18;
    reasons.push('close_model');
  } else {
    return { score: 0, reasons: ['model_mismatch'], mileageDiff: Number.POSITIVE_INFINITY };
  }

  const yearDiff = Math.abs(candidate.year - input.year);
  if (yearDiff === 0) {
    score += 14;
    reasons.push('same_year');
  } else if (yearDiff === 1) {
    score += 8;
    reasons.push('year_plus_minus_1');
  } else if (yearDiff > 1) {
    return { score: 0, reasons: ['year_mismatch'], mileageDiff: Number.POSITIVE_INFINITY };
  }

  const versionOverlap = tokenOverlap(candidate.version, input.version);
  if (versionOverlap >= 0.75) {
    score += 12;
    reasons.push('close_version');
  } else if (versionOverlap >= 0.5) {
    score += 6;
    reasons.push('partial_version');
  }

  const mileageDiff = lastSnapshot ? Math.abs(lastSnapshot.mileage - input.mileage) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(mileageDiff)) {
    if (mileageDiff <= 500) {
      score += 22;
      reasons.push('km_very_close');
    } else if (mileageDiff <= 1500) {
      score += 18;
      reasons.push('km_close');
    } else if (mileageDiff <= 3000) {
      score += 14;
      reasons.push('km_plus_minus_3k');
    } else if (mileageDiff <= 5000) {
      score += 8;
      reasons.push('km_plus_minus_5k');
    }
  }

  const candidateFuel = normalize(input.fuel ? candidate.fuel || lastSnapshot?.fuel : '');
  if (input.fuel && candidateFuel && candidateFuel === normalize(input.fuel)) {
    score += 8;
    reasons.push('same_fuel');
  }

  const candidateTransmission = normalize(input.transmission ? candidate.transmission || lastSnapshot?.transmission : '');
  if (input.transmission && candidateTransmission && candidateTransmission === normalize(input.transmission)) {
    score += 8;
    reasons.push('same_transmission');
  }

  const candidateColor = normalize(input.color ? candidate.color || lastSnapshot?.color : '');
  if (input.color && candidateColor && candidateColor === normalize(input.color)) {
    score += 5;
    reasons.push('same_color');
  }

  const candidateEngineSize = candidate.engineSize ?? lastSnapshot?.engineSize ?? null;
  if (input.engineSize && candidateEngineSize && input.engineSize === candidateEngineSize) {
    score += 8;
    reasons.push('same_engine_size');
  }

  const candidatePower = candidate.power ?? lastSnapshot?.power ?? null;
  if (input.power && candidatePower && input.power === candidatePower) {
    score += 6;
    reasons.push('same_power');
  }

  const candidateFiscalPower = candidate.fiscalPower ?? lastSnapshot?.fiscalPower ?? null;
  if (input.fiscalPower && candidateFiscalPower && input.fiscalPower === candidateFiscalPower) {
    score += 4;
    reasons.push('same_fiscal_power');
  }

  const sameCT = !!(
    input.technicalCheckUrl && lastSnapshot?.technicalCheckUrl
    && input.technicalCheckUrl === lastSnapshot.technicalCheckUrl
  );
  if (sameCT) {
    score += 35;
    reasons.push('same_technical_check');
  }

  const sameCondition = !!(
    input.conditionImageUrl && lastSnapshot?.conditionImageUrl
    && input.conditionImageUrl === lastSnapshot.conditionImageUrl
  );
  if (sameCondition) {
    score += 20;
    reasons.push('same_condition_sheet');
  }

  const sameCdnHash = !!(
    input.cdnHash && lastSnapshot?.cdnHash && input.cdnHash === lastSnapshot.cdnHash
  );
  if (sameCdnHash) {
    score += 15;
    reasons.push('same_photo_hash');
  }

  // Hard gate: two listings with no strong per-vehicle fingerprint (CT URL,
  // condition sheet, or photo cdnHash) and a mileage gap > 5 000 km cannot be
  // the same car. Without this, the score for "same model + year + version +
  // fuel + trans + color + engine" alone exceeds the 70-point threshold and
  // merges distinct Ford Pumas 2023 with 50k vs 130k km into one vehicle.
  const hasStrongFingerprint = sameCT || sameCondition || sameCdnHash;
  if (
    lastSnapshot
    && Number.isFinite(mileageDiff)
    && mileageDiff > 5000
    && !hasStrongFingerprint
  ) {
    return { score: 0, reasons: [...reasons, 'mileage_gap_without_fingerprint'], mileageDiff };
  }

  // Cross-reference gate: VPauto does NOT reuse a vehicle's reference across
  // re-listings (observed e.g. on a non-roulant Ford Transit Custom listed in
  // Nantes on 07/04 as ref 11372975, then again on 20/04 as ref 11409453 —
  // same VIN, same odometer 115 351 km, different ref). So differing refs
  // alone cannot rule out identity. But we also don't want to bridge two
  // genuinely distinct cars just because specs overlap. Accept a cross-ref
  // match only when a strong fingerprint matches OR the odometer reading is
  // nearly identical (≤ 500 km diff) — two distinct cars of the same model,
  // year and trim virtually never report the same mileage to the kilometre.
  if (
    candidate.reference
    && input.reference
    && candidate.reference !== input.reference
  ) {
    const nearIdenticalMileage = Number.isFinite(mileageDiff) && mileageDiff <= 500;
    if (!hasStrongFingerprint && !nearIdenticalMileage) {
      return { score: 0, reasons: [...reasons, 'different_reference_without_proof'], mileageDiff };
    }
    reasons.push('cross_reference_accepted');
  }

  return { score, reasons, mileageDiff };
}

/**
 * Find the best matching vehicle for a given snapshot.
 * Priority: reference match > attribute match
 */
export async function findExactVehicle(data: VehicleSnapshot): Promise<ExactVehicleMatch> {
  // 1. Try matching by reference (strongest signal)
  if (data.reference) {
    const byRef = await prisma.vehicle.findUnique({
      where: { reference: data.reference },
    });
    if (byRef) {
      return { vehicleId: byRef.id, matchedBy: 'reference', score: 100, reasons: ['same_reference'] };
    }
  }

  // 2. Candidate already created from list page with current hashId
  let byHashIdVehicleId: number | null = null;
  if (data.hashId) {
    const byHash = await prisma.vehicle.findFirst({
      where: { hashId: data.hashId },
    });
    if (byHash) {
      byHashIdVehicleId = byHash.id;
    }
  }

  // 3. Try matching by detailed identity against prior vehicles/snapshots.
  //    We DO NOT filter candidates by reference here: VPauto was observed
  //    reusing the same physical car under a fresh reference on re-listing
  //    (e.g. non-roulant Ford Transit Custom Nantes — ref 11372975 then ref
  //    11409453, same VIN, same odometer). Filtering at SQL level would hide
  //    those re-listings from identity scoring. The cross-reference gate in
  //    `computeIdentityScore` still requires a strong fingerprint (CT URL,
  //    condition sheet, photo hash) or near-identical mileage (≤ 500 km) to
  //    accept a cross-ref match, so distinct cars with the same trim/year
  //    cannot be accidentally merged.
  const candidates = await prisma.vehicle.findMany({
    where: {
      brand: data.brand,
      year: {
        gte: data.year - 1,
        lte: data.year + 1,
      },
    },
    include: {
      snapshots: {
        orderBy: { scrapedAt: 'desc' },
        take: 1,
      },
    },
  });

  let bestCandidate: { vehicleId: number; score: number; reasons: string[]; mileageDiff: number } | null = null;

  for (const candidate of candidates) {
    const scored = computeIdentityScore(data, candidate);
    if (scored.score === 0) continue;

    if (!bestCandidate || scored.score > bestCandidate.score) {
      bestCandidate = {
        vehicleId: candidate.id,
        score: scored.score,
        reasons: scored.reasons,
        mileageDiff: scored.mileageDiff,
      };
    }
  }

  const isStrongDetailsMatch = Boolean(
    bestCandidate
    && (
      bestCandidate.score >= 70
      || (
        bestCandidate.score >= 55
        && Number.isFinite(bestCandidate.mileageDiff)
        && bestCandidate.mileageDiff <= 3000
      )
    ),
  );

  if (byHashIdVehicleId) {
    if (
      isStrongDetailsMatch
      && bestCandidate
      && bestCandidate.vehicleId !== byHashIdVehicleId
      && bestCandidate.score >= 70
    ) {
      return {
        vehicleId: bestCandidate.vehicleId,
        matchedBy: 'details',
        duplicateVehicleId: byHashIdVehicleId,
        score: bestCandidate.score,
        reasons: bestCandidate.reasons,
      };
    }

    return {
      vehicleId: byHashIdVehicleId,
      matchedBy: 'hash',
      score: bestCandidate?.vehicleId === byHashIdVehicleId ? bestCandidate.score : 50,
      reasons: bestCandidate?.vehicleId === byHashIdVehicleId ? bestCandidate.reasons : ['same_hash'],
    };
  }

  if (isStrongDetailsMatch && bestCandidate) {
    return {
      vehicleId: bestCandidate.vehicleId,
      matchedBy: 'details',
      score: bestCandidate.score,
      reasons: bestCandidate.reasons,
    };
  }

  return { vehicleId: null, matchedBy: null };
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

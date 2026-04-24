import { describe, expect, it } from 'vitest';
import type { VehicleSnapshot } from '@vpauto/shared';
import { calculateSimilarityScore, computeIdentityScore } from './matching.js';

/**
 * Regression tests for the identity scoring logic.
 *
 * These pin down the critical guard-rails:
 *   - A real car can still match its own passage across auctions.
 *   - Two distinct physical cars with matching specs but divergent mileage
 *     MUST NOT be fused (the bug that merged different Ford Pumas into one).
 */

const baseInput: VehicleSnapshot = {
  reference: '11395424',
  hashId: '244cc94344',
  brand: 'FORD',
  model: 'Puma 1.0',
  version: 'Flexifuel 125 ch S&S mHEV ST-Line X',
  year: 2023,
  mileage: 50496,
  color: 'Gris',
  fuel: 'FH',
  transmission: '',
  engineSize: 999,
  power: 125,
  fiscalPower: null,
  city: 'LORIENT',
  center: null,
  sourceUrl: 'https://vpauto.fr/vehicule/xxx',
  saleDate: '2026-04-13',
  status: 'available',
  technicalCheckUrl: null,
  conditionImageUrl: null,
  cdnHash: null,
} as unknown as VehicleSnapshot;

function candidate(overrides: Partial<{
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
  snapshotMileage: number;
  snapshotCity: string;
  technicalCheckUrl: string | null;
  conditionImageUrl: string | null;
  cdnHash: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 1,
    reference: overrides.reference ?? '11395424',
    hashId: overrides.hashId ?? '244cc94344',
    brand: overrides.brand ?? baseInput.brand,
    model: overrides.model ?? baseInput.model,
    version: overrides.version ?? baseInput.version,
    year: overrides.year ?? baseInput.year,
    color: overrides.color ?? 'Gris',
    fuel: overrides.fuel ?? 'FH',
    transmission: overrides.transmission ?? '',
    engineSize: overrides.engineSize ?? 999,
    power: overrides.power ?? 125,
    fiscalPower: overrides.fiscalPower ?? null,
    snapshots: [
      {
        mileage: overrides.snapshotMileage ?? 50496,
        color: 'Gris',
        fuel: 'FH',
        transmission: '',
        engineSize: 999,
        power: 125,
        fiscalPower: null,
        technicalCheckUrl: overrides.technicalCheckUrl ?? null,
        conditionImageUrl: overrides.conditionImageUrl ?? null,
        cdnHash: overrides.cdnHash ?? null,
        saleDate: '2026-04-09',
        city: overrides.snapshotCity ?? 'LORIENT',
        scrapedAt: new Date('2026-04-09'),
      },
    ],
  };
}

describe('computeIdentityScore', () => {
  it('scores a high-confidence same-car match (same specs, same km)', () => {
    const result = computeIdentityScore(baseInput, candidate());
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('same_model');
    expect(result.reasons).toContain('same_year');
    expect(result.reasons).toContain('km_very_close');
  });

  it('rejects brand mismatch outright', () => {
    const result = computeIdentityScore(baseInput, candidate({ brand: 'PEUGEOT' }));
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('brand_mismatch');
  });

  it('rejects model mismatch outright', () => {
    const result = computeIdentityScore(baseInput, candidate({ model: 'Focus 1.5' }));
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('model_mismatch');
  });

  it('rejects when year gap exceeds 1 year', () => {
    const result = computeIdentityScore(baseInput, candidate({ year: 2021 }));
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('year_mismatch');
  });

  // ── Critical regression: Ford Puma contamination bug ──
  it('REJECTS same-spec candidate with > 5000 km gap and no strong fingerprint', () => {
    // This was the bug: two Ford Puma with identical specs but 130k vs 50k km
    // scored 89+ points and got fused. The hard gate must reject this.
    const result = computeIdentityScore(
      baseInput,
      candidate({
        snapshotMileage: 131809, // same specs, but 80k km gap
        technicalCheckUrl: null,
        conditionImageUrl: null,
        cdnHash: null,
      }),
    );
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('mileage_gap_without_fingerprint');
    expect(result.mileageDiff).toBe(131809 - 50496);
  });

  it('ACCEPTS same-spec candidate with large km gap when technicalCheckUrl matches', () => {
    // If a per-car fingerprint matches (CT report URL), the mileage gap is
    // allowed — this is the legitimate case of an odometer reading error or
    // rapid use between passages.
    const inputWithCT = { ...baseInput, technicalCheckUrl: 'https://ct.example/report-123.pdf' };
    const result = computeIdentityScore(
      inputWithCT,
      candidate({
        snapshotMileage: 131809,
        technicalCheckUrl: 'https://ct.example/report-123.pdf',
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('same_technical_check');
  });

  it('ACCEPTS same-spec candidate with large km gap when conditionImageUrl matches', () => {
    const inputWithCond = { ...baseInput, conditionImageUrl: 'https://cond.example/sheet-456.png' };
    const result = computeIdentityScore(
      inputWithCond,
      candidate({
        snapshotMileage: 131809,
        conditionImageUrl: 'https://cond.example/sheet-456.png',
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('same_condition_sheet');
  });

  it('ACCEPTS same-spec candidate with large km gap when cdnHash matches', () => {
    const inputWithHash = { ...baseInput, cdnHash: 'ab12cd34' };
    const result = computeIdentityScore(
      inputWithHash,
      candidate({
        snapshotMileage: 131809,
        cdnHash: 'ab12cd34',
      }),
    );
    expect(result.reasons).toContain('same_photo_hash');
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it('allows small mileage growth between passages (1000 km ≈ normal use)', () => {
    const result = computeIdentityScore(baseInput, candidate({ snapshotMileage: 51500 }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toContain('km_close');
  });

  it('tolerates mid-range mileage growth with partial score reduction (~3000 km)', () => {
    // 50496 + 2500 = 52996 → within the km_plus_minus_3k bucket
    const result = computeIdentityScore(baseInput, candidate({ snapshotMileage: 52996 }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toContain('km_plus_minus_3k');
  });

  it('allows 3-5k km gap with lower score', () => {
    // 50496 + 4000 = 54496 → km_plus_minus_5k, still allowed (no hard gate)
    const result = computeIdentityScore(baseInput, candidate({ snapshotMileage: 54496 }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toContain('km_plus_minus_5k');
  });

  // ── Cross-reference regression: Ford Transit Custom re-listing bug ──
  // VPauto sometimes re-assigns a new reference to the same physical car on
  // re-listing (observed on a non-roulant Transit Custom: ref 11372975 then
  // ref 11409453, same odometer 115 351 km, same specs). These tests pin
  // down the cross-reference gate: identity matching still accepts two
  // differing references when the mileage matches to the km OR when a
  // strong per-car fingerprint matches; but it rejects cross-ref matches
  // otherwise (so two distinct Ford Pumas are never merged).
  it('ACCEPTS same-spec candidate with DIFFERENT reference when mileage is identical (Ford Transit Custom bug)', () => {
    const inputWithRef = { ...baseInput, reference: '11409453', mileage: 115351 };
    const result = computeIdentityScore(
      inputWithRef,
      candidate({ reference: '11372975', snapshotMileage: 115351 }),
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('cross_reference_accepted');
    expect(result.reasons).toContain('km_very_close');
  });

  it('ACCEPTS same-spec candidate with DIFFERENT reference when near-identical mileage (≤ 500 km)', () => {
    // Odometer can tick forward a handful of km between two listings (car
    // moved on/off a transport truck). Anything within 500 km is still
    // considered "the same reading".
    const inputWithRef = { ...baseInput, reference: '11409453', mileage: 50700 };
    const result = computeIdentityScore(
      inputWithRef,
      candidate({ reference: '11372975', snapshotMileage: 50496 }),
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toContain('cross_reference_accepted');
  });

  it('REJECTS same-spec candidate with DIFFERENT reference when mileage drift > 500 km and no fingerprint', () => {
    // Two distinct Ford Pumas of the same trim/year with ~2k km drift must
    // stay distinct: without a CT URL, condition sheet or photo hash to
    // prove identity, differing references are the stronger signal.
    const inputWithRef = { ...baseInput, reference: '11409453', mileage: 52500 };
    const result = computeIdentityScore(
      inputWithRef,
      candidate({ reference: '11372975', snapshotMileage: 50496 }),
    );
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('different_reference_without_proof');
  });

  it('ACCEPTS same-spec candidate with DIFFERENT reference when a technicalCheckUrl fingerprint matches', () => {
    // Strong fingerprint overrides the cross-ref rejection: two refs but
    // same CT report URL = same car.
    const inputWithRef = {
      ...baseInput,
      reference: '11409453',
      mileage: 52500,
      technicalCheckUrl: 'https://ct.example/report-xyz.pdf',
    };
    const result = computeIdentityScore(
      inputWithRef,
      candidate({
        reference: '11372975',
        snapshotMileage: 50496,
        technicalCheckUrl: 'https://ct.example/report-xyz.pdf',
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('cross_reference_accepted');
    expect(result.reasons).toContain('same_technical_check');
  });

  // ── Missing-reference safety gate (CITROEN BERLINGO VAN bug) ──
  // VPauto's list-page flow used to create Vehicle rows with
  // reference=null/power=null/transmission='' (no identity fingerprint).
  // A later detail scrape of a DIFFERENT physical car of the same brand/
  // model/year/version would bypass the cross-reference gate (which needs
  // BOTH refs populated) and reach a 70+ score on spec overlap alone,
  // merging two distinct cars. These tests pin down the fix: when neither
  // side has a reference and no fingerprint matches, require at least one
  // identity discriminator (power, engineSize, or transmission).
  it('REJECTS attribute-only match when reference pair is missing and no discriminator agrees', () => {
    // Simulate: list-only Vehicle (reference=null, power=null, transmission='')
    // being scored against an incoming detail scrape that ALSO has no ref
    // (network glitch, deleted element, mid-migration data). Without a ref
    // pair and without any discriminator, the two cars could be completely
    // different — the matcher must refuse to merge.
    // A list-only Vehicle row has reference/power/transmission/engineSize
    // all null or empty (the list card doesn't expose them in the old flow).
    const listOnlyCandidate = candidate({
      power: 0,   // sentinel → overridden below via direct mutation
      transmission: '',
    });
    // ?? in the helper treats `null` as missing, so mutate post-facto.
    (listOnlyCandidate as { reference: string | null }).reference = null;
    (listOnlyCandidate as { power: number | null }).power = null;
    (listOnlyCandidate as { engineSize: number | null }).engineSize = null;
    (listOnlyCandidate.snapshots[0] as { power: number | null }).power = null;
    listOnlyCandidate.snapshots[0].transmission = '';
    (listOnlyCandidate.snapshots[0] as { engineSize: number | null }).engineSize = null;

    const inputWithoutRef = {
      ...baseInput,
      reference: '',   // detail scrape missed the Ref line too
      power: 130,
      engineSize: 1499,  // different block from the candidate
      transmission: 'Automatique EAT8',
    };
    const result = computeIdentityScore(inputWithoutRef, listOnlyCandidate);
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('no_reference_no_discriminator');
  });

  it('ACCEPTS attribute-only match when reference pair is missing but power agrees', () => {
    // Power alone is strong enough: 75 ch vs 130 ch variants of the same
    // model never overlap. When power matches, the list-only candidate is
    // likely the same car seen earlier from the list page.
    const listOnlyCandidate = candidate({
      power: 125,             // same as input
      transmission: '',
    });
    (listOnlyCandidate as { reference: string | null }).reference = null;

    const inputWithoutRef = {
      ...baseInput,
      reference: '',
      power: 125,
      transmission: '',
    };
    const result = computeIdentityScore(inputWithoutRef, listOnlyCandidate);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toContain('same_power');
    expect(result.reasons).not.toContain('no_reference_no_discriminator');
  });

  it('ACCEPTS cross-reference match via CT fingerprint even when discriminators disagree', () => {
    // A strong fingerprint (CT URL) bypasses the missing-ref gate — the
    // cross-ref branch already lets this through, and the new gate must
    // not undo that.
    const input = {
      ...baseInput,
      reference: '',
      power: 999,
      technicalCheckUrl: 'https://ct.example/strong-match.pdf',
    };
    const listOnlyCandidate = candidate({
      power: 125,
      technicalCheckUrl: 'https://ct.example/strong-match.pdf',
    });
    (listOnlyCandidate as { reference: string | null }).reference = null;

    const result = computeIdentityScore(input, listOnlyCandidate);
    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(result.reasons).toContain('same_technical_check');
    expect(result.reasons).not.toContain('no_reference_no_discriminator');
  });
});

// ── Similarity (cross-vehicle "similaires ailleurs" scoring) ──
//
// `calculateSimilarityScore` powers the "Similaires disponibles ailleurs"
// card in the sidepanel. Unlike `computeIdentityScore`, which decides
// whether two listings are the SAME car, this one decides whether two
// DIFFERENT cars are close enough to be a useful price benchmark.
//
// The regression that motivated this block: an AUDI A1 Sportback "40 TFSI
// 207 ch S Line" (ref 11406775) was matched with an AUDI A1 Sportback
// "35 TFSI 150 ch Design Luxe" (ref 11404612). Same chassis, but a 38 %
// power gap and a different engine variant in the Audi nomenclature →
// genuinely different price segment. The user reported this as misleading.
describe('calculateSimilarityScore — power gate (AUDI A1 11406775 regression)', () => {
  function audiA1(overrides: Partial<{
    version: string;
    year: number;
    mileage: number;
    color: string;
    fuel: string;
    transmission: string;
    engineSize: number | null;
    power: number | null;
  }> = {}) {
    // Note: we use `'key' in overrides` rather than `??` for nullable fields
    // (engineSize / power) — `null ?? 207` evaluates to `207`, which would
    // silently swallow an explicit null override.
    return {
      brand: 'AUDI',
      model: 'A1 Sportback',
      version: overrides.version ?? '40 TFSI 207 ch S tronic 7 S Line',
      year: overrides.year ?? 2022,
      mileage: overrides.mileage ?? 35000,
      color: overrides.color ?? 'Blanc',
      fuel: overrides.fuel ?? 'ES',
      transmission: overrides.transmission ?? 'BVA',
      engineSize: 'engineSize' in overrides ? overrides.engineSize ?? null : 1984,
      power: 'power' in overrides ? overrides.power ?? null : 207,
    };
  }

  it('REJECTS the 35 TFSI 150 ch as similar to a 40 TFSI 207 ch', () => {
    const input = audiA1({ power: 207 });
    const candidate = audiA1({
      version: '35 TFSI 150 ch S tronic 7 Design Luxe',
      power: 150,
      engineSize: 1498,
    });
    const result = calculateSimilarityScore(input, candidate);
    expect(result.score).toBe(0);
    expect(result.reasons.some((r) => r.includes('Puissance trop différente'))).toBe(true);
  });

  it('ACCEPTS a 40 TFSI 207 ch matched with a 40 TFSI 200 ch (within band)', () => {
    // Different production year of the same engine variant — still a fair
    // comparable. Power within ±5 % stays in the same price segment.
    const input = audiA1({ power: 207 });
    const candidate = audiA1({ power: 200, year: 2021 });
    const result = calculateSimilarityScore(input, candidate);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons.some((r) => r.includes('trop différente'))).toBe(false);
  });

  it('ACCEPTS exact power match and emits "Même puissance"', () => {
    const input = audiA1({ power: 207 });
    const candidate = audiA1({ power: 207, mileage: 42000 });
    const result = calculateSimilarityScore(input, candidate);
    expect(result.reasons).toContain('Même puissance (207 ch)');
  });

  it('emits a "Puissance ±X ch" reason when within band but not equal (UI signal)', () => {
    // The sidepanel reads `match.reasons.slice(0, 3)` — the delta string
    // must be there so the bidder sees "Puissance -10 ch (197 ch)" without
    // having to open the candidate page.
    const input = audiA1({ power: 207 });
    const candidate = audiA1({ power: 197 });
    const result = calculateSimilarityScore(input, candidate);
    expect(result.reasons.some((r) => /Puissance [+-]\d+ ch/.test(r))).toBe(true);
  });

  it('STAYS INERT when either side is missing power data (no false reject)', () => {
    // Older snapshots and list-only stubs can have power=null. The gate
    // must not fire in that case — falling back to the rest of the score
    // is safer than rejecting every legacy row.
    const input = audiA1({ power: null });
    const candidate = audiA1({ power: 150 });
    const result = calculateSimilarityScore(input, candidate);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes('trop différente'))).toBe(false);
  });

  it('uses a 25 ch absolute floor for small engines (75 vs 100 ch passes, 75 vs 130 ch fails)', () => {
    // For a 75 ch city car, 20 % is only 15 ch — too tight, would reject
    // genuinely close trims. The max(25, 0.2*power) floor lets a 75/100
    // pair through while still rejecting a 75/130 pair.
    const passing = calculateSimilarityScore(
      audiA1({ power: 75, version: 'TFSI 75 ch' }),
      audiA1({ power: 100, version: 'TFSI 100 ch' }),
    );
    const failing = calculateSimilarityScore(
      audiA1({ power: 75, version: 'TFSI 75 ch' }),
      audiA1({ power: 130, version: 'TFSI 130 ch' }),
    );
    expect(passing.score).toBeGreaterThan(0);
    expect(failing.score).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { isSpuriousStartingPrice } from './scraper';

describe('isSpuriousStartingPrice — VPauto placeholder detector', () => {
  // ── Non-100 values: always preserved ─────────────────────────────────────
  it('leaves a normal 15 000 € MAP alone even with a higher live bid', () => {
    expect(
      isSpuriousStartingPrice(15000, { currentAuctionPrice: 16500 }),
    ).toBe(false);
  });

  it('leaves MAP=200 € alone even with a big live bid', () => {
    // We only target the exact 100 € VPauto placeholder. Other low MAPs
    // (observed 18 snapshots with MAP=200 in the wild) are rare and real.
    expect(
      isSpuriousStartingPrice(200, { currentAuctionPrice: 5000 }),
    ).toBe(false);
  });

  it('leaves undefined/null alone (no value, no scrub)', () => {
    expect(isSpuriousStartingPrice(undefined, {})).toBe(false);
    // undefined is the only undefined-ish value we get from the scraper;
    // the backend also calls this with null through the wrapper.
  });

  // ── 100 € with no live signals: preserved (real scooter / épave) ─────────
  it('preserves a legitimate 100 € scooter MAP when no live signal contradicts', () => {
    expect(isSpuriousStartingPrice(100, {})).toBe(false);
  });

  it('preserves 100 € MAP with currentAuctionPrice just below the 500 € floor', () => {
    // A 100 € MAP scooter/épave bid up to 499 € stays clean.
    expect(
      isSpuriousStartingPrice(100, { currentAuctionPrice: 499 }),
    ).toBe(false);
  });

  it('preserves 100 € MAP with soldPrice at 400 €', () => {
    expect(isSpuriousStartingPrice(100, { soldPrice: 400 })).toBe(false);
  });

  // ── 100 € with live bid / sold proof: rejected ───────────────────────────
  it('rejects 100 € MAP when currentAuctionPrice ≥ 500 €', () => {
    // Nantes 20/04/26 SKODA Kodiaq: MAP=100 €, current bid=35 500 €.
    expect(
      isSpuriousStartingPrice(100, { currentAuctionPrice: 35500 }),
    ).toBe(true);
  });

  it('rejects 100 € MAP at the 500 € live-bid threshold', () => {
    expect(
      isSpuriousStartingPrice(100, { currentAuctionPrice: 500 }),
    ).toBe(true);
  });

  it('rejects 100 € MAP when soldPrice ≥ 500 €', () => {
    expect(isSpuriousStartingPrice(100, { soldPrice: 20000 })).toBe(true);
  });

  // ── 100 € with cote / prix neuf proof: rejected ──────────────────────────
  it('rejects 100 € MAP when marketValue (cote) ≥ 1000 €', () => {
    // NISSAN Qashqai ref 11407209: bogus 100 € MAP, cote = 28 500 €.
    expect(isSpuriousStartingPrice(100, { marketValue: 28500 })).toBe(true);
  });

  it('rejects 100 € MAP when newPrice (prix neuf) ≥ 1000 €', () => {
    expect(isSpuriousStartingPrice(100, { newPrice: 45350 })).toBe(true);
  });

  it('preserves 100 € MAP when marketValue is just below the 1000 € threshold', () => {
    // A real 900 € cote with a 100 € MAP is plausible (low-value lot).
    expect(isSpuriousStartingPrice(100, { marketValue: 999 })).toBe(false);
  });

  // ── null / undefined signals must not trigger false positives ────────────
  it('handles all-null signals (fresh listing with no bids, no cote)', () => {
    expect(
      isSpuriousStartingPrice(100, {
        currentAuctionPrice: undefined,
        soldPrice: undefined,
        marketValue: undefined,
        newPrice: undefined,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  isSpuriousStartingPrice,
  MAP_LIVE_BID_FLOOR,
  MAP_PLACEHOLDER_VALUE,
  MAP_VALUATION_FLOOR,
  scrubStartingPriceForWrite,
} from './utils.js';

/**
 * Defense-in-depth for the scraper's 100 € VPauto placeholder.
 *
 * The scraper already filters this value, but an older/compromised extension
 * or a direct API caller must not be able to pollute the DB with it. These
 * tests pin the threshold constants so any future tweak shows up in PR diff.
 */
describe('isSpuriousStartingPrice (backend write-path guard)', () => {
  it('exports the placeholder constants that match the scraper', () => {
    expect(MAP_PLACEHOLDER_VALUE).toBe(100);
    expect(MAP_LIVE_BID_FLOOR).toBe(500);
    expect(MAP_VALUATION_FLOOR).toBe(1000);
  });

  it('rejects 100 € MAP when currentAuctionPrice proves it is fake', () => {
    // Real case: SKODA Kodiaq ref 11402222, Nantes 20/04/26.
    expect(
      isSpuriousStartingPrice(100, { currentAuctionPrice: 35500 }),
    ).toBe(true);
  });

  it('rejects 100 € MAP when soldPrice proves it is fake', () => {
    expect(isSpuriousStartingPrice(100, { soldPrice: 20000 })).toBe(true);
  });

  it('rejects 100 € MAP when marketValue (cote) ≥ 1000 €', () => {
    // Real case: NISSAN Qashqai ref 11407209 (cote 28 500 €).
    expect(isSpuriousStartingPrice(100, { marketValue: 28500 })).toBe(true);
  });

  it('preserves a legitimate 15 000 € MAP unchanged', () => {
    expect(
      isSpuriousStartingPrice(15000, { currentAuctionPrice: 16500 }),
    ).toBe(false);
  });

  it('preserves a 100 € MAP with no contradicting signal (real scooter / épave)', () => {
    expect(isSpuriousStartingPrice(100, {})).toBe(false);
  });

  it('handles null signals as "no signal" (no false positive)', () => {
    expect(
      isSpuriousStartingPrice(100, {
        currentAuctionPrice: null,
        soldPrice: null,
        marketValue: null,
        newPrice: null,
      }),
    ).toBe(false);
  });

  it('ignores undefined/null startingPrice (nothing to scrub)', () => {
    expect(isSpuriousStartingPrice(null, { currentAuctionPrice: 35500 })).toBe(false);
    expect(isSpuriousStartingPrice(undefined, { currentAuctionPrice: 35500 })).toBe(false);
  });
});

describe('scrubStartingPriceForWrite (convenience wrapper)', () => {
  it('returns null for the spurious 100 € placeholder', () => {
    expect(
      scrubStartingPriceForWrite(100, { currentAuctionPrice: 35500 }),
    ).toBeNull();
  });

  it('returns the original value when it is legitimate', () => {
    expect(
      scrubStartingPriceForWrite(15000, { currentAuctionPrice: 16500 }),
    ).toBe(15000);
  });

  it('returns null when input is null', () => {
    expect(scrubStartingPriceForWrite(null, { currentAuctionPrice: 16500 })).toBeNull();
  });

  it('returns null when input is undefined', () => {
    expect(scrubStartingPriceForWrite(undefined, { currentAuctionPrice: 16500 })).toBeNull();
  });

  it('preserves a real 100 € scooter MAP (no contradiction)', () => {
    expect(scrubStartingPriceForWrite(100, {})).toBe(100);
    expect(scrubStartingPriceForWrite(100, { currentAuctionPrice: 300 })).toBe(100);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyPassageNavigation,
  buildLiveBidTrajectory,
  buildMapTrajectory,
  buildPassageEvents,
  buildPassageFromGroup,
  buildPassagesForVehicle,
  buildPriceHistory,
  computeEvolution,
  findFinalSoldDate,
  groupSnapshotsIntoPassages,
  pickLatestLiveBid,
  pickPassageSaleDate,
  pickStartingPrice,
  truncateAfterFinalSale,
  type SnapshotForHistory,
} from './history.js';

/**
 * Regression tests for the pure history helpers. These pin down the
 * real-world bugs that motivated the refactor:
 *
 *   1. Audi A4 1332: same hashId scraped across 2 saleDates produced 2
 *      fake passages. Grouping must be hashId-primary.
 *   2. Audi A4 1332: seller dropped MAP 3900 → 3500 before sale, but UI
 *      showed "Stable 3500 → 3500". mapTrajectory must expose the drop.
 *   3. Mercedes 294: a one-off sold-page snapshot reporting 21 700 €
 *      poisoned the passage, hiding the real +100€ gain. pickStartingPrice
 *      must prefer the latest pre-sale snapshot and reject 1-off outliers.
 */

function snap(overrides: Partial<SnapshotForHistory>): SnapshotForHistory {
  // Use `in` checks rather than ?? so explicit null/0 values pass through.
  const base: SnapshotForHistory = {
    id: 1,
    hashId: 'deadbeef',
    city: 'PARIS',
    center: null,
    status: 'available',
    saleDate: '2026-04-13',
    saleTime: null,
    scrapedAt: new Date('2026-04-10T10:00:00Z'),
    startingPrice: null,
    currentAuctionPrice: null,
    soldPrice: null,
    marketValue: null,
    newPrice: null,
    mileage: 50000,
    lotNumber: null,
    observations: null,
    technicalCheckUrl: null,
    sourceUrl: 'https://vpauto.fr/v/x',
    photoUrls: '[]',
  };
  return { ...base, ...overrides };
}

describe('groupSnapshotsIntoPassages', () => {
  it('groups snapshots with the same hashId into ONE passage even if saleDate differs (Audi A4 1332 regression)', () => {
    // Real case: scraped on 2026-04-09 with a provisional saleDate, then
    // re-scraped on 2026-04-13 (sale day) when the date was refreshed. Both
    // share hashId b57162b44 because it's the same listing.
    const snaps = [
      snap({
        id: 1,
        hashId: 'b57162b44',
        saleDate: '2026-04-09',
        scrapedAt: new Date('2026-04-09T08:00:00Z'),
        startingPrice: 3900,
        status: 'available',
      }),
      snap({
        id: 2,
        hashId: 'b57162b44',
        saleDate: '2026-04-13',
        scrapedAt: new Date('2026-04-13T08:00:00Z'),
        startingPrice: 3500,
        status: 'available',
      }),
      snap({
        id: 3,
        hashId: 'b57162b44',
        saleDate: '2026-04-13',
        scrapedAt: new Date('2026-04-13T18:00:00Z'),
        soldPrice: 3500,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(1);
    expect(groups[0].snapshots).toHaveLength(3);
  });

  it('falls back to (city, saleDate) for legacy snapshots without hashId', () => {
    const snaps = [
      snap({ id: 1, hashId: null, city: 'LYON', saleDate: '2026-01-10' }),
      snap({ id: 2, hashId: null, city: 'LYON', saleDate: '2026-01-10' }),
      snap({ id: 3, hashId: null, city: 'LYON', saleDate: '2026-02-14' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(2);
    expect(groups[0].snapshots).toHaveLength(2);
    expect(groups[1].snapshots).toHaveLength(1);
  });

  it('prefers the sold snapshot as canonical (so soldPrice is never lost)', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'abc',
        scrapedAt: new Date('2026-04-13T18:00:00Z'),
        soldPrice: 14900,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'abc',
        scrapedAt: new Date('2026-04-13T20:00:00Z'), // later scrape but no sold
        startingPrice: 14300,
        status: 'available',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups[0].canonical.id).toBe(1);
    expect(groups[0].canonical.soldPrice).toBe(14900);
  });

  it('separates distinct hashIds into distinct passages (re-listing)', () => {
    const snaps = [
      snap({ id: 1, hashId: 'listing-A', saleDate: '2026-01-10' }),
      snap({ id: 2, hashId: 'listing-B', saleDate: '2026-02-14' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(2);
  });

  it('sorts passages chronologically (oldest first)', () => {
    const snaps = [
      snap({ id: 2, hashId: 'later', saleDate: '2026-03-01' }),
      snap({ id: 1, hashId: 'earlier', saleDate: '2026-01-01' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups[0].canonical.id).toBe(1);
    expect(groups[1].canonical.id).toBe(2);
  });

  it('splits a same-hashId relist (sold then re-auctioned) into TWO passages (Symbioz regression)', () => {
    // Real case: RENAULT Symbioz ref 11404337, hashId 333f8ad378 reused by
    // VPauto across two successive Rouen sales — adjugé 24 000 € on 15 avr,
    // then relisted and adjugé again 24 000 € on 18 avr. The old grouping
    // collapsed both into one passage, hiding the 15-apr sale from history.
    const snaps = [
      snap({
        id: 1,
        hashId: '333f8ad378',
        saleDate: '2026-04-15',
        scrapedAt: new Date('2026-04-14T08:00:00Z'),
        startingPrice: 22000,
        status: 'available',
      }),
      snap({
        id: 2,
        hashId: '333f8ad378',
        saleDate: '2026-04-15',
        scrapedAt: new Date('2026-04-15T18:00:00Z'),
        startingPrice: 22000,
        soldPrice: 24000,
        status: 'sold',
      }),
      snap({
        id: 3,
        hashId: '333f8ad378',
        saleDate: '2026-04-18',
        scrapedAt: new Date('2026-04-16T09:00:00Z'),
        startingPrice: 22500,
        status: 'available',
      }),
      snap({
        id: 4,
        hashId: '333f8ad378',
        saleDate: '2026-04-18',
        scrapedAt: new Date('2026-04-18T18:00:00Z'),
        startingPrice: 22500,
        soldPrice: 24000,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(2);
    // Passage 1 = 15 avr
    expect(groups[0].canonical.saleDate).toBe('2026-04-15');
    expect(groups[0].canonical.soldPrice).toBe(24000);
    expect(groups[0].snapshots.map((s) => s.id).sort()).toEqual([1, 2]);
    // Passage 2 = 18 avr
    expect(groups[1].canonical.saleDate).toBe('2026-04-18');
    expect(groups[1].canonical.soldPrice).toBe(24000);
    expect(groups[1].snapshots.map((s) => s.id).sort()).toEqual([3, 4]);
  });

  it('splits an unsold-then-relisted car into TWO passages', () => {
    // Vehicle went unsold on 10 jan, then relisted and sold on 14 feb.
    const snaps = [
      snap({
        id: 1,
        hashId: 'abc',
        saleDate: '2026-01-10',
        scrapedAt: new Date('2026-01-10T18:00:00Z'),
        startingPrice: 8000,
        status: 'unsold',
      }),
      snap({
        id: 2,
        hashId: 'abc',
        saleDate: '2026-02-14',
        scrapedAt: new Date('2026-02-12T10:00:00Z'),
        startingPrice: 7500,
        status: 'available',
      }),
      snap({
        id: 3,
        hashId: 'abc',
        saleDate: '2026-02-14',
        scrapedAt: new Date('2026-02-14T18:00:00Z'),
        startingPrice: 7500,
        soldPrice: 8200,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(2);
    expect(groups[0].canonical.status).toBe('unsold');
    expect(groups[1].canonical.status).toBe('sold');
  });

  it('orders by saleDate before scrapedAt when late-ingested rows would otherwise mix two passages', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'abc',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-10T10:00:00Z'),
        status: 'available',
      }),
      snap({
        id: 2,
        hashId: 'abc',
        saleDate: '2026-04-14',
        scrapedAt: new Date('2026-04-11T10:00:00Z'),
        status: 'unsold',
      }),
      snap({
        id: 3,
        hashId: 'abc',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-12T10:00:00Z'),
        status: 'unsold',
      }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);

    expect(groups).toHaveLength(2);
    expect(groups[0].canonical.saleDate).toBe('2026-04-14');
    expect(groups[1].canonical.saleDate).toBe('2026-04-17');
    expect(groups[0].snapshots.map((snapshot) => snapshot.id)).toEqual([2]);
    expect(groups[1].snapshots.map((snapshot) => snapshot.id)).toEqual([1, 3]);
  });

  it('keeps post-sale linger (same saleDate, same hashId) in the sold passage', () => {
    // After the sold snap, VPauto may still show the listing as "available"
    // for a short window before purging. That linger must not fork a passage.
    const snaps = [
      snap({
        id: 1,
        hashId: 'abc',
        saleDate: '2026-04-13',
        scrapedAt: new Date('2026-04-13T18:00:00Z'),
        startingPrice: 14300,
        soldPrice: 14900,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'abc',
        saleDate: '2026-04-13',
        scrapedAt: new Date('2026-04-13T21:00:00Z'),
        startingPrice: 14300,
        status: 'available',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical.id).toBe(1); // sold stays canonical
    expect(groups[0].snapshots).toHaveLength(2);
  });

  it('splits two sold snapshots with distinct saleDates (double-sale)', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'abc',
        saleDate: '2026-04-13',
        scrapedAt: new Date('2026-04-13T18:00:00Z'),
        soldPrice: 10000,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'abc',
        saleDate: '2026-04-20',
        scrapedAt: new Date('2026-04-20T18:00:00Z'),
        soldPrice: 10500,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(2);
    expect(groups[0].canonical.saleDate).toBe('2026-04-13');
    expect(groups[1].canonical.saleDate).toBe('2026-04-20');
  });
});

describe('buildMapTrajectory', () => {
  it('captures a reserve drop during the listing window (Audi A4 3900 → 3500)', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-13T08:00:00Z'), startingPrice: 3500, status: 'available' }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([3900, 3500]);
  });

  it('collapses consecutive equal values', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-11T08:00:00Z'), startingPrice: 3500, status: 'available' }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([3500]);
  });

  it('ignores sold-page snapshots (post-sale noise)', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-13T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-13T19:00:00Z'), startingPrice: 21700, status: 'sold', soldPrice: 21400 }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([21300]);
  });

  it('returns [] when no pre-sale snapshot has a price', () => {
    const snaps = [
      snap({ status: 'sold', startingPrice: null, soldPrice: 14900 }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([]);
  });
});

describe('pickStartingPrice', () => {
  it('prefers the latest pre-sale snapshot (Mercedes 294 regression)', () => {
    // 4 pre-sale scrapes all show 21 300 €, then a single sold-page scrape
    // shows 21 700 € (VPauto briefly rewrites the MAP field on sold pages).
    // pickStartingPrice must return 21 300 €, not 21 700 €.
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-11T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-13T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-13T19:00:00Z'), startingPrice: 21700, soldPrice: 21400, status: 'sold' }),
    ];
    expect(pickStartingPrice(snaps)).toBe(21300);
  });

  it('returns the most recent pre-sale value when the reserve changed', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 3500, status: 'available' }),
    ];
    expect(pickStartingPrice(snaps)).toBe(3500);
  });

  it('falls back to the mode when no pre-sale snapshot exists', () => {
    // Only sold-page data; pick the value seen most often.
    const snaps = [
      snap({ startingPrice: 21300, status: 'sold', soldPrice: 21400 }),
      snap({ startingPrice: 21300, status: 'sold', soldPrice: 21400 }),
      snap({ startingPrice: 21700, status: 'sold', soldPrice: 21400 }),
    ];
    expect(pickStartingPrice(snaps)).toBe(21300);
  });

  it('returns undefined when every snapshot lacks a startingPrice', () => {
    const snaps = [
      snap({ startingPrice: null, soldPrice: 14900, status: 'sold' }),
    ];
    expect(pickStartingPrice(snaps)).toBeUndefined();
  });
});

describe('buildPassageFromGroup', () => {
  it('uses the full MAP trajectory as the passage startingPrice when the reserve moved', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-13T18:00:00Z'), soldPrice: 3500, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.passageNumber).toBe(1);
    expect(p.startingPrice).toBe(3500); // final MAP
    expect(p.soldPrice).toBe(3500);
    expect(p.mapTrajectory).toEqual([3900, 3500]);
  });

  it('does not set mapTrajectory when the MAP was constant', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-13T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-13T19:00:00Z'), soldPrice: 21400, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.mapTrajectory).toBeUndefined();
    expect(p.startingPrice).toBe(21300);
    expect(p.soldPrice).toBe(21400);
  });

  it('uses the first photo from the JSON array string', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'a',
        photoUrls: JSON.stringify(['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg']),
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.photoUrl).toBe('https://cdn.example/1.jpg');
  });

  it('handles malformed photoUrls gracefully', () => {
    const snaps = [snap({ id: 1, photoUrls: 'not-json' })];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.photoUrl).toBeUndefined();
  });
});

describe('buildPassageEvents', () => {
  it('compresses identical snapshots inside the same passage into one business event', () => {
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-03T08:00:00Z'), startingPrice: 8300, status: 'available' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-03T10:00:00Z'), startingPrice: 8300, status: 'available' }),
      snap({ id: 3, scrapedAt: new Date('2026-04-03T12:00:00Z'), startingPrice: 8300, status: 'available' }),
    ];

    const events = buildPassageEvents(snaps);

    expect(events).toHaveLength(1);
    expect(events[0].snapshotId).toBe(1);
    expect(events[0].startingPrice).toBe(8300);
  });

  it('emits an additional event when the MAP changes inside one passage', () => {
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-03T08:00:00Z'), startingPrice: 8300, status: 'available' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-03T12:00:00Z'), startingPrice: 7900, status: 'available' }),
    ];

    const events = buildPassageEvents(snaps);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.startingPrice)).toEqual([8300, 7900]);
  });

  it('emits an additional event when the status changes inside one passage', () => {
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-14T08:00:00Z'), startingPrice: 7400, status: 'available' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-14T18:00:00Z'), startingPrice: 7400, status: 'unsold' }),
    ];

    const events = buildPassageEvents(snaps);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.status)).toEqual(['available', 'unsold']);
  });
});

describe('historical passage reconstruction', () => {
  it('keeps 03/04, 14/04 and 17/04 as three distinct passages with their own canonical snapshots', () => {
    const snaps = [
      snap({ id: 101, hashId: 'b301f0d194', saleDate: '2026-04-03', scrapedAt: new Date('2026-04-03T18:00:00Z'), startingPrice: 8300, status: 'unsold' }),
      snap({ id: 201, hashId: '290fa1ed6a', saleDate: '2026-04-14', scrapedAt: new Date('2026-04-14T18:00:00Z'), startingPrice: 7400, status: 'unsold' }),
      snap({ id: 301, hashId: '290fa1ed6a', saleDate: '2026-04-17', scrapedAt: new Date('2026-04-16T09:00:00Z'), startingPrice: 7400, status: 'available' }),
      snap({ id: 302, hashId: '290fa1ed6a', saleDate: '2026-04-17', scrapedAt: new Date('2026-04-17T18:00:00Z'), startingPrice: 7400, status: 'unsold' }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((group, index) => buildPassageFromGroup(group, index));

    expect(groups).toHaveLength(3);
    expect(passages.map((passage) => passage.date)).toEqual(['2026-04-03', '2026-04-14', '2026-04-17']);
    expect(passages.map((passage) => passage.snapshotId)).toEqual([101, 201, 302]);
  });
});

describe('applyPassageNavigation', () => {
  it('opens an older canonical passage in VPauto when its historical URL stays unique', () => {
    const snaps = [
      snap({
        id: 101,
        hashId: 'b301f0d194',
        saleDate: '2026-04-03',
        scrapedAt: new Date('2026-04-03T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://vpauto.fr/vehicule/b301f0d194/polo',
      }),
      snap({
        id: 201,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-14',
        scrapedAt: new Date('2026-04-14T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
      snap({
        id: 301,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-17T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://www.vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = applyPassageNavigation(
      groups,
      groups.map((group, index) => buildPassageFromGroup(group, index)),
    );

    expect(passages[0].openMode).toBe('vpauto');
    expect(passages[0].isSourceUrlStable).toBe(true);
    expect(passages[0].events[0].openMode).toBe('vpauto');
  });

  it('falls back to the local fiche when a canonical passage URL is reused later', () => {
    const snaps = [
      snap({
        id: 201,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-14',
        scrapedAt: new Date('2026-04-14T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
      snap({
        id: 301,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-17T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://www.vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = applyPassageNavigation(
      groups,
      groups.map((group, index) => buildPassageFromGroup(group, index)),
    );

    expect(passages[0].openMode).toBe('local');
    expect(passages[0].isSourceUrlStable).toBe(false);
    expect(passages[0].openReason).toContain('réutilisée');
  });

  it('keeps intermediate snapshots local even when the canonical passage can open in VPauto', () => {
    const snaps = [
      snap({
        id: 401,
        hashId: 'stable-hash',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-16T08:00:00Z'),
        status: 'available',
        sourceUrl: 'https://vpauto.fr/vehicule/stable-hash/polo',
      }),
      snap({
        id: 402,
        hashId: 'stable-hash',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-17T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://vpauto.fr/vehicule/stable-hash/polo',
      }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = applyPassageNavigation(
      groups,
      groups.map((group, index) => buildPassageFromGroup(group, index)),
    );

    expect(passages[0].openMode).toBe('vpauto');
    expect(passages[0].events).toHaveLength(2);
    expect(passages[0].events[0].snapshotId).toBe(401);
    expect(passages[0].events[0].openMode).toBe('local');
    expect(passages[0].events[0].openReason).toContain('intermédiaire');
    expect(passages[0].events[1].snapshotId).toBe(402);
    expect(passages[0].events[1].openMode).toBe('vpauto');
  });

  it('allows the latest canonical passage to open in VPauto even if the same hash was reused earlier', () => {
    const snaps = [
      snap({
        id: 201,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-14',
        scrapedAt: new Date('2026-04-14T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
      snap({
        id: 301,
        hashId: '290fa1ed6a',
        saleDate: '2026-04-17',
        scrapedAt: new Date('2026-04-17T18:00:00Z'),
        status: 'unsold',
        sourceUrl: 'https://www.vpauto.fr/vehicule/290fa1ed6a/polo',
      }),
    ];

    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = applyPassageNavigation(
      groups,
      groups.map((group, index) => buildPassageFromGroup(group, index)),
    );

    expect(passages[1].openMode).toBe('vpauto');
    expect(passages[1].isSourceUrlStable).toBe(true);
    expect(passages[1].events.at(-1)?.openMode).toBe('vpauto');
  });
});

describe('buildPriceHistory', () => {
  it('emits MAP + sold points with adjusted label when the reserve moved', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-13T18:00:00Z'), soldPrice: 3500, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    // Single passage: expect "Mise à prix", "Mise à prix ajustée", "Adjugé"
    expect(history.map((h) => h.price)).toEqual([3900, 3500, 3500]);
    expect(history.map((h) => h.label)).toEqual(['Mise à prix', 'Mise à prix ajustée', 'Adjugé']);
  });

  it('labels points with passage numbers when there are multiple passages', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-01-10T10:00:00Z'), saleDate: '2026-01-10', startingPrice: 4000, soldPrice: null, status: 'unsold' }),
      snap({ id: 2, hashId: 'b', scrapedAt: new Date('2026-03-01T10:00:00Z'), saleDate: '2026-03-01', startingPrice: 3500, soldPrice: 3700, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    expect(history.map((h) => h.label)).toEqual(['MAP P1', 'MAP P2', 'Adjugé P2']);
  });
});

describe('computeEvolution', () => {
  it('anchors firstStartingPrice to the FIRST value of the MAP trajectory (Audi A4 regression)', () => {
    // Audi A4: MAP moved 3900 → 3500, sold at 3500. Evolution must be -400€
    // (against the initial 3900), not "Stable" (3500 vs 3500).
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-09T08:00:00Z'), startingPrice: 3900, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 3500, status: 'available' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-13T18:00:00Z'), soldPrice: 3500, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.firstStartingPrice).toBe(3900);
    expect(evo.lastEffectivePrice).toBe(3500);
    expect(evo.evolutionAmount).toBe(-400);
    expect(evo.evolutionDirection).toBe('down');
    expect(evo.lastPassageSold).toBe(true);
  });

  it('reports +100€ up when MAP is steady and the sold price exceeds it (Mercedes 294 regression)', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-12T08:00:00Z'), startingPrice: 21300, status: 'available' }),
      // The poisoning sold-page snapshot showing 21 700 € as startingPrice:
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-13T19:00:00Z'), startingPrice: 21700, soldPrice: 21400, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.firstStartingPrice).toBe(21300);
    expect(evo.lastEffectivePrice).toBe(21400);
    expect(evo.evolutionAmount).toBe(100);
    expect(evo.evolutionDirection).toBe('up');
  });

  it('reports stable when the reserve and sold price are equal and the MAP never moved', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 21400, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-13T18:00:00Z'), soldPrice: 21400, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.evolutionDirection).toBe('stable');
    expect(evo.evolutionAmount).toBe(0);
  });

  it('reports unknown when prices are missing', () => {
    const evo = computeEvolution([]);
    expect(evo.evolutionDirection).toBe('unknown');
    expect(evo.evolutionAmount).toBeNull();
    expect(evo.totalPassages).toBe(0);
  });
});

describe('buildLiveBidTrajectory', () => {
  it('captures the ordered sequence of distinct live-bid values (Yaris Cross 11403878)', () => {
    // Real case: 27 snapshots of ref 11403878, startingPrice always null,
    // currentAuctionPrice walked 17 900 → 18 000 → 18 400 before soldPrice=19 800.
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-18T14:05:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 3, scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 18000, status: 'auction_live' }),
      snap({ id: 4, scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 18400, status: 'auction_live' }),
      snap({ id: 5, scrapedAt: new Date('2026-04-18T14:20:00Z'), currentAuctionPrice: null, soldPrice: 19800, status: 'sold' }),
    ];
    expect(buildLiveBidTrajectory(snaps)).toEqual([17900, 18000, 18400]);
  });

  it('returns [] when no snapshot ever reported a live bid', () => {
    const snaps = [
      snap({ startingPrice: 15000, status: 'available' }),
      snap({ startingPrice: 15000, soldPrice: 17200, status: 'sold' }),
    ];
    expect(buildLiveBidTrajectory(snaps)).toEqual([]);
  });

  it('ignores zero / null live-bid values', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 0, status: 'auction_live' }),
      snap({ scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: null, status: 'auction_live' }),
      snap({ scrapedAt: new Date('2026-04-18T14:20:00Z'), currentAuctionPrice: 12000, status: 'auction_live' }),
    ];
    expect(buildLiveBidTrajectory(snaps)).toEqual([12000]);
  });

  it('collapses consecutive duplicates but preserves re-visits', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 10000 }),
      snap({ scrapedAt: new Date('2026-04-18T14:05:00Z'), currentAuctionPrice: 10000 }),
      snap({ scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 10500 }),
      snap({ scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 10500 }),
      snap({ scrapedAt: new Date('2026-04-18T14:20:00Z'), currentAuctionPrice: 11000 }),
    ];
    expect(buildLiveBidTrajectory(snaps)).toEqual([10000, 10500, 11000]);
  });
});

describe('pickLatestLiveBid', () => {
  it('returns the latest currentAuctionPrice by scrapedAt', () => {
    const snaps = [
      snap({ scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900 }),
      snap({ scrapedAt: new Date('2026-04-18T14:20:00Z'), currentAuctionPrice: 18400 }),
      snap({ scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 18000 }),
    ];
    expect(pickLatestLiveBid(snaps)).toBe(18400);
  });

  it('returns undefined when no snapshot has a live bid', () => {
    expect(pickLatestLiveBid([snap({ startingPrice: 15000 })])).toBeUndefined();
  });
});

describe('buildPassageFromGroup with live-bid', () => {
  it('exposes liveBidTrajectory + currentAuctionPrice on the passage (Yaris Cross)', () => {
    const snaps = [
      snap({ id: 1, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 2, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 18000, status: 'auction_live' }),
      snap({ id: 3, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 18400, status: 'auction_live' }),
      snap({ id: 4, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:20:00Z'), soldPrice: 19800, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.liveBidTrajectory).toEqual([17900, 18000, 18400]);
    expect(p.currentAuctionPrice).toBe(18400);
    expect(p.soldPrice).toBe(19800);
    expect(p.startingPrice).toBeUndefined(); // no MAP ever published
  });

  it('omits liveBidTrajectory when no live bid was ever observed', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-10T08:00:00Z'), startingPrice: 15000, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-13T18:00:00Z'), soldPrice: 17200, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    expect(p.liveBidTrajectory).toBeUndefined();
    expect(p.currentAuctionPrice).toBeUndefined();
  });
});

describe('buildPassageEvents with live-bid', () => {
  it('emits a distinct event for each live-bid change within one passage', () => {
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 18000, status: 'auction_live' }),
      snap({ id: 3, scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 18400, status: 'auction_live' }),
    ];
    const events = buildPassageEvents(snaps);
    expect(events.map((e) => e.currentAuctionPrice)).toEqual([17900, 18000, 18400]);
  });

  it('carries currentAuctionPrice on each event alongside startingPrice', () => {
    const snaps = [
      snap({
        id: 1,
        scrapedAt: new Date('2026-04-18T14:00:00Z'),
        startingPrice: 15000,
        currentAuctionPrice: 16500,
        status: 'auction_live',
      }),
    ];
    const events = buildPassageEvents(snaps);
    expect(events).toHaveLength(1);
    expect(events[0].startingPrice).toBe(15000);
    expect(events[0].currentAuctionPrice).toBe(16500);
  });
});

describe('buildPriceHistory with live-bid', () => {
  it('emits live-bid points + sold point when MAP is absent (Yaris Cross 11403878)', () => {
    // No MAP ever → evolution built entirely from live bids + sold price.
    const snaps = [
      snap({ id: 1, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 2, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 18000, status: 'auction_live' }),
      snap({ id: 3, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 18400, status: 'auction_live' }),
      snap({ id: 4, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:20:00Z'), soldPrice: 19800, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    expect(history.map((h) => h.price)).toEqual([17900, 18000, 18400, 19800]);
    expect(history.at(-1)?.label).toBe('Adjugé');
    expect(history.slice(0, -1).every((h) => h.label?.startsWith('Enchère'))).toBe(true);
  });

  it('does not duplicate a live-bid point equal to the final MAP', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-18T14:00:00Z'), startingPrice: 15000, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-18T14:10:00Z'), currentAuctionPrice: 15000, startingPrice: 15000, status: 'auction_live' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-18T14:20:00Z'), currentAuctionPrice: 16500, status: 'auction_live' }),
      snap({ id: 4, hashId: 'a', scrapedAt: new Date('2026-04-18T14:30:00Z'), soldPrice: 17200, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    expect(history.map((h) => h.price)).toEqual([15000, 16500, 17200]);
    expect(history[0].label).toBe('Mise à prix');
  });

  it('does not duplicate a live-bid point equal to the sold price', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 12000, status: 'auction_live' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-18T14:30:00Z'), currentAuctionPrice: 14500, status: 'auction_live' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-18T14:40:00Z'), soldPrice: 14500, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    // 14 500 appears only once (as "Adjugé") — not twice.
    expect(history.filter((h) => h.price === 14500)).toHaveLength(1);
    expect(history.at(-1)?.label).toBe('Adjugé');
  });
});

describe('retroactive placeholder scrub in passage-level helpers (C3 BlueHDi 11404446)', () => {
  // Real case: 13 snaps captured MAP=100 € (VPauto placeholder) from 16/04 to
  // 20/04 while no live/cote/neuf signal existed. On 21/04 the real MAP=1 200 €
  // arrived, then on sale day the auction went live at 1 500 € with cote=6 800 €
  // and prix neuf=18 750 €. Those later signals retroactively prove the 100 €
  // was bogus — the passage-level helpers must reject it when rendering.
  const makeC3Passage = () => [
    ...Array.from({ length: 10 }, (_, i) =>
      snap({
        id: 100 + i,
        hashId: 'c3-hash',
        saleDate: '2026-04-24',
        scrapedAt: new Date(`2026-04-${16 + Math.floor(i / 3)}T${10 + (i % 3) * 4}:00:00Z`),
        startingPrice: 100,
        status: 'available',
      }),
    ),
    snap({
      id: 200,
      hashId: 'c3-hash',
      saleDate: '2026-04-24',
      scrapedAt: new Date('2026-04-21T08:20:00Z'),
      startingPrice: 1200,
      status: 'available',
    }),
    snap({
      id: 300,
      hashId: 'c3-hash',
      saleDate: '2026-04-24',
      scrapedAt: new Date('2026-04-24T00:36:00Z'),
      startingPrice: null,
      currentAuctionPrice: 1500,
      marketValue: 6800,
      newPrice: 18750,
      status: 'auction_live',
    }),
  ];

  it('buildMapTrajectory drops the 100 € placeholder when a later live/cote/neuf signal disproves it', () => {
    const snaps = makeC3Passage();
    expect(buildMapTrajectory(snaps)).toEqual([1200]);
  });

  it('pickStartingPrice ignores the polluted 100 € and returns the real 1 200 € reserve', () => {
    const snaps = makeC3Passage();
    expect(pickStartingPrice(snaps)).toBe(1200);
  });

  it('buildPassageFromGroup exposes a clean single-value mapTrajectory (no 100 → 1200 fake drop)', () => {
    const snaps = makeC3Passage();
    const groups = groupSnapshotsIntoPassages(snaps);
    const p = buildPassageFromGroup(groups[0], 0);
    // 13 snapshots collapse into 1 passage; the polluted 100 € is gone.
    expect(p.startingPrice).toBe(1200);
    expect(p.mapTrajectory).toBeUndefined(); // single-value, not surfaced
    expect(p.currentAuctionPrice).toBe(1500);
    expect(p.liveBidTrajectory).toEqual([1500]);
  });

  it('buildPassageEvents does NOT emit a startingPrice=100 event inside the polluted passage', () => {
    const snaps = makeC3Passage();
    const events = buildPassageEvents(snaps);
    // No event should report startingPrice=100 — only the real 1 200 € step
    // (and the live-bid / status transitions) should survive.
    expect(events.every((e) => e.startingPrice !== 100)).toBe(true);
    expect(events.some((e) => e.startingPrice === 1200)).toBe(true);
  });

  it('buildPriceHistory emits a single clean progression 1 200 € → 1 500 € (no phantom 100 → 1200 drop)', () => {
    const snaps = makeC3Passage();
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const history = buildPriceHistory(passages);
    const prices = history.map((h) => h.price);
    expect(prices).not.toContain(100);
    expect(prices).toEqual([1200, 1500]);
  });

  it('preserves a real 100 € MAP when no contradicting signal exists (scooter / épave case)', () => {
    // Defense-in-depth check: the scrub must only fire when a signal actively
    // disproves the 100 €. A passage with only MAP=100 and nothing else stays.
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-20T08:00:00Z'), startingPrice: 100, status: 'available' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-22T08:00:00Z'), startingPrice: 100, status: 'available' }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([100]);
    expect(pickStartingPrice(snaps)).toBe(100);
  });

  it('preserves a real 100 € MAP when only a sub-threshold signal exists (299 € bid)', () => {
    // A 100 € scooter bid up to 299 € is plausible; the scrub threshold is 500.
    const snaps = [
      snap({ id: 1, scrapedAt: new Date('2026-04-20T08:00:00Z'), startingPrice: 100, status: 'available' }),
      snap({ id: 2, scrapedAt: new Date('2026-04-22T08:00:00Z'), startingPrice: 100, currentAuctionPrice: 299, status: 'auction_live' }),
    ];
    expect(buildMapTrajectory(snaps)).toEqual([100]);
  });
});

describe('cross-passage placeholder scrub (ref 11402626 regression)', () => {
  // Real case: a vehicle is listed on 3 successive sale dates with 3 distinct
  // hashIds (VPauto regenerates the listing each time). The 24/04 passage
  // captured only MAP=100 € snapshots (scraper placeholder) with no live/sold
  // and no cote yet. The 02/05 passage finally captured cote=21 200 € and prix
  // neuf=38 500 € — those values retroactively prove the 24/04 MAP=100 €
  // was the bogus VPauto placeholder. The per-passage scrub alone couldn't
  // see them (distinct hashId → distinct passage); we need vehicle-wide
  // signal aggregation via buildPassagesForVehicle.
  const makeMultiPassageVehicle = () => [
    // P1 — 18/04: no signal, no MAP stored (legitimate blank passage).
    snap({
      id: 1,
      hashId: 'hash-18',
      saleDate: '2026-04-18',
      scrapedAt: new Date('2026-04-18T08:00:00Z'),
      startingPrice: null,
      status: 'available',
    }),
    // P2 — 24/04: MAP=100 (placeholder). No signal in this passage alone.
    ...Array.from({ length: 9 }, (_, i) => {
      const day = String(20 + Math.floor(i / 3)).padStart(2, '0');
      const hour = String(8 + (i % 3) * 2).padStart(2, '0');
      return snap({
        id: 10 + i,
        hashId: 'hash-24',
        saleDate: '2026-04-24',
        scrapedAt: new Date(`2026-04-${day}T${hour}:00:00Z`),
        startingPrice: 100,
        status: 'available',
      });
    }),
    // P3 — 02/05: cote + prix neuf, but no MAP yet (listing just opened).
    snap({
      id: 100,
      hashId: 'hash-02',
      saleDate: '2026-05-02',
      scrapedAt: new Date('2026-05-01T09:00:00Z'),
      startingPrice: null,
      marketValue: 21200,
      newPrice: 38500,
      status: 'available',
    }),
  ];

  it('buildPassagesForVehicle scrubs MAP=100 € on P2 using cote/neuf captured on P3', () => {
    const snaps = makeMultiPassageVehicle();
    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(3);
    const passages = buildPassagesForVehicle(groups, snaps);
    expect(passages).toHaveLength(3);
    // None of the passages must surface 100 € as startingPrice — the vehicle's
    // cote/neuf make 100 € categorically implausible.
    expect(passages.every((p) => p.startingPrice !== 100)).toBe(true);
  });

  it('buildPriceHistory for a cross-passage-polluted vehicle never emits a 100 € chart point', () => {
    const snaps = makeMultiPassageVehicle();
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    const history = buildPriceHistory(passages);
    expect(history.some((h) => h.price === 100)).toBe(false);
  });

  it('without cross-passage signals, per-passage helpers alone keep the 100 € (proves the bug pattern)', () => {
    // Sanity anchor: if we only look at P2's own snapshots, there is no way
    // to know the 100 € is bogus — 9 snaps, all MAP=100, no live/sold/cote.
    // This test codifies the limitation the vehicle-wide scrub was built to
    // overcome.
    const snaps = makeMultiPassageVehicle();
    const groups = groupSnapshotsIntoPassages(snaps);
    const p2 = groups[1]; // the 24/04 passage, isolated
    expect(buildMapTrajectory(p2.snapshots)).toEqual([100]);
    expect(pickStartingPrice(p2.snapshots)).toBe(100);
  });

  it('buildPassageFromGroup accepts externalSignals and rejects the canonical 100 € fallback', () => {
    // Defense-in-depth: even when the trajectory is empty and pickStartingPrice
    // returns undefined, the canonical snapshot's raw startingPrice must not
    // leak through when vehicle-wide signals prove it bogus.
    const snaps = makeMultiPassageVehicle();
    const groups = groupSnapshotsIntoPassages(snaps);
    const p2 = groups[1];
    // With no external signals, the 100 € leaks through the canonical fallback.
    const withoutExternal = buildPassageFromGroup(p2, 1);
    expect(withoutExternal.startingPrice).toBe(100);
    // With vehicle-wide signals, the 100 € is scrubbed.
    const withExternal = buildPassageFromGroup(p2, 1, {
      currentAuctionPrice: null,
      soldPrice: null,
      marketValue: 21200,
      newPrice: 38500,
    });
    expect(withExternal.startingPrice).toBeUndefined();
  });
});

describe('pickPassageSaleDate (CITROEN C3 11404446 regression)', () => {
  // Bug: snapshot #27955 was scraped on 2026-04-24 with saleDate=2019-08-19
  // because the live-auction page lacked an explicit "date de vente" kv and
  // the scraper's regex fallback latched onto the car's MEC (19/08/2019).
  // That outlier became the canonical (latest scrapedAt) and pulled the
  // entire passage's saleDate into 2019, which created a phantom "old
  // passage" with a stale 1 200 € MAP copied from the real 24/04 passage.
  // The chart then rendered [1 200, 1 500, 1 200] → "Stable" instead of
  // [1 200, 1 500] → "+300 € ↑". The consensus MODE below immunises us.
  it('returns the MODE when one saleDate dominates', () => {
    const snaps = [
      snap({ id: 1, saleDate: '2026-04-24' }),
      snap({ id: 2, saleDate: '2026-04-24' }),
      snap({ id: 3, saleDate: '2026-04-24' }),
      snap({ id: 4, saleDate: '2019-08-19' }), // outlier
    ];
    expect(pickPassageSaleDate(snaps)).toBe('2026-04-24');
  });

  it('ignores null saleDates in the count', () => {
    const snaps = [
      snap({ id: 1, saleDate: null }),
      snap({ id: 2, saleDate: '2026-04-24' }),
      snap({ id: 3, saleDate: '2026-04-24' }),
    ];
    expect(pickPassageSaleDate(snaps)).toBe('2026-04-24');
  });

  it('prefers the later date on ties (MODE tie-break)', () => {
    const snaps = [
      snap({ id: 1, saleDate: '2026-04-20' }),
      snap({ id: 2, saleDate: '2026-04-20' }),
      snap({ id: 3, saleDate: '2026-04-24' }),
      snap({ id: 4, saleDate: '2026-04-24' }),
    ];
    expect(pickPassageSaleDate(snaps)).toBe('2026-04-24');
  });

  it('falls back to the canonical when every saleDate is null', () => {
    const canonical = snap({
      id: 9,
      saleDate: null,
      scrapedAt: new Date('2026-04-24T12:00:00Z'),
    });
    const snaps = [snap({ id: 1, saleDate: null }), canonical];
    expect(pickPassageSaleDate(snaps, canonical)).toBe('2026-04-24');
  });

  it('keeps the real passage on 2026-04-24 when 11 snaps say 24/04 and 1 says MEC 2019 (C3 11404446 e2e)', () => {
    // Full integration: feed 12 sibling snapshots (same hashId) where 11 have
    // saleDate=2026-04-24 and the 12th — with the latest scrapedAt, i.e. the
    // natural canonical pick — reports 2019-08-19. Grouping + rendering
    // must surface a single 2026-04-24 passage, not two (one phantom 2019).
    const hashId = 'c3-11404446';
    const snaps: SnapshotForHistory[] = [];
    for (let i = 0; i < 11; i++) {
      snaps.push(
        snap({
          id: 100 + i,
          hashId,
          saleDate: '2026-04-24',
          scrapedAt: new Date(`2026-04-24T${String(6 + i).padStart(2, '0')}:00:00Z`),
          startingPrice: 1200,
          currentAuctionPrice: i > 5 ? 1500 : null,
          status: 'auction_live',
        }),
      );
    }
    // Poisoned canonical — latest scrapedAt, bogus saleDate.
    snaps.push(
      snap({
        id: 999,
        hashId,
        saleDate: '2019-08-19',
        scrapedAt: new Date('2026-04-24T23:00:00Z'),
        startingPrice: 1200,
        currentAuctionPrice: 1500,
        status: 'auction_live',
      }),
    );

    const groups = groupSnapshotsIntoPassages(snaps);
    expect(groups).toHaveLength(1);
    const passages = buildPassagesForVehicle(groups, snaps);
    expect(passages).toHaveLength(1);
    expect(passages[0].date).toBe('2026-04-24');
    // Sanity: no phantom 2019 passage in the chart.
    const history = buildPriceHistory(passages);
    expect(history.every((h) => !(h.label ?? '').includes('2019'))).toBe(true);
  });
});

describe('computeEvolution with live-bid fallback', () => {
  it('reports +1 900 € for Yaris Cross 11403878 (null MAP, live bid → sold)', () => {
    // First live bid = 17 900, sold = 19 800 → +1 900, direction up.
    const snaps = [
      snap({ id: 1, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:00:00Z'), currentAuctionPrice: 17900, status: 'auction_live' }),
      snap({ id: 2, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:15:00Z'), currentAuctionPrice: 18400, status: 'auction_live' }),
      snap({ id: 3, hashId: 'yaris', scrapedAt: new Date('2026-04-18T14:20:00Z'), soldPrice: 19800, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.firstStartingPrice).toBeNull(); // no real MAP ever published
    expect(evo.lastEffectivePrice).toBe(19800);
    expect(evo.evolutionAmount).toBe(1900);
    expect(evo.evolutionDirection).toBe('up');
    expect(evo.lastPassageSold).toBe(true);
  });

  it('still uses MAP as anchor when both MAP and live bid exist', () => {
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-18T14:00:00Z'), startingPrice: 15000, status: 'available' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-18T14:10:00Z'), startingPrice: 15000, currentAuctionPrice: 16500, status: 'auction_live' }),
      snap({ id: 3, hashId: 'a', scrapedAt: new Date('2026-04-18T14:30:00Z'), soldPrice: 17200, status: 'sold' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.firstStartingPrice).toBe(15000);
    expect(evo.lastEffectivePrice).toBe(17200);
    expect(evo.evolutionAmount).toBe(2200);
    expect(evo.evolutionDirection).toBe('up');
  });

  it('reports live-bid-only evolution while still live (no sold yet)', () => {
    // Auction ongoing: first bid 10 000, current bid 12 500 → +2 500.
    const snaps = [
      snap({ id: 1, hashId: 'a', scrapedAt: new Date('2026-04-20T14:00:00Z'), currentAuctionPrice: 10000, status: 'auction_live' }),
      snap({ id: 2, hashId: 'a', scrapedAt: new Date('2026-04-20T14:30:00Z'), currentAuctionPrice: 12500, status: 'auction_live' }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = groups.map((g, i) => buildPassageFromGroup(g, i));
    const evo = computeEvolution(passages);
    expect(evo.firstStartingPrice).toBeNull();
    expect(evo.lastEffectivePrice).toBe(12500);
    expect(evo.evolutionAmount).toBe(2500);
    expect(evo.evolutionDirection).toBe('up');
    expect(evo.lastPassageSold).toBe(false);
  });
});

describe('truncateAfterFinalSale (VW Golf 11408791 regression)', () => {
  // Real case: VW Golf sold 28 100 € on 24 avr. 2026 at MARSEILLE,
  // re-listed as "Disponible" on 27 avr. 2026 at LORIENT (orphan listing
  // VPauto itself flags as "Vente Live terminée"). The 27 avr passage
  // must disappear from the parcours and the historique.

  it('drops a stale "Disponible" passage scraped after the final sale', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'sale-marseille',
        city: 'MARSEILLE',
        saleDate: '2026-04-24',
        scrapedAt: new Date('2026-04-24T15:00:00Z'),
        soldPrice: 28100,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'orphan-lorient',
        city: 'LORIENT',
        saleDate: '2026-04-27',
        scrapedAt: new Date('2026-04-27T09:00:00Z'),
        startingPrice: 27000,
        status: 'available',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    const result = truncateAfterFinalSale(passages);
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].city).toBe('MARSEILLE');
    expect(result.passages[0].status).toBe('sold');
    expect(result.truncatedPassages).toHaveLength(1);
    expect(result.truncatedPassages[0].city).toBe('LORIENT');
    expect(result.truncatedPassages[0].date).toBe('2026-04-27');
    expect(result.truncatedPassages[0].sourceUrl).toBe('https://vpauto.fr/v/x');
  });

  it('keeps everything up to and including the sold passage on the same day', () => {
    // Edge case: sale happened on 24 avr, scraped at 15:00 Z. Another
    // passage on the SAME date must NOT be dropped (we only drop strictly
    // newer dates), even if it was an "Invendu" mid-day.
    const snaps = [
      snap({
        id: 1,
        hashId: 'sameday-A',
        city: 'LYON',
        saleDate: '2026-04-24',
        scrapedAt: new Date('2026-04-24T10:00:00Z'),
        startingPrice: 27000,
        status: 'unsold',
      }),
      snap({
        id: 2,
        hashId: 'sameday-B',
        city: 'MARSEILLE',
        saleDate: '2026-04-24',
        scrapedAt: new Date('2026-04-24T15:00:00Z'),
        soldPrice: 28100,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    const result = truncateAfterFinalSale(passages);
    expect(result.passages).toHaveLength(2);
    expect(result.truncatedPassages).toEqual([]);
  });

  it('caps at the LATEST sale when the car was re-sold weeks later', () => {
    // Re-sale scenario: sold a first time, then the new owner re-listed
    // and re-sold weeks later. Both sales are legitimate; we only trim
    // any orphan listing scraped AFTER the second sale.
    const snaps = [
      snap({
        id: 1,
        hashId: 'sale-1',
        city: 'PARIS',
        saleDate: '2026-03-10',
        scrapedAt: new Date('2026-03-10T15:00:00Z'),
        soldPrice: 28000,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'sale-2',
        city: 'LYON',
        saleDate: '2026-04-24',
        scrapedAt: new Date('2026-04-24T15:00:00Z'),
        soldPrice: 27500,
        status: 'sold',
      }),
      snap({
        id: 3,
        hashId: 'orphan',
        city: 'NANTES',
        saleDate: '2026-04-27',
        scrapedAt: new Date('2026-04-27T09:00:00Z'),
        startingPrice: 27000,
        status: 'available',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    const result = truncateAfterFinalSale(passages);
    expect(result.passages).toHaveLength(2);
    expect(result.passages.map((p) => p.city)).toEqual(['PARIS', 'LYON']);
    expect(result.truncatedPassages.map((p) => p.city)).toEqual(['NANTES']);
  });

  it('is a no-op when the vehicle has never been sold (only Invendu / Disponible)', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'a',
        city: 'PARIS',
        saleDate: '2026-04-10',
        scrapedAt: new Date('2026-04-10T15:00:00Z'),
        startingPrice: 18000,
        status: 'unsold',
      }),
      snap({
        id: 2,
        hashId: 'b',
        city: 'LYON',
        saleDate: '2026-04-20',
        scrapedAt: new Date('2026-04-20T15:00:00Z'),
        startingPrice: 17500,
        status: 'available',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    const result = truncateAfterFinalSale(passages);
    expect(result.passages).toHaveLength(2);
    expect(result.truncatedPassages).toEqual([]);
  });

  it('findFinalSoldDate returns null when no sold passage exists', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'a',
        city: 'PARIS',
        saleDate: '2026-04-10',
        startingPrice: 18000,
        status: 'unsold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    expect(findFinalSoldDate(passages)).toBeNull();
  });

  it('findFinalSoldDate picks the most recent sale, not the first', () => {
    const snaps = [
      snap({
        id: 1,
        hashId: 'a',
        city: 'PARIS',
        saleDate: '2026-03-10',
        soldPrice: 28000,
        status: 'sold',
      }),
      snap({
        id: 2,
        hashId: 'b',
        city: 'LYON',
        saleDate: '2026-04-24',
        soldPrice: 27500,
        status: 'sold',
      }),
    ];
    const groups = groupSnapshotsIntoPassages(snaps);
    const passages = buildPassagesForVehicle(groups, snaps);
    expect(findFinalSoldDate(passages)).toBe('2026-04-24');
  });
});

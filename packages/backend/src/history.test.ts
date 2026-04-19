import { describe, expect, it } from 'vitest';
import {
  applyPassageNavigation,
  buildMapTrajectory,
  buildPassageEvents,
  buildPassageFromGroup,
  buildPriceHistory,
  computeEvolution,
  groupSnapshotsIntoPassages,
  pickStartingPrice,
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
    soldPrice: null,
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

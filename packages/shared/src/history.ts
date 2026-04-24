/**
 * Pure helpers over VehiclePassage — shared between the backend (which
 * builds them from DB rows) and the extension (which may patch a live MAP
 * resolved from the current list card and then re-derive chart data).
 */
import type { VehiclePassage, VehiclePriceEvolution } from './types.js';

export interface PriceHistoryPoint {
  date: string;
  price: number;
  label?: string;
}

/**
 * Flatten passages into chart points. For each passage, emits in order:
 *   - distinct MAP values (mapTrajectory, oldest first) — or the single
 *     startingPrice if no trajectory,
 *   - distinct live-bid values (liveBidTrajectory, oldest first) — so the
 *     chart shows the real evolution when the seller never published a MAP,
 *   - the final sold price if the passage closed sold.
 *
 * Labels include the passage number when there are multiple passages; a
 * within-passage reserve drop is labelled "ajusté".
 */
export function buildPriceHistory(passages: VehiclePassage[]): PriceHistoryPoint[] {
  const priceHistory: PriceHistoryPoint[] = [];
  const many = passages.length > 1;
  for (const p of passages) {
    // 1) MAP points (real reserve, if published).
    const traj = p.mapTrajectory;
    if (traj && traj.length > 1) {
      traj.forEach((price, i) => {
        priceHistory.push({
          date: p.date,
          price,
          label: many
            ? (i === 0 ? `MAP P${p.passageNumber}` : `MAP P${p.passageNumber} (ajusté)`)
            : (i === 0 ? 'Mise à prix' : 'Mise à prix ajustée'),
        });
      });
    } else if (p.startingPrice != null) {
      priceHistory.push({
        date: p.date,
        price: p.startingPrice,
        label: many ? `MAP P${p.passageNumber}` : 'Mise à prix',
      });
    }

    // 2) Live-bid points. Skip any value equal to the last MAP (to avoid
    //    a flat line) or equal to the sold price (the sold point will be
    //    emitted next and is more informative).
    const liveTraj = p.liveBidTrajectory;
    if (liveTraj && liveTraj.length > 0) {
      const lastMap = traj && traj.length > 0 ? traj[traj.length - 1] : p.startingPrice ?? null;
      const sold = p.soldPrice ?? null;
      liveTraj.forEach((price, i) => {
        if (price === lastMap || price === sold) return;
        priceHistory.push({
          date: p.date,
          price,
          label: many
            ? (liveTraj.length > 1
                ? `Enchère P${p.passageNumber} #${i + 1}`
                : `Enchère P${p.passageNumber}`)
            : (liveTraj.length > 1
                ? `Enchère en cours #${i + 1}`
                : 'Enchère en cours'),
        });
      });
    }

    // 3) Sold point (final hammer).
    if (p.soldPrice != null) {
      priceHistory.push({
        date: p.date,
        price: p.soldPrice,
        label: many ? `Adjugé P${p.passageNumber}` : 'Adjugé',
      });
    }
  }
  return priceHistory;
}

/**
 * Summarise price movement across passages.
 *
 * `firstStartingPrice` is the oldest known MAP (first entry of the first
 * passage's mapTrajectory when present), kept as-is for callers that
 * strictly need the real reserve. When no MAP was ever published, the
 * evolution computation falls back to the oldest live-bid entry so that
 * e.g. currentAuctionPrice 17 900 € → soldPrice 19 800 € is reported as
 * "+1 900 €" instead of "inconnu" / "stable". `lastEffectivePrice` prefers
 * soldPrice, then the most recent live bid, then the latest MAP.
 */
export function computeEvolution(passages: VehiclePassage[]): VehiclePriceEvolution {
  const firstPassageTraj = passages[0]?.mapTrajectory;
  const firstStartingPrice = firstPassageTraj && firstPassageTraj.length > 0
    ? firstPassageTraj[0]
    : passages.find((p) => p.startingPrice != null)?.startingPrice ?? null;

  // Fallback anchor when no real MAP is known: the oldest live bid seen
  // across all passages. Keeps the evolution meaningful for cars where the
  // seller never published a MAP but we still captured a live progression.
  const firstLiveBid =
    passages[0]?.liveBidTrajectory?.[0] ??
    passages.find((p) => p.liveBidTrajectory && p.liveBidTrajectory.length > 0)?.liveBidTrajectory?.[0] ??
    passages.find((p) => p.currentAuctionPrice != null)?.currentAuctionPrice ??
    null;
  const anchor = firstStartingPrice ?? firstLiveBid;

  const lastPassage = passages[passages.length - 1] ?? null;
  const lastLiveBid = lastPassage
    ? (lastPassage.liveBidTrajectory && lastPassage.liveBidTrajectory.length > 0
        ? lastPassage.liveBidTrajectory[lastPassage.liveBidTrajectory.length - 1]
        : lastPassage.currentAuctionPrice ?? null)
    : null;
  const lastEffectivePrice = lastPassage
    ? (lastPassage.soldPrice ?? lastLiveBid ?? lastPassage.startingPrice ?? null)
    : null;
  const lastPassageSold = !!(lastPassage && lastPassage.status === 'sold' && lastPassage.soldPrice != null);

  let evolutionAmount: number | null = null;
  let evolutionDirection: VehiclePriceEvolution['evolutionDirection'] = 'unknown';
  if (anchor != null && lastEffectivePrice != null) {
    evolutionAmount = lastEffectivePrice - anchor;
    if (evolutionAmount > 0) evolutionDirection = 'up';
    else if (evolutionAmount < 0) evolutionDirection = 'down';
    else evolutionDirection = 'stable';
  }

  return {
    totalPassages: passages.length,
    soldCount: passages.filter((p) => p.status === 'sold').length,
    unsoldCount: passages.filter((p) => p.status === 'unsold').length,
    firstStartingPrice,
    lastEffectivePrice,
    lastPassageSold,
    evolutionAmount,
    evolutionDirection,
  };
}

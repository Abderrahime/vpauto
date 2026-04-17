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
 * Flatten passages into chart points. Emits one point per distinct MAP and
 * one for the sold price. Labels include the passage number when there are
 * multiple passages; a within-passage reserve drop is labelled "ajusté".
 */
export function buildPriceHistory(passages: VehiclePassage[]): PriceHistoryPoint[] {
  const priceHistory: PriceHistoryPoint[] = [];
  const many = passages.length > 1;
  for (const p of passages) {
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
 * Summarise price movement across passages. firstStartingPrice is anchored
 * to the oldest passage's initial MAP (first entry of mapTrajectory when
 * present) so a within-passage reserve drop is included in the evolution.
 */
export function computeEvolution(passages: VehiclePassage[]): VehiclePriceEvolution {
  const firstPassageTraj = passages[0]?.mapTrajectory;
  const firstStartingPrice = firstPassageTraj && firstPassageTraj.length > 0
    ? firstPassageTraj[0]
    : passages.find((p) => p.startingPrice != null)?.startingPrice ?? null;
  const lastPassage = passages[passages.length - 1] ?? null;
  const lastEffectivePrice = lastPassage
    ? (lastPassage.soldPrice ?? lastPassage.startingPrice ?? null)
    : null;
  const lastPassageSold = !!(lastPassage && lastPassage.status === 'sold' && lastPassage.soldPrice != null);

  let evolutionAmount: number | null = null;
  let evolutionDirection: VehiclePriceEvolution['evolutionDirection'] = 'unknown';
  if (firstStartingPrice != null && lastEffectivePrice != null) {
    evolutionAmount = lastEffectivePrice - firstStartingPrice;
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

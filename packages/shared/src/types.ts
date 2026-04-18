// ── Vehicle core types ──

export interface VehicleIdentity {
  reference: string;       // Internal VPauto reference (e.g., "11401745")
  hashId: string;          // URL hash (e.g., "cc8d8fe05a")
  brand: string;
  model: string;
  version: string;         // Full trim/version string
  year: number;
  color: string;
  fuel: string;            // "Essence", "Diesel", "Electrique", etc.
  transmission: string;    // "Manuelle", "Automatique"
  engineSize?: number;     // cc
  power?: number;          // ch
  fiscalPower?: number;    // CV
}

export interface VehicleSnapshot {
  id?: number;
  vehicleId?: number;
  reference: string;
  hashId: string;
  brand: string;
  model: string;
  version: string;
  year: number;
  mileage: number;
  color: string;
  fuel: string;
  transmission: string;
  engineSize?: number;
  power?: number;
  fiscalPower?: number;
  doors?: number;
  seats?: number;
  co2?: number;
  critair?: string;
  euroStandard?: string;
  bodyType?: string;

  // Pricing
  startingPrice?: number;       // "Mise à prix" — seller-defined initial price
  startingPriceHT?: number;
  marketValue?: number;
  newPrice?: number;
  vatRecoverable: boolean;
  /** "Enchère en cours" — live auction price during bidding.
   *  Distinct from startingPrice: the MAP is the reserve set by the seller,
   *  while currentAuctionPrice is the current highest bid during a live
   *  auction. Displayed in the sidepanel as a secondary metric, never as
   *  the MAP. */
  currentAuctionPrice?: number;

  // Sale info
  city: string;
  center?: string;
  department?: string;
  saleDate?: string;       // ISO date
  saleTime?: string;
  lotNumber?: number;

  // Condition
  technicalCheckUrl?: string;
  conditionImageUrl?: string;
  observations?: string;
  maintenanceStatus?: string;
  serviceHistory?: boolean;
  firstOwner?: boolean;
  warranty?: string;

  // Equipment & options
  equipment?: string[];

  // Photos
  photoUrls: string[];
  cdnHash?: string;

  // Source
  sourceUrl: string;
  scrapedAt: string;       // ISO datetime

  // Status tracking
  status: VehicleStatus;
  soldPrice?: number;
}

export type VehicleStatus = 'available' | 'auction_live' | 'sold' | 'unsold' | 'removed';

export type MatchLevel = 'exact' | 'same_model' | 'similar';

export interface MatchResult {
  level: MatchLevel;
  score: number;           // 0-100
  vehicleId: number;
  snapshot: VehicleSnapshot;
  reasons: string[];       // Why this matched
}

// ── Comparison ──

export interface ComparisonField {
  label: string;
  current: string | number | undefined;
  compared: string | number | undefined;
  diff?: string;           // Human-readable difference
  highlight: 'better' | 'worse' | 'neutral' | 'same';
}

export interface VehicleComparison {
  current: VehicleSnapshot;
  compared: VehicleSnapshot;
  matchLevel: MatchLevel;
  matchScore: number;
  fields: ComparisonField[];
}

// ── History ──

export interface VehiclePassage {
  /** 1-based passage number, oldest first */
  passageNumber: number;
  snapshotId: number;
  date: string;
  city: string;
  center?: string;
  status: VehicleStatus;
  startingPrice?: number;
  soldPrice?: number;
  mileage: number;
  observations?: string;
  technicalCheckUrl?: string;
  /** Link to the listing page of this specific passage */
  sourceUrl: string;
  photoUrl?: string;
  /**
   * Distinct MAP values observed during this passage's listing window,
   * oldest first. Populated only when the seller changed the reserve
   * before the auction (e.g. [3900, 3500] = reserve dropped from 3 900 €
   * to 3 500 € before sale). Absent when the MAP was constant.
   */
  mapTrajectory?: number[];
}

export interface VehiclePriceEvolution {
  /** Total unique passages (deduplicated by city+saleDate) */
  totalPassages: number;
  soldCount: number;
  unsoldCount: number;
  /** Starting price (MAP) of the very first passage */
  firstStartingPrice: number | null;
  /** Effective price of the latest passage: soldPrice if sold, else startingPrice */
  lastEffectivePrice: number | null;
  /** True if the latest passage was sold */
  lastPassageSold: boolean;
  /** lastEffectivePrice - firstStartingPrice (null if either missing) */
  evolutionAmount: number | null;
  evolutionDirection: 'up' | 'down' | 'stable' | 'unknown';
}

export interface VehicleHistory {
  vehicleId: number;
  identity: VehicleIdentity;
  /** Deduplicated passages, chronological (oldest first) */
  passages: VehiclePassage[];
  totalPassages: number;
  firstSeen: string;
  lastSeen: string;
  /** Combined MAP and Adjugé points so charts show real movement */
  priceHistory: { date: string; price: number; label?: string }[];
  mileageHistory: { date: string; mileage: number }[];
  evolution: VehiclePriceEvolution;
}

// ── Badge types ──

export type BadgeType = 'new' | 'seen' | 'price_drop' | 'price_up' | 'reappeared';

export interface VehicleBadge {
  type: BadgeType;
  label: string;
  detail?: string;         // e.g., "Vu 3 fois" or "-500€"
}

// ── API types ──

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SearchSimilarParams {
  brand: string;
  model: string;
  year?: number;
  fuel?: string;
  transmission?: string;
  maxResults?: number;
}

// ── Messages between extension components ──

export type MessageType =
  | 'VEHICLE_DETECTED'
  | 'VEHICLE_LIST_DETECTED'
  | 'GET_VEHICLE_HISTORY'
  | 'GET_SIMILAR_VEHICLES'
  | 'GET_VEHICLE_BADGES'
  | 'SNAPSHOT_SAVED'
  | 'OPEN_SIDE_PANEL';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

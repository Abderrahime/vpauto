export interface VehicleIdentity {
    reference: string;
    hashId: string;
    brand: string;
    model: string;
    version: string;
    year: number;
    color: string;
    fuel: string;
    transmission: string;
    engineSize?: number;
    power?: number;
    fiscalPower?: number;
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
    startingPrice?: number;
    startingPriceHT?: number;
    marketValue?: number;
    newPrice?: number;
    vatRecoverable: boolean;
    currentAuctionPrice?: number;
    city: string;
    center?: string;
    department?: string;
    saleDate?: string;
    saleTime?: string;
    lotNumber?: number;
    technicalCheckUrl?: string;
    conditionImageUrl?: string;
    observations?: string;
    maintenanceStatus?: string;
    serviceHistory?: boolean;
    firstOwner?: boolean;
    warranty?: string;
    equipment?: string[];
    photoUrls: string[];
    cdnHash?: string;
    sourceUrl: string;
    scrapedAt: string;
    status: VehicleStatus;
    soldPrice?: number;
}
export type VehicleStatus = 'available' | 'auction_live' | 'sold' | 'unsold' | 'removed';
export type MatchLevel = 'exact' | 'same_model' | 'similar';
export interface MatchResult {
    level: MatchLevel;
    score: number;
    vehicleId: number;
    snapshot: VehicleSnapshot;
    reasons: string[];
}
export interface ComparisonField {
    label: string;
    current: string | number | undefined;
    compared: string | number | undefined;
    diff?: string;
    highlight: 'better' | 'worse' | 'neutral' | 'same';
}
export interface VehicleComparison {
    current: VehicleSnapshot;
    compared: VehicleSnapshot;
    matchLevel: MatchLevel;
    matchScore: number;
    fields: ComparisonField[];
}
export interface VehiclePassage {
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
    sourceUrl: string;
    photoUrl?: string;
}
export interface VehicleHistory {
    vehicleId: number;
    identity: VehicleIdentity;
    passages: VehiclePassage[];
    totalPassages: number;
    firstSeen: string;
    lastSeen: string;
    priceHistory: {
        date: string;
        price: number;
    }[];
    mileageHistory: {
        date: string;
        mileage: number;
    }[];
    postSaleTruncatedPassages?: VehiclePassage[];
}
export type BadgeType = 'new' | 'seen' | 'price_drop' | 'price_up' | 'reappeared';
export interface VehicleBadge {
    type: BadgeType;
    label: string;
    detail?: string;
}
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
export type MessageType = 'VEHICLE_DETECTED' | 'VEHICLE_LIST_DETECTED' | 'GET_VEHICLE_HISTORY' | 'GET_SIMILAR_VEHICLES' | 'GET_VEHICLE_BADGES' | 'SNAPSHOT_SAVED' | 'OPEN_SIDE_PANEL';
export interface ExtensionMessage {
    type: MessageType;
    payload?: unknown;
}
//# sourceMappingURL=types.d.ts.map
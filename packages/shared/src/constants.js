export const VPAUTO_BASE_URL = 'https://vpauto.fr';
export const VPAUTO_CDN_URL = 'https://cdn.vpauto.fr';
export const VPAUTO_LIST_URL = `${VPAUTO_BASE_URL}/vehicule/liste`;
export const VPAUTO_VEHICLE_URL_PATTERN = /^https:\/\/(?:www\.)?vpauto\.fr\/vehicule\/([a-f0-9]+)\//;
export const DEFAULT_API_URL = 'http://localhost:3456';
// Matching thresholds
export const EXACT_MATCH_THRESHOLD = 90;
export const MODEL_MATCH_THRESHOLD = 60;
export const SIMILAR_MATCH_THRESHOLD = 40;
// Matching weights (total = 100)
export const MATCH_WEIGHTS = {
    reference: 50, // Same reference = very likely same vehicle
    brand: 5,
    model: 10,
    version: 8,
    year: 7,
    mileage: 5,
    color: 3,
    fuel: 4,
    transmission: 3,
    engineSize: 3,
    power: 2,
};
// VPauto cities
export const VPAUTO_CITIES = [
    'Bordeaux',
    'Lyon',
    'Paris',
    'Marseille',
    'Lille',
    'Rennes',
    'Strasbourg',
    'Toulouse',
    'Nantes',
];
//# sourceMappingURL=constants.js.map
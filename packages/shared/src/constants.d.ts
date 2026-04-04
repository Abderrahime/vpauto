export declare const VPAUTO_BASE_URL = "https://vpauto.fr";
export declare const VPAUTO_CDN_URL = "https://cdn.vpauto.fr";
export declare const VPAUTO_LIST_URL = "https://vpauto.fr/vehicule/liste";
export declare const VPAUTO_VEHICLE_URL_PATTERN: RegExp;
export declare const DEFAULT_API_URL = "http://localhost:3456";
export declare const EXACT_MATCH_THRESHOLD = 90;
export declare const MODEL_MATCH_THRESHOLD = 60;
export declare const SIMILAR_MATCH_THRESHOLD = 40;
export declare const MATCH_WEIGHTS: {
    readonly reference: 50;
    readonly brand: 5;
    readonly model: 10;
    readonly version: 8;
    readonly year: 7;
    readonly mileage: 5;
    readonly color: 3;
    readonly fuel: 4;
    readonly transmission: 3;
    readonly engineSize: 3;
    readonly power: 2;
};
export declare const VPAUTO_CITIES: readonly ["Bordeaux", "Lyon", "Paris", "Marseille", "Lille", "Rennes", "Strasbourg", "Toulouse", "Nantes"];
//# sourceMappingURL=constants.d.ts.map
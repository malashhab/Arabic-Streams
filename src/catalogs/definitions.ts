export type MediaType = "movie" | "series";

/** TMDB ISO-3166 origin country groups. Reliable for TMDB-tagged productions only. */
export const REGIONS = {
  gulf: { name: "Saudi & Gulf", ar: "الخليج", countries: ["SA", "KW", "AE", "QA", "BH", "OM"] },
  egypt: { name: "Egyptian", ar: "مصري", countries: ["EG"] },
  levant: { name: "Syrian & Levantine", ar: "شامي", countries: ["SY", "LB", "JO", "PS"] },
  maghreb: { name: "Maghreb", ar: "مغاربي", countries: ["MA", "DZ", "TN"] },
} as const;
export type RegionKey = keyof typeof REGIONS;

/** Arabic-speaking origin countries (used for the "arabicOnly" filter on top of original_language=ar). */
export const ARAB_COUNTRIES = ["SA", "KW", "AE", "QA", "BH", "OM", "EG", "SY", "LB", "JO", "PS", "IQ", "YE", "SD", "LY", "MA", "DZ", "TN", "MR", "SO", "DJ", "KM"];

export type CatalogKind = "latest" | "year" | "ramadan" | "region" | "search";

export interface CatalogDef {
  id: string;
  type: MediaType;
  /** Shown in Stremio/Nuvio: English first, Arabic after the dot. */
  name: string;
  kind: CatalogKind;
  region?: RegionKey;
}

const TYPE_LABEL: Record<MediaType, { en: string; ar: string }> = {
  movie: { en: "Movies", ar: "أفلام" },
  series: { en: "Series", ar: "مسلسلات" },
};

export const CATALOGS: CatalogDef[] = [
  { id: "ar_series_latest", type: "series", name: "Latest Arabic Series · أحدث المسلسلات العربية", kind: "latest" },
  { id: "ar_movies_latest", type: "movie", name: "Latest Arabic Movies · أحدث الأفلام العربية", kind: "latest" },
  { id: "ar_series_ramadan", type: "series", name: "Ramadan Series · مسلسلات رمضان", kind: "ramadan" },
  { id: "ar_series_year", type: "series", name: "Arabic Series by Year · مسلسلات حسب السنة", kind: "year" },
  { id: "ar_movies_year", type: "movie", name: "Arabic Movies by Year · أفلام حسب السنة", kind: "year" },
  ...(["series", "movie"] as const).flatMap((type) =>
    (Object.keys(REGIONS) as RegionKey[]).map((region) => ({
      id: `ar_${type === "movie" ? "movies" : "series"}_${region}`,
      type,
      name: `${REGIONS[region].name} ${TYPE_LABEL[type].en} · ${TYPE_LABEL[type].ar} ${REGIONS[region].ar}`,
      kind: "region" as const,
      region,
    })),
  ),
  { id: "ar_search_movie", type: "movie", name: "Arabic Search · بحث", kind: "search" },
  { id: "ar_search_series", type: "series", name: "Arabic Search · بحث", kind: "search" },
];

export const CATALOG_IDS = CATALOGS.map((c) => c.id);

export function findCatalog(id: string, type: string): CatalogDef | undefined {
  return CATALOGS.find((c) => c.id === id && c.type === type);
}

export const PAGE_SIZE = 20;

/** Years offered in the "By Year" dropdowns: current year back to 1970. */
export function yearOptions(now = new Date()): string[] {
  const out: string[] = [];
  for (let y = now.getFullYear(); y >= 1970; y--) out.push(String(y));
  return out;
}

/** Ramadan seasons offered in the Ramadan dropdown: current year back to 2010. */
export function ramadanYearOptions(now = new Date(), explicit?: number[]): string[] {
  if (explicit && explicit.length) return [...explicit].sort((a, b) => b - a).map(String);
  const out: string[] = [];
  const top = Math.max(now.getFullYear(), 2026);
  for (let y = top; y >= 2010; y--) out.push(String(y));
  return out;
}

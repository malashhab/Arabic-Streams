// Arabic text normalisation for search and title comparison.

const TATWEEL = /ـ/g;
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g; // harakat, shadda, sukun, dagger alef, Quranic marks
const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/;
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

export interface NormalizeOptions {
  /** Strip harakat/shadda. Default true. */
  stripDiacritics?: boolean;
  /** Fold taa marbuta (ة→ه) and alef maqsura (ى→ي). Default true. */
  foldEndings?: boolean;
}

export function hasArabic(s: string): boolean {
  return ARABIC_RANGE.test(s);
}

export function normalizeArabic(input: string, opts: NormalizeOptions = {}): string {
  const { stripDiacritics = true, foldEndings = true } = opts;
  let s = input.normalize("NFKC");
  s = s.replace(TATWEEL, "");
  if (stripDiacritics) s = s.replace(DIACRITICS, "");
  s = s.replace(/[آأإٱ]/g, "ا"); // آ أ إ ٱ → ا
  if (foldEndings) s = s.replace(/ة/g, "ه").replace(/ى/g, "ي"); // ة→ه ى→ي
  s = s.replace(/ک/g, "ك").replace(/ی/g, "ي"); // Persian kaf/yeh → Arabic
  s = s.replace(EASTERN_DIGITS, (d) => String(d.charCodeAt(0) & 0xf)); // ٠-٩ / ۰-۹ → 0-9
  return s;
}

/** Full search-key normalisation: Arabic folding + lowercase Latin, punctuation removed, whitespace collapsed. */
export function normalizeQuery(input: string, opts: NormalizeOptions = {}): string {
  return normalizeArabic(input, opts)
    .toLowerCase()
    .replace(/[؛؟،]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

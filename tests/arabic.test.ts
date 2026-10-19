import { describe, expect, it } from "vitest";
import { matchScore, bestMatch, MATCH_THRESHOLD, levenshtein } from "../src/arabic/fuzzy.js";
import { hasArabic, normalizeArabic, normalizeQuery } from "../src/arabic/normalize.js";
import { arabicToLatin, skeleton } from "../src/arabic/translit.js";

describe("normalizeArabic", () => {
  it("folds alef variants", () => expect(normalizeArabic("أحمد إبراهيم آمن")).toBe("احمد ابراهيم امن"));
  it("removes tatweel", () => expect(normalizeArabic("مـــصـــر")).toBe("مصر"));
  it("removes diacritics by default and can keep them", () => {
    expect(normalizeArabic("مُحَمَّد")).toBe("محمد");
    expect(normalizeArabic("مُحَمَّد", { stripDiacritics: false })).toContain("ُ");
  });
  it("folds taa marbuta and alef maqsura", () => expect(normalizeArabic("الحارة موسى")).toBe("الحاره موسي"));
  it("maps eastern digits", () => expect(normalizeArabic("رمضان ٢٠٢٦")).toBe("رمضان 2026"));
  it("normalises whitespace and punctuation in queries", () => expect(normalizeQuery("  باب   الحارة! ")).toBe("باب الحاره"));
  it("detects Arabic", () => {
    expect(hasArabic("Bab")).toBe(false);
    expect(hasArabic("باب")).toBe(true);
  });
});

describe("transliteration + fuzzy matching", () => {
  it("romanises", () => expect(arabicToLatin("باب الحارة")).toBe("bab alhara"));
  it("same skeleton for common Latin spellings", () => {
    expect(skeleton("Bab Al-Hara")).toBe(skeleton("bab el hara"));
  });
  it("matches Latin spelling to the Arabic title", () => {
    expect(matchScore("Bab Al Hara", "باب الحارة")).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(matchScore("bab el hara", "باب الحارة")).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
  it("matches hamza/alef spelling variants", () => expect(matchScore("احمد", "أحمد")).toBe(1));
  it("does not confuse unrelated titles", () => {
    expect(matchScore("باب الحارة", "الهيبة")).toBeLessThan(MATCH_THRESHOLD);
    expect(matchScore("نور", "نار")).toBeLessThan(MATCH_THRESHOLD);
    expect(matchScore("Bab Al Hara", "Game of Thrones")).toBeLessThan(MATCH_THRESHOLD);
    expect(matchScore("The Mummy", "The Matrix")).toBeLessThan(MATCH_THRESHOLD);
  });
  it("token containment scores high", () => expect(matchScore("الهيبة", "مسلسل الهيبة")).toBeGreaterThanOrEqual(0.8));
  it("bestMatch picks the best candidate and ignores empties", () => expect(bestMatch("x y z", [undefined, "", "x y z"])).toBe(1));
  it("levenshtein", () => expect(levenshtein("kitten", "sitting")).toBe(3));
});

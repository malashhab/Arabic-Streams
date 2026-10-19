import { normalizeQuery } from "./normalize.js";

// Arabic → Latin "chat style" romanisation. It is deliberately lossy (no short vowels in the source text),
// so it is only ever compared via the consonant skeleton (see `skeleton`), never shown to users.

const MAP: Record<string, string> = {
  "ا": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s",
  "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q",
  "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y",
  "ء": "", "ة": "a", "ى": "a","ؤ": "w", "ئ": "y", "پ": "b", "چ": "j", "گ": "g", "ڤ": "f",
};

export function arabicToLatin(input: string): string {
  const s = normalizeQuery(input, { foldEndings: false });
  let out = "";
  for (const ch of s) out += MAP[ch] ?? ch;
  return out;
}

/**
 * Consonant skeleton used to compare transliterations that disagree on vowels/spelling:
 * "Bab Al-Hara" / "باب الحارة" / "Bab el hara" all collapse to similar skeletons.
 * Folds common variants (q/k/g, th/s/t, dh/z/d, kh/h, sh/s, gh/g, ou/u/w, ee/i/y), drops vowels and the article "al/el".
 */
export function skeleton(latin: string): string {
  let s = normalizeQuery(latin)
    .replace(/\b(al|el|al-|el-)\s*/g, "") // definite article
    .replace(/kh|gh/g, "h")
    .replace(/sh|ch/g, "s")
    .replace(/th/g, "t")
    .replace(/dh/g, "d")
    .replace(/[qkg]/g, "k")
    .replace(/[zs]/g, "s")
    .replace(/[aeiou]/g, "")
    .replace(/[wy]/g, "")
    .replace(/\s+/g, "");
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

/** Skeleton of any title (Arabic is romanised first). */
export function titleSkeleton(title: string): string {
  return skeleton(arabicToLatin(title));
}

import { hasArabic, normalizeQuery } from "./normalize.js";
import { titleSkeleton } from "./translit.js";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

function tokenSet(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

/**
 * Score 0..1 of how well `candidate` matches `query`.
 *  - exact (after normalisation) = 1
 *  - all query tokens present in the candidate = 0.9 (substring search, e.g. "هارة" is not enough but "باب الحارة" in a longer name is)
 *  - otherwise character similarity, and for cross-script pairs, similarity of consonant skeletons (discounted).
 * Short, unrelated strings are protected by a skeleton length guard so "نور" does not match "نار".
 */
export function matchScore(query: string, candidate: string, opts: { strict?: boolean } = {}): number {
  const q = normalizeQuery(query);
  const c = normalizeQuery(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const qt = tokenSet(q);
  const ct = new Set(tokenSet(c));
  // strict mode (release names): "Dark" must not match "Dark Phoenix", so partial token overlap does not count
  if (!opts.strict && qt.length > 0 && qt.every((t) => ct.has(t))) return qt.length === 1 && c.split(" ").length > 3 ? 0.8 : 0.9;

  let best = similarity(q, c);

  const crossScript = hasArabic(q) !== hasArabic(c);
  const sameScriptSpellingVariants = !hasArabic(q) && !hasArabic(c);
  if (crossScript || sameScriptSpellingVariants) {
    const sq = titleSkeleton(query);
    const sc = titleSkeleton(candidate);
    if (sq.length >= 3 && sc.length >= 3) {
      const s = similarity(sq, sc) * (crossScript ? 0.92 : 0.95);
      best = Math.max(best, s);
    }
  }
  return best;
}

/** Best score of a query against any of several candidate names (title, original title, alt titles). */
export function bestMatch(query: string, candidates: Array<string | undefined | null>, opts: { strict?: boolean } = {}): number {
  let best = 0;
  for (const c of candidates) if (c) best = Math.max(best, matchScore(query, c, opts));
  return best;
}

export const MATCH_THRESHOLD = 0.72;

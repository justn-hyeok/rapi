// Pure rules behind the community curation channels.

const KST_MS = 9 * 3_600_000;

/** "2026-10-09" for the Asia/Seoul calendar day containing `now`. */
export function kstDateKey(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
}

/** Whether the Asia/Seoul clock has reached hour:minute today. */
export function kstReached(now: Date, hour: number, minute = 0): boolean {
  const local = new Date(now.getTime() + KST_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= hour * 60 + minute;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|ref$|source$)/.test(key)) url.searchParams.delete(key);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export interface CitationCandidate {
  id: string;
  url: string;
  title: string;
  body: string;
  source: string;
}

/**
 * Items that discuss an official post: same link, a body that links to it,
 * or a title that quotes it. An official post never cites itself.
 */
export function findCitations(
  official: { id: string; url: string; title: string },
  others: CitationCandidate[],
): CitationCandidate[] {
  const target = normalizeUrl(official.url);
  const title = official.title.trim().toLowerCase();
  return others.filter((other) => {
    if (other.id === official.id) return false;
    if (normalizeUrl(other.url) === target) return true;
    const body = other.body.toLowerCase();
    if (target.length > 12 && body.includes(target)) return true;
    if (target.length > 12 && body.includes(official.url.toLowerCase()))
      return true;
    return title.length >= 24 && other.title.toLowerCase().includes(title);
  });
}

const FREE_PATTERN =
  /\bfree\s+(?:credits?|tier|tokens?|api|models?|access|usage|trial|plan)\b|\b(?:credits?|tokens?)\s+for\s+free\b|무료\s*(?:크레딧|토큰|티어|모델|API|사용|제공|공개)|크레딧\s*(?:무료|지급|제공)/i;

// "Free" alone is common outside AI, so these also need an AI term in the title.
const FREE_OFFER =
  /\b(?:now|available|try|use)\s+(?:it\s+)?(?:for\s+)?free\b|\bfree\s+(?:for|to)\s+(?:students|developers|everyone|all|use|try|open[- ]source)\b|\bat\s+no\s+(?:additional\s+|extra\s+)?cost\b|무료로\s*(?:제공|공개|사용|쓸|이용|풀|전환)/i;
const AI_TERM =
  /(?<![.\w])ai\b|\b(?:llms?|gpts?|claude|gemini|copilot|codex|cursor|models?|inference|agents?|mcp)\b|모델|에이전트|인공지능|코파일럿|클로드|제미나이/i;

/** News about free AI credits, tiers or models. */
export function isFreeTokenNews(title: string, body: string): boolean {
  const head = body.slice(0, 600);
  return (
    FREE_PATTERN.test(title) ||
    FREE_PATTERN.test(head) ||
    (AI_TERM.test(title) && (FREE_OFFER.test(title) || FREE_OFFER.test(head)))
  );
}

/** A title marked with an earlier year, as link aggregators do: "... (2016)". */
export function isOldStory(title: string, now: Date): boolean {
  const year = /\((?:19|20)\d{2}\)\s*$/.exec(title.trim())?.[0];
  return !!year && Number(year.replace(/\D/g, "")) < now.getUTCFullYear();
}

const PERSONNEL_NEWS = /\bappoints\b/i;

export interface BlogFeedItem {
  source: string;
  title: string;
  /** The source also posts about other things, so the title must be about AI. */
  aiOnly?: boolean | null;
}

/**
 * The AI blog card's items: no off-topic posts, and at most `perSource` from
 * one source so a busy feed cannot push the quiet ones out. Keeps input order.
 */
export function selectBlogItems<T extends BlogFeedItem>(
  items: T[],
  perSource = 3,
): T[] {
  const taken = new Map<string, number>();
  return items.filter((item) => {
    if (PERSONNEL_NEWS.test(item.title)) return false;
    if (item.aiOnly && !AI_TERM.test(item.title)) return false;
    const count = taken.get(item.source) ?? 0;
    if (count >= perSource) return false;
    taken.set(item.source, count + 1);
    return true;
  });
}

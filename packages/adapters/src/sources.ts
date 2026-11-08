import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  type ExternalItem,
  type FeedReader,
  type GitHubEventReader,
  type HtmlReader,
  type HtmlSourcePolicy,
  type ServicePage,
  type SourceParsers,
  type SourcePayload,
  isPublicUrl,
} from "@rapi/domain";

export interface SourceHttpOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  // Keep the first maxBodyBytes instead of failing. Long feeds are newest first.
  truncate?: boolean;
  fetch?: typeof fetch;
}

export async function readSource(
  url: string,
  headers: Record<string, string>,
  options: SourceHttpOptions,
  onPayload?: (payload: SourcePayload) => Promise<void>,
): Promise<{ response: Response; body: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBodyBytes = options.maxBodyBytes ?? 2_000_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes <= 0
  )
    throw new Error("Source HTTP limits must be positive integers");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304) return { response, body: "" };
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Source returned ${response.status}`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBodyBytes) {
            await reader.cancel();
            if (!options.truncate)
              throw new Error("Source body exceeds the byte limit");
            chunks.push(
              chunk.value.subarray(
                0,
                chunk.value.byteLength - (size - maxBodyBytes),
              ),
            );
            break;
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    // Persist the exact response before JSON/XML parsing can fail.
    await onPayload?.({
      contentType: response.headers.get("content-type") ?? "",
      body,
    });
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (value && typeof value === "object" && "#text" in value)
    return text((value as { "#text": unknown })["#text"]);
  return "";
}

function atomLink(value: unknown): string {
  for (const link of arrayOf(value)) {
    if (typeof link === "string") return link;
    if (link && typeof link === "object") {
      const record = link as Record<string, unknown>;
      if (
        (record["@_rel"] === undefined || record["@_rel"] === "alternate") &&
        typeof record["@_href"] === "string"
      )
        return record["@_href"];
    }
  }
  return "";
}

export function parseFeed(xml: string): ExternalItem[] {
  if (Buffer.byteLength(xml) > 2_000_000)
    throw new Error("Feed exceeds the 2 MB input limit");
  // CDATA content is inert text; feeds such as WordPress embed full HTML
  // documents there. Only a real document type declaration is rejected.
  if (/<!DOCTYPE/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")))
    throw new Error("DOCTYPE is not allowed in feeds");
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    trimValues: true,
    // Atom content can be inline XHTML (Vercel); keep it as text, not parsed tags.
    stopNodes: ["feed.entry.content"],
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
  if (rss?.channel) {
    return arrayOf(
      rss.channel.item as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((item) => {
      const url = text(item.link);
      const externalId = text(item.guid) || url;
      return {
        externalId,
        url,
        title: text(item.title),
        body: text(item.description) || text(item["content:encoded"]),
        author: text(item.author) || text(item["dc:creator"]) || null,
        publishedAt: text(item.pubDate) || null,
        metadata: { feedType: "rss" },
      };
    });
  }

  const feed = parsed.feed as { entry?: unknown } | undefined;
  if (feed) {
    return arrayOf(
      feed.entry as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((entry) => {
      const url = atomLink(entry.link);
      const author = entry.author as Record<string, unknown> | undefined;
      return {
        externalId: text(entry.id) || url,
        url,
        title: text(entry.title),
        body:
          text(entry.summary) ||
          text(entry.content).replace(/<!\[CDATA\[|\]\]>/g, ""),
        author: author ? text(author.name) || null : null,
        publishedAt: text(entry.published) || text(entry.updated) || null,
        metadata: { feedType: "atom" },
      };
    });
  }

  throw new Error("Unsupported RSS/Atom document");
}

// A feed cut off by the byte limit: drop the partial entry and close the document.
export function closeTruncatedFeed(xml: string): string {
  if (/<\/(?:feed|rss)>\s*$/.test(xml)) return xml;
  const entry = xml.lastIndexOf("</entry>");
  if (entry >= 0) return `${xml.slice(0, entry + 8)}</feed>`;
  const item = xml.lastIndexOf("</item>");
  if (item >= 0) return `${xml.slice(0, item + 7)}</channel></rss>`;
  return xml;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

interface HtmlNode {
  tag: string;
  attrs: string;
  parent: HtmlNode | null;
  children: Array<HtmlNode | string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, name: string) => {
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    },
  );
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attrs);
  const value = match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
  return value === undefined ? undefined : decodeEntities(value);
}

// A tolerant tag-stream tree: no script execution, no external parser.
function stripInertHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

function buildHtmlTree(html: string): HtmlNode {
  const stripped = stripInertHtml(html);
  const root: HtmlNode = {
    tag: "#root",
    attrs: "",
    parent: null,
    children: [],
  };
  let current = root;
  const tokens =
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<!?[^>]*>|([^<]+|<)/g;
  for (const match of stripped.matchAll(tokens)) {
    if (match[4] !== undefined) {
      current.children.push(match[4]);
      continue;
    }
    if (match[2] === undefined) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      for (let node: HtmlNode | null = current; node; node = node.parent)
        if (node.tag === tag) {
          current = node.parent ?? root;
          break;
        }
      continue;
    }
    const attrs = match[3] ?? "";
    const node: HtmlNode = { tag, attrs, parent: current, children: [] };
    current.children.push(node);
    if (!VOID_TAGS.has(tag) && !attrs.trimEnd().endsWith("/")) current = node;
  }
  return root;
}

function nodeText(node: HtmlNode): string {
  const parts: string[] = [];
  const walk = (current: HtmlNode): void => {
    for (const child of current.children)
      if (typeof child === "string") parts.push(child);
      else {
        parts.push(" ");
        walk(child);
        parts.push(" ");
      }
  };
  walk(node);
  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

function findNodes(
  node: HtmlNode,
  predicate: (node: HtmlNode) => boolean,
  found: HtmlNode[] = [],
): HtmlNode[] {
  for (const child of node.children)
    if (typeof child !== "string") {
      if (predicate(child)) found.push(child);
      findNodes(child, predicate, found);
    }
  return found;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString()
    : null;
}

// First date in free text: ISO, "Oct 18, 2026", "18 October 2026", "2026년 10월 18일".
export function findDateText(
  value: string,
): { iso: string; matched: string } | null {
  const candidates: Array<{
    index: number;
    iso: string | null;
    matched: string;
  }> = [];
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
    [
      /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
      (m) => {
        const parsed = Date.parse(m[0].replace(" ", "T"));
        return /[T ]/.test(m[0]) && Number.isFinite(parsed)
          ? new Date(parsed).toISOString()
          : isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
      },
    ],
    [
      new RegExp(
        `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
        "gi",
      ),
      (m) =>
        isoDate(
          Number(m[3]),
          MONTHS[m[1]!.slice(0, 3).toLowerCase()]!,
          Number(m[2]),
        ),
    ],
    [
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`,
        "gi",
      ),
      (m) =>
        isoDate(
          Number(m[3]),
          MONTHS[m[2]!.slice(0, 3).toLowerCase()]!,
          Number(m[1]),
        ),
    ],
    [
      /(\d{4})\s*(?:년|\.)\s*(\d{1,2})\s*(?:월|\.)\s*(\d{1,2})\s*(?:일|\.)?/g,
      (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])),
    ],
  ];
  for (const [pattern, convert] of patterns)
    for (const match of value.matchAll(pattern))
      candidates.push({
        index: match.index,
        iso: convert(match as RegExpExecArray),
        matched: match[0],
      });
  const first = candidates
    .filter((candidate) => candidate.iso)
    .sort((a, b) => a.index - b.index)[0];
  return first ? { iso: first.iso!, matched: first.matched } : null;
}

function dateWithin(node: HtmlNode): string | null {
  for (const time of findNodes(node, (n) => n.tag === "time")) {
    const stamp = attribute(time.attrs, "datetime");
    const found = stamp ? findDateText(stamp) : null;
    if (found) return found.iso;
  }
  return findDateText(nodeText(node))?.iso ?? null;
}

// Extract post links from a server-rendered list page. Links must be
// same-origin and match the policy; the nearest date text becomes publishedAt.
export function parseHtmlList(
  html: string,
  baseUrl: string,
  policy: Pick<HtmlSourcePolicy, "linkPattern"> &
    Partial<Pick<HtmlSourcePolicy, "maxItems" | "exclude">>,
): ExternalItem[] {
  if (Buffer.byteLength(html) > 2_000_000)
    throw new Error("HTML exceeds the 2 MB input limit");
  const base = new URL(baseUrl);
  const include = new RegExp(policy.linkPattern);
  const excluded = (policy.exclude ?? []).map((pattern) => new RegExp(pattern));
  const maxItems = policy.maxItems ?? 20;
  const root = buildHtmlTree(html);
  const matches = (anchor: HtmlNode): string | null => {
    const href = attribute(anchor.attrs, "href");
    if (!href) return null;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (url.origin !== base.origin) return null;
    if (!include.test(url.pathname)) return null;
    if (excluded.some((pattern) => pattern.test(url.pathname))) return null;
    url.hash = "";
    return url.href;
  };
  const anchors = findNodes(root, (node) => node.tag === "a")
    .map((anchor) => ({ anchor, url: matches(anchor) }))
    .filter((entry): entry is { anchor: HtmlNode; url: string } => !!entry.url);
  const urlsUnder = (node: HtmlNode): Set<string> =>
    new Set(
      findNodes(node, (n) => n.tag === "a").flatMap((a) => matches(a) ?? []),
    );

  const items = new Map<string, ExternalItem>();
  for (const { anchor, url } of anchors) {
    let item = items.get(url);
    if (!item) {
      if (items.size >= maxItems) continue;
      item = {
        externalId: url,
        url,
        title: "",
        body: "",
        author: null,
        publishedAt: null,
        metadata: { feedType: "html" },
      };
      items.set(url, item);
    }
    const anchorText = nodeText(anchor);
    let publishedAt = dateWithin(anchor);
    if (!publishedAt) {
      // Climb while the container still holds only this post's link.
      for (
        let container = anchor.parent;
        container && container.tag !== "#root";
        container = container.parent
      ) {
        const urls = urlsUnder(container);
        if (urls.size !== 1 || !urls.has(url)) break;
        publishedAt = dateWithin(container);
        if (publishedAt) break;
      }
    }
    if (!item.publishedAt && publishedAt) item.publishedAt = publishedAt;
    if (!item.title) {
      const heading = findNodes(anchor, (n) => /^h[1-6]$/.test(n.tag))
        .map(nodeText)
        .find(Boolean);
      let title = heading ?? anchorText;
      const date = findDateText(title);
      if (date) title = title.replace(date.matched, " ");
      title = title.replace(/\s+/g, " ").trim();
      item.title =
        title ||
        attribute(anchor.attrs, "title")?.trim() ||
        attribute(anchor.attrs, "aria-label")?.trim() ||
        "";
    }
  }
  return [...items.values()].filter((item) => item.title);
}

const MONTH_YEAR_TAIL = new RegExp(
  `\\b(?:${MONTH_NAMES}),?\\s+(20\\d{2})\\s*$`,
  "i",
);
const MONTH_DAY_HEAD = new RegExp(
  `^\\W*((?:${MONTH_NAMES})\\.?\\s+\\d{1,2})\\b`,
  "i",
);
const ENTRY_TITLE_MAX_CHARS = 120;

// A page holding many updates with no link of their own. `entryStart` is a regex
// that marks in the HTML where each update begins. Dates come from the start of
// the update, from a date-only heading above it, or, for "Oct 28", from a
// "October, 2026" heading above it.
export function parseHtmlEntries(
  html: string,
  pageUrl: string,
  entryStart: string,
): ExternalItem[] {
  if (Buffer.byteLength(html) > 2_000_000)
    throw new Error("HTML exceeds the 2 MB input limit");
  const page = stripInertHtml(html);
  const starts = [...page.matchAll(new RegExp(entryStart, "g"))].map(
    (match) => match.index,
  );
  const items: ExternalItem[] = [];
  let carriedDate: string | null = null;
  let year = MONTH_YEAR_TAIL.exec(
    nodeText(buildHtmlTree(page.slice(0, starts[0] ?? 0))),
  )?.[1];
  starts.forEach((start, index) => {
    const root = buildHtmlTree(page.slice(start, starts[index + 1]));
    const raw = nodeText(root)
      .replace(/\u200b/g, "")
      .trim();
    const tailYear = MONTH_YEAR_TAIL.exec(raw);
    const text = tailYear ? raw.slice(0, tailYear.index).trim() : raw;
    const monthDay = year ? MONTH_DAY_HEAD.exec(text) : null;
    const found = monthDay
      ? findDateText(`${monthDay[1]}, ${year}`)
      : findDateText(text.slice(0, 60));
    year = tailYear?.[1] ?? year;
    const body = monthDay ? text.slice(monthDay[0].length).trim() : text;
    if (found) {
      carriedDate = found.iso;
      // A heading with only a date dates the updates below it.
      if (/^\W*(?:date)?\W*$/i.test(body.replace(found.matched, ""))) return;
    }
    const heading = findNodes(root, (node) => /^h[1-6]$/.test(node.tag))
      .map((node) =>
        nodeText(node)
          .replace(/\u200b/g, "")
          .trim(),
      )
      .find((value) => value && !MONTH_YEAR_TAIL.test(value));
    const title = heading ?? body.slice(0, ENTRY_TITLE_MAX_CHARS).trim();
    if (!title) return;
    const digest = createHash("sha256")
      .update(`${carriedDate ?? ""}|${title}`)
      .digest("hex")
      .slice(0, 16);
    items.push({
      externalId: `${pageUrl}#${digest}`,
      url: pageUrl,
      title,
      body,
      author: null,
      publishedAt: carriedDate,
      metadata: { feedType: "html-entries" },
    });
  });
  return items;
}

// An article's visible text, without the site navigation when the page marks it.
export function parseHtmlArticle(html: string): string {
  if (Buffer.byteLength(html) > 2_000_000)
    throw new Error("HTML exceeds the 2 MB input limit");
  const root = buildHtmlTree(html);
  return nodeText(findNodes(root, (node) => node.tag === "main")[0] ?? root);
}

const TERMS_LINK = /\b(?:terms|tos)\b|약관|条款|服务协议|用户协议|利用規約/i;
const TERMS_URL_MAX_CHARS = 500;

// A service's home page: its visible text and the first public link to its terms.
export function parseServicePage(html: string, pageUrl: string): ServicePage {
  if (Buffer.byteLength(html) > 2_000_000)
    throw new Error("HTML exceeds the 2 MB input limit");
  const root = buildHtmlTree(html);
  let termsUrl: string | null = null;
  for (const anchor of findNodes(root, (node) => node.tag === "a")) {
    const href = attribute(anchor.attrs, "href");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!TERMS_LINK.test(`${nodeText(anchor)} ${url.pathname}`)) continue;
    // The address alone: a query can carry a referral code.
    const clean = `${url.origin}${url.pathname}`;
    if (isPublicUrl(clean) && clean.length <= TERMS_URL_MAX_CHARS) {
      termsUrl = clean;
      break;
    }
  }
  return { text: nodeText(root), termsUrl };
}

export function parseGitHubEvent(
  payload: Record<string, unknown>,
): ExternalItem {
  const repository = (payload.repository ?? payload.repo) as
    | Record<string, unknown>
    | undefined;
  const eventPayload = payload.payload as Record<string, unknown> | undefined;
  const issue = eventPayload?.issue as Record<string, unknown> | undefined;
  const pullRequest = eventPayload?.pull_request as
    | Record<string, unknown>
    | undefined;
  const commits = arrayOf(
    eventPayload?.commits as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined,
  );
  const commit = commits[0];
  const repositoryName = text(repository?.full_name) || text(repository?.name);
  const externalId =
    text(payload.id) || text(payload.node_id) || text(payload.after);
  const url =
    text(payload.html_url) ||
    text(payload.url) ||
    text(issue?.html_url) ||
    text(pullRequest?.html_url) ||
    text(commit?.url) ||
    (repositoryName ? `https://github.com/${repositoryName}` : "");
  if (!externalId || !url)
    throw new Error("GitHub event requires an id and URL");
  return {
    externalId,
    url,
    title:
      text(payload.title) ||
      text(issue?.title) ||
      text(pullRequest?.title) ||
      text(payload.message) ||
      text(commit?.message) ||
      `GitHub change ${externalId}`,
    body:
      text(payload.body) ||
      text(issue?.body) ||
      text(pullRequest?.body) ||
      text(payload.description) ||
      text(payload.message) ||
      text(commit?.message),
    author:
      text((payload.user as Record<string, unknown> | undefined)?.login) ||
      text((payload.author as Record<string, unknown> | undefined)?.login) ||
      text((payload.actor as Record<string, unknown> | undefined)?.login) ||
      null,
    publishedAt:
      text(payload.updated_at) ||
      text(payload.created_at) ||
      text(payload.timestamp) ||
      null,
    metadata: {
      repository: repositoryName,
      eventType: text(payload.type) || "change",
    },
  };
}

export class GitHubSourceAdapter implements GitHubEventReader {
  constructor(
    private readonly token?: string,
    private readonly options: SourceHttpOptions = {},
  ) {}

  async fetchRepositoryEvents(
    owner: string,
    repository: string,
    etag?: string,
    onPayload?: (payload: SourcePayload) => Promise<void>,
  ): Promise<{ items: ExternalItem[]; etag?: string }> {
    const { response, body } = await readSource(
      `https://api.github.com/repos/${owner}/${repository}/events`,
      {
        Accept: "application/vnd.github+json",
        "User-Agent": "rapi",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      this.options,
      onPayload,
    );
    if (response.status === 304)
      return { items: [], ...(etag ? { etag } : {}) };
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const payload = JSON.parse(body) as Record<string, unknown>[];
    const responseEtag = response.headers.get("etag") ?? undefined;
    return {
      items: payload.map(parseGitHubEvent),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
}

export class FeedSourceAdapter implements FeedReader {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  async fetch(
    url: string,
    etag?: string,
    onPayload?: (payload: SourcePayload) => Promise<void>,
  ): Promise<{ items: ExternalItem[]; etag?: string }> {
    const { response, body } = await readSource(
      url,
      etag ? { "If-None-Match": etag } : {},
      this.options,
      onPayload,
    );
    if (response.status === 304)
      return { items: [], ...(etag ? { etag } : {}) };
    if (!response.ok) throw new Error(`Feed returned ${response.status}`);
    const responseEtag = response.headers.get("etag") ?? undefined;
    return {
      items: parseFeed(this.options.truncate ? closeTruncatedFeed(body) : body),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
}

const HTML_HEADERS = { Accept: "text/html", "User-Agent": "rapi" };

export class HtmlSourceAdapter implements HtmlReader {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  // Same limits and fetch path as the RSS adapter (shared readSource).
  async fetch(
    url: string,
    policy: HtmlSourcePolicy,
    etag?: string,
    onPayload?: (payload: SourcePayload) => Promise<void>,
  ): Promise<{ items: ExternalItem[]; etag?: string }> {
    const { response, body } = await readSource(
      url,
      {
        Accept: "text/html",
        "User-Agent": "rapi",
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      this.options,
      onPayload,
    );
    if (response.status === 304)
      return { items: [], ...(etag ? { etag } : {}) };
    const responseEtag = response.headers.get("etag") ?? undefined;
    return {
      items: parseHtmlList(body, url, policy),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }

  async fetchEntries(url: string, entryStart: string): Promise<ExternalItem[]> {
    const { body } = await readSource(url, HTML_HEADERS, this.options);
    return parseHtmlEntries(body, url, entryStart);
  }

  async fetchArticle(url: string): Promise<string> {
    const { body } = await readSource(url, HTML_HEADERS, this.options);
    return parseHtmlArticle(body);
  }
}

export const sourceParsers: SourceParsers = {
  feed: parseFeed,
  githubEvent: parseGitHubEvent,
};

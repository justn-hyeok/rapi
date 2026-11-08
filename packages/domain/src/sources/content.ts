import { createHash } from "node:crypto";
import type { NormalizedItem } from "./items.js";

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP(S) source URLs are allowed");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function contentFingerprint(title: string, body: string): string {
  const normalized = `${title}\n${body}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function checksumPayload(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const taxonomy: Readonly<Record<string, readonly string[]>> = {
  security: ["security", "vulnerability", "cve", "보안", "취약점"],
  release: ["release", "released", "version", "출시", "버전"],
  development: ["pull request", "commit", "issue", "github", "개발"],
  ai: ["ai", "model", "llm", "인공지능", "모델"],
};

export function classify(title: string, body: string): string[] {
  const haystack = `${title} ${body}`.toLowerCase();
  const labels = Object.entries(taxonomy)
    .filter(([, words]) => words.some((word) => haystack.includes(word)))
    .map(([label]) => label);
  return labels.length > 0 ? labels : ["general"];
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,
    (_, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(Number(lower.slice(1)));
      return (
        {
          nbsp: " ",
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
        }[lower] ?? ""
      );
    },
  );
}

// Only real HTML tags: a title such as "Agents <ship>" or "Vec<String>" stays as written.
const HTML_TAG =
  /<\/?(?:a|abbr|article|aside|audio|b|blockquote|body|br|button|center|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|label|li|main|mark|nav|ol|p|path|picture|pre|s|section|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|th|thead|time|tr|u|ul|video)\b[^>]*>/gi;

/**
 * Feed text as people read it: entity-escaped HTML is decoded first, then tags,
 * comments, scripts and styles go. Anything shown in Discord or mail goes through this.
 */
export function plainText(value: string, limit = 2000): string {
  let text = value;
  for (let pass = 0; pass < 2 && /&(lt|gt|amp);/i.test(text); pass += 1)
    text = decodeEntities(text);
  return decodeEntities(
    text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(HTML_TAG, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function summarize(
  item: Pick<NormalizedItem, "title" | "body">,
): string {
  const clean = plainText(item.body, 4000);
  if (clean.length === 0) return plainText(item.title, 300);
  return clean.length <= 220 ? clean : `${clean.slice(0, 217)}...`;
}

export function splitDiscordMessage(message: string, limit = 1900): string[] {
  if (message.length <= limit) return [message];
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > limit) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n", limit),
      remaining.lastIndexOf(" ", limit),
    );
    const index = splitAt > 0 ? splitAt : limit;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

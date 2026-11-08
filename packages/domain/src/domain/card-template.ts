import defaults from "./card-templates.json" with { type: "json" };
import type { DiscordCard } from "./discord-card.js";

/**
 * How a Discord card reads, kept as data so it can be edited without code. Text
 * in {이름} is filled in by the card's code, already escaped; text in [[...]] is
 * dropped when anything in it is empty; a line that ends up empty is dropped.
 */
export interface CardTemplate {
  author: string;
  title: string;
  lines: string[];
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer: string;
  // A palette name, or {이름} whose value is one.
  color: string;
  // Fixed wording the card shows in a case, such as the discount card's risk line.
  risk?: string;
}

export interface CardTemplates {
  colors: Record<string, string>;
  routeLabels: Record<string, string>;
  cards: Record<
    | "discount"
    | "review"
    | "problem"
    | "guildRequest"
    | "star"
    | "starFound"
    | "rapiUpdate",
    CardTemplate
  >;
  texts: Record<string, string>;
}

export const DEFAULT_CARD_TEMPLATES: CardTemplates = defaults as CardTemplates;

let current: CardTemplates = DEFAULT_CARD_TEMPLATES;

/** The templates cards use. Tests and the card studio swap them; the bot never does. */
export function cardTemplates(): CardTemplates {
  return current;
}

export function useCardTemplates(templates: CardTemplates): void {
  current = templates;
}

export type TemplateValues = Record<string, string | null | undefined>;

const PLACEHOLDER = /\{([^{}[\]]+)\}/g;
const OPTIONAL = /\[\[((?:(?!\]\]).)*)\]\]/g;

/** Fills one template string. */
export function fillTemplate(template: string, values: TemplateValues): string {
  const value = (name: string) => (values[name.trim()] ?? "").trim();
  return template
    .replace(OPTIONAL, (_, inner: string) =>
      [...inner.matchAll(PLACEHOLDER)].every(([, name]) => value(name!))
        ? inner
        : "",
    )
    .replace(PLACEHOLDER, (_, name: string) => value(name))
    .trim();
}

function colorOf(
  name: string,
  values: TemplateValues,
  templates: CardTemplates,
): number | undefined {
  const key = fillTemplate(name, values);
  const hex = templates.colors[key] ?? key;
  return /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined;
}

/** A card from its template. Extra lines, already filled, such as a review's memo, follow the template's. */
export function templateCard(
  name: keyof CardTemplates["cards"],
  values: TemplateValues,
  options: {
    url?: string | null;
    extraLines?: string[];
    templates?: CardTemplates;
  } = {},
): DiscordCard {
  const templates = options.templates ?? current;
  const template = templates.cards[name];
  const fill = (text: string) => fillTemplate(text, values);
  const author = fill(template.author);
  const footer = fill(template.footer);
  // Extra lines arrive filled in: filling them again could read a stranger's
  // "{...}" as a placeholder.
  const description = [
    ...template.lines.map(fill),
    ...(options.extraLines ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  const fields = (template.fields ?? []).flatMap((field) => {
    const value = fill(field.value);
    return value
      ? [
          {
            name: fill(field.name),
            value,
            ...(field.inline ? { inline: true } : {}),
          },
        ]
      : [];
  });
  const color = colorOf(template.color, values, templates);
  return {
    ...(author ? { author } : {}),
    title: fill(template.title),
    ...(options.url ? { url: options.url } : {}),
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    ...(footer ? { footer } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

/** One of the plain texts, filled in. */
export function templateText(
  name: string,
  values: TemplateValues = {},
): string {
  return fillTemplate(current.texts[name] ?? "", values);
}

import { PostgresCommunityStore } from "./community-store.js";
import { PostgresConnectionStore } from "./connection-store.js";
import { PostgresDashboardStore } from "./dashboard-store.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresDiscordLayoutStore } from "./discord-layout-store.js";
import { PostgresDiscountCandidateStore } from "./discount-candidate-store.js";
import { PostgresGuildStore } from "./guild-store.js";
import { PostgresModelUsageStore } from "./model-usage-store.js";
import { PostgresRapiUpdateStore } from "./rapi-update-store.js";
import { PostgresReportStore } from "./report-store.js";
import { PostgresSourceStore } from "./source-store.js";
import { PostgresStarSubscriberStore } from "./star-subscriber-store.js";

/** Every Postgres store, on one database. */
export function postgresStores(db: PostgresDatabase) {
  return {
    sources: new PostgresSourceStore(db),
    discounts: new PostgresDiscountCandidateStore(db),
    reports: new PostgresReportStore(db),
    guilds: new PostgresGuildStore(db),
    rapiUpdates: new PostgresRapiUpdateStore(db),
    community: new PostgresCommunityStore(db),
    discordLayout: new PostgresDiscordLayoutStore(db),
    stars: new PostgresStarSubscriberStore(db),
    connections: new PostgresConnectionStore(db),
    modelUsage: new PostgresModelUsageStore(db),
    dashboard: new PostgresDashboardStore(db),
  };
}

export type PostgresStores = ReturnType<typeof postgresStores>;

// Public members only: two classes with the same private field (every store
// has a private db) intersect to never, which would accept any use.
type Public<T> = { [K in keyof T]: T[K] };

type Joined<T extends readonly object[]> = T extends readonly [
  infer First,
  ...infer Rest extends readonly object[],
]
  ? Public<First> & Joined<Rest>
  : unknown;

/**
 * One object with the methods of several stores, for a use case that needs
 * more than one port. Later stores do not replace an earlier one's method.
 */
export function joinStores<const T extends readonly object[]>(
  ...stores: T
): Joined<T> {
  const joined: Record<string, unknown> = {};
  for (const store of stores) {
    let proto: object | null = store;
    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const value = (store as Record<string, unknown>)[key];
        if (
          key === "constructor" ||
          key in joined ||
          typeof value !== "function"
        )
          continue;
        joined[key] = (value as (...args: unknown[]) => unknown).bind(store);
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  }
  return joined as Joined<T>;
}

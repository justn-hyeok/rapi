import { readFile } from "node:fs/promises";
import {
  ChangelogRoute,
  CodeSearchRoute,
  DiscordRateLimitError,
  PullRequestRoute,
  readServicePage,
  UncertainDeliveryError,
  type CandidateResult,
  type ChangelogSource,
  type ResolveHostname,
  type SourceHttpOptions,
} from "@rapi/adapters";
import {
  discordEmbed,
  discountCard,
  knownOperator,
  reviewCard,
  shouldCardCandidate,
  verifyCandidate,
  type CandidateForCard,
  type DeliveryAdapter,
  type DeliveryPayload,
  type KnownOperator,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { messageBody } from "./community-feeds.js";

export interface DiscountSources {
  changelogs: ChangelogSource[];
  pullRequests: { repository: string };
  codeSearch: { queries: string[]; denylist: string[] };
  operators: KnownOperator[];
}

export async function loadDiscountSources(
  root: string,
): Promise<DiscountSources> {
  return JSON.parse(
    await readFile(`${root}/config/discount-sources.json`, "utf8"),
  ) as DiscountSources;
}

type CandidateStore = Pick<
  PostgresStore,
  | "createSource"
  | "saveCursor"
  | "recordSourceFailure"
  | "saveDiscountCandidate"
>;

const NO_TOKEN = "GITHUB_READ_TOKEN이 없어 건너뜀";

/**
 * One pass over every route, recording only: nothing is posted. Each source has
 * its own row in `sources`, so `/수집원` shows its last success and last error,
 * and one failing never stops the next. Returns the sources that failed.
 */
export async function collectDiscountCandidates(input: {
  store: CandidateStore;
  sources: DiscountSources;
  githubToken?: string | undefined;
  http?: SourceHttpOptions;
  now?: () => Date;
}): Promise<string[]> {
  const { store, sources, githubToken: token, http } = input;
  const changelog = new ChangelogRoute(http, input.now);
  const pullRequests = token && new PullRequestRoute(token, http);
  const codeSearch =
    token && new CodeSearchRoute(token, sources.codeSearch.denylist, http);
  const jobs: Array<{
    kind: string;
    locator: string;
    collect?: () => Promise<CandidateResult>;
  }> = [
    ...sources.changelogs.map((source) => ({
      kind: "candidate_changelog",
      locator: source.url,
      collect: () => changelog.collect(source),
    })),
    {
      kind: "candidate_pull_request",
      locator: sources.pullRequests.repository,
      ...(pullRequests && {
        collect: () => pullRequests.collect(sources.pullRequests.repository),
      }),
    },
    ...sources.codeSearch.queries.map((query) => ({
      kind: "candidate_code_search",
      locator: query,
      ...(codeSearch && { collect: () => codeSearch.collect(query) }),
    })),
  ];

  const failures: string[] = [];
  for (const job of jobs) {
    let sourceId: string | undefined;
    try {
      sourceId = await store.createSource(job.kind, job.locator, "public");
      if (!job.collect) {
        await store.recordSourceFailure(sourceId, NO_TOKEN);
        continue;
      }
      const { candidates, problem } = await job.collect();
      for (const candidate of candidates)
        await store.saveDiscountCandidate(candidate);
      if (problem) throw new Error(problem);
      await store.saveCursor(sourceId, new Date().toISOString(), null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      failures.push(`${job.locator}: ${message}`);
      if (sourceId)
        await store.recordSourceFailure(sourceId, message).catch(() => {});
    }
  }
  return failures;
}

type VerificationStore = Pick<
  PostgresStore,
  "unverifiedDiscountCandidates" | "saveCandidateVerification"
>;

// Pages are read one at a time; anything past this waits for tomorrow's run.
const VERIFICATIONS_PER_RUN = 200;

/**
 * Decides the band and tags of every candidate without one. Nothing is posted. A
 * page that cannot be read is a result, recorded as such; only a row that could
 * not be checked or saved is a failure, and it is tried again on the next run.
 */
export async function verifyDiscountCandidates(input: {
  store: VerificationStore;
  operators: readonly KnownOperator[];
  http?: SourceHttpOptions & { resolve?: ResolveHostname };
}): Promise<string[]> {
  const { store, operators, http } = input;
  const failures: string[] = [];
  let candidates;
  try {
    candidates = await store.unverifiedDiscountCandidates(
      VERIFICATIONS_PER_RUN,
    );
  } catch (error) {
    return [
      `verification: ${error instanceof Error ? error.message : "failed"}`,
    ];
  }
  for (const candidate of candidates) {
    try {
      const page = candidate.domain
        ? await readServicePage(candidate.domain, http)
        : null;
      await store.saveCandidateVerification(
        candidate.id,
        verifyCandidate(
          candidate,
          knownOperator(candidate.domain, operators),
          page,
        ),
      );
    } catch (error) {
      failures.push(
        `${candidate.domain ?? candidate.id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }
  return failures;
}

type CardStore = Pick<
  PostgresStore,
  | "cardsInLastHour"
  | "candidatesForCards"
  | "claimCandidateCard"
  | "releaseCandidateCard"
  | "saveCandidateCardMessage"
>;

export const CARDS_PER_HOUR = 5;
// Most recent rows are noise, so look well past what can be sent.
const CARD_ROWS_TO_READ = 500;
// A channel that refuses everything is not asked about the whole backlog each run.
const CARD_ATTEMPTS_PER_RUN = 20;

export const DISCOUNT_PUBLISH_PREFIX = "discount_publish:";
export const DISCOUNT_DISCARD_PREFIX = "discount_discard:";

/** One card as one message with its link, and nothing the reader could press to decide. */
export function cardPayloadFor(
  candidate: CandidateForCard,
  deadline = "",
): DeliveryPayload {
  return {
    subject: candidate.title,
    text: candidate.title,
    html: "",
    itemIds: [],
    discord: messageBody([discordEmbed(discountCard(candidate, deadline))]),
  };
}

// The buttons carry only the row id; whoever presses them is checked on the click.
function reviewPayloadFor(candidate: CandidateForCard): DeliveryPayload {
  const message = messageBody([discordEmbed(reviewCard(candidate))]);
  return {
    ...cardPayloadFor(candidate),
    discord: {
      ...message,
      components: [
        ...(message.components ?? []),
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "게시",
              custom_id: `${DISCOUNT_PUBLISH_PREFIX}${candidate.id}`,
            },
            {
              type: 2,
              style: 4,
              label: "버리기",
              custom_id: `${DISCOUNT_DISCARD_PREFIX}${candidate.id}`,
            },
          ],
        },
      ],
    },
  };
}

const failureText = (id: string, error: unknown) =>
  `${id}: ${error instanceof Error ? error.message : "failed"}`;

/**
 * Sends what `budget` allows; the rest stay unclaimed for a later run. A row is
 * claimed before its send, so dying mid-send loses a card (the row shows it:
 * carded_at without a message id) rather than sending it twice. Only a send
 * Discord definitely refused is released and tried again. Returns the failures.
 */
async function sendClaimedCards<Row extends { id: string }>(input: {
  rows: readonly Row[];
  budget: number;
  delivery: Pick<DeliveryAdapter, "send">;
  channelId: string;
  claim: (id: string) => Promise<boolean>;
  release: (id: string) => Promise<void>;
  saveMessage: (id: string, messageId: string) => Promise<void>;
  payload: (row: Row) => DeliveryPayload;
  deliveryKey: string;
}): Promise<string[]> {
  const { rows, delivery, channelId, claim, release, saveMessage } = input;
  let budget = input.budget;
  const failures: string[] = [];
  for (const row of rows) {
    if (budget <= 0) break;
    try {
      if (!(await claim(row.id))) continue;
    } catch (error) {
      failures.push(failureText(row.id, error));
      continue;
    }
    let messageId: string;
    try {
      const sent = await delivery.send(
        { channel: "discord_channel", recipientId: channelId },
        input.payload(row),
        `${input.deliveryKey}:${row.id}`,
      );
      messageId = sent.providerId;
    } catch (error) {
      failures.push(failureText(row.id, error));
      // It may be in the channel already, so it keeps the claim and counts.
      if (error instanceof UncertainDeliveryError) {
        budget -= 1;
        continue;
      }
      await release(row.id).catch((releaseError: unknown) =>
        failures.push(failureText(row.id, releaseError)),
      );
      if (error instanceof DiscordRateLimitError) break;
      continue;
    }
    budget -= 1;
    await saveMessage(row.id, messageId).catch((saveError: unknown) =>
      failures.push(failureText(row.id, saveError)),
    );
  }
  return failures;
}

/** Verified candidates, as many as the hourly limit allows. */
export async function sendDiscountCards(input: {
  store: CardStore;
  delivery: Pick<DeliveryAdapter, "send">;
  channelId: string;
}): Promise<string[]> {
  const { store, delivery, channelId } = input;
  let budget: number;
  let candidates: CandidateForCard[];
  try {
    budget = CARDS_PER_HOUR - (await store.cardsInLastHour());
    if (budget <= 0) return [];
    candidates = (await store.candidatesForCards(CARD_ROWS_TO_READ))
      .filter(shouldCardCandidate)
      .slice(0, CARD_ATTEMPTS_PER_RUN);
  } catch (error) {
    return [failureText("cards", error)];
  }
  return sendClaimedCards({
    rows: candidates,
    budget,
    delivery,
    channelId,
    claim: (id) => store.claimCandidateCard(id),
    release: (id) => store.releaseCandidateCard(id),
    saveMessage: (id, messageId) =>
      store.saveCandidateCardMessage(id, messageId),
    payload: reviewPayloadFor,
    deliveryKey: "discount-card",
  });
}

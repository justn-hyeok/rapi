import {
  type CandidateJob,
  type DiscordGateway,
  DiscordRateLimitError,
  type DiscountCandidateStore,
  type ServicePageGateway,
  type SourceStore,
  UncertainDeliveryError,
} from "./ports/index.js";
import {
  discordEmbed,
  discountCard,
  knownOperator,
  problemCard,
  reviewCard,
  shouldCardCandidate,
  UNVETTED_ROUTES,
  verifyCandidate,
  type CandidateForCard,
  type DeliveryPayload,
  type DiscountCandidate,
  type DiscountCandidateRoute,
  type ProblemReportForCard,
  type KnownOperator,
} from "@rapi/domain";
import { messageBody } from "./community-feeds.js";

type CandidateStore = Pick<
  DiscountCandidateStore,
  "knownCandidateKeys" | "saveDiscountCandidate"
> &
  Pick<
    SourceStore,
    "createSource" | "sourceCursor" | "saveCursor" | "recordSourceFailure"
  >;

const CHINESE = /\p{Script=Han}/u;
const KOREAN = /\p{Script=Hangul}/u;
// Three words in a row: an English sentence, not a name, an address or "PR #7".
const ENGLISH_WORDS =
  /[A-Za-z]{3,}[\s,:'’-]+[A-Za-z]{2,}[\s,:'’-]+[A-Za-z]{2,}/;

/**
 * Whether a row's field is read by people in another language: Chinese
 * anywhere, or English with no Korean in it, on an offer. A new service's
 * title is its name or address, and a report's is the reporter's domain.
 */
export function needsKorean(
  candidate: Pick<DiscountCandidate, "kind" | "route">,
  text: string,
): boolean {
  if (CHINESE.test(text)) return true;
  if (candidate.kind !== "discount" || candidate.route === "report")
    return false;
  return (
    !KOREAN.test(text) && !/^https?:\/\//.test(text) && ENGLISH_WORDS.test(text)
  );
}

/**
 * Rows in Korean before they are stored. Rows already stored are left out, so
 * a feed seen again every day is translated once. A failed translation keeps
 * the original wording: an untranslated card still says what was offered.
 */
async function inKorean(
  candidates: DiscountCandidate[],
  translate: ((texts: string[]) => Promise<string[]>) | undefined,
  known: ReadonlySet<string> = new Set(),
): Promise<{ candidates: DiscountCandidate[]; problem?: string }> {
  const fields = candidates.flatMap((candidate, index) =>
    known.has(candidate.dedupeKey)
      ? []
      : (["title", "evidence"] as const)
          .filter((field) => needsKorean(candidate, candidate[field]))
          .map((field) => ({ index, field })),
  );
  if (!translate || !fields.length) return { candidates };
  try {
    const korean = await translate(
      fields.map(({ index, field }) => candidates[index]![field]),
    );
    const result = candidates.map((candidate) => ({ ...candidate }));
    fields.forEach(({ index, field }, i) => {
      result[index]![field] = korean[i]!;
    });
    return { candidates: result };
  } catch (error) {
    return {
      candidates,
      problem: `translation: ${error instanceof Error ? error.message : "failed"}`,
    };
  }
}

/**
 * One pass over every route, recording only: nothing is posted. Each source has
 * its own row in `sources`, so `/수집원` shows its last success and last error,
 * and one failing never stops the next. Returns the sources that failed.
 */
export async function collectDiscountCandidates(input: {
  store: CandidateStore;
  jobs: readonly CandidateJob[];
  translate?: (texts: string[]) => Promise<string[]>;
}): Promise<string[]> {
  const { store, jobs } = input;
  const failures: string[] = [];
  for (const job of jobs) {
    let sourceId: string | undefined;
    try {
      sourceId = await store.createSource(job.kind, job.locator, "public");
      if (!job.collect) {
        await store.recordSourceFailure(sourceId, job.skipped ?? "건너뜀");
        continue;
      }
      const id = sourceId;
      const collected = await job.collect(() => store.sourceCursor(id));
      const { problem, cursor } = collected;
      const translated = await inKorean(
        collected.candidates,
        input.translate,
        input.translate && collected.candidates.length
          ? await store.knownCandidateKeys(
              collected.candidates.map((candidate) => candidate.dedupeKey),
            )
          : new Set(),
      );
      if (translated.problem)
        failures.push(`${job.locator}: ${translated.problem}`);
      for (const candidate of translated.candidates)
        await store.saveDiscountCandidate(candidate);
      if (problem) throw new Error(problem);
      await store.saveCursor(
        sourceId,
        cursor ?? new Date().toISOString(),
        null,
      );
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
  DiscountCandidateStore,
  | "unverifiedDiscountCandidates"
  | "saveCandidateVerification"
  | "saveDiscountCandidate"
>;

// Pages are read one at a time; anything past this waits for tomorrow's run.
const VERIFICATIONS_PER_RUN = 200;
// On the short timer, so a page taking its full time cannot outlast the run.
const REPORT_VERIFICATIONS_PER_RUN = 20;

/**
 * Decides the band and tags of every candidate without one. Nothing is posted. A
 * page that cannot be read is a result, recorded as such; only a row that could
 * not be checked or saved is a failure, and it is tried again on the next run.
 */
export async function verifyDiscountCandidates(
  input: {
    store: VerificationStore;
    operators: readonly KnownOperator[];
    pages: ServicePageGateway;
    translate?: (texts: string[]) => Promise<string[]>;
  },
  only: { limit: number; route?: DiscountCandidateRoute } = {
    limit: VERIFICATIONS_PER_RUN,
  },
): Promise<string[]> {
  const { store, operators, pages } = input;
  const failures: string[] = [];
  let candidates;
  try {
    candidates = await store.unverifiedDiscountCandidates(
      only.limit,
      only.route,
    );
  } catch (error) {
    return [
      `verification: ${error instanceof Error ? error.message : "failed"}`,
    ];
  }
  for (const candidate of candidates) {
    try {
      const page = candidate.domain ? await pages.read(candidate.domain) : null;
      const known = knownOperator(candidate.domain, operators);
      await store.saveCandidateVerification(
        candidate.id,
        verifyCandidate(candidate, known, page),
      );
      // A new service's own page may already offer something: that is a deal
      // of its own, found once, when the service is first checked.
      if (candidate.kind === "new_service" && candidate.domain && !known) {
        const offer = await pages.offer(candidate.domain, page);
        if (offer) {
          const translated = await inKorean([offer], input.translate);
          if (translated.problem)
            failures.push(`${candidate.domain}: ${translated.problem}`);
          await store.saveDiscountCandidate(translated.candidates[0]!);
        }
      }
    } catch (error) {
      failures.push(
        `${candidate.domain ?? candidate.id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }
  return failures;
}

type CardStore = Pick<
  DiscountCandidateStore,
  | "cardsInLastHour"
  | "newServiceCardsInLastDay"
  | "unvettedCardsInLastDay"
  | "candidatesForCards"
  | "claimCandidateCard"
  | "releaseCandidateCard"
  | "saveCandidateCardMessage"
>;

export const CARDS_PER_HOUR = 5;
// Providers open PRs and appear in code far more often than anything gets cheaper.
export const NEW_SERVICE_CARDS_PER_DAY = 5;
// A forum posts deals all day, lists change daily, and each is risky to begin with.
export const UNVETTED_CARDS_PER_DAY = 3;
// Most recent rows are noise, so look well past what can be sent.
const CARD_ROWS_TO_READ = 500;
// A channel that refuses everything is not asked about the whole backlog each run.
const CARD_ATTEMPTS_PER_RUN = 20;

export const DISCOUNT_PUBLISH_PREFIX = "discount_publish:";
export const DISCOUNT_DISCARD_PREFIX = "discount_discard:";
export const PROBLEM_RED_PREFIX = "problem_red:";
export const PROBLEM_CLEAR_PREFIX = "problem_clear:";

/** Where review cards go. A kind without a channel is not sent. */
export interface CardChannels {
  discount: string | undefined;
  newService: string | undefined;
  report: string | undefined;
}

// A report is someone waiting on the owner, whatever it turned out to be.
export function cardChannelFor(
  candidate: Pick<CandidateForCard, "kind" | "route">,
  channels: CardChannels,
): string | undefined {
  if (candidate.route === "report") return channels.report;
  return candidate.kind === "new_service"
    ? channels.newService
    : channels.discount;
}

export async function isReviewChannel(
  channelIds: () => Promise<readonly string[]>,
  channelId: string | undefined,
): Promise<boolean> {
  return channelId !== undefined && (await channelIds()).includes(channelId);
}

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
 * Reports check out on the card timer: someone is waiting, and it is not a day's
 * worth of rows. The daily run would get to them too; the band is only written once.
 */
export const verifyReports = (input: {
  store: VerificationStore;
  operators: readonly KnownOperator[];
  pages: ServicePageGateway;
}): Promise<string[]> =>
  verifyDiscountCandidates(input, {
    limit: REPORT_VERIFICATIONS_PER_RUN,
    route: "report",
  });

/**
 * Sends what `budget` allows; the rest stay unclaimed for a later run. A row is
 * claimed before its send, so dying mid-send loses a card (the row shows it:
 * carded_at without a message id) rather than sending it twice. Only a send
 * Discord definitely refused is released and tried again. Returns the failures.
 */
export async function sendClaimedCards<Row extends { id: string }>(input: {
  rows: readonly Row[];
  budget: number;
  delivery: Pick<DiscordGateway, "send">;
  channelFor: (row: Row) => string;
  claim: (id: string) => Promise<boolean>;
  release: (id: string) => Promise<void>;
  saveMessage: (id: string, messageId: string) => Promise<void>;
  payload: (row: Row) => DeliveryPayload;
  deliveryKey: string;
}): Promise<string[]> {
  const { rows, delivery, channelFor, claim, release, saveMessage } = input;
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
        { channel: "discord_channel", recipientId: channelFor(row) },
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
  delivery: Pick<DiscordGateway, "send">;
  channels: CardChannels;
}): Promise<string[]> {
  const { store, delivery, channels } = input;
  let budget: number;
  let candidates: CandidateForCard[];
  try {
    budget = CARDS_PER_HOUR - (await store.cardsInLastHour());
    if (budget <= 0) return [];
    let newServicesLeft =
      NEW_SERVICE_CARDS_PER_DAY - (await store.newServiceCardsInLastDay());
    let unvettedLeft =
      UNVETTED_CARDS_PER_DAY - (await store.unvettedCardsInLastDay());
    candidates = (await store.candidatesForCards(CARD_ROWS_TO_READ))
      .filter((candidate) => shouldCardCandidate(candidate))
      .filter((candidate) => cardChannelFor(candidate, channels))
      .filter((candidate) => {
        if (UNVETTED_ROUTES.includes(candidate.route)) {
          unvettedLeft -= 1;
          return unvettedLeft >= 0;
        }
        if (candidate.kind !== "new_service" || candidate.route === "report")
          return true;
        newServicesLeft -= 1;
        return newServicesLeft >= 0;
      })
      .slice(0, CARD_ATTEMPTS_PER_RUN);
  } catch (error) {
    return [failureText("cards", error)];
  }
  return sendClaimedCards({
    rows: candidates,
    budget,
    delivery,
    channelFor: (candidate) => cardChannelFor(candidate, channels)!,
    claim: (id) => store.claimCandidateCard(id),
    release: (id) => store.releaseCandidateCard(id),
    saveMessage: (id, messageId) =>
      store.saveCandidateCardMessage(id, messageId),
    payload: reviewPayloadFor,
    deliveryKey: "discount-card",
  });
}

type ProblemCardStore = Pick<
  DiscountCandidateStore,
  | "cardsInLastHour"
  | "problemReportsForCards"
  | "claimProblemCard"
  | "releaseProblemCard"
  | "saveProblemCardMessage"
>;

function problemPayloadFor(report: ProblemReportForCard): DeliveryPayload {
  const message = messageBody([discordEmbed(problemCard(report))]);
  return {
    subject: report.domain,
    text: report.domain,
    html: "",
    itemIds: [],
    discord: {
      ...message,
      components: [
        ...(message.components ?? []),
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: "빨강으로 정함",
              custom_id: `${PROBLEM_RED_PREFIX}${report.id}`,
            },
            {
              type: 2,
              style: 2,
              label: "문제 없음",
              custom_id: `${PROBLEM_CLEAR_PREFIX}${report.id}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Problem reports, ahead of the other cards when run first. They share the
 * channel's hourly limit, so many of them cannot flood the owner.
 */
export async function sendProblemCards(input: {
  store: ProblemCardStore;
  delivery: Pick<DiscordGateway, "send">;
  channelId: string;
}): Promise<string[]> {
  const { store, delivery, channelId } = input;
  let budget: number;
  let rows: ProblemReportForCard[];
  try {
    budget = CARDS_PER_HOUR - (await store.cardsInLastHour());
    if (budget <= 0) return [];
    rows = await store.problemReportsForCards(CARD_ATTEMPTS_PER_RUN);
  } catch (error) {
    return [failureText("problem cards", error)];
  }
  return sendClaimedCards({
    rows,
    budget,
    delivery,
    channelFor: () => channelId,
    claim: (id) => store.claimProblemCard(id),
    release: (id) => store.releaseProblemCard(id),
    saveMessage: (id, messageId) => store.saveProblemCardMessage(id, messageId),
    payload: problemPayloadFor,
    deliveryKey: "problem-card",
  });
}

export interface SummaryInput {
  id: string;
  title: string;
  body: string;
  url: string;
  /** Background the reader needs, e.g. what a GitHub repository is. */
  context?: string;
}

export interface ItemSummarizer {
  readonly policy: string;
  summarize(items: SummaryInput[]): Promise<Map<string, string>>;
  /** Keeps the items that fit a channel, each with a short Korean summary. */
  curate?(
    items: SummaryInput[],
    channel: CurationChannel,
  ): Promise<Map<string, string>>;
  /** Each text in Korean, in the same order. */
  translate?(texts: string[]): Promise<string[]>;
}

export type CurationChannel = "ai-blogs" | "free-tokens";

import type {
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/domain";

export interface DeliveryAdapter {
  send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult>;
}

export class UncertainDeliveryError extends Error {
  readonly possiblyDelivered = true;
}

export class PermanentDeliveryError extends Error {}

/** Nothing was sent; the caller should stop asking for a while. */
export class DiscordRateLimitError extends Error {}

/** A 5xx: usually nothing was posted, but Discord did not say so. */
export class DiscordServerError extends Error {}

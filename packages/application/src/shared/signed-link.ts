import { createHmac, timingSafeEqual } from "node:crypto";

const DAY_MS = 86_400_000;
const DISCORD_ID = /^\d{1,32}$/;

const linkKey = (secret: string, label: string) =>
  createHmac("sha256", secret).update(label).digest();

const signature = (
  secret: string,
  label: string,
  userId: string,
  expires: number,
) =>
  createHmac("sha256", linkKey(secret, label))
    .update(`${userId}.${expires}`)
    .digest("base64url");

/** "<expires>.<signature>" for one person, expiring in `days` days. */
export function signedLinkToken(
  secret: string,
  label: string,
  userId: string,
  days: number,
  now: Date,
): string {
  const expires = Math.floor((now.getTime() + days * DAY_MS) / 1000);
  return `${expires}.${signature(secret, label, userId, expires)}`;
}

/** Whether the token is this person's, for this label, and has not expired. */
export function validSignedLinkToken(
  secret: string,
  label: string,
  userId: string | null,
  token: string | null,
  now: Date,
): boolean {
  if (!userId || !DISCORD_ID.test(userId)) return false;
  const [expiresText, given] = (token ?? "").split(".");
  const expires = Number(expiresText);
  if (!given || !Number.isInteger(expires) || expires * 1000 < now.getTime())
    return false;
  const expected = Buffer.from(signature(secret, label, userId, expires));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretBox } from "@rapi/application";

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64",
    );
  return key;
}

export function encryptSecret(secret: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, encodedKey: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra)
    throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(encodedKey),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Seals with AES-256-GCM under the deployment's WEBHOOK_ENCRYPTION_KEY. */
export function secretBox(key: string): SecretBox {
  return {
    seal: (text) => encryptSecret(text, key),
    open: (sealed) => decryptSecret(sealed, key),
  };
}

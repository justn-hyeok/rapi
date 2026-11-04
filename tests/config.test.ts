import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnvironment } from "../packages/config/src/index.js";

const validEnvironment = {
  REDHOOD_ENV: "test",
  DATABASE_URL: "postgresql://redhood:redhood@localhost:5432/redhood",
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "1234567890",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_ALLOWED_USER_IDS: "100,200",
};

describe("environment configuration", () => {
  it("ignores leftover OMP_* keys from an older .env", () => {
    const config = loadEnvironment({
      ...validEnvironment,
      OMP_ENDPOINT: "http://127.0.0.1:3200",
      OMP_CALLBACK_SECRET: "x",
      OMP_READY_URL: "not-a-url",
    });
    assert.equal(config.DATABASE_URL, validEnvironment.DATABASE_URL);
  });

  it("parses allowlists before application startup", () => {
    const config = loadEnvironment({
      ...validEnvironment,
      DISCORD_SUPERADMIN_USER_IDS: "100",
      DISCORD_ADMIN_ROLE_IDS: "300",
      DISCORD_USER_ROLE_IDS: "400,500",
      DISCORD_GUILD_MEMBERS_ARE_USERS: "true",
    });
    assert.deepEqual(config.DISCORD_ALLOWED_USER_IDS, ["100", "200"]);
    assert.deepEqual(config.DISCORD_SUPERADMIN_USER_IDS, ["100"]);
    assert.deepEqual(config.DISCORD_ADMIN_ROLE_IDS, ["300"]);
    assert.deepEqual(config.DISCORD_USER_ROLE_IDS, ["400", "500"]);
    assert.equal(config.DISCORD_GUILD_MEMBERS_ARE_USERS, true);
  });

  it("reports invalid fields without exposing values", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          DATABASE_URL: "sqlite://local",
        }),
      /DATABASE_URL must use postgresql:\/\//,
    );
  });

  it("requires an encryption key for fixed managed webhook endpoints", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          REDHOOD_PUBLIC_BASE_URL: "https://redhood.example.com",
        }),
      /WEBHOOK_ENCRYPTION_KEY and REDHOOD_PUBLIC_BASE_URL/,
    );
    const config = loadEnvironment({
      ...validEnvironment,
      REDHOOD_PUBLIC_BASE_URL: "https://redhood.example.com",
      WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    assert.equal(config.DB_POOL_MAX, 5);
    assert.equal(config.DB_QUERY_TIMEOUT_MS, 5000);
  });

  it("requires certificate verification for production database connections", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          REDHOOD_ENV: "production",
          DATABASE_URL: "postgresql://redhood:redhood@example.com:5432/redhood",
        }),
      /sslmode=verify-full or verify-ca/,
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        REDHOOD_ENV: "production",
      }),
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        REDHOOD_ENV: "production",
        DATABASE_URL:
          "postgresql://redhood:redhood@example.com:5432/redhood?sslmode=verify-full",
      }),
    );
  });
});

describe("model gateway configuration", () => {
  it("is off by default and keeps the codex summarizer", () => {
    const config = loadEnvironment(validEnvironment);
    assert.equal(config.MODEL_API_BASE_URL, undefined);
    assert.equal(config.MODEL_API_KEY, undefined);
    assert.equal(config.MODEL_MONTHLY_BUDGET_USD, undefined);
    assert.equal(config.SUMMARIZER_BACKEND, "codex");
  });

  it("allows plain http only on loopback", () => {
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        MODEL_API_BASE_URL: "http://127.0.0.1:4000/v1",
      }).MODEL_API_BASE_URL,
      "http://127.0.0.1:4000/v1",
    );
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          MODEL_API_BASE_URL: "http://gateway.example.com/v1",
        }),
      /HTTPS/,
    );
  });

  it("requires a configured client for the api summarizer", () => {
    assert.throws(
      () => loadEnvironment({ ...validEnvironment, SUMMARIZER_BACKEND: "api" }),
      /SUMMARIZER_BACKEND/,
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        SUMMARIZER_BACKEND: "api",
        MODEL_API_BASE_URL: "https://api.openai.com/v1",
        MODEL_API_KEY: "k",
        MODEL_DEFAULT: "gpt-4o-mini",
        MODEL_MONTHLY_BUDGET_USD: "20",
      }).MODEL_MONTHLY_BUDGET_USD,
      20,
    );
  });
});

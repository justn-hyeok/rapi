import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadEnvironment,
  notificationChannels,
} from "../packages/config/src/index.js";

const validEnvironment = {
  RAPI_ENV: "test",
  DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
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

  it("starts without a discount card channel and rejects a malformed one", () => {
    assert.equal(
      loadEnvironment(validEnvironment).DISCOUNT_REVIEW_CHANNEL_ID,
      undefined,
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        DISCOUNT_REVIEW_CHANNEL_ID: "123",
      }).DISCOUNT_REVIEW_CHANNEL_ID,
      "123",
    );
    assert.throws(() =>
      loadEnvironment({
        ...validEnvironment,
        DISCOUNT_REVIEW_CHANNEL_ID: "owner-only",
      }),
    );
  });

  it("starts without a star reminder user and rejects a malformed one", () => {
    assert.equal(
      loadEnvironment(validEnvironment).STAR_REMINDER_GITHUB_USER,
      undefined,
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        STAR_REMINDER_GITHUB_USER: "justn-hyeok",
      }).STAR_REMINDER_GITHUB_USER,
      "justn-hyeok",
    );
    assert.throws(() =>
      loadEnvironment({
        ...validEnvironment,
        STAR_REMINDER_GITHUB_USER: "../orgs/x",
      }),
    );
  });

  it("starts without a public discount channel and rejects a malformed one", () => {
    assert.equal(
      loadEnvironment(validEnvironment).DISCOUNT_PUBLIC_CHANNEL_ID,
      undefined,
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        DISCOUNT_PUBLIC_CHANNEL_ID: "456",
      }).DISCOUNT_PUBLIC_CHANNEL_ID,
      "456",
    );
    assert.throws(() =>
      loadEnvironment({
        ...validEnvironment,
        DISCOUNT_PUBLIC_CHANNEL_ID: "everyone",
      }),
    );
  });

  it("sends a kind without its own channel where discounts go", () => {
    const shared = notificationChannels(
      loadEnvironment({
        ...validEnvironment,
        DISCOUNT_REVIEW_CHANNEL_ID: "1",
        DISCOUNT_PUBLIC_CHANNEL_ID: "2",
      }),
    );
    assert.deepEqual(shared, {
      review: {
        discount: "1",
        newService: "1",
        report: "1",
        guildRequest: "1",
      },
      reviewIds: ["1"],
      public: { discount: "2", newService: "2" },
    });
    assert.deepEqual(
      notificationChannels(
        loadEnvironment({
          ...validEnvironment,
          DISCOUNT_REVIEW_CHANNEL_ID: "1",
          DISCOUNT_PUBLIC_CHANNEL_ID: "2",
          NEW_SERVICE_REVIEW_CHANNEL_ID: "3",
          NEW_SERVICE_PUBLIC_CHANNEL_ID: "4",
          REPORT_REVIEW_CHANNEL_ID: "5",
          GUILD_REQUEST_REVIEW_CHANNEL_ID: "6",
        }),
      ),
      {
        review: {
          discount: "1",
          newService: "3",
          report: "5",
          guildRequest: "6",
        },
        reviewIds: ["1", "3", "5", "6"],
        public: { discount: "2", newService: "4" },
      },
    );
    assert.deepEqual(
      notificationChannels(loadEnvironment(validEnvironment)).reviewIds,
      [],
    );
    assert.throws(() =>
      loadEnvironment({
        ...validEnvironment,
        REPORT_REVIEW_CHANNEL_ID: "reports",
      }),
    );
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
          RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
        }),
      /WEBHOOK_ENCRYPTION_KEY and RAPI_PUBLIC_BASE_URL/,
    );
    const config = loadEnvironment({
      ...validEnvironment,
      RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
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
          RAPI_ENV: "production",
          DATABASE_URL: "postgresql://rapi:rapi@example.com:5432/rapi",
        }),
      /sslmode=verify-full or verify-ca/,
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        RAPI_ENV: "production",
      }),
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        RAPI_ENV: "production",
        DATABASE_URL:
          "postgresql://rapi:rapi@example.com:5432/rapi?sslmode=verify-full",
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

import { z } from "zod";

const csvIds = z
  .string()
  .min(1)
  .transform((value) => value.split(",").map((part) => part.trim()))
  .pipe(z.array(z.string().regex(/^\d+$/)).min(1));

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const environmentSchema = z
  .object({
    RAPI_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RAPI_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATABASE_URL: z.url().refine((url) => url.startsWith("postgresql://"), {
      message: "DATABASE_URL must use postgresql://",
    }),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    DB_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(5000),
    DB_QUERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(5000),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
    DISCORD_PUBLIC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    DISCORD_ALLOWED_USER_IDS: csvIds,
    DISCORD_SUPERADMIN_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_USER_IDS: csvIds.optional(),
    DISCORD_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_ROLE_IDS: csvIds.optional(),
    DISCORD_USER_ROLE_IDS: csvIds.optional(),
    DISCORD_GUILD_MEMBERS_ARE_USERS: booleanString,
    DISCORD_ALLOWED_GUILD_IDS: csvIds.optional(),
    DISCORD_HOME_GUILD_ID: z.string().regex(/^\d+$/).optional(),
    DISCORD_ALLOWED_CHANNEL_IDS: csvIds.optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEBHOOK_ENCRYPTION_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      }, "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64")
      .optional(),
    RAPI_PUBLIC_BASE_URL: z.url().optional(),
    PUBLIC_TUNNEL_VERIFIED_FILE: z
      .string()
      .default("/var/lib/rapi/tunnel-verified.json"),
    MONITOR_STATE_FILE: z.string().default("/var/lib/rapi/monitor-state.json"),
    MONITOR_PORT: z.coerce.number().int().min(1).max(65535).default(4300),
    PUBLIC_GATEWAY_READY_URL: z.url().default("http://127.0.0.1:4601/ready"),
    CLOUDFLARE_TUNNEL_READY_URL: z.url().default("http://127.0.0.1:4700/ready"),
    DISCORD_LAYOUT_FILE: z
      .string()
      .default("/home/justn/rapi/config/discord-channels.yaml"),
    OPERATIONS_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    OPERATIONS_DISCORD_WEBHOOK_URL: z.url().optional(),
    OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT: z.string().min(1).optional(),
    DATABASE_SIZE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(500_000_000),
    MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
    BOT_READY_URL: z.url().default("http://127.0.0.1:4000/ready"),
    BACKUP_STATUS_FILE: z.string().default("backups/backup-status.json"),
    GITHUB_READ_TOKEN: z.string().min(1).optional(),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
    MODEL_API_BASE_URL: z.url().optional(),
    MODEL_API_KEY: z.string().min(1).optional(),
    MODEL_DEFAULT: z.string().min(1).optional(),
    MODEL_MONTHLY_BUDGET_USD: z.coerce.number().positive().optional(),
    MODEL_PRICES_FILE: z.string().min(1).optional(),
    MODEL_FOR_SUMMARY: z.string().min(1).optional(),
    SUMMARIZER_BACKEND: z.enum(["codex", "api"]).default("codex"),
    COMMUNITY_GUILD_ID: z.string().regex(/^\d+$/).optional(),
    DISCOUNT_REVIEW_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    DISCOUNT_PUBLIC_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    NEW_SERVICE_REVIEW_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    NEW_SERVICE_PUBLIC_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    REPORT_REVIEW_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    GUILD_REQUEST_REVIEW_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    STAR_REMINDER_GITHUB_USER: z
      .string()
      .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.MODEL_API_BASE_URL) {
      // The key travels in a header: plain HTTP is only acceptable on loopback.
      const url = new URL(value.MODEL_API_BASE_URL);
      if (
        url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        context.addIssue({
          code: "custom",
          path: ["MODEL_API_BASE_URL"],
          message: "MODEL_API_BASE_URL must use HTTPS unless it is loopback",
        });
    }
    if (
      value.SUMMARIZER_BACKEND === "api" &&
      (!value.MODEL_API_BASE_URL ||
        !value.MODEL_API_KEY ||
        !(value.MODEL_FOR_SUMMARY || value.MODEL_DEFAULT))
    )
      context.addIssue({
        code: "custom",
        path: ["SUMMARIZER_BACKEND"],
        message:
          "SUMMARIZER_BACKEND=api requires MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_DEFAULT (or MODEL_FOR_SUMMARY)",
      });
    if (value.RAPI_PUBLIC_BASE_URL && !value.WEBHOOK_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        path: ["WEBHOOK_ENCRYPTION_KEY"],
        message:
          "WEBHOOK_ENCRYPTION_KEY and RAPI_PUBLIC_BASE_URL must be configured together",
      });
    }
    if (
      value.OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT &&
      !value.WEBHOOK_ENCRYPTION_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT"],
        message: "encrypted operations webhook requires WEBHOOK_ENCRYPTION_KEY",
      });
    }
    if (
      value.RAPI_PUBLIC_BASE_URL &&
      !value.RAPI_PUBLIC_BASE_URL.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["RAPI_PUBLIC_BASE_URL"],
        message: "RAPI_PUBLIC_BASE_URL must use HTTPS",
      });
    }
    if (value.RAPI_ENV !== "production") return;
    try {
      const databaseUrl = new URL(value.DATABASE_URL);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        databaseUrl.hostname,
      );
      if (
        !isLoopback &&
        !["verify-full", "verify-ca"].includes(
          databaseUrl.searchParams.get("sslmode") ?? "",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            "production DATABASE_URL must set sslmode=verify-full or verify-ca",
        });
      }
    } catch {
      // The URL field reports malformed connection strings.
    }
  });

export type Environment = z.infer<typeof environmentSchema>;
export function loadEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): Environment {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

/**
 * Where each kind of notification goes. A kind without its own channel goes where
 * discounts go, so one channel is enough until the owner wants them apart.
 */
export function notificationChannels(
  config: Pick<
    Environment,
    | "DISCOUNT_REVIEW_CHANNEL_ID"
    | "DISCOUNT_PUBLIC_CHANNEL_ID"
    | "NEW_SERVICE_REVIEW_CHANNEL_ID"
    | "NEW_SERVICE_PUBLIC_CHANNEL_ID"
    | "REPORT_REVIEW_CHANNEL_ID"
    | "GUILD_REQUEST_REVIEW_CHANNEL_ID"
  >,
) {
  const review = {
    discount: config.DISCOUNT_REVIEW_CHANNEL_ID,
    newService:
      config.NEW_SERVICE_REVIEW_CHANNEL_ID ?? config.DISCOUNT_REVIEW_CHANNEL_ID,
    report:
      config.REPORT_REVIEW_CHANNEL_ID ?? config.DISCOUNT_REVIEW_CHANNEL_ID,
    guildRequest:
      config.GUILD_REQUEST_REVIEW_CHANNEL_ID ??
      config.DISCOUNT_REVIEW_CHANNEL_ID,
  };
  return {
    review,
    // Buttons work in all of them, so a card sent before a split can still be decided.
    reviewIds: [
      ...new Set(
        [config.DISCOUNT_REVIEW_CHANNEL_ID, ...Object.values(review)].filter(
          (id) => id !== undefined,
        ),
      ),
    ],
    public: {
      discount: config.DISCOUNT_PUBLIC_CHANNEL_ID,
      newService:
        config.NEW_SERVICE_PUBLIC_CHANNEL_ID ??
        config.DISCOUNT_PUBLIC_CHANNEL_ID,
    },
  };
}

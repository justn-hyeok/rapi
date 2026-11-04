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
    REDHOOD_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    REDHOOD_LOG_LEVEL: z
      .enum(["debug", "info", "warn", "error"])
      .default("info"),
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
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
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
    REDHOOD_PUBLIC_BASE_URL: z.url().optional(),
    PUBLIC_TUNNEL_VERIFIED_FILE: z
      .string()
      .default("/var/lib/redhood/tunnel-verified.json"),
    MONITOR_STATE_FILE: z
      .string()
      .default("/var/lib/redhood/monitor-state.json"),
    MONITOR_PORT: z.coerce.number().int().min(1).max(65535).default(3300),
    PUBLIC_GATEWAY_READY_URL: z.url().default("http://127.0.0.1:3601/ready"),
    CLOUDFLARE_TUNNEL_READY_URL: z.url().default("http://127.0.0.1:3700/ready"),
    DISCORD_LAYOUT_FILE: z
      .string()
      .default("/home/justn/redhood/config/discord-channels.yaml"),
    OPERATIONS_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    OPERATIONS_DISCORD_WEBHOOK_URL: z.url().optional(),
    OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT: z.string().min(1).optional(),
    DATABASE_SIZE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(500_000_000),
    MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
    BOT_READY_URL: z.url().default("http://127.0.0.1:3000/ready"),
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
    if (value.REDHOOD_PUBLIC_BASE_URL && !value.WEBHOOK_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        path: ["WEBHOOK_ENCRYPTION_KEY"],
        message:
          "WEBHOOK_ENCRYPTION_KEY and REDHOOD_PUBLIC_BASE_URL must be configured together",
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
      value.REDHOOD_PUBLIC_BASE_URL &&
      !value.REDHOOD_PUBLIC_BASE_URL.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["REDHOOD_PUBLIC_BASE_URL"],
        message: "REDHOOD_PUBLIC_BASE_URL must use HTTPS",
      });
    }
    if (value.REDHOOD_ENV !== "production") return;
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

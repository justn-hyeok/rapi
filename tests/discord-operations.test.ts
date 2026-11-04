import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordCommandService, type RapiAgent } from "@rapi/agent";

describe("Discord operations commands", () => {
  it("restricts status to admins and server configuration to superadmins", async () => {
    const service = new DiscordCommandService(
      {} as RapiAgent,
      {
        userIds: ["owner"],
        adminUserIds: ["admin"],
        guildIds: ["guild"],
      },
      {
        status: () => Promise.resolve("healthy"),
        serverConfig: {
          preview: () => Promise.resolve({ summary: "plan", planId: "p" }),
          apply: () => Promise.resolve("applied"),
          export: () => Promise.resolve("yaml"),
        },
      },
    );
    const admin = { userId: "admin", guildId: "guild", channelId: "channel" };
    assert.deepEqual(
      await service.execute(admin, { name: "status", options: {} }),
      { messages: ["healthy"] },
    );
    const owner = { userId: "owner", guildId: "guild", channelId: "channel" };
    const preview = await service.execute(owner, {
      name: "server_config",
      options: { action: "미리보기" },
    });
    assert.equal(preview.data?.confirmationCustomId, "server_config_apply:p");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultCommunityLayout,
  parseDiscordLayout,
  planDiscordLayout,
} from "@rapi/agent";
describe("Discord layout", () => {
  it("parses the default YAML-compatible layout", () => {
    const layout = parseDiscordLayout(JSON.stringify(defaultCommunityLayout));
    assert.equal(layout.version, 1);
    assert.equal(layout.roles.length, 2);
    assert.equal(
      layout.categories.flatMap((category) => category.channels).length,
      17,
    );
  });

  it("adopts exact names, plans missing resources and deletes extras", () => {
    const layout = defaultCommunityLayout;
    const plan = planDiscordLayout(
      layout,
      {
        guildId: "guild",
        roles: [
          { id: "guild", name: "@everyone", permissions: "0", position: 0 },
          {
            id: "user-role",
            name: "라피 USER",
            permissions: "0",
            position: 1,
          },
        ],
        channels: [
          { id: "start", name: "시작하기", type: 4, position: 0 },
          {
            id: "rules",
            name: "규칙",
            type: 0,
            position: 0,
            parentId: "start",
          },
          { id: "old", name: "옛날-채널", type: 0, position: 99 },
        ],
      },
      [],
    );
    assert.ok(plan.actions.some((action) => action.kind === "create_role"));
    assert.ok(plan.actions.some((action) => action.kind === "create_channel"));
    assert.ok(
      plan.actions.some(
        (action) => action.kind === "delete_channel" && action.id === "old",
      ),
    );
    assert.ok(plan.layoutDigest.length >= 32);
    assert.ok(plan.snapshotDigest.length >= 32);
  });

  it("rejects ambiguous adoption instead of guessing", () => {
    assert.throws(
      () =>
        planDiscordLayout(
          defaultCommunityLayout,
          {
            guildId: "guild",
            roles: [
              { id: "guild", name: "@everyone", permissions: "0", position: 0 },
            ],
            channels: [
              { id: "a", name: "시작하기", type: 4, position: 0 },
              { id: "b", name: "시작하기", type: 4, position: 1 },
            ],
          },
          [],
        ),
      /ambiguous/i,
    );
  });

  it("rejects duplicate stable names in the configuration", () => {
    const duplicate = structuredClone(defaultCommunityLayout);
    duplicate.categories[1]!.channels[0]!.name =
      duplicate.categories[0]!.channels[0]!.name;
    assert.throws(
      () => parseDiscordLayout(JSON.stringify(duplicate)),
      /duplicate.*channel name/i,
    );
  });
});

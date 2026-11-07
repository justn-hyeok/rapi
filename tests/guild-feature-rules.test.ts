import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeGuildFeatures,
  enabledGuildFeatures,
  guildFeatureRefusal,
} from "@rapi/core";

describe("guild feature rules", () => {
  it("has only the read-only basics and each person's own stars on without a row", () => {
    assert.deepEqual([...enabledGuildFeatures([])], ["status", "stars"]);
  });

  it("lets a saved setting win and ignores names it does not know", () => {
    assert.deepEqual(
      [
        ...enabledGuildFeatures([
          { feature: "status", enabled: false },
          { feature: "report", enabled: true },
          { feature: "gone", enabled: true },
        ]),
      ],
      ["report", "stars"],
    );
  });

  it("words the refusal and the list in Korean", () => {
    assert.match(guildFeatureRefusal("report"), /제보 기능이 꺼져/);
    const list = describeGuildFeatures(new Set(["status"]), false);
    assert.match(list, /켜짐 · 상태/);
    assert.match(list, /꺼짐 · 소식 카드/);
    assert.match(describeGuildFeatures(new Set(), true), /홈 서버/);
  });
});

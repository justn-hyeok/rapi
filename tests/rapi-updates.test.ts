import assert from "node:assert/strict";
import { test } from "node:test";
import { announceRapiUpdate } from "@rapi/agent";
import { releaseSummary } from "@rapi/core";

const NOTES = `Channels moved into commands.

## 바뀐 것
- One command per alert.

## 확인한 것
- VM deployed.

## 남은 것
- Not pressed in Discord.`;

test("a release shows its opening and changes, not how it was checked", () => {
  assert.equal(
    releaseSummary(NOTES),
    "Channels moved into commands.\n\n- One command per alert.",
  );
  assert.equal(releaseSummary("Only a line."), "Only a line.");
  assert.equal(releaseSummary(""), "");
});

function setup(latest = "v2") {
  const claimed = new Set<string>();
  const sent: Array<{ to: string; body: string }> = [];
  const failing = new Set<string>();
  return {
    claimed,
    sent,
    failing,
    input: {
      store: {
        rapiUpdateNoticed: async () => claimed.size > 0,
        claimRapiUpdate: async (tag: string) => {
          if (claimed.has(tag)) return false;
          claimed.add(tag);
          return true;
        },
      },
      delivery: {
        send: async (
          target: { recipientId: string },
          payload: { discord?: unknown },
        ) => {
          if (failing.has(target.recipientId)) throw new Error("403");
          sent.push({
            to: target.recipientId,
            body: JSON.stringify(payload.discord),
          });
          return { providerId: "m" };
        },
      },
      channelIds: async () => ["1", "2"],
      latestRelease: async () => ({
        tag: latest,
        url: `https://x.test/${latest}`,
        body: NOTES,
      }),
    },
  };
}

test("the first run remembers the release and announces nothing", async () => {
  const { input, sent, claimed } = setup();
  assert.deepEqual(await announceRapiUpdate(input as never), []);
  assert.equal(sent.length, 0);
  assert.deepEqual([...claimed], ["v2"]);
  assert.deepEqual(await announceRapiUpdate(input as never), []);
  assert.equal(sent.length, 0);
});

test("a new release reaches every channel once, whatever one of them does", async () => {
  const { input, sent, claimed, failing } = setup();
  claimed.add("v1");
  failing.add("1");
  const failures = await announceRapiUpdate(input as never);
  assert.equal(failures.length, 1);
  assert.deepEqual(
    sent.map(({ to }) => to),
    ["2"],
  );
  assert.match(sent[0]!.body, /One command per alert/);
  assert.doesNotMatch(sent[0]!.body, /VM deployed/);
  failing.clear();
  assert.deepEqual(await announceRapiUpdate(input as never), []);
  assert.equal(sent.length, 1);
});

test("GitHub being down is a failure and remembers nothing", async () => {
  const { input, claimed } = setup();
  input.latestRelease = async () => {
    throw new Error("502");
  };
  assert.equal((await announceRapiUpdate(input as never)).length, 1);
  assert.equal(claimed.size, 0);
});

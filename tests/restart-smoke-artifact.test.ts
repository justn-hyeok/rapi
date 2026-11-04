import assert from "node:assert/strict";
import test from "node:test";
import { restartSmokeArtifact } from "../scripts/restart-smoke-artifact.mjs";

test("restart smoke artifacts require preserved non-empty counts", () => {
  assert.deepEqual(
    restartSmokeArtifact({
      project: "redhood-restart-1",
      database: "redhood_test",
      before: "1:0:1",
      after: "1:0:1",
    }),
    {
      project: "redhood-restart-1",
      database: "redhood_test",
      before: "1:0:1",
      after: "1:0:1",
    },
  );
  assert.throws(() =>
    restartSmokeArtifact({
      project: "redhood-restart-1",
      database: "redhood_test",
      before: "0:0:0",
      after: "0:0:0",
    }),
  );
  assert.throws(() =>
    restartSmokeArtifact({
      project: "redhood-restart-1",
      database: "redhood_test",
      before: "1:0:1",
      after: "1:0:2",
    }),
  );
});

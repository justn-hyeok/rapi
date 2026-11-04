import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTestDatabaseUrl } from "../scripts/test-database-admission.mjs";

test("accepts only loopback redhood_test PostgreSQL URLs", () => {
  assert.equal(
    assertTestDatabaseUrl(
      "postgresql://redhood:password@localhost:5432/redhood_test",
    ).hostname,
    "localhost",
  );
  assert.equal(
    assertTestDatabaseUrl(
      "postgresql://redhood:password@127.0.0.1:5432/redhood_test",
    ).hostname,
    "127.0.0.1",
  );
});

for (const [label, value] of [
  [
    "production database",
    "postgresql://redhood:password@localhost:5432/redhood",
  ],
  [
    "remote host",
    "postgresql://redhood:password@db.example.com:5432/redhood_test",
  ],
  [
    "database query override",
    "postgresql://redhood:password@localhost:5432/redhood_test?database=redhood",
  ],
  ["malformed URL", "not a URL"],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => assertTestDatabaseUrl(value), /Test database URL/);
  });
}

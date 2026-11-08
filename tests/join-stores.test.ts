import assert from "node:assert/strict";
import { test } from "node:test";
import { joinStores } from "@rapi/adapters";

class Guilds {
  constructor(private readonly name: string) {}
  async allowed() {
    return [this.name];
  }
}
class Cards {
  count = 2;
  async cardsInLastHour() {
    return this.count;
  }
  async allowed() {
    return ["not this one"];
  }
}

test("joining stores keeps each method bound to its own store, first one wins", async () => {
  const joined = joinStores(new Guilds("g1"), new Cards());
  assert.deepEqual(await joined.allowed(), ["g1"]);
  assert.equal(await joined.cardsInLastHour(), 2);
  // Only methods are joined, not fields.
  assert.equal(Object.hasOwn(joined, "count"), false);
});

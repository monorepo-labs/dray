import assert from "node:assert/strict";
import { test } from "node:test";

import { standing } from "../src/lib/cloud/plans.ts";

const HOUR = 3600;
const pro = (fields) => ({ plan: "pro", status: "active", overage: false, overageCapCents: null, ...fields });

test("no plan, or one that stopped paying, runs nothing", () => {
  assert.equal(standing(null, 0).canRun, false);
  assert.equal(standing(pro({ status: "canceled" }), 0).canRun, false);
  assert.equal(standing(pro({ status: "incomplete" }), 0).canRun, false);
  assert.equal(standing(pro({ plan: "gold" }), 0).canRun, false);
  assert.equal(standing(pro({ status: "past_due" }), 0).canRun, true);
});

test("included hours run free, and the last second is the limit", () => {
  assert.deepEqual(standing(pro(), 600 * HOUR - 1), {
    plan: "pro",
    usedSeconds: 600 * HOUR - 1,
    includedSeconds: 600 * HOUR,
    overageSeconds: 0,
    billableMinutes: 0,
    canRun: true,
  });
  assert.equal(standing(pro(), 600 * HOUR).canRun, false);
});

test("overage bills whole minutes, up to the cap", () => {
  assert.equal(standing(pro({ overage: true }), 600 * HOUR + 119).billableMinutes, 1);
  assert.equal(standing(pro({ overage: true }), 2000 * HOUR).canRun, true);
  // $2 at $0.20 an hour is ten hours.
  const capped = standing(pro({ overage: true, overageCapCents: 200 }), 615 * HOUR);
  assert.equal(capped.billableMinutes, 600);
  assert.equal(capped.canRun, false);
});

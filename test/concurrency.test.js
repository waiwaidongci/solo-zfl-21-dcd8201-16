"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, as, registerClock } = require("../test-support/helpers");

let api;
before(async () => {
  api = await startServer();
});
after(async () => {
  await api.close();
});

async function submitQuote(caseId, total) {
  return api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "故障" }], items: [{ name: "项目", quantity: 1, unitPriceCents: total }], totalAmountCents: total },
    as.technician()
  );
}

async function openFreshCase(limit = 100000) {
  const clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "并发用案件", assessorLimitCents: limit },
    as.intake()
  );
  return opened.body.data.id;
}

test("并发审批：定损员批准与主管驳回同时到达，只有一个生效", async () => {
  const caseId = await openFreshCase(100000);
  await submitQuote(caseId, 1000);

  const [first, second] = await Promise.all([
    api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor()),
    api.call("POST", `/cases/${caseId}/assessment`, { approved: false }, as.supervisor())
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  // 审计中只能有一条 QuoteAssessed，案件最终状态唯一且自洽。
  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  const assessed = timeline.body.data.filter((event) => event.type === "QuoteAssessed");
  assert.equal(assessed.length, 1);
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.ok(["approved", "quote_rejected"].includes(kase.status));
  assert.equal(kase.status === "approved", assessed[0].data.approved);
});

test("并发客户确认：同一客户重复点击只确认一次", async () => {
  const caseId = await openFreshCase(100000);
  await submitQuote(caseId, 1000);
  await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());

  const results = await Promise.all(
    Array.from({ length: 6 }, () => api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer("cust1")))
  );
  const succeeded = results.filter((r) => r.status === 201);
  const conflicted = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 1);
  assert.equal(conflicted.length, 5);

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "repairing");
});

test("并发结算（完工复测）：只有一次结案，其余 409，不产生多条复测", async () => {
  const caseId = await openFreshCase(100000);
  await submitQuote(caseId, 1000);
  await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer("cust1"));
  await api.call("POST", `/cases/${caseId}/repair-complete`, {}, as.technician());

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      api.call(
        "POST",
        `/cases/${caseId}/completion-retest`,
        { dailyRateSeconds: 1, amplitude: 300 },
        as.technician()
      )
    )
  );
  const succeeded = results.filter((r) => r.status === 201 && r.body.data.passed);
  const conflicted = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 1);
  assert.equal(conflicted.length, 7);

  const retests = (await api.call("GET", "/retests")).body.data.filter((r) => r.caseId === caseId);
  assert.equal(retests.length, 1);
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "closed");
});

test("并发取消与审批：只有一个生效，不会出现既审批又取消", async () => {
  const caseId = await openFreshCase(100000);
  await submitQuote(caseId, 1000);

  const [approve, cancel] = await Promise.all([
    api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor()),
    api.call("POST", `/cases/${caseId}/cancel`, { reason: "并发取消" }, as.intake())
  ]);

  const code = [approve.status, cancel.status].sort();
  assert.deepEqual(code, [201, 409]);
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.ok(["approved", "cancelled"].includes(kase.status));

  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  assert.equal(timeline.body.data.filter((e) => e.type === "CaseCancelled").length, kase.status === "cancelled" ? 1 : 0);
  assert.equal(timeline.body.data.filter((e) => e.type === "QuoteAssessed").length, kase.status === "approved" ? 1 : 0);
});

test("并发重报同一幂等键：只落一条记录，全部拿到同一结果", async () => {
  const clockId = await registerClock(api);
  const payload = { clockId, customerUserId: "cust1", description: "并发幂等" };
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      api.call("POST", "/cases", payload, { ...as.intake(), "Idempotency-Key": "concurrent-key-1" })
    )
  );
  const ids = new Set(results.map((r) => r.body.data.id));
  assert.equal(ids.size, 1);
  assert.equal((await api.call("GET", `/cases?clockId=${clockId}`)).body.data.length, 1);
});

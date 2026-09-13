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

async function freshClock() {
  return registerClock(api);
}

async function openCaseWith(clockId, payload, headers, key) {
  return api.call("POST", "/cases", payload, { ...headers, "Idempotency-Key": key });
}

test("同一幂等键、同载荷回放；载荷任一字段不同即冲突 409 且不回放旧结果", async () => {
  const clockId = await freshClock();
  const key = "scope-payload-1";
  const first = await openCaseWith(clockId, { clockId, customerUserId: "c1", description: "首次" }, as.intake(), key);
  assert.equal(first.status, 201);
  const firstId = first.body.data.id;

  // 同键同载荷：回放。
  const replay = await openCaseWith(clockId, { clockId, customerUserId: "c1", description: "首次" }, as.intake(), key);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.id, firstId);

  // 同键但 description 不同：冲突，且返回的绝不是首次结果。
  const changed = await openCaseWith(clockId, { clockId, customerUserId: "c1", description: "被篡改的载荷" }, as.intake(), key);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  // 金额/客户字段被改同样冲突。
  const changedLimit = await openCaseWith(
    clockId,
    { clockId, customerUserId: "c1", description: "首次", assessorLimitCents: 1 },
    as.intake(),
    key
  );
  assert.equal(changedLimit.status, 409);

  // 冲突没有产生第二个案件，也没有把首次结果覆盖。
  const cases = (await api.call("GET", `/cases?clockId=${clockId}`)).body.data;
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, firstId);
  assert.equal(cases[0].description, "首次");
});

test("同一幂等键用于不同钟表（不同资源）：冲突 409，不会把 A 表的结果回放到 B 表", async () => {
  const clockA = await freshClock();
  const clockB = await freshClock();
  const key = "scope-resource-1";

  const onA = await openCaseWith(clockA, { clockId: clockA, customerUserId: "c1", description: "A表案件" }, as.intake(), key);
  assert.equal(onA.status, 201);

  const onB = await openCaseWith(clockB, { clockId: clockB, customerUserId: "c1", description: "A表案件" }, as.intake(), key);
  assert.equal(onB.status, 409);
  assert.equal(onB.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  // B 表没有被偷偷建案；去掉键后可正常在 B 表开案。
  const casesB = (await api.call("GET", `/cases?clockId=${clockB}`)).body.data;
  assert.equal(casesB.length, 0);
  const realB = await api.call(
    "POST",
    "/cases",
    { clockId: clockB, customerUserId: "c1", description: "B表案件" },
    as.intake()
  );
  assert.equal(realB.status, 201);
});

test("同一幂等键在同一案件上用于不同操作：冲突 409", async () => {
  const clockId = await freshClock();
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c1", description: "操作作用域", assessorLimitCents: 100000 },
    as.intake()
  );
  const caseId = opened.body.data.id;
  const key = "scope-action-1";

  const quote = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "f" }], items: [{ name: "i", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    { ...as.technician(), "Idempotency-Key": key }
  );
  assert.equal(quote.status, 201);

  // 同键用于审批（不同操作）：冲突，案件不被审批。
  const assess = await api.call(
    "POST",
    `/cases/${caseId}/assessment`,
    { approved: true },
    { ...as.assessor(), "Idempotency-Key": key }
  );
  assert.equal(assess.status, 409);
  assert.equal(assess.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "pending_assessment");
});

test("同一幂等键由不同操作者重放：冲突 409，不能冒领他人请求结果", async () => {
  const clockId = await freshClock();
  const key = "scope-actor-1";
  const first = await openCaseWith(clockId, { clockId, customerUserId: "c1", description: "操作者作用域" }, as.intake("intake-A"), key);
  assert.equal(first.status, 201);

  const other = await openCaseWith(clockId, { clockId, customerUserId: "c1", description: "操作者作用域" }, as.intake("intake-B"), key);
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "IDEMPOTENCY_KEY_CONFLICT");
});

test("载荷仅 JSON 键序不同视为同一请求，正常回放", async () => {
  const clockId = await freshClock();
  const key = "scope-canonical-1";
  const first = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c1", description: "规范化", assessorLimitCents: 500 },
    { ...as.intake(), "Idempotency-Key": key }
  );
  const replay = await api.call(
    "POST",
    "/cases",
    { assessorLimitCents: 500, description: "规范化", customerUserId: "c1", clockId },
    { ...as.intake(), "Idempotency-Key": key }
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.id, first.body.data.id);
});

test("作用域指纹跨重启仍然生效：同载荷回放，换载荷冲突", async () => {
  const clockId = await freshClock();
  const key = "scope-restart-1";
  const payload = { clockId, customerUserId: "c1", description: "重启作用域" };
  const first = await openCaseWith(clockId, payload, as.intake(), key);
  assert.equal(first.status, 201);

  await api.restart();

  const replay = await openCaseWith(clockId, payload, as.intake(), key);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.id, first.body.data.id);

  const tampered = await openCaseWith(clockId, { ...payload, description: "重启后改载荷" }, as.intake(), key);
  assert.equal(tampered.status, 409);
});

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, as } = require("../test-support/helpers");

let api;
before(async () => {
  api = await startServer();
});
after(async () => {
  await api.close();
});

function assertClockSummary(envelope) {
  // 钟表自身字段
  for (const field of [
    "id",
    "code",
    "escapementType",
    "balanceFrequency",
    "targetDailyRateSeconds",
    "minCompletionAmplitude",
    "note",
    "createdAt"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(envelope, field), `摘要缺少字段 ${field}`);
  }
  // 旧版摘要三件套
  assert.ok(Object.prototype.hasOwnProperty.call(envelope, "qualified"));
  assert.ok(Object.prototype.hasOwnProperty.call(envelope, "latestAdjustment"));
  assert.ok(Object.prototype.hasOwnProperty.call(envelope, "latestRetest"));
}

test("POST /clocks：返回体即钟表摘要（新表 qualified=false，最近调校/复测为 null）", async () => {
  const res = await api.call("POST", "/clocks", {
    code: `SHAPE-CREATE-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20,
    note: "建档响应结构"
  });
  assert.equal(res.status, 201);
  const { data } = res.body;
  assertClockSummary(data);
  assert.equal(data.qualified, false);
  assert.equal(data.latestAdjustment, null);
  assert.equal(data.latestRetest, null);
  assert.equal(data.code.startsWith("SHAPE-CREATE-"), true);
  // 旧版没有嵌套 clock 字段，摘要必须直接挂在 data 上。
  assert.equal(data.clock, undefined);
});

test("POST /clocks：带幂等键重放时仍返回相同摘要结构", async () => {
  const payload = { code: "SHAPE-IDEM", escapementType: "杠杆式", balanceFrequency: "28800vph", targetDailyRateSeconds: 10 };
  const first = await api.call("POST", "/clocks", payload, { "Idempotency-Key": "shape-clock-idem-1" });
  assert.equal(first.status, 201);
  assert.equal(first.body.replayed, false);
  const replay = await api.call("POST", "/clocks", payload, { "Idempotency-Key": "shape-clock-idem-1" });
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.id, first.body.data.id);
  assertClockSummary(replay.body.data);
});

test("GET /clocks 与 GET /clocks/not-qualified：含最近调校/复测的钟表摘要字段被正确填充", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `SHAPE-LIST-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "杠杆式",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 5
  });
  const clockId = created.body.data.id;

  const adj = await api.call(
    "POST",
    `/clocks/${clockId}/adjustments`,
    { currentDailyRateSeconds: 40, direction: "慢针", amount: "微调", note: "n" }
  );
  assert.equal(adj.status, 201);

  // 日差 12 超出目标 5 -> qualified=false，进入 not-qualified 列表。
  const retest = await api.call(
    "POST",
    `/clocks/${clockId}/retests`,
    { dailyRateSeconds: 12, amplitude: 280, note: "复测" }
  );
  assert.equal(retest.status, 201);

  const list = await api.call("GET", "/clocks");
  const summary = list.body.data.find((c) => c.id === clockId);
  assertClockSummary(summary);
  assert.equal(summary.qualified, false);
  assert.equal(summary.latestAdjustment.id, adj.body.data.id);
  assert.equal(summary.latestRetest.id, retest.body.data.id);
  assert.equal(summary.latestRetest.dailyRateSeconds, 12);

  const nq = await api.call("GET", "/clocks/not-qualified");
  const nqSummary = nq.body.data.find((c) => c.id === clockId);
  assert.ok(nqSummary, "不合格列表应包含该表");
  assertClockSummary(nqSummary);
  assert.equal(nqSummary.latestRetest.id, retest.body.data.id);
});

test("POST /clocks/:id/retests：data 为复测数据，clock 为钟表摘要且 latestRetest 指向本次复测", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `SHAPE-RETEST-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "杠杆式",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 30
  });
  const clockId = created.body.data.id;
  await api.call(
    "POST",
    `/clocks/${clockId}/adjustments`,
    { currentDailyRateSeconds: 35, direction: "慢针", amount: "微调" }
  );

  const res = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 10, amplitude: 275 });
  assert.equal(res.status, 201);

  // 复测数据本体（旧版字段）
  const { data, clock } = res.body;
  for (const field of ["id", "clockId", "adjustmentId", "testedAt", "dailyRateSeconds", "amplitude", "qualified", "note"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, field), `复测数据缺少字段 ${field}`);
  }
  assert.equal(data.clockId, clockId);
  assert.equal(data.dailyRateSeconds, 10);
  assert.equal(data.amplitude, 275);
  assert.equal(data.qualified, true); // |10| <= 30 自动判定合格

  // 附加钟表摘要（旧版同级 clock 字段）
  assert.ok(clock, "响应需保留同级 clock 摘要");
  assertClockSummary(clock);
  assert.equal(clock.id, clockId);
  assert.equal(clock.qualified, true);
  assert.equal(clock.latestRetest.id, data.id);
  assert.ok(clock.latestAdjustment, "摘要应含最近调校");
});

test("POST /clocks/:id/retests：多次复测后 clock.latestRetest 取最新一条", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `SHAPE-LATEST-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "杠杆式",
    balanceFrequency: "21600vph",
    targetDailyRateSeconds: 30
  });
  const clockId = created.body.data.id;
  await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 20, amplitude: 260, testedAt: "2026-01-01T00:00:00.000Z" });
  const second = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 4, amplitude: 290, testedAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(second.body.clock.latestRetest.id, second.body.data.id);
  assert.equal(second.body.clock.latestRetest.amplitude, 290);
  assert.equal(second.body.clock.qualified, true);
});

test("旧接口错误状态保持：建档缺字段/非法摆幅 400，复测不存在钟表 404，复测缺字段/零振幅 400", async () => {
  const missing = await api.call("POST", "/clocks", { escapementType: "x", balanceFrequency: "y" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "VALIDATION_ERROR");

  const badAmp = await api.call("POST", "/clocks", {
    code: "SHAPE-BAD-AMP",
    escapementType: "x",
    balanceFrequency: "y",
    minCompletionAmplitude: 0
  });
  assert.equal(badAmp.status, 400);
  assert.equal(badAmp.body.code, "INVALID_AMPLITUDE");

  const noClock = await api.call("POST", "/clocks/clock_missing/retests", { dailyRateSeconds: 1, amplitude: 280 });
  assert.equal(noClock.status, 404);
  assert.equal(noClock.body.code, "CLOCK_NOT_FOUND");

  // 先建一个表用于 400 场景。
  const created = await api.call("POST", "/clocks", { code: "SHAPE-ERR-1", escapementType: "x", balanceFrequency: "y", targetDailyRateSeconds: 10 });
  const clockId = created.body.data.id;

  const missingField = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 1 });
  assert.equal(missingField.status, 400);
  assert.equal(missingField.body.code, "VALIDATION_ERROR");

  const zeroAmp = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 1, amplitude: -3 });
  assert.equal(zeroAmp.status, 400);
  assert.equal(zeroAmp.body.code, "INVALID_AMPLITUDE");

  const noAdjClock = await api.call("POST", "/clocks/clock_missing/adjustments", {
    currentDailyRateSeconds: 1,
    direction: "x",
    amount: "y"
  });
  assert.equal(noAdjClock.status, 404);
  assert.equal(noAdjClock.body.code, "CLOCK_NOT_FOUND");
});

test("新增定损流程不受影响：开案后钟表摘要 activeCase 指向进行中案件，复测摘要仍可用", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `SHAPE-CASE-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "杠杆式",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 10,
    minCompletionAmplitude: 250
  });
  const clockId = created.body.data.id;
  assert.equal(created.body.data.activeCase, null);

  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust-shape", description: "兼容回归案件", assessorLimitCents: 100000 },
    as.intake()
  );
  assert.equal(opened.status, 201);
  const caseId = opened.body.data.id;

  // 列表/建档摘要反映进行中案件（新增附加字段，不影响旧字段）。
  const list = await api.call("GET", "/clocks");
  const summary = list.body.data.find((c) => c.id === clockId);
  assert.equal(summary.activeCase, caseId);
  assertClockSummary(summary);

  // 定损主流程仍可走完。
  await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "f" }], items: [{ name: "i", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  const confirmed = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer("cust-shape"));
  assert.equal(confirmed.body.data.status, "repairing");

  // 与案件无关的旧调校复测仍然返回 {data, clock} 结构，且不动案件状态。
  const tuningRetest = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 2, amplitude: 260 });
  assert.equal(tuningRetest.status, 201);
  assert.equal(tuningRetest.body.data.caseId, null);
  assert.equal(tuningRetest.body.clock.activeCase, caseId);
});

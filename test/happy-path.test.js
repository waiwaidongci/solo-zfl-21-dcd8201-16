"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, as, caseToAwaitingRetest } = require("../test-support/helpers");

let api;
before(async () => {
  api = await startServer();
});
after(async () => {
  await api.close();
});

test("完整正常流程：开案→报价→额度内审批→客户确认→完工→复测合格结案", async () => {
  const { clockId, caseId } = await caseToAwaitingRetest(api, { total: 50000, limit: 100000 });

  const got = await api.call("GET", `/cases/${caseId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.status, "awaiting_retest");
  assert.equal(got.body.data.clockId, clockId);

  const retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 5, amplitude: 285 },
    as.technician()
  );
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.passed, true);
  assert.equal(retest.body.data.status, "closed");
  assert.deepEqual(retest.body.data.gates, {
    rateOk: true,
    amplitudeOk: true,
    targetDailyRateSeconds: 10,
    minAmplitude: 270
  });

  // 结案后释放钟表占用，可以重新开案。
  const reopen = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "二次维修" },
    as.intake()
  );
  assert.equal(reopen.status, 201);
  assert.notEqual(reopen.body.data.id, caseId);
});

test("日差合格但摆幅不足：退回调校；再调校后复测合格才结案", async () => {
  const { clockId, caseId } = await caseToAwaitingRetest(api);

  let retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 2, amplitude: 250 }, // 摆幅 250 < 270
    as.technician()
  );
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.passed, false);
  assert.equal(retest.body.data.gates.rateOk, true);
  assert.equal(retest.body.data.gates.amplitudeOk, false);
  assert.equal(retest.body.data.status, "returned_to_tuning");

  // 退回后直接再复测摆幅仍不够，不能结案。
  retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 2, amplitude: 260 },
    as.technician()
  );
  assert.equal(retest.body.data.passed, false);
  assert.equal(retest.body.data.status, "returned_to_tuning");

  // 技师重新调校（复用既有调校接口）后再复测。
  const adj = await api.call(
    "POST",
    `/clocks/${clockId}/adjustments`,
    { currentDailyRateSeconds: 8, direction: "快慢针微调", amount: "摆幅提升调校" },
    as.technician()
  );
  assert.equal(adj.status, 201);

  retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: -8, amplitude: 275 },
    as.technician()
  );
  assert.equal(retest.body.data.passed, true);
  assert.equal(retest.body.data.status, "closed");
});

test("摆幅合格但日差超差：同样退回调校", async () => {
  const { caseId } = await caseToAwaitingRetest(api);
  const retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 30, amplitude: 300 },
    as.technician()
  );
  assert.equal(retest.body.data.passed, false);
  assert.equal(retest.body.data.gates.rateOk, false);
  assert.equal(retest.body.data.gates.amplitudeOk, true);
  assert.equal(retest.body.data.status, "returned_to_tuning");
});

test("审批驳回后技师可重新报价，流程继续", async () => {
  const freshClock = await api.call("POST", "/clocks", {
    code: "CLK-REJ-1",
    escapementType: "同轴擒纵",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 10
  });
  const cid = freshClock.body.data.id;

  const opened = await api.call(
    "POST",
    "/cases",
    { clockId: cid, customerUserId: "cust9", description: "进水", assessorLimitCents: 100000 },
    as.intake()
  );
  const rejectCaseId = opened.body.data.id;

  await api.call(
    "POST",
    `/cases/${rejectCaseId}/quotes`,
    { faults: [{ name: "进水" }], items: [{ name: "烘干", quantity: 1, unitPriceCents: 90000 }], totalAmountCents: 90000 },
    as.technician()
  );
  const rejected = await api.call(
    "POST",
    `/cases/${rejectCaseId}/assessment`,
    { approved: false, note: "报价偏高" },
    as.assessor()
  );
  assert.equal(rejected.status, 201);
  assert.equal(rejected.body.data.status, "quote_rejected");

  // 客户在驳回状态不能确认。
  const earlyConfirm = await api.call("POST", `/cases/${rejectCaseId}/confirm`, {}, as.customer("cust9"));
  assert.equal(earlyConfirm.status, 409);

  // 重新报价（更低）后再审批通过。
  const requote = await api.call(
    "POST",
    `/cases/${rejectCaseId}/quotes`,
    { faults: [{ name: "进水" }], items: [{ name: "清洗烘干", quantity: 1, unitPriceCents: 60000 }], totalAmountCents: 60000 },
    as.technician()
  );
  assert.equal(requote.status, 201);
  assert.equal(requote.body.data.version, 2);
  const approved = await api.call(
    "POST",
    `/cases/${rejectCaseId}/assessment`,
    { approved: true },
    as.assessor()
  );
  assert.equal(approved.body.data.status, "approved");
});

test("时间线按 seq 有序记录每一次流转，并支持钟表维度查询", async () => {
  const { clockId, caseId } = await caseToAwaitingRetest(api, { total: 1000 });
  await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 1, amplitude: 300 },
    as.technician()
  );

  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  assert.equal(timeline.status, 200);
  const types = timeline.body.data.map((event) => event.type);
  assert.deepEqual(types, [
    "CaseOpened",
    "QuoteSubmitted",
    "QuoteAssessed",
    "CustomerConfirmed",
    "RepairCompleted",
    "CompletionRetested"
  ]);
  // 审计记录不可修改：事件数据是落盘时的快照。
  const opened = timeline.body.data[0];
  assert.equal(opened.actor.role, "intake");
  assert.ok(opened.at);
  assert.equal(opened.data.id, caseId);

  const clockTimeline = await api.call("GET", `/audit-timeline?clockId=${clockId}`);
  assert.ok(clockTimeline.body.data.every((event) => event.at));
  assert.ok(clockTimeline.body.data.length >= 6);
});

test("重启后数据不丢：案件状态、审计时间线完全恢复", async () => {
  const { caseId } = await caseToAwaitingRetest(api, { total: 2000 });
  await api.restart();
  const got = await api.call("GET", `/cases/${caseId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.status, "awaiting_retest");
  assert.equal(got.body.data.totalAmountCents, 2000);

  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  assert.equal(timeline.body.data.length, 5);

  // 重启后流程可以继续走完。
  const retest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 0, amplitude: 290 },
    as.technician()
  );
  assert.equal(retest.body.data.status, "closed");
});

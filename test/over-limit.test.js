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

async function openCaseWithLimit(limitCents) {
  const clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "超额测试", assessorLimitCents: limitCents },
    as.intake()
  );
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  return { clockId, caseId: opened.body.data.id };
}

async function quote(caseId, totalCents, items) {
  return api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    {
      faults: [{ name: "机芯大修" }],
      items: items || [{ name: "维修", quantity: 1, unitPriceCents: totalCents }],
      totalAmountCents: totalCents
    },
    as.technician()
  );
}

test("合计等于额度时仍归定损员授权", async () => {
  const { caseId } = await openCaseWithLimit(50000);
  const res = await quote(caseId, 50000);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.routedTo, "assessor");
  const approved = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  assert.equal(approved.status, 201);
});

test("超过授权额度自动转主管：定损员批准/驳回都 403", async () => {
  const { caseId } = await openCaseWithLimit(50000);
  const res = await quote(caseId, 50001);
  assert.equal(res.body.data.routedTo, "supervisor");

  const caseGot = await api.call("GET", `/cases/${caseId}`);
  assert.equal(caseGot.body.data.status, "pending_supervisor");

  const assessorApproves = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  assert.equal(assessorApproves.status, 403);
  const assessorRejects = await api.call("POST", `/cases/${caseId}/assessment`, { approved: false }, as.assessor());
  assert.equal(assessorRejects.status, 403);

  // 状态没有被越权尝试覆盖。
  const still = await api.call("GET", `/cases/${caseId}`);
  assert.equal(still.body.data.status, "pending_supervisor");
});

test("主管复核通过后客户才能确认", async () => {
  const { caseId } = await openCaseWithLimit(10000);
  await quote(caseId, 80000);

  const earlyConfirm = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer());
  assert.equal(earlyConfirm.status, 409);

  const approved = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true, note: "同意大修" }, as.supervisor());
  assert.equal(approved.status, 201);
  const confirmed = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer());
  assert.equal(confirmed.body.data.status, "repairing");
});

test("主管复核驳回：回到报价被拒，技师重新报价走定损通道", async () => {
  const { caseId } = await openCaseWithLimit(10000);
  await quote(caseId, 80000);
  const rejected = await api.call("POST", `/cases/${caseId}/assessment`, { approved: false }, as.supervisor());
  assert.equal(rejected.body.data.status, "quote_rejected");

  // 重新报价降到额度内。
  const requote = await quote(caseId, 9000);
  assert.equal(requote.body.data.routedTo, "assessor");
  // 此时主管不再是必经路径，定损员可直接批。
  const approved = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  assert.equal(approved.body.data.status, "approved");
});

test("未审批时客户确认 409，未确认时不能完工", async () => {
  const { caseId } = await openCaseWithLimit(100000);
  await quote(caseId, 1000);
  const confirmEarly = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer());
  assert.equal(confirmEarly.status, 409);
  const completeEarly = await api.call("POST", `/cases/${caseId}/repair-complete`, {}, as.technician());
  assert.equal(completeEarly.status, 409);
});

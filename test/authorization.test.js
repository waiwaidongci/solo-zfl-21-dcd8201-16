"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, as, registerClock } = require("../test-support/helpers");

let api;
let clockId;
let caseId;

before(async () => {
  api = await startServer();
  clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "越权测试", assessorLimitCents: 100000 },
    as.intake()
  );
  caseId = opened.body.data.id;
});
after(async () => {
  await api.close();
});

test("未带身份头不能执行流转操作", async () => {
  const res = await api.call("POST", `/cases/${caseId}/quotes`, {
    faults: [{ name: "x" }],
    items: [{ name: "y", quantity: 1, unitPriceCents: 1 }],
    totalAmountCents: 1
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "UNAUTHENTICATED");
});

test("未知角色被拒绝", async () => {
  const res = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c", description: "d" },
    { "x-user-role": "hacker", "x-user-id": "h1" }
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "FORBIDDEN_ROLE");
});

test("接件员不能报价，技师不能开案", async () => {
  const byIntake = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.intake()
  );
  assert.equal(byIntake.status, 403);
  assert.equal(byIntake.body.code, "FORBIDDEN");

  const byTech = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c", description: "d" },
    as.technician()
  );
  assert.equal(byTech.status, 403);
});

test("定损员/主管/客户都不能替技师报价", async () => {
  for (const headers of [as.assessor(), as.supervisor(), as.customer()]) {
    const res = await api.call(
      "POST",
      `/cases/${caseId}/quotes`,
      { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
      headers
    );
    assert.equal(res.status, 403);
  }
});

test("客户不能替定损员审批；定损员不能取消案件（仅接件员/主管）", async () => {
  // 先让案件进入待定损。
  const quote = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  assert.equal(quote.status, 201);

  const customerApproves = await api.call(
    "POST",
    `/cases/${caseId}/assessment`,
    { approved: true },
    as.customer("cust1")
  );
  assert.equal(customerApproves.status, 403);

  const assessorCancels = await api.call(
    "POST",
    `/cases/${caseId}/cancel`,
    { reason: "想取消" },
    as.assessor()
  );
  assert.equal(assessorCancels.status, 403);
});

test("非本人客户不能确认报价；技师不能代为确认", async () => {
  // 上一用例的报价仍在待定损，先审批通过。
  const approved = await api.call(
    "POST",
    `/cases/${caseId}/assessment`,
    { approved: true },
    as.assessor()
  );
  assert.equal(approved.status, 201);

  const stranger = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer("someone-else"));
  assert.equal(stranger.status, 403);

  const tech = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.technician());
  assert.equal(tech.status, 403);
});

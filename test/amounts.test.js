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

async function openCase() {
  const clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "金额校验", assessorLimitCents: 100000 },
    as.intake()
  );
  return { clockId, caseId: opened.body.data.id };
}

async function quote(caseId, payload) {
  return api.call("POST", `/cases/${caseId}/quotes`, { faults: [{ name: "故障" }], ...payload }, as.technician());
}

test("分项合计与总报价不一致：400 AMOUNT_MISMATCH，案件仍停留在 open", async () => {
  const { caseId } = await openCase();
  const res = await quote(caseId, {
    items: [
      { name: "清洗", quantity: 1, unitPriceCents: 30000 },
      { name: "换件", quantity: 2, unitPriceCents: 10000 } // 合计 50000
    ],
    totalAmountCents: 50001
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "AMOUNT_MISMATCH");

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "open");
  assert.equal(kase.quoteVersions.length, 0);
  assert.equal(kase.totalAmountCents, null);
});

test("数量乘单价参与合计：3 件 x 100.00 元必须报 300.00 元", async () => {
  const { caseId } = await openCase();
  const wrong = await quote(caseId, {
    items: [{ name: "密封圈", quantity: 3, unitPriceCents: 10000 }],
    totalAmountCents: 10000
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "AMOUNT_MISMATCH");

  const right = await quote(caseId, {
    items: [{ name: "密封圈", quantity: 3, unitPriceCents: 10000 }],
    totalAmountCents: 30000
  });
  assert.equal(right.status, 201);
  assert.equal(right.body.data.totalAmountCents, 30000);
});

test("支持两位小数元金额，拒绝第三位小数/负数/非法格式", async () => {
  const { caseId } = await openCase();
  const fine = await quote(caseId, {
    items: [{ name: "A", quantity: 1, unitPrice: "199.99" }],
    totalAmount: "199.99"
  });
  assert.equal(fine.status, 201);
  assert.equal(fine.body.data.totalAmountCents, 19999);

  const rejected = await api.call("POST", "/cases", {
    clockId: (await registerClock(api)),
    customerUserId: "c",
    description: "额度小数位非法",
    assessorLimitCents: "100.999"
  }, as.intake());
  assert.equal(rejected.status, 400);

  const neg = await quote((await openCase()).caseId, {
    items: [{ name: "A", quantity: 1, unitPriceCents: -1 }],
    totalAmountCents: -1
  });
  assert.equal(neg.status, 400);
});

test("空故障项/空报价/非法数量/非法 JSON 均被拒绝且不落数据", async () => {
  const { caseId } = await openCase();

  const noFaults = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [], items: [{ name: "A", quantity: 1, unitPriceCents: 1 }], totalAmountCents: 1 },
    as.technician()
  );
  assert.equal(noFaults.status, 400);

  const noItems = await quote(caseId, { items: [], totalAmountCents: 0 });
  assert.equal(noItems.status, 400);

  const badQty = await quote(caseId, {
    items: [{ name: "A", quantity: 0, unitPriceCents: 1 }],
    totalAmountCents: 0
  });
  assert.equal(badQty.status, 400);

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "open");
  assert.equal(kase.quoteVersions.length, 0);
});

test("不存在的钟表/案件返回 404", async () => {
  const noClock = await api.call(
    "POST",
    "/cases",
    { clockId: "clock_nope", customerUserId: "c", description: "d" },
    as.intake()
  );
  assert.equal(noClock.status, 404);
  const noCase = await api.call("POST", "/cases/case_nope/confirm", {}, as.customer());
  assert.equal(noCase.status, 404);
});

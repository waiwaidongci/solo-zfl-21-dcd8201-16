"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, as, registerClock, caseToAwaitingRetest } = require("../test-support/helpers");

let api;
before(async () => {
  api = await startServer();
});
after(async () => {
  await api.close();
});

async function caseCount(clockId) {
  const res = await api.call("GET", `/cases?clockId=${clockId}`);
  return res.body.data.length;
}

test("同一钟表只能有一个进行中案件：重复开案 409，结案后才可再开", async () => {
  const clockId = await registerClock(api);
  const first = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "一修" },
    as.intake()
  );
  assert.equal(first.status, 201);

  const second = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "二修" },
    as.intake()
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "CASE_ALREADY_ACTIVE");
  assert.equal(await caseCount(clockId), 1);

  // 并发重复开案同样只允许一个（另一个 409）。
  const freshClock = await registerClock(api);
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      api.call("POST", "/cases", { clockId: freshClock, customerUserId: "c", description: "并发开案" }, as.intake())
    )
  );
  const created = parallel.filter((r) => r.status === 201);
  const rejected = parallel.filter((r) => r.status === 409);
  assert.equal(created.length, 1);
  assert.equal(rejected.length, 4);
  assert.equal(await caseCount(freshClock), 1);

  // 取消后释放占用。
  const cancel = await api.call("POST", `/cases/${created[0].body.data.id}/cancel`, { reason: "客户撤单" }, as.intake());
  assert.equal(cancel.status, 201);
  const again = await api.call(
    "POST",
    "/cases",
    { clockId: freshClock, customerUserId: "c", description: "重新开案" },
    as.intake()
  );
  assert.equal(again.status, 201);
});

test("不带幂等键的重复提交/确认/审批：第二次起 409，不产生重复记录", async () => {
  const { caseId } = await caseToAwaitingRetest(api);

  // 已进入 awaiting_retest，重复完工/确认全部失败且状态不变。
  const repeatComplete = await api.call("POST", `/cases/${caseId}/repair-complete`, {}, as.technician());
  assert.equal(repeatComplete.status, 409);
  const repeatConfirm = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer());
  assert.equal(repeatConfirm.status, 409);

  await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 0, amplitude: 300 },
    as.technician()
  );
  // 已结案后重复结算/复测。
  const repeatRetest = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 0, amplitude: 300 },
    as.technician()
  );
  assert.equal(repeatRetest.status, 409);

  const res = await api.call("GET", `/cases/${caseId}`);
  assert.equal(res.body.data.status, "closed");
  assert.equal(res.body.data.quoteVersions.length, 1);
  const retests = (await api.call("GET", "/retests")).body.data.filter((r) => r.caseId === caseId && r.kind === "completion");
  assert.equal(retests.length, 1, "只允许一条完工复测记录");
});

test("同一报价版本不能被审批两次（含批准与驳回混合）", async () => {
  const clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c1", description: "重复审批", assessorLimitCents: 100000 },
    as.intake()
  );
  const caseId = opened.body.data.id;
  await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "f" }], items: [{ name: "i", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  const approve = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  assert.equal(approve.status, 201);
  const approveAgain = await api.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());
  assert.equal(approveAgain.status, 409);
  const rejectAfter = await api.call("POST", `/cases/${caseId}/assessment`, { approved: false }, as.assessor());
  assert.equal(rejectAfter.status, 409);

  const got = await api.call("GET", `/cases/${caseId}`);
  assert.equal(got.body.data.status, "approved");
  assert.equal(got.body.data.decision, "approved");
});

test("幂等键：同一键重复请求只生效一次并回放首次结果", async () => {
  const clockId = await registerClock(api);
  const key = "idem-open-001";
  const headers = { ...as.intake(), "Idempotency-Key": key };
  const payload = { clockId, customerUserId: "c1", description: "幂等开案" };
  const first = await api.call("POST", "/cases", payload, headers);
  assert.equal(first.status, 201);
  assert.equal(first.body.replayed, false);
  const firstId = first.body.data.id;

  const second = await api.call("POST", "/cases", payload, headers);
  assert.equal(second.status, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.data.id, firstId);

  const third = await api.call("POST", "/cases", payload, headers);
  assert.equal(third.body.data.id, firstId);
  assert.equal(await caseCount(clockId), 1);
});

test("幂等键跨重启仍然生效", async () => {
  const clockId = await registerClock(api);
  const key = "idem-open-restart-001";
  const payload = { clockId, customerUserId: "c1", description: "重启幂等" };
  const first = await api.call("POST", "/cases", payload, { ...as.intake(), "Idempotency-Key": key });
  assert.equal(first.status, 201);

  await api.restart();

  const replay = await api.call("POST", "/cases", payload, { ...as.intake(), "Idempotency-Key": key });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(await caseCount(clockId), 1);
});

test("同一幂等键用于不同操作返回冲突，且都不落数据", async () => {
  const clockId = await registerClock(api);
  const key = "idem-conflict-001";
  await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "c1", description: "首操作" },
    { ...as.intake(), "Idempotency-Key": key }
  );
  const other = await api.call(
    "POST",
    `/clocks/${clockId}/adjustments`,
    { currentDailyRateSeconds: 1, direction: "x", amount: "y" },
    { ...as.technician(), "Idempotency-Key": key }
  );
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "IDEMPOTENCY_KEY_CONFLICT");
});

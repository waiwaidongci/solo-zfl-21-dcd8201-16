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

test("建档：摆幅下限必须为正数，0/负数/非数字一律 400", async () => {
  for (const bad of [0, -270, "-1", "abc", null]) {
    const res = await api.call(
      "POST",
      "/clocks",
      { code: `CLK-AMP-${String(bad)}`, escapementType: "杠杆式", balanceFrequency: "28800vph", minCompletionAmplitude: bad }
    );
    assert.equal(res.status, 400, `下限 ${bad} 应被拒绝`);
    assert.equal(res.body.code, "INVALID_AMPLITUDE");
  }

  const ok = await api.call("POST", "/clocks", {
    code: "CLK-AMP-OK",
    escapementType: "杠杆式",
    balanceFrequency: "28800vph",
    minCompletionAmplitude: 200
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.minCompletionAmplitude, 200);

  // 不传时使用正数默认值。
  const def = await registerClock(api, { code: "CLK-AMP-DEFAULT" });
  const got = await api.call("GET", `/clocks`);
  const created = got.body.data.find((c) => c.id === def);
  assert.ok(created.minCompletionAmplitude > 0);
});

test("完工复测：振幅 0 或负数 400，不能通过也不能结案", async () => {
  const { caseId } = await caseToAwaitingRetest(api);

  for (const amplitude of [0, -1, -300]) {
    const res = await api.call(
      "POST",
      `/cases/${caseId}/completion-retest`,
      { dailyRateSeconds: 0, amplitude },
      as.technician()
    );
    assert.equal(res.status, 400, `振幅 ${amplitude} 应被拒绝`);
    assert.equal(res.body.code, "INVALID_AMPLITUDE");
  }

  // 失败的非法复测没有推进状态、没有产生复测记录。
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "awaiting_retest");
  assert.equal(kase.completionRetestId, null);
  const retests = (await api.call("GET", "/retests")).body.data.filter((r) => r.caseId === caseId);
  assert.equal(retests.length, 0);
});

test("完工复测：振幅恰等于下限是正数边界，可结案；低于下限（仍为正）退回调校", async () => {
  const clockId = await registerClock(api, { minCompletionAmplitude: 220 });
  const { caseId } = await caseToAwaitingRetest(api, { clockId });

  const atBoundary = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 0, amplitude: 220 },
    as.technician()
  );
  assert.equal(atBoundary.status, 201);
  assert.equal(atBoundary.body.data.passed, true);
  assert.equal(atBoundary.body.data.gates.amplitudeOk, true);
  assert.equal(atBoundary.body.data.status, "closed");
});

test("正数但不足下限的摆幅退回调校；既有调校复测接口同样拒绝非正振幅", async () => {
  const clockId = await registerClock(api, { minCompletionAmplitude: 280 });
  const { caseId } = await caseToAwaitingRetest(api, { clockId });

  const low = await api.call(
    "POST",
    `/cases/${caseId}/completion-retest`,
    { dailyRateSeconds: 0, amplitude: 279 },
    as.technician()
  );
  assert.equal(low.body.data.passed, false);
  assert.equal(low.body.data.status, "returned_to_tuning");

  // 既有 /clocks/:id/retests 调校复测也必须是正振幅。
  for (const amplitude of [0, -5]) {
    const res = await api.call(
      "POST",
      `/clocks/${clockId}/retests`,
      { dailyRateSeconds: 5, amplitude },
      as.technician()
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_AMPLITUDE");
  }

  const goodTuning = await api.call(
    "POST",
    `/clocks/${clockId}/retests`,
    { dailyRateSeconds: 5, amplitude: 290 },
    as.technician()
  );
  assert.equal(goodTuning.status, 201);
});

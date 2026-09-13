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

test("既有接口：健康检查与路由清单", async () => {
  const health = await api.call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.routes.includes("POST /cases/:id/quotes"));
});

test("既有接口：建档→调校→调校复测→历史→最新复测→列表过滤 全链路保持可用", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `CLK-LEGACY-${Math.random().toString(36).slice(2, 7)}`,
    escapementType: "杠杆式",
    balanceFrequency: "21600vph",
    targetDailyRateSeconds: 20,
    note: "既有接口回归"
  });
  assert.equal(created.status, 201);
  const clockId = created.body.data.id;

  // 不带角色头也能用（向后兼容旧调用方式）。
  const anonAdjust = await api.call("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 55,
    direction: "慢针方向",
    amount: "微调0.3格",
    note: ""
  });
  assert.equal(anonAdjust.status, 201);
  assert.equal(anonAdjust.body.data.clockId, clockId);

  const retest = await api.call("POST", `/clocks/${clockId}/retests`, {
    dailyRateSeconds: 12,
    amplitude: 285
  });
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.kind, "tuning");
  assert.equal(retest.body.data.caseId, null);

  const latest = await api.call("GET", `/clocks/${clockId}/latest-retest`);
  assert.equal(latest.body.data.id, retest.body.data.id);

  const history = await api.call("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.adjustments.length, 1);
  assert.equal(history.body.data.retests.length, 1);

  const adjustments = await api.call("GET", `/adjustments?clockId=${clockId}`);
  assert.equal(adjustments.body.data.length, 1);
  const retests = await api.call("GET", `/retests?clockId=${clockId}&qualified=true`);
  assert.equal(retests.body.data.length, 1);

  const list = await api.call("GET", "/clocks");
  assert.ok(list.body.data.some((c) => c.id === clockId));
  const notQualified = await api.call("GET", "/clocks/not-qualified");
  // 该表复测 qualified=true，不应出现在不合格列表。
  assert.ok(!notQualified.body.data.some((c) => c.id === clockId));
});

test("既有接口：显式 qualified=false 与自动判定均保留", async () => {
  const created = await api.call("POST", "/clocks", {
    code: `CLK-LEGACY-Q-${Math.random().toString(36).slice(2, 7)}`,
    escapementType: "同轴",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 5
  }, as.technician());
  const clockId = created.body.data.id;

  // 日差 12 超出目标 5，自动 qualified=false。
  const auto = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 12, amplitude: 300 });
  assert.equal(auto.body.data.qualified, false);

  // 显式 qualified 仍受尊重。
  const forced = await api.call("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 12, amplitude: 300, qualified: true });
  assert.equal(forced.body.data.qualified, true);
});

test("既有接口：非法 JSON 返回 400，未知路由返回 404", async () => {
  const res = await fetch(`${api.base}/clocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not json"
  });
  // fetch 直连以发送非法 JSON（call() 会序列化对象）。
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_JSON");

  const missing = await api.call("GET", "/nope");
  assert.equal(missing.status, 404);
});

"use strict";

/** 测试辅助：每个用例独立临时数据目录 + 随机端口起停服务。 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildStore, createApp } = require("../src/app");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clock-case-test-"));
}

async function startServer(options = {}) {
  const dataDir = options.dataDir || tempDir();
  const handle = { dataDir, servers: [], store: null };

  async function boot(seed) {
    const store = await buildStore({ dataDir, bootstrapEvents: seed ? true : false });
    handle.store = store;
    const server = createApp(store);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    handle.servers.push(server);
    return server.address().port;
  }

  await boot(options.seed !== false);
  const base = () => `http://127.0.0.1:${handle.servers[handle.servers.length - 1].address().port}`;

  handle.call = async function call(method, urlPath, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base() + urlPath, init);
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  handle.restart = async () => {
    const old = handle.servers[handle.servers.length - 1];
    await new Promise((resolve, reject) => old.close((err) => (err ? reject(err) : resolve())));
    handle.servers.pop();
    await boot(false);
    return handle;
  };
  handle.close = async () => {
    for (const server of handle.servers) await new Promise((resolve) => server.close(resolve));
  };
  return handle;
}

/** 角色快捷请求头。 */
const as = {
  intake: (id = "intake1") => ({ "x-user-role": "intake", "x-user-id": id }),
  technician: (id = "tech1") => ({ "x-user-role": "technician", "x-user-id": id }),
  assessor: (id = "assessor1") => ({ "x-user-role": "assessor", "x-user-id": id }),
  supervisor: (id = "supervisor1") => ({ "x-user-role": "supervisor", "x-user-id": id }),
  customer: (id = "cust1") => ({ "x-user-role": "customer", "x-user-id": id })
};

/** 建一个新钟表，返回其 id。 */
async function registerClock(api, overrides = {}) {
  const res = await api.call("POST", "/clocks", {
    code: `CLK-T-${Math.random().toString(36).slice(2, 8)}`,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 10,
    minCompletionAmplitude: 270,
    ...overrides
  });
  if (res.status !== 201) throw new Error("建表失败：" + JSON.stringify(res.body));
  return res.body.data.id;
}

/** 建案 → 报价 → 审批 → 客户确认 → 完工，默认进入待复测状态。 */
async function caseToAwaitingRetest(api, options = {}) {
  const clockId = options.clockId || (await registerClock(api));
  const customerId = options.customerId || "cust1";
  const limit = options.limit ?? 100000;
  const total = options.total ?? 50000;
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: customerId, description: "摔停走慢", assessorLimitCents: limit },
    as.intake()
  );
  if (opened.status !== 201) throw new Error("开案失败：" + JSON.stringify(opened.body));
  const caseId = opened.body.data.id;

  const quote = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    {
      faults: [{ name: "摆轮轴磨损" }],
      items: [{ name: "清洗保养", quantity: 1, unitPriceCents: total }],
      totalAmountCents: total
    },
    as.technician()
  );
  if (quote.status !== 201) throw new Error("报价失败：" + JSON.stringify(quote.body));

  const routedSupervisor = total > limit;
  const decision = await api.call(
    "POST",
    `/cases/${caseId}/assessment`,
    { approved: true },
    routedSupervisor ? as.supervisor() : as.assessor()
  );
  if (decision.status !== 201) throw new Error("审批失败：" + JSON.stringify(decision.body));

  const confirmed = await api.call("POST", `/cases/${caseId}/confirm`, {}, as.customer(customerId));
  if (confirmed.status !== 201) throw new Error("客户确认失败：" + JSON.stringify(confirmed.body));

  const repaired = await api.call("POST", `/cases/${caseId}/repair-complete`, {}, as.technician());
  if (repaired.status !== 201) throw new Error("完工失败：" + JSON.stringify(repaired.body));

  return { clockId, caseId };
}

module.exports = { startServer, tempDir, as, registerClock, caseToAwaitingRetest };

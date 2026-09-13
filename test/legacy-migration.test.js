"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { startServer, as } = require("../test-support/helpers");

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clock-legacy-"));
}

test("旧版 db.json（v1 钟表调校数据）自动迁移为审计事件，快照丢失也能全量重建", async () => {
  const dir = mktmp();
  fs.writeFileSync(
    path.join(dir, "db.json"),
    JSON.stringify({
      clocks: [
        {
          id: "clock_old",
          code: "OLD-1",
          escapementType: "叉瓦式",
          balanceFrequency: "21600vph",
          targetDailyRateSeconds: 15,
          note: "旧档案",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      adjustments: [
        {
          id: "adj_old",
          clockId: "clock_old",
          currentDailyRateSeconds: 40,
          direction: "慢",
          amount: "微调",
          note: "",
          createdAt: "2026-01-02T00:00:00.000Z"
        }
      ],
      retests: [
        {
          id: "ret_old",
          clockId: "clock_old",
          adjustmentId: "adj_old",
          testedAt: "2026-01-03T00:00:00.000Z",
          dailyRateSeconds: 20,
          amplitude: 260,
          qualified: false,
          note: "旧复测"
        }
      ]
    })
  );

  let api = await startServer({ dataDir: dir, seed: false });
  try {
    const clocks = await api.call("GET", "/clocks");
    assert.equal(clocks.body.data.length, 1);
    assert.equal(clocks.body.data[0].id, "clock_old");

    // 在迁移后的数据上继续走新案件流程。
    const opened = await api.call(
      "POST",
      "/cases",
      { clockId: "clock_old", customerUserId: "c1", description: "迁移后开案", assessorLimitCents: 100000 },
      as.intake()
    );
    assert.equal(opened.status, 201);
    const caseId = opened.body.data.id;

    // 迁移事件 + 开案事件都在钟表维度时间线里。
    const tl = await api.call("GET", `/audit-timeline?clockId=clock_old`);
    const types = tl.body.data.map((event) => event.type);
    assert.deepEqual(types, ["ClockRegistered", "AdjustmentRecorded", "RetestRecorded", "CaseOpened"]);

    // 彻底删除快照：仅凭审计日志即可全量重建全部旧数据。
    fs.unlinkSync(path.join(dir, "db.json"));
    await api.restart();

    const clocks2 = await api.call("GET", "/clocks");
    assert.equal(clocks2.body.data.length, 1);
    assert.equal(clocks2.body.data[0].code, "OLD-1");
    const retests = await api.call("GET", "/retests");
    assert.equal(retests.body.data.length, 1);
    const kase = await api.call("GET", `/cases/${caseId}`);
    assert.equal(kase.status, 200);
    assert.equal(kase.body.data.status, "open");
  } finally {
    await api.close();
  }
});

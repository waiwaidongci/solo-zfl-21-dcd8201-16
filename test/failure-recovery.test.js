"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { startServer, as, registerClock } = require("../test-support/helpers");

let api;
before(async () => {
  api = await startServer();
});
after(async () => {
  await api.close();
});

function auditLineCount() {
  const raw = fs.readFileSync(path.join(api.dataDir, "audit.log"), "utf8");
  return raw.split("\n").filter((line) => line.trim()).length;
}

function snapshotLastSeq() {
  const raw = fs.readFileSync(path.join(api.dataDir, "db.json"), "utf8");
  return JSON.parse(raw).lastSeq;
}

async function openCase() {
  const clockId = await registerClock(api);
  const opened = await api.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "故障恢复" },
    as.intake()
  );
  return { clockId, caseId: opened.body.data.id };
}

test("审计写入阶段失败：整体放弃，日志/快照/状态都不留半条数据，随后可重试", async () => {
  const { caseId } = await openCase();
  const beforeLines = auditLineCount();
  const beforeSeq = snapshotLastSeq();

  api.store.injectFault("audit", "once");
  const failed = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INJECTED_AUDIT_FAILURE");

  // 没有任何事件落盘，内存状态也未推进。
  assert.equal(auditLineCount(), beforeLines);
  assert.equal(snapshotLastSeq(), beforeSeq);
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "open");
  assert.equal(kase.quoteVersions.length, 0);

  // 故障仅一次：原请求重试成功。
  const retry = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  assert.equal(retry.status, 201);
  assert.equal(auditLineCount(), beforeLines + 1);
});

test("快照写入阶段失败：审计已提交，内存立即按日志自愈；客户端用幂等键重试不产生重复", async () => {
  const { caseId } = await openCase();
  const beforeLines = auditLineCount();

  const key = "snapshot-fault-quote-1";
  api.store.injectFault("snapshot", "once");
  const failed = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 200 }], totalAmountCents: 200 },
    { ...as.technician(), "Idempotency-Key": key }
  );
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INJECTED_SNAPSHOT_FAILURE");

  // 审计只有一条，且内存视图已自愈到已提交状态。
  assert.equal(auditLineCount(), beforeLines + 1);
  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "pending_assessment");

  // 同一幂等键重试：回放首次结果，不再追加事件。
  const replay = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 200 }], totalAmountCents: 200 },
    { ...as.technician(), "Idempotency-Key": key }
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(auditLineCount(), beforeLines + 1);
});

test("重启后快照是更早的一致版本（丢失最新快照）：凭审计日志重放补齐且不重复", async () => {
  const { caseId } = await openCase();
  const auditLines = auditLineCount();

  // 模拟最新快照丢失、只剩一个更早的一致快照（tmp+rename 保证状态与水位始终一致）。
  const snapshotPath = path.join(api.dataDir, "db.json");
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      version: 2,
      lastSeq: 0,
      state: { clocks: [], adjustments: [], retests: [], cases: [] }
    })
  );

  await api.restart();

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "open");
  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  // CaseOpened 通过日志重放补回，恰好一条，没有重复。
  assert.equal(timeline.body.data.length, 1);
  assert.equal(snapshotLastSeq(), auditLines);
});

test("审计日志最后一行被崩溃截断：重启跳过坏行，此前已提交数据全部保留", async () => {
  const { caseId } = await openCase();
  const lines = auditLineCount();

  fs.appendFileSync(path.join(api.dataDir, "audit.log"), '{"seq":' + (lines + 1) + ',"type":"QuoteSubmit');
  await api.restart();

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.status, "open"); // 截断的提交未生效
  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  assert.equal(timeline.body.data.length, 1); // 此前的 CaseOpened 完好

  // 跳过坏行后可以继续正常提交，序号不冲突。
  const quote = await api.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  assert.equal(quote.status, 201);
});

test("快照文件损坏：忽略快照，凭审计日志全量重建", async () => {
  const { caseId } = await openCase();
  fs.writeFileSync(path.join(api.dataDir, "db.json"), "{ 这不是合法JSON ");

  await api.restart();

  const kase = (await api.call("GET", `/cases/${caseId}`)).body.data;
  assert.equal(kase.id, caseId);
  assert.equal(kase.status, "open");
  const clocks = await api.call("GET", "/clocks");
  assert.ok(clocks.body.data.length >= 1);
});

test("崩溃残留的快照临时文件不影响启动，不产生重复数据", async () => {
  const { caseId } = await openCase();
  const lines = auditLineCount();
  fs.writeFileSync(path.join(api.dataDir, "db.json.tmp-stale"), "partial");

  await api.restart();

  const timeline = await api.call("GET", `/cases/${caseId}/timeline`);
  assert.equal(timeline.body.data.length, 1);
  assert.equal(auditLineCount(), lines);
});

test("审计不可修改：重启与后续流转只追加，已提交的审计行逐字节不变", async (t) => {
  // 独立服务器/数据目录：本文件其他用例会人为截断日志，不能共用。
  const isolated = await startServer();
  t.after(async () => {
    await isolated.close();
  });
  const clockId = await registerClock(isolated);
  const opened = await isolated.call(
    "POST",
    "/cases",
    { clockId, customerUserId: "cust1", description: "审计不可变", assessorLimitCents: 100000 },
    as.intake()
  );
  const caseId = opened.body.data.id;
  const readAudit = () => fs.readFileSync(path.join(isolated.dataDir, "audit.log"), "utf8").split("\n").filter(Boolean);
  const prefixAfterOpen = readAudit();

  await isolated.call(
    "POST",
    `/cases/${caseId}/quotes`,
    { faults: [{ name: "停走" }], items: [{ name: "维修", quantity: 1, unitPriceCents: 100 }], totalAmountCents: 100 },
    as.technician()
  );
  await isolated.restart();
  await isolated.call("POST", `/cases/${caseId}/assessment`, { approved: true }, as.assessor());

  const finalLines = readAudit();
  // 前缀逐字节一致（没有任何已提交行被重写），新增行只出现在尾部。
  assert.deepEqual(finalLines.slice(0, prefixAfterOpen.length), prefixAfterOpen);
  assert.ok(finalLines.length > prefixAfterOpen.length);

  // seq 连续且不重复。
  const seqs = finalLines.map((line) => JSON.parse(line).seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

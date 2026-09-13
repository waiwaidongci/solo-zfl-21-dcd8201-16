"use strict";

/**
 * 持久化存储层：
 *
 *  - 所有写操作经单一互斥链串行化：读状态→领域命令→追加审计→原子快照，
 *    并发的审批/确认/结算只会有一个胜出，其余收到 409（状态前置条件失败）。
 *  - 审计日志 data/audit.log 仅追加（append + fsync），每流转一条不可修改；
 *    时间线查询即读取该日志。
 *  - 快照 data/db.json 采用 写临时文件 → fsync → rename → 目录 fsync，
 *    崩溃时要么是旧快照要么是新快照，绝不出现半条 JSON。
 *  - 启动时以快照为基础、重放审计日志中 seq 更大的记录对账；
 *    日志最后一行若在崩溃中被截断会被跳过，不影响此前全部已提交数据。
 *  - Idempotency-Key 命中时直接返回首次结果（含首次状态码），不产生重复事件。
 */

const {
  readFile,
  open: fsOpen,
  rename: fsRename,
  mkdir,
  access
} = require("fs/promises");
const { constants: FS_CONSTANTS, createReadStream } = require("fs");
const path = require("path");
const readline = require("readline");

const domain = require("./domain");
const { applyEvent, initialState, COMMANDS, DomainError } = domain;

const SNAPSHOT_NAME = "db.json";
const AUDIT_NAME = "audit.log";

function defaultMakeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function defaultRandom(n) {
  return Math.random().toString(36).slice(2, 2 + n);
}
function defaultNow() {
  return new Date().toISOString();
}

class Store {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, "..", "data");
    this.snapshotPath = path.join(this.dataDir, SNAPSHOT_NAME);
    this.auditPath = path.join(this.dataDir, AUDIT_NAME);
    this.makeId = options.makeId || defaultMakeId;
    this.random = options.random || defaultRandom;
    this.now = options.now || defaultNow;
    this.bootstrapEvents = options.bootstrapEvents || null;
    // 测试用故障注入：在第 n 次提交的 audit/snapshot 阶段人为失败。
    this.fault = null; // { stage: 'audit'|'snapshot', match: 'nth'|'once', n }
    this.faultCount = 0;
    this._tail = Promise.resolve();
    this.state = initialState();
    this.audit = []; // 已提交的审计信封（内存视图，与 audit.log 一致）
    this.idempotency = new Map(); // key -> { command, status, result }
    this.lastSeq = 0;
    this.ready = false;
  }

  /* ----------------------------- 启动 / 对账 ----------------------------- */

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    let snapshot = null;
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      snapshot = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") {
        // 快照损坏不应丢数据：忽略快照，改由审计日志全量重放。
        snapshot = null;
      }
    }

    let state = initialState();
    this.lastSeq = 0;
    let legacyMigrated = false;
    if (snapshot && snapshot.version === 2 && snapshot.state) {
      state = snapshot.state;
      this.lastSeq = snapshot.lastSeq || 0;
    } else if (snapshot && Array.isArray(snapshot.clocks)) {
      // 兼容旧版 db.json（钟表调校服务的原始格式）：在审计日志缺失时，
      // 先把旧数据改写为审计事件落盘，使日志成为完整事实来源，再走统一重放。
      if (!await this.fileExists(this.auditPath)) {
        const legacyEvents = this.legacyEvents(snapshot);
        if (legacyEvents.length) {
          await this.appendAuditDurable(legacyEvents);
          legacyMigrated = true;
        }
      }
    } else if (!await this.fileExists(this.auditPath)) {
      // 全新数据目录：写入引导事件（演示数据），日志先落盘，再出快照。
      if (this.bootstrapEvents && this.bootstrapEvents.length) {
        const seeded = await this.seedBootstrap(this.bootstrapEvents);
        this.audit = seeded.audit;
        this.state = seeded.state;
        this.lastSeq = seeded.lastSeq;
        this.rebuildIdempotency(seeded.audit);
        await this.writeSnapshot();
        this.ready = true;
        return;
      }
    }

    // 读取全量审计：时间线查询需要完整历史，不能只保留快照之后的部分。
    const { lines, corruptLines } = await this.readAuditLines();
    if (corruptLines > 0) {
      // 崩溃截断的尾巴可能没有换行；补一个换行隔离坏行，否则后续 append 的
      // 第一条合法事件会与坏行拼在同一行而被一起丢弃。
      await this.appendAuditDurable([]);
    }
    const audit = [];
    const seenSeq = new Set();
    let replayed = 0;
    for (const line of lines) {
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        // 崩溃截断的尾部行：跳过。该行对应的提交没有完成 fsync，本就未生效。
        continue;
      }
      if (!envelope || typeof envelope.seq !== "number") continue;
      if (seenSeq.has(envelope.seq)) continue; // 防御：重复行只取一条
      seenSeq.add(envelope.seq);
      try {
        if (envelope.seq > this.lastSeq) {
          applyEvent(state, envelope);
          replayed += 1;
        }
      } catch {
        // 单条异常事件不阻断启动对账：跳过并继续。
        continue;
      }
      audit.push(envelope);
    }
    audit.sort((a, b) => a.seq - b.seq);
    this.lastSeq = audit.length ? audit[audit.length - 1].seq : this.lastSeq;
    this.audit = audit;
    this.state = state;
    this.rebuildIdempotency(audit);

    // 快照损坏/落后于日志时立即自愈重写，保证重启后水位与日志对齐。
    if (replayed > 0 || snapshot === null || legacyMigrated) {
      await this.writeSnapshot();
    }

    this.ready = true;
  }

  /** 把旧版 db.json 的行规范化为当前事件信封（仅迁移时使用）。 */
  legacyEvents(snapshot) {
    const events = [];
    let seq = 0;
    const wrap = (type, data, at) => {
      seq += 1;
      return { seq, at, actor: { userId: "legacy-migration", role: null }, type, data, idempotencyKey: null, result: null, command: null };
    };
    for (const clock of snapshot.clocks || []) {
      events.push(wrap("ClockRegistered", clock, clock.createdAt));
    }
    for (const adjustment of snapshot.adjustments || []) {
      events.push(wrap("AdjustmentRecorded", adjustment, adjustment.createdAt));
    }
    for (const retest of snapshot.retests || []) {
      events.push(
        wrap(
          "RetestRecorded",
          {
            kind: "tuning",
            caseId: null,
            passed: null,
            ...retest
          },
          retest.testedAt
        )
      );
    }
    return events;
  }

  async seedBootstrap(events) {
    const audit = [];
    const state = initialState();
    let seq = 0;
    for (const event of events) {
      seq += 1;
      const envelope = { seq, at: event.at || this.now(), actor: event.actor || null, type: event.type, data: event.data, idempotencyKey: null, result: null, command: null };
      applyEvent(state, envelope);
      audit.push(envelope);
    }
    await this.appendAuditDurable(audit);
    return { audit, state, lastSeq: seq };
  }

  async fileExists(target) {
    try {
      await access(target, FS_CONSTANTS.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readAuditLines() {
    if (!await this.fileExists(this.auditPath)) return { lines: [], corruptLines: 0 };
    const lines = [];
    let corruptLines = 0;
    const rl = readline.createInterface({ input: createReadStream(this.auditPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines.push(line);
      try {
        JSON.parse(line);
      } catch {
        corruptLines += 1;
      }
    }
    return { lines, corruptLines };
  }

  rebuildIdempotency(audit) {
    for (const envelope of audit) {
      if (envelope.idempotencyKey) this.registerIdempotency(envelope);
    }
  }

  registerIdempotency(envelope) {
    this.idempotency.set(envelope.idempotencyKey, {
      command: envelope.command,
      status: envelope.result?.status || 201,
      result: envelope.result?.body ?? null
    });
  }

  /* ------------------------------- 锁原语 -------------------------------- */

  // 串行化所有写事务：返回值在任务入队的微任务中保持。
  withLock(task) {
    const run = this._tail.then(() => task());
    // 不让单个任务的拒绝炸掉整条链。
    this._tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /* ------------------------------- 主事务 -------------------------------- */

  async command(commandName, cmd = {}, actor = null, options = {}) {
    if (!COMMANDS[commandName]) {
      throw new DomainError(500, "UNKNOWN_COMMAND", `未知命令：${commandName}`);
    }
    return this.withLock(() => this.runTransaction(commandName, cmd, actor, options));
  }

  async runTransaction(commandName, cmd, actor, options) {
    const idemKey = options.idempotencyKey || null;
    if (idemKey) {
      const cached = this.idempotency.get(idemKey);
      if (cached) {
        if (cached.command !== commandName) {
          throw new DomainError(409, "IDEMPOTENCY_KEY_CONFLICT", "同一幂等键被用于不同操作");
        }
        return { replayed: true, status: cached.status, result: cached.result };
      }
    }

    const handler = COMMANDS[commandName];
    const deps = { id: this.makeId, now: this.now, random: this.random };
    // 纯函数阶段：只校验、产出事件与返回值，不触碰状态。
    const [events, resultValue] = handler(this.state, cmd, actor ? { ...actor } : null, deps);
    const at = this.now();
    const list = Array.isArray(events) ? events : [events];
    const envelopes = list.map((event, index) => ({
      seq: this.lastSeq + index + 1,
      at,
      actor: actor ? { userId: actor.userId, role: actor.role } : null,
      type: event.type,
      data: event.data,
      // 幂等键与返回值挂在该命令的第一条事件上，随日志持久化，重启仍可重放。
      idempotencyKey: index === 0 ? idemKey : null,
      result: index === 0 ? { status: 201, body: resultValue } : null,
      command: index === 0 ? commandName : null
    }));

    this.faultCount += 1;
    const faultHit = this.fault && this.fault.stage === "audit" && this.faultShouldFire();
    if (faultHit) {
      // 审计追加前失败：什么都没写，状态/日志/快照保持原样，无半条数据。
      this.clearFaultIfOnce();
      throw new DomainError(500, "INJECTED_AUDIT_FAILURE", "注入故障：审计日志写入失败（事务已整体放弃）");
    }

    // 1) 审计先行，append + fsync，成功即“已提交”。
    await this.appendAuditDurable(envelopes);

    // 2) 内存视图推进。
    const stateForApply = this.state;
    for (const envelope of envelopes) applyEvent(stateForApply, envelope);
    this.audit.push(...envelopes);
    this.lastSeq += envelopes.length;
    if (idemKey) this.registerIdempotency(envelopes[0]);

    // 3) 原子快照。即使这里崩溃/失败，重启后由审计重放补齐，提交不丢。
    try {
      await this.writeSnapshot();
    } catch (error) {
      // 快照失败后立即用日志重建内存视图，保证下一个请求看到的是已提交状态。
      await this.resyncFromAudit();
      throw error;
    }
    if (this.fault && this.fault.stage === "snapshot" && this.faultShouldFire()) {
      this.clearFaultIfOnce();
      await this.resyncFromAudit();
      // 事务其实已提交（审计已落盘），按 500 返回；客户端用幂等键重试会拿到同一结果。
      throw new DomainError(500, "INJECTED_SNAPSHOT_FAILURE", "注入故障：快照写入失败（审计已提交，重启/重试不丢不重）");
    }

    return { replayed: false, status: 201, result: resultValue };
  }

  faultShouldFire() {
    if (!this.fault) return false;
    if (this.fault.match === "nth") return this.faultCount === this.fault.n;
    return true; // once
  }

  clearFaultIfOnce() {
    if (this.fault && (this.fault.match === "once" || this.fault.match === "nth")) this.fault = null;
  }

  injectFault(stage, mode = "once", n = 1) {
    this.fault = { stage, match: mode, n };
    this.faultCount = 0;
  }

  /** 快照失败后：丢弃内存视图，从空状态 + 全量审计重放重建。 */
  async resyncFromAudit() {
    const state = initialState();
    const audit = [];
    this.idempotency.clear();
    let lastSeq = 0;
    const { lines } = await this.readAuditLines();
    for (const line of lines) {
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        continue;
      }
      if (!envelope || typeof envelope.seq !== "number") continue;
      applyEvent(state, envelope);
      audit.push(envelope);
      lastSeq = Math.max(lastSeq, envelope.seq);
      if (envelope.idempotencyKey) this.registerIdempotency(envelope);
    }
    this.state = state;
    this.audit = audit;
    this.lastSeq = lastSeq;
  }

  /* ------------------------------- 磁盘 IO ------------------------------- */

  async appendAuditDurable(envelopes) {
    const payload = envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n";
    const fh = await fsOpen(this.auditPath, "a");
    try {
      await fh.appendFile(payload);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async writeSnapshot() {
    const snapshot = {
      version: 2,
      lastSeq: this.lastSeq,
      updatedAt: this.now(),
      state: this.state
    };
    const tmp = `${this.snapshotPath}.tmp-${process.pid}-${this.lastSeq}`;
    const fh = await fsOpen(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(snapshot, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsRename(tmp, this.snapshotPath);
    // 目录 fsync：保证 rename 在掉电后仍然生效。
    const dir = await fsOpen(this.dataDir, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  /* ------------------------------- 查询 ---------------------------------- */

  getState() {
    return this.state;
  }

  timeline(options = {}) {
    const { caseId, clockId, limit = 500 } = options;
    const eventCaseId = (envelope) => (envelope.type === "CaseOpened" ? envelope.data?.id : envelope.data?.caseId);
    let rows = this.audit;
    if (caseId) rows = rows.filter((envelope) => eventCaseId(envelope) === caseId);
    if (clockId) {
      rows = rows.filter((envelope) => {
        const data = envelope.data;
        if (data?.clockId === clockId) return true;
        if (data?.retest?.clockId === clockId) return true;
        if (envelope.type === "ClockRegistered" && data?.id === clockId) return true;
        const cid = eventCaseId(envelope);
        if (cid) return this.state.cases.find((kase) => kase.id === cid)?.clockId === clockId;
        return false;
      });
    }
    rows = rows.filter((envelope) => !envelope.type.startsWith("_"));
    return rows.slice(0, limit).map((envelope) => ({
      seq: envelope.seq,
      at: envelope.at,
      actor: envelope.actor,
      type: envelope.type,
      command: envelope.command,
      summary: domain.EVENT_SUMMARY[envelope.type] || envelope.type,
      data: envelope.data
    }));
  }
}

module.exports = { Store };

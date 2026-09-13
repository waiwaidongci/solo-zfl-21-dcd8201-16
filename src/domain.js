"use strict";

/**
 * 维修保险定损闭环 —— 事件溯源领域模型（纯函数，无 IO）。
 *
 * 案件状态机：
 *   open ──submitQuote──▶ pending_assessment  (合计<=额度)
 *                        pending_supervisor  (合计>额度，自动上报)
 *   pending_assessment ──assess(approved)──▶ approved
 *                        ──assess(rejected)──▶ quote_rejected
 *   pending_supervisor ──assess(approved)──▶ approved
 *                        ──assess(rejected)──▶ quote_rejected
 *   quote_rejected ──submitQuote──▶ pending_assessment / pending_supervisor
 *   approved ──customerConfirm──▶ repairing
 *   repairing ──repairComplete──▶ awaiting_retest
 *   awaiting_retest 或 returned_to_tuning ──completionRetest(合格)──▶ closed
 *   awaiting_retest 或 returned_to_tuning ──completionRetest(不合格)──▶ returned_to_tuning
 *   任一进行中状态 ──cancel──▶ cancelled
 *
 * 金额一律以“分”为单位的整数保存，杜绝浮点误差；分项合计必须精确等于总报价。
 */

const ROLES = Object.freeze({
  INTAKE: "intake", // 接件员：开案、取消
  TECHNICIAN: "technician", // 技师：报价、维修、复测
  ASSESSOR: "assessor", // 定损员：授权额度内审批
  SUPERVISOR: "supervisor", // 主管：超额复核
  CUSTOMER: "customer" // 客户：确认报价
});
const ALL_ROLES = Object.freeze(Object.values(ROLES));

/** 同一钟表只能有一个“进行中”案件；closed/cancelled 释放占用。 */
const ACTIVE_STATUSES = Object.freeze([
  "open",
  "pending_assessment",
  "pending_supervisor",
  "quote_rejected",
  "approved",
  "repairing",
  "awaiting_retest",
  "returned_to_tuning"
]);
const TERMINAL_STATUSES = Object.freeze(["closed", "cancelled"]);

const DEFAULT_ASSESSOR_LIMIT_CENTS = 500000; // 5,000.00 元
/** 完工复测默认最低摆幅（度），钟表档案可用 minCompletionAmplitude 覆盖。 */
const DEFAULT_MIN_COMPLETION_AMPLITUDE = 270;
/** 分项报价条数与单价边界，防止脏数据。 */
const MAX_QUOTE_ITEMS = 50;
const MAX_CENTS = 1000000000; // 1000 万（分），仅作输入合理性上限

class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new DomainError(status, code, message);
}

function requireActor(ctx) {
  if (!ctx || !ctx.role) fail(401, "UNAUTHENTICATED", "缺少 x-user-role 请求头");
  if (!ALL_ROLES.includes(ctx.role)) {
    fail(403, "FORBIDDEN_ROLE", `未知角色：${ctx.role}`);
  }
  if (!ctx.userId) fail(401, "UNAUTHENTICATED", "缺少 x-user-id 请求头");
}

function requireRole(ctx, roles, action) {
  requireActor(ctx);
  if (!roles.includes(ctx.role)) {
    fail(403, "FORBIDDEN", `角色 ${ctx.role} 无权执行「${action}」`);
  }
}

/** 既有调校接口保持向后兼容：不带角色头时以匿名身份记录，带了就校验合法性。 */
function optionalActor(ctx) {
  if (!ctx || !ctx.role) return { userId: ctx?.userId || "anonymous", role: null };
  if (!ALL_ROLES.includes(ctx.role)) fail(403, "FORBIDDEN_ROLE", `未知角色：${ctx.role}`);
  if (!ctx.userId) fail(401, "UNAUTHENTICATED", "缺少 x-user-id 请求头");
  return ctx;
}

/**
 * 金额解析。两种入参形式：
 *  - 名字带 Cents 的字段（unitPriceCents / totalAmountCents / assessorLimitCents）：
 *    必须是以“分”为单位的非负整数，不做缩放。
 *  - 不带 Cents 的别名（unitPrice / totalAmount / assessorLimit）：以“元”计，
 *    数字或最多两位小数的字符串，解析为分。
 */
function parseCents(value, field) {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= MAX_CENTS) return value;
    fail(400, "INVALID_AMOUNT", `${field} 必须是以分为单位的非负整数（收到 ${value}）`);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const cents = Number(value.trim());
    if (cents <= MAX_CENTS) return cents;
  }
  fail(400, "INVALID_AMOUNT", `${field} 必须是以分为单位的非负整数（收到 ${value}）`);
}

function parseYuan(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value * 100 > MAX_CENTS) {
      fail(400, "INVALID_AMOUNT", `${field} 金额不合法（收到 ${value}）`);
    }
    return Math.round(value * 100);
  }
  if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value.trim())) {
    const [intPart, frac = ""] = value.trim().split(".");
    const cents = Number(intPart) * 100 + Number((frac + "00").slice(0, 2));
    if (cents <= MAX_CENTS) return cents;
  }
  fail(400, "INVALID_AMOUNT", `${field} 金额格式不合法（收到 ${value}），最多两位小数`);
}

const requiredString = (body, field) => {
  if (typeof body[field] !== "string" || body[field].trim() === "") {
    fail(400, "VALIDATION_ERROR", `缺少字段：${field}`);
  }
  return body[field].trim();
};

const initialState = () => ({
  clocks: [],
  adjustments: [],
  retests: [],
  cases: []
});

function findClock(state, clockId) {
  const clock = state.clocks.find((item) => item.id === clockId);
  if (!clock) fail(404, "CLOCK_NOT_FOUND", "钟表不存在");
  return clock;
}

function findCase(state, caseId) {
  const kase = state.cases.find((item) => item.id === caseId);
  if (!kase) fail(404, "CASE_NOT_FOUND", "案件不存在");
  return kase;
}

function activeCaseForClock(state, clockId) {
  return state.cases.find((item) => item.clockId === clockId && ACTIVE_STATUSES.includes(item.status)) || null;
}

function assertCaseStatus(kase, statuses, action) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  if (!list.includes(kase.status)) {
    fail(
      409,
      "INVALID_STATE",
      `案件当前状态 ${kase.status} 不允许「${action}」，需要 ${list.join("/")}`
    );
  }
}

/* ---------------- reducer：事件 -> 状态（唯一的状态变更点） ---------------- */

function applyEvent(state, event) {
  const next = state;
  switch (event.type) {
    case "ClockRegistered": {
      next.clocks.push(event.data);
      break;
    }
    case "AdjustmentRecorded": {
      next.adjustments.push(event.data);
      break;
    }
    case "RetestRecorded": {
      next.retests.push(event.data);
      break;
    }
    case "CaseOpened": {
      const d = event.data;
      next.cases.push({
        id: d.id,
        code: d.code,
        clockId: d.clockId,
        customerUserId: d.customerUserId,
        description: d.description,
        insurancePolicyNo: d.insurancePolicyNo,
        status: "open",
        faults: [],
        quoteVersions: [],
        totalAmountCents: null,
        currentQuoteVersion: 0,
        assessorLimitCents: d.assessorLimitCents,
        decidedBy: null,
        decidedAt: null,
        decision: null,
        decisionNote: "",
        confirmedAt: null,
        repairCompletedAt: null,
        completionRetestId: null,
        closedAt: null,
        cancelledAt: null,
        cancelReason: "",
        openedBy: event.actor,
        createdAt: event.at
      });
      break;
    }
    case "QuoteSubmitted": {
      const kase = findCase(next, event.data.caseId);
      const d = event.data;
      kase.faults = d.faults; // 重新报价时整体替换故障与分项
      kase.quoteVersions.push({
        version: d.version,
        totalAmountCents: d.totalAmountCents,
        items: d.items,
        note: d.note,
        submittedBy: event.actor,
        submittedAt: event.at,
        routedTo: d.routedTo
      });
      kase.currentQuoteVersion = d.version;
      kase.totalAmountCents = d.totalAmountCents;
      kase.status = d.routedTo === "supervisor" ? "pending_supervisor" : "pending_assessment";
      break;
    }
    case "QuoteAssessed": {
      const kase = findCase(next, event.data.caseId);
      kase.status = event.data.approved ? "approved" : "quote_rejected";
      kase.decision = event.data.approved ? "approved" : "rejected";
      kase.decisionNote = event.data.note;
      kase.decidedBy = event.actor;
      kase.decidedAt = event.at;
      break;
    }
    case "CustomerConfirmed": {
      const kase = findCase(next, event.data.caseId);
      kase.status = "repairing";
      kase.confirmedAt = event.at;
      break;
    }
    case "RepairCompleted": {
      const kase = findCase(next, event.data.caseId);
      kase.status = "awaiting_retest";
      kase.repairCompletedAt = event.at;
      break;
    }
    case "CompletionRetested": {
      next.retests.push(event.data.retest);
      const kase = findCase(next, event.data.caseId);
      if (event.data.passed) {
        kase.status = "closed";
        kase.completionRetestId = event.data.retest.id;
        kase.closedAt = event.at;
      } else {
        kase.status = "returned_to_tuning";
      }
      break;
    }
    case "CaseCancelled": {
      const kase = findCase(next, event.data.caseId);
      kase.status = "cancelled";
      kase.cancelledAt = event.at;
      kase.cancelReason = event.data.reason;
      break;
    }
    default:
      fail(500, "UNKNOWN_EVENT", `未知事件类型：${event.type}`);
  }
  return next;
}

/* ---------------- 命令处理：参数校验/授权/状态前置条件 -> 事件 ---------------- */

/** 校验复测摆幅：必须是正数（度），0 或负数一律拒绝。 */
function positiveAmplitude(value) {
  const amplitude = Number(value);
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    fail(400, "INVALID_AMPLITUDE", `振幅 amplitude 必须为正数（收到 ${value}）`);
  }
  return amplitude;
}

function registerClock(state, cmd, ctx, deps) {
  optionalActor(ctx);
  const code = requiredString(cmd, "code");
  const escapementType = requiredString(cmd, "escapementType");
  const balanceFrequency = requiredString(cmd, "balanceFrequency");
  const targetDailyRateSeconds = Number.isFinite(Number(cmd.targetDailyRateSeconds))
    ? Number(cmd.targetDailyRateSeconds)
    : 30;
  // 完工复测摆幅下限：可覆盖但必须是正数；不传用默认值。
  const hasMinAmplitude = cmd.minCompletionAmplitude !== undefined;
  const minCompletionAmplitude = hasMinAmplitude
    ? positiveAmplitude(cmd.minCompletionAmplitude)
    : DEFAULT_MIN_COMPLETION_AMPLITUDE;
  if (targetDailyRateSeconds < 0) fail(400, "VALIDATION_ERROR", "日差目标不能为负");
  const clock = {
    id: deps.id("clock"),
    code,
    escapementType,
    balanceFrequency,
    targetDailyRateSeconds,
    minCompletionAmplitude,
    note: typeof cmd.note === "string" ? cmd.note : "",
    createdAt: deps.now()
  };
  return [{ type: "ClockRegistered", data: clock }, clock];
}

function recordAdjustment(state, cmd, ctx, deps) {
  optionalActor(ctx);
  const clock = findClock(state, cmd.clockId);
  if (cmd.currentDailyRateSeconds === undefined || cmd.direction === undefined || cmd.amount === undefined) {
    fail(400, "VALIDATION_ERROR", "缺少字段：currentDailyRateSeconds, direction, amount");
  }
  const adjustment = {
    id: deps.id("adjustment"),
    clockId: clock.id,
    currentDailyRateSeconds: Number(cmd.currentDailyRateSeconds),
    direction: String(cmd.direction),
    amount: String(cmd.amount),
    note: typeof cmd.note === "string" ? cmd.note : "",
    createdAt: deps.now()
  };
  return [{ type: "AdjustmentRecorded", data: adjustment }, adjustment];
}

function recordRetest(state, cmd, ctx, deps) {
  optionalActor(ctx);
  const clock = findClock(state, cmd.clockId);
  if (cmd.dailyRateSeconds === undefined || cmd.amplitude === undefined) {
    fail(400, "VALIDATION_ERROR", "缺少字段：dailyRateSeconds, amplitude");
  }
  const adjustment = state.adjustments
    .filter((item) => item.clockId === clock.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const qualified = cmd.qualified !== undefined
    ? Boolean(cmd.qualified)
    : Math.abs(Number(cmd.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
  const retest = {
    id: deps.id("retest"),
    kind: "tuning",
    clockId: clock.id,
    caseId: null,
    adjustmentId: cmd.adjustmentId || adjustment?.id || null,
    testedAt: cmd.testedAt || deps.now(),
    dailyRateSeconds: Number(cmd.dailyRateSeconds),
    amplitude: positiveAmplitude(cmd.amplitude),
    qualified,
    passed: null,
    note: typeof cmd.note === "string" ? cmd.note : ""
  };
  return [{ type: "RetestRecorded", data: retest }, retest];
}

function openCase(state, cmd, ctx, deps) {
  requireRole(ctx, [ROLES.INTAKE], "开案");
  const clock = findClock(state, cmd.clockId);
  // 同一钟表只能有一个进行中案件：由 reducer 前的不变量校验保证，重复开案 409。
  if (activeCaseForClock(state, clock.id)) {
    fail(409, "CASE_ALREADY_ACTIVE", "该钟表已有进行中的维修案件，结案后才能再次开案");
  }
  const customerUserId = requiredString(cmd, "customerUserId");
  const description = requiredString(cmd, "description");
  const limitCents = cmd.assessorLimitCents !== undefined
    ? parseCents(cmd.assessorLimitCents, "assessorLimitCents")
    : cmd.assessorLimit !== undefined
      ? parseYuan(cmd.assessorLimit, "assessorLimit")
      : DEFAULT_ASSESSOR_LIMIT_CENTS;
  const kase = {
    id: deps.id("case"),
    code: cmd.code ? String(cmd.code) : `CASE-${deps.now().replace(/[-:.TZ]/g, "").slice(0, 14)}-${deps.random(4)}`,
    clockId: clock.id,
    customerUserId,
    description,
    insurancePolicyNo: cmd.insurancePolicyNo ? String(cmd.insurancePolicyNo) : "",
    assessorLimitCents: limitCents
  };
  const eventData = { ...kase };
  return [{ type: "CaseOpened", data: eventData }, { id: kase.id }];
}

function submitQuote(state, cmd, ctx, deps) {
  requireRole(ctx, [ROLES.TECHNICIAN], "提交故障项与报价");
  const kase = findCase(state, cmd.caseId);
  assertCaseStatus(kase, ["open", "quote_rejected"], "提交/重新提交报价");

  if (!Array.isArray(cmd.faults) || cmd.faults.length === 0) {
    fail(400, "VALIDATION_ERROR", "至少填写一个故障项");
  }
  const faults = cmd.faults.map((fault, index) => {
    if (!fault || typeof fault.name !== "string" || fault.name.trim() === "") {
      fail(400, "VALIDATION_ERROR", `第 ${index + 1} 个故障项缺少 name`);
    }
    return { code: fault.code ? String(fault.code) : `F${index + 1}`, name: fault.name.trim(), note: fault.note ? String(fault.note) : "" };
  });

  if (!Array.isArray(cmd.items) || cmd.items.length === 0) {
    fail(400, "VALIDATION_ERROR", "至少填写一条分项报价");
  }
  if (cmd.items.length > MAX_QUOTE_ITEMS) fail(400, "VALIDATION_ERROR", `分项报价最多 ${MAX_QUOTE_ITEMS} 条`);
  const items = cmd.items.map((item, index) => {
    if (!item || typeof item.name !== "string" || item.name.trim() === "") {
      fail(400, "VALIDATION_ERROR", `第 ${index + 1} 条分项缺少 name`);
    }
    const hasCents = item.unitPriceCents !== undefined;
    const unitPriceCents = hasCents
      ? parseCents(item.unitPriceCents, `items[${index}].unitPriceCents`)
      : parseYuan(item.unitPrice, `items[${index}].unitPrice`);
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) {
      fail(400, "VALIDATION_ERROR", `items[${index}].quantity 必须是 1..9999 的整数`);
    }
    return {
      name: item.name.trim(),
      faultCode: item.faultCode ? String(item.faultCode) : null,
      quantity,
      unitPriceCents,
      lineTotalCents: unitPriceCents * quantity
    };
  });

  // 不变量：分项报价合计必须精确等于总报价（整数分比较）。
  const sumCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const hasTotalCents = cmd.totalAmountCents !== undefined;
  const totalCents = hasTotalCents
    ? parseCents(cmd.totalAmountCents, "totalAmountCents")
    : parseYuan(cmd.totalAmount, "totalAmount");
  if (sumCents !== totalCents) {
    fail(
      400,
      "AMOUNT_MISMATCH",
      `分项报价合计 ${sumCents} 分与总报价 ${totalCents} 分不一致`
    );
  }

  const version = kase.currentQuoteVersion + 1;
  const routedTo = totalCents <= kase.assessorLimitCents ? "assessor" : "supervisor";
  const data = {
    caseId: kase.id,
    version,
    faults,
    items,
    totalAmountCents: totalCents,
    note: typeof cmd.note === "string" ? cmd.note : "",
    routedTo
  };
  return [{ type: "QuoteSubmitted", data }, { version, totalAmountCents: totalCents, routedTo }];
}

function assessQuote(state, cmd, ctx, deps) {
  requireActor(ctx);
  const kase = findCase(state, cmd.caseId);

  if (kase.status === "pending_supervisor") {
    // 超额：定损员无权批准/驳回，只能主管复核。
    requireRole(ctx, [ROLES.SUPERVISOR], "超额复核");
  } else if (kase.status === "pending_assessment") {
    requireRole(ctx, [ROLES.ASSESSOR, ROLES.SUPERVISOR], "定损审批");
  } else {
    assertCaseStatus(kase, ["pending_assessment", "pending_supervisor"], "审批报价");
  }

  const approved = cmd.approved === true;
  if (cmd.approved !== true && cmd.approved !== false) {
    fail(400, "VALIDATION_ERROR", "approved 必须为 true 或 false");
  }
  const data = { caseId: kase.id, version: kase.currentQuoteVersion, approved, note: typeof cmd.note === "string" ? cmd.note : "" };
  return [{ type: "QuoteAssessed", data }, { approved, status: approved ? "approved" : "quote_rejected" }];
}

function customerConfirm(state, cmd, ctx) {
  requireRole(ctx, [ROLES.CUSTOMER], "客户确认");
  const kase = findCase(state, cmd.caseId);
  assertCaseStatus(kase, ["approved"], "客户确认");
  if (ctx.userId !== kase.customerUserId) {
    fail(403, "FORBIDDEN", "只有该案件的客户本人可以确认报价");
  }
  return [{ type: "CustomerConfirmed", data: { caseId: kase.id } }, { status: "repairing" }];
}

function completeRepair(state, cmd, ctx) {
  requireRole(ctx, [ROLES.TECHNICIAN], "标记维修完工");
  const kase = findCase(state, cmd.caseId);
  assertCaseStatus(kase, ["repairing"], "提交完工");
  return [{ type: "RepairCompleted", data: { caseId: kase.id } }, { status: "awaiting_retest" }];
}

function completionRetest(state, cmd, ctx, deps) {
  requireRole(ctx, [ROLES.TECHNICIAN], "完工复测");
  const kase = findCase(state, cmd.caseId);
  assertCaseStatus(kase, ["awaiting_retest", "returned_to_tuning"], "完工复测");
  const clock = findClock(state, kase.clockId);
  if (cmd.dailyRateSeconds === undefined || cmd.amplitude === undefined) {
    fail(400, "VALIDATION_ERROR", "缺少字段：dailyRateSeconds, amplitude");
  }
  const dailyRateSeconds = Number(cmd.dailyRateSeconds);
  // 摆幅必须为正数：0/负数属于非法测量，直接 400，绝不进入合格判定或结案。
  const amplitude = positiveAmplitude(cmd.amplitude);
  if (!Number.isFinite(dailyRateSeconds)) {
    fail(400, "VALIDATION_ERROR", "日差必须是数字");
  }

  // 双闸门：日差 AND 摆幅同时满足才合格，任一不满足退回调校。
  const rateOk = Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
  const minAmplitude = Number(clock.minCompletionAmplitude ?? DEFAULT_MIN_COMPLETION_AMPLITUDE);
  const amplitudeOk = amplitude >= minAmplitude;
  const passed = rateOk && amplitudeOk;

  const adjustment = state.adjustments
    .filter((item) => item.clockId === clock.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const retest = {
    id: deps.id("retest"),
    kind: "completion",
    clockId: clock.id,
    caseId: kase.id,
    adjustmentId: cmd.adjustmentId || adjustment?.id || null,
    testedAt: deps.now(),
    dailyRateSeconds,
    amplitude,
    qualified: passed,
    passed,
    rateOk,
    amplitudeOk,
    minAmplitude,
    note: typeof cmd.note === "string" ? cmd.note : ""
  };
  const data = { caseId: kase.id, retest, passed };
  return [
    { type: "CompletionRetested", data },
    {
      passed,
      status: passed ? "closed" : "returned_to_tuning",
      gates: { rateOk, amplitudeOk, targetDailyRateSeconds: clock.targetDailyRateSeconds, minAmplitude },
      retest
    }
  ];
}

function cancelCase(state, cmd, ctx) {
  requireRole(ctx, [ROLES.INTAKE, ROLES.SUPERVISOR], "取消案件");
  const kase = findCase(state, cmd.caseId);
  // 只允许在定损决策作出之前取消：审批/确认/维修开始后不能再撤案，
  // 从而保证“并发取消与审批”不会出现两者同时生效。
  const cancellable = ["open", "pending_assessment", "pending_supervisor", "quote_rejected"];
  assertCaseStatus(kase, cancellable, "取消案件");
  const reason = typeof cmd.reason === "string" ? cmd.reason : "";
  return [{ type: "CaseCancelled", data: { caseId: kase.id, reason } }, { status: "cancelled" }];
}

const COMMANDS = Object.freeze({
  registerClock,
  recordAdjustment,
  recordRetest,
  openCase,
  submitQuote,
  assessQuote,
  customerConfirm,
  completeRepair,
  completionRetest,
  cancelCase
});

/** 供测试/审计时间线使用的中文动作摘要。 */
const EVENT_SUMMARY = Object.freeze({
  ClockRegistered: "钟表建档",
  AdjustmentRecorded: "记录调校",
  RetestRecorded: "记录调校复测",
  CaseOpened: "接件开案",
  QuoteSubmitted: "技师提交故障项与分项报价",
  QuoteAssessed: "定损/主管复核",
  CustomerConfirmed: "客户确认报价",
  RepairCompleted: "维修完工待复测",
  CompletionRetested: "完工复测",
  CaseCancelled: "案件取消"
});

module.exports = {
  ROLES,
  ALL_ROLES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_ASSESSOR_LIMIT_CENTS,
  DEFAULT_MIN_COMPLETION_AMPLITUDE,
  DomainError,
  initialState,
  applyEvent,
  COMMANDS,
  EVENT_SUMMARY,
  parseCents,
  parseYuan,
  activeCaseForClock,
  findClock,
  findCase
};

"use strict";

/** 演示数据（全新数据目录时作为引导事件写入审计日志，与现有服务自带数据保持一致）。 */

const SEED_AT = "2026-06-16T00:00:00.000Z";

const clock = {
  id: "clock_demo",
  code: "CLK-1890-07",
  escapementType: "瑞士杠杆式",
  balanceFrequency: "18000vph",
  targetDailyRateSeconds: 20,
  minCompletionAmplitude: 270,
  note: "怀表机芯，走时偏快",
  createdAt: SEED_AT
};

const adjustment = {
  id: "adjustment_demo",
  clockId: "clock_demo",
  currentDailyRateSeconds: 68,
  direction: "慢针方向",
  amount: "游丝快慢针向慢侧微调0.4格",
  note: "初次调校，先保守处理",
  createdAt: SEED_AT
};

const retest = {
  id: "retest_demo",
  kind: "tuning",
  clockId: "clock_demo",
  caseId: null,
  adjustmentId: "adjustment_demo",
  testedAt: SEED_AT,
  dailyRateSeconds: 31,
  amplitude: 248,
  qualified: false,
  passed: null,
  note: "仍偏快，振幅尚可"
};

const bootstrapEvents = [
  { type: "ClockRegistered", at: SEED_AT, actor: { userId: "system", role: "intake" }, data: clock },
  { type: "AdjustmentRecorded", at: SEED_AT, actor: { userId: "tech_demo", role: "technician" }, data: adjustment },
  { type: "RetestRecorded", at: SEED_AT, actor: { userId: "tech_demo", role: "technician" }, data: retest }
];

module.exports = { bootstrapEvents };

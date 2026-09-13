# 机械钟表擒纵调校 + 维修保险定损 API

纯后端零依赖 Node 服务（Node ≥ 20）。在原有钟表调校服务上，新增了完整的**维修保险定损闭环**。

## 启动与测试

```bash
PORT=3021 node server.js          # 默认数据目录 ./data，可用 DATA_DIR 覆盖
npm test                          # node --test，41 个用例
```

首次启动若 `data/` 为空，会写入与原服务一致的演示钟表；旧版 `data/db.json`（v1 钟表/调校/复测）会在首次启动时**自动迁移**为审计事件。

## 定损闭环与角色

角色经请求头传入：`x-user-role` + `x-user-id`。

| 角色 | 权限 |
| --- | --- |
| `intake` 接件员 | 开案、绑定钟表、决策前取消 |
| `technician` 技师 | 提交故障项与分项报价、标记完工、完工复测 |
| `assessor` 定损员 | 仅在授权额度内批准/驳回 |
| `supervisor` 主管 | 超额案件复核（也可取消） |
| `customer` 客户 | 只能确认属于自己的案件 |

状态机：

```
open ──报价──▶ pending_assessment(总额≤额度) / pending_supervisor(超额)
             ──审批──▶ approved / quote_rejected(可重新报价)
approved ──客户确认──▶ repairing ──完工──▶ awaiting_retest
awaiting_retest / returned_to_tuning ──复测合格(日差且摆幅)──▶ closed
                                      ──任一不合格──▶ returned_to_tuning（退回调校后可再复测）
决策前任意进行中状态 ──取消──▶ cancelled（closed/cancelled 后释放钟表占用）
```

## 金额

- 接口金额一律使用以**分**为单位的整数：`assessorLimitCents`、`unitPriceCents`、`totalAmountCents`（也接受元别名 `assessorLimit`/`unitPrice`/`totalAmount`，数字或最多两位小数字符串）。
- 不变量：**分项报价合计必须精确等于总报价**，否则 `400 AMOUNT_MISMATCH`，不落任何数据。
- 超过授权额度的报价自动路由 `pending_supervisor`，定损员审批返回 `403 FORBIDDEN`。

## 新增接口

| 方法/路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /cases` | intake | 开案并绑定钟表（同表只能有一个进行中案件，重复 `409 CASE_ALREADY_ACTIVE`） |
| `GET /cases?status=&clockId=&active=` | 任意 | 案件列表 |
| `GET /cases/:id` | 任意 | 案件详情（含最新报价版本） |
| `POST /cases/:id/quotes` | technician | 故障项 `faults` + 分项 `items` + 总报价；驳回后可重新报价（版本递增） |
| `POST /cases/:id/assessment` | assessor / supervisor | `{approved:boolean}`；超额仅主管 |
| `POST /cases/:id/confirm` | 客户本人 | 确认后才允许维修 |
| `POST /cases/:id/repair-complete` | technician | 完工进入待复测 |
| `POST /cases/:id/completion-retest` | technician | `{dailyRateSeconds, amplitude}`；日差与摆幅双闸门 |
| `POST /cases/:id/cancel` | intake / supervisor | 仅决策前可取消 |
| `GET /cases/:id/timeline` | 任意 | 该案件完整流转时间线 |
| `GET /audit-timeline?clockId=` | 任意 | 全局/按钟表的审计时间线 |

原有接口（`/clocks`、`/adjustments`、`/retests` 等）保持不变。

## 幂等与并发

- 写接口支持 `Idempotency-Key` 请求头：同键重放首次结果（含首次状态码），键跨重启仍生效；同键用于不同操作返回 `409 IDEMPOTENCY_KEY_CONFLICT`。
- 所有写事务经单进程互斥链串行化：重复提交/审批/确认，以及并发审批、并发结算，只有一个胜出，其余 `409 INVALID_STATE`，不会出现重复记录或状态覆盖。

## 审计与持久化（重启不丢、不留半条数据）

- 每次流转向 `data/audit.log` **只追加一行** JSON 并 `fsync`；审计行写入后不可修改，时间线即该日志的视图。
- `data/db.json` 为快照，采用 `写临时文件 → fsync → rename → 目录 fsync`，崩溃时只会是旧版或新版，不会半写。
- 启动时以快照为基础重放审计日志：快照损坏可仅凭日志全量重建；日志尾部被崩溃截断的坏行自动隔离跳过，已提交数据不受影响。
- 事务顺序：纯函数校验/产出事件 → 追加审计（先落盘即提交）→ 更新内存 → 原子快照。审计前失败整体放弃；快照失败时已提交的审计仍在，内存按日志自愈，客户端用幂等键重试不产生重复。

## 测试覆盖

`npm test` 覆盖：正常全流程（含驳回重报、复测不合格退回再测、重启恢复）、越权、超额路由、重复提交/审批/确认、高并发审批/确认/结算/取消、金额不一致、审计不可变、故障注入（审计阶段失败 / 快照阶段失败）、日志截断、快照损坏与旧版数据迁移。

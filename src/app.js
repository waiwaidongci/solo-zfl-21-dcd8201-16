"use strict";

/**
 * HTTP 应用层：路由、鉴权头解析、入参/出参，业务规则全部在 src/domain.js，
 * 持久化/并发/审计全部在 src/store.js。
 */

const http = require("http");
const { URL } = require("url");

const domain = require("./domain");
const { Store } = require("./store");
const { bootstrapEvents } = require("./seed");

const routes = [
  // 既有：钟表调校
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  // 新增：维修保险定损闭环
  "POST /cases",
  "GET /cases",
  "GET /cases/:id",
  "POST /cases/:id/quotes",
  "POST /cases/:id/assessment",
  "POST /cases/:id/confirm",
  "POST /cases/:id/repair-complete",
  "POST /cases/:id/completion-retest",
  "POST /cases/:id/cancel",
  "GET /cases/:id/timeline",
  "GET /audit-timeline"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new domain.DomainError(400, "INVALID_JSON", "请求体必须是合法JSON");
    throw error;
  }
}

function actorFrom(req) {
  const role = req.headers["x-user-role"];
  const userId = req.headers["x-user-id"];
  if (!role && !userId) return null;
  return { role: role ? String(role) : null, userId: userId ? String(userId) : null };
}

function latestRetest(state, clockId) {
  return state.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(state, clockId) {
  return state.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(state, clock) {
  const retest = latestRetest(state, clock.id);
  return {
    ...clock,
    latestAdjustment: latestAdjustment(state, clock.id),
    latestRetest: retest,
    activeCase: domain.activeCaseForClock(state, clock.id)?.id || null,
    qualified: retest ? retest.qualified : false
  };
}

function caseView(state, kase) {
  const clock = state.clocks.find((item) => item.id === kase.clockId) || null;
  return {
    ...kase,
    clock: clock ? { id: clock.id, code: clock.code } : null,
    latestQuote: kase.quoteVersions[kase.quoteVersions.length - 1] || null
  };
}

function createApp(store) {
  const exec = async (commandName, body, req, res) => {
    const idemKey = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null;
    const outcome = await store.command(commandName, body, actorFrom(req), { idempotencyKey: idemKey });
    send(res, outcome.status, { data: outcome.result, replayed: Boolean(outcome.replayed) });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status || 500;
      send(res, status, {
        error: error.message || "服务器错误",
        code: error.code || "INTERNAL_ERROR"
      });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const state = () => store.getState();

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
    }

    /* ------------------------- 既有：钟表调校接口 ------------------------- */

    if (req.method === "GET" && pathname === "/clocks") {
      const qualified = url.searchParams.get("qualified");
      let data = state().clocks.map((clock) => clockSummary(state(), clock));
      if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/clocks") {
      // 兼容旧接口：返回钟表摘要（含 qualified/latestAdjustment/latestRetest）。
      const outcome = await store.command("registerClock", await parseBody(req), actorFrom(req), {
        idempotencyKey: req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null
      });
      const clock = state().clocks.find((item) => item.id === outcome.result.id);
      return send(res, outcome.status, { data: clockSummary(state(), clock), replayed: Boolean(outcome.replayed) });
    }

    if (req.method === "GET" && pathname === "/clocks/not-qualified") {
      const data = state().clocks.map((clock) => clockSummary(state(), clock)).filter((clock) => !clock.qualified);
      return send(res, 200, { data });
    }

    let match = pathname.match(/^\/clocks\/([^/]+)\/history$/);
    if (match && req.method === "GET") {
      const clock = domain.findClock(state(), match[1]);
      return send(res, 200, {
        data: {
          clock,
          adjustments: state().adjustments.filter((item) => item.clockId === clock.id),
          retests: state().retests.filter((item) => item.clockId === clock.id),
          cases: state().cases.filter((item) => item.clockId === clock.id),
          latestRetest: latestRetest(state(), clock.id)
        }
      });
    }

    match = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
    if (match && req.method === "POST") {
      const body = await parseBody(req);
      return exec("recordAdjustment", { ...body, clockId: match[1] }, req, res);
    }

    match = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
    if (match && req.method === "POST") {
      // 兼容旧接口：除复测数据外，附带该钟表的最新摘要。
      const body = await parseBody(req);
      const outcome = await store.command("recordRetest", { ...body, clockId: match[1] }, actorFrom(req), {
        idempotencyKey: req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null
      });
      const retest = state().retests.find((item) => item.id === outcome.result.id) || outcome.result;
      const clock = state().clocks.find((item) => item.id === retest.clockId);
      return send(res, outcome.status, { data: retest, clock: clockSummary(state(), clock), replayed: Boolean(outcome.replayed) });
    }

    match = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
    if (match && req.method === "GET") {
      domain.findClock(state(), match[1]);
      return send(res, 200, { data: latestRetest(state(), match[1]) });
    }

    if (req.method === "GET" && pathname === "/adjustments") {
      const clockId = url.searchParams.get("clockId");
      return send(res, 200, { data: state().adjustments.filter((item) => !clockId || item.clockId === clockId) });
    }

    if (req.method === "GET" && pathname === "/retests") {
      const clockId = url.searchParams.get("clockId");
      const qualified = url.searchParams.get("qualified");
      const data = state().retests.filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchQualified = qualified === null || item.qualified === (qualified === "true");
        return matchClock && matchQualified;
      });
      return send(res, 200, { data });
    }

    /* ----------------------- 新增：保险定损案件接口 ----------------------- */

    if (req.method === "POST" && pathname === "/cases") {
      const body = await parseBody(req);
      const outcome = await store.command("openCase", body, actorFrom(req), {
        idempotencyKey: req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null
      });
      const kase = state().cases.find((item) => item.id === outcome.result.id);
      return send(res, outcome.status, { data: caseView(state(), kase), replayed: Boolean(outcome.replayed) });
    }

    if (req.method === "GET" && pathname === "/cases") {
      const status = url.searchParams.get("status");
      const clockId = url.searchParams.get("clockId");
      const active = url.searchParams.get("active");
      let data = state().cases;
      if (status) data = data.filter((item) => item.status === status);
      if (clockId) data = data.filter((item) => item.clockId === clockId);
      if (active !== null) {
        const set = active === "true" ? domain.ACTIVE_STATUSES : domain.TERMINAL_STATUSES;
        data = data.filter((item) => set.includes(item.status));
      }
      return send(res, 200, { data: data.map((item) => caseView(state(), item)) });
    }

    if (req.method === "GET" && pathname === "/audit-timeline") {
      const clockId = url.searchParams.get("clockId");
      const limit = Number(url.searchParams.get("limit") || 500);
      return send(res, 200, { data: store.timeline({ clockId, limit }) });
    }

    match = pathname.match(/^\/cases\/([^/]+)\/timeline$/);
    if (match && req.method === "GET") {
      domain.findCase(state(), match[1]);
      return send(res, 200, { data: store.timeline({ caseId: match[1] }) });
    }

    match = pathname.match(/^\/cases\/([^/]+)\/(quotes|assessment|confirm|repair-complete|completion-retest|cancel)$/);
    if (match && req.method === "POST") {
      const caseId = match[1];
      const action = match[2];
      domain.findCase(state(), caseId); // 404 先于业务校验
      const commandMap = {
        quotes: "submitQuote",
        assessment: "assessQuote",
        confirm: "customerConfirm",
        "repair-complete": "completeRepair",
        "completion-retest": "completionRetest",
        cancel: "cancelCase"
      };
      const body = await parseBody(req);
      return exec(commandMap[action], { ...body, caseId }, req, res);
    }

    if ((match = pathname.match(/^\/cases\/([^/]+)$/)) && req.method === "GET") {
      const kase = domain.findCase(state(), match[1]);
      return send(res, 200, { data: caseView(state(), kase) });
    }

    return send(res, 404, { error: "接口不存在", code: "NOT_FOUND", routes });
  }

  return server;
}

async function buildStore(options = {}) {
  const store = new Store({
    dataDir: options.dataDir,
    bootstrapEvents: options.bootstrapEvents === false ? null : bootstrapEvents
  });
  await store.init();
  return store;
}

module.exports = { createApp, buildStore, routes };

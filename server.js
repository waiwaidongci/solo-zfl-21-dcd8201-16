"use strict";

/** 服务入口：组装持久化层 + HTTP 应用。业务逻辑见 src/ 目录。 */

const { createApp, buildStore } = require("./src/app");

const PORT = Number(process.env.PORT || 3021);
const DATA_DIR = process.env.DATA_DIR || undefined; // 默认 ./data
const SEED_DEMO = process.env.SEED_DEMO !== "false";

async function main() {
  const store = await buildStore({ dataDir: DATA_DIR, bootstrapEvents: SEED_DEMO });
  const server = createApp(store);
  server.listen(PORT, () => {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

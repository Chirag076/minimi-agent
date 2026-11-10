// main.ts: `npm run dev` starts here.
import { config } from "./config.js";
import { MemoryStore } from "./memory.js";
import { createApp } from "./server.js";
import { buildAgent, requireKeys } from "./wiring.js";

requireKeys();
const store = new MemoryStore(config.dataFile);
createApp(buildAgent(store), store).listen(config.port, () => {
  console.log(`Chat agent running at http://localhost:${config.port} (model ${config.model}, time zone ${config.timeZone})`);
});

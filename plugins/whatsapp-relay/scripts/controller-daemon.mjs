import { ControllerConfigStore } from "./controller-config.mjs";
import { WhatsAppControllerBridge } from "./controller-bridge.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn"
});
const configStore = new ControllerConfigStore();
const stateStore = new ControllerStateStore();
const bridge = new WhatsAppControllerBridge({
  runtime,
  configStore,
  stateStore
});

async function shutdown(code = 0) {
  try {
    await bridge.stop();
  } catch (error) {
    console.error("failed to stop WhatsApp controller bridge cleanly", error);
  }
  process.exit(code);
}

process.on("SIGTERM", () => {
  shutdown(0).catch((error) => {
    console.error("failed to shut down WhatsApp controller bridge", error);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  shutdown(0).catch((error) => {
    console.error("failed to shut down WhatsApp controller bridge", error);
    process.exit(1);
  });
});

try {
  await bridge.start();
  process.stdout.write("WhatsApp controller bridge started.\n");
} catch (error) {
  await stateStore.clearProcess().catch(() => {});
  console.error(`failed to start WhatsApp controller bridge: ${error.message}`);
  process.exit(1);
}

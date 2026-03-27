import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});

process.stdout.write("Starting WhatsApp terminal QR authentication...\n");
process.stdout.write(
  "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
);

await runtime.start({ printQrToTerminal: true, force: true });

try {
  const socket = await runtime.waitForConnection(5 * 60_000);
  const user = socket.user?.id ?? "unknown";
  process.stdout.write(`\nAuthenticated successfully as ${user}.\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exit(1);
}

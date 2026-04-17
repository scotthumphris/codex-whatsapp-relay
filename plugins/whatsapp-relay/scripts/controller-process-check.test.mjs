import test from "node:test";
import assert from "node:assert/strict";

import { commandLineMatchesControllerDaemon } from "./controller-process-check.mjs";

test("commandLineMatchesControllerDaemon recognizes the relay daemon script", () => {
  assert.equal(
    commandLineMatchesControllerDaemon(
      "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\Scott.Humphris\\.codex\\plugins\\whatsapp-relay\\plugins\\whatsapp-relay\\scripts\\controller-daemon.mjs\""
    ),
    true
  );
});

test("commandLineMatchesControllerDaemon rejects unrelated recycled pids", () => {
  assert.equal(
    commandLineMatchesControllerDaemon(
      "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\Scott.Humphris\\AppData\\Roaming\\npm\\node_modules\\@hubspot\\cli\\mcp-server\\server.js\""
    ),
    false
  );
});

import { execFileSync } from "node:child_process";
import process from "node:process";

import { controllerDaemonScript } from "./paths.mjs";

function normalizeCommandLine(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/").toLowerCase() : "";
}

export function commandLineMatchesControllerDaemon(commandLine) {
  const normalized = normalizeCommandLine(commandLine);
  if (!normalized) {
    return false;
  }

  const expectedScript = normalizeCommandLine(controllerDaemonScript);
  return normalized.includes(expectedScript) || normalized.includes("controller-daemon.mjs");
}

function readWindowsProcessCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    const command = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($p) { $p.CommandLine }"
    ].join("; ");

    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }
    );

    return output.trim() || null;
  } catch {
    return null;
  }
}

export function isControllerPidRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "win32") {
    return true;
  }

  return commandLineMatchesControllerDaemon(readWindowsProcessCommandLine(pid));
}

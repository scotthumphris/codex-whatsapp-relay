import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { controllerOutboxDir, ensureRuntimeDirs } from "./paths.mjs";

function commandFileName(id) {
  return `${id}.json`;
}

export async function enqueueControllerCommand({ type, payload }) {
  if (!type) {
    throw new Error("Controller command type is required.");
  }

  await ensureRuntimeDirs();

  const id = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const command = {
    id,
    type,
    payload: payload ?? {},
    createdAt: new Date().toISOString()
  };

  const finalPath = path.join(controllerOutboxDir, commandFileName(id));
  const tempPath = path.join(
    controllerOutboxDir,
    `.${commandFileName(id)}.${crypto.randomUUID()}.tmp`
  );

  await fs.writeFile(tempPath, JSON.stringify(command, null, 2));
  await fs.rename(tempPath, finalPath);

  return command;
}

export async function drainControllerCommands(handler) {
  await ensureRuntimeDirs();

  const entries = await fs.readdir(controllerOutboxDir, {
    withFileTypes: true
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const filePath = path.join(controllerOutboxDir, file);
    let command = null;

    try {
      command = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }

    await handler(command);
    await fs.unlink(filePath).catch(() => {});
  }
}

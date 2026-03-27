import fs from "node:fs/promises";
import path from "node:path";

import { controllerStateFile } from "./paths.mjs";

function defaultState() {
  return {
    process: {
      pid: null,
      status: "stopped",
      startedAt: null,
      heartbeatAt: null
    },
    sessions: {}
  };
}

function normalizeState(value = {}) {
  return {
    ...defaultState(),
    ...value,
    process: {
      ...defaultState().process,
      ...(value.process ?? {})
    },
    sessions: value.sessions ?? {}
  };
}

export class ControllerStateStore {
  constructor(filePath = controllerStateFile) {
    this.filePath = filePath;
    this.data = defaultState();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.data = defaultState();
    }

    return this.data;
  }

  async save() {
    this.data = normalizeState(this.data);
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tempFile, JSON.stringify(this.data, null, 2));
    await fs.rename(tempFile, this.filePath);
    return this.data;
  }

  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.load();
      await mutator(this.data);
      return this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async setProcess(partial = {}) {
    return this.mutate((data) => {
      data.process = {
        ...data.process,
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  async clearProcess() {
    return this.mutate((data) => {
      data.process = defaultState().process;
      this.data = normalizeState(data);
    });
  }

  async upsertSession(phoneKey, partial = {}) {
    return this.mutate((data) => {
      data.sessions[phoneKey] = {
        ...(data.sessions[phoneKey] ?? {}),
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  async removeSession(phoneKey) {
    return this.mutate((data) => {
      delete data.sessions[phoneKey];
      this.data = normalizeState(data);
    });
  }

  listSessions() {
    return Object.entries(this.data.sessions).map(([phoneKey, session]) => ({
      phoneKey,
      ...session
    }));
  }
}

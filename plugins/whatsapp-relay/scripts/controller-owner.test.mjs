import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  claimGlobalControllerOwner,
  getGlobalControllerOwner,
  releaseGlobalControllerOwner
} from "./controller-owner.mjs";

const isPidRunning = (pid) => pid === process.pid;

async function withTempOwnerFile(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-"));
  const ownerFile = path.join(tempDir, "owner.json");
  try {
    await run(ownerFile);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("claimGlobalControllerOwner prevents a second live owner from taking over", async () => {
  await withTempOwnerFile(async (ownerFile) => {
    const initial = await claimGlobalControllerOwner(
      {
        pid: process.pid,
        repoRootPath: "/repo/first",
        pluginRootPath: "/plugin/first"
      },
      ownerFile,
      { isPidRunning }
    );
    assert.equal(initial.acquired, true);

    const blocked = await claimGlobalControllerOwner(
      {
        pid: process.pid + 100_000,
        repoRootPath: "/repo/second",
        pluginRootPath: "/plugin/second"
      },
      ownerFile,
      { isPidRunning }
    );

    assert.equal(blocked.acquired, false);
    assert.equal(blocked.owner?.repoRoot, "/repo/first");
  });
});

test("claimGlobalControllerOwner clears stale owners before granting a new claim", async () => {
  await withTempOwnerFile(async (ownerFile) => {
    await fs.writeFile(
      ownerFile,
      JSON.stringify({
        pid: 999_999,
        repoRoot: "/repo/stale",
        pluginRoot: "/plugin/stale",
        startedAt: new Date().toISOString()
      })
    );

    const claimed = await claimGlobalControllerOwner(
      {
        pid: process.pid,
        repoRootPath: "/repo/current",
        pluginRootPath: "/plugin/current"
      },
      ownerFile,
      { isPidRunning }
    );

    assert.equal(claimed.acquired, true);
    assert.equal(claimed.owner.repoRoot, "/repo/current");
    assert.equal(
      (await getGlobalControllerOwner(ownerFile, { isPidRunning }))?.pid,
      process.pid
    );
  });
});

test("releaseGlobalControllerOwner only removes the lock for the owner pid", async () => {
  await withTempOwnerFile(async (ownerFile) => {
    await claimGlobalControllerOwner(
      {
        pid: process.pid,
        repoRootPath: "/repo/current",
        pluginRootPath: "/plugin/current"
      },
      ownerFile,
      { isPidRunning }
    );

    assert.equal(
      await releaseGlobalControllerOwner(
        { pid: process.pid + 100_000 },
        ownerFile,
        { isPidRunning }
      ),
      false
    );
    assert.equal(
      (await getGlobalControllerOwner(ownerFile, { isPidRunning }))?.pid,
      process.pid
    );

    assert.equal(
      await releaseGlobalControllerOwner({ pid: process.pid }, ownerFile, { isPidRunning }),
      true
    );
    assert.equal(await getGlobalControllerOwner(ownerFile, { isPidRunning }), null);
  });
});

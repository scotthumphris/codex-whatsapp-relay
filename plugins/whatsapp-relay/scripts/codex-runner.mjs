import { spawn } from "node:child_process";

const CLIENT_INFO = {
  name: "whatsapp-relay",
  title: "WhatsApp Relay",
  version: "0.1.0"
};

const OPT_OUT_NOTIFICATIONS = [
  "account/rateLimits/updated",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "mcpServer/startupStatus/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated"
];

function configArgs({ model, profile, search, fullAuto }) {
  const args = ["app-server"];

  if (profile) {
    args.push("-c", `profile=${JSON.stringify(profile)}`);
  }

  if (model) {
    args.push("-c", `model=${JSON.stringify(model)}`);
  }

  if (search) {
    args.push("-c", 'web_search="live"');
  }

  if (fullAuto !== false) {
    args.push("-c", 'approval_policy="never"');
    args.push("-c", 'sandbox_mode="workspace-write"');
  }

  return args;
}

function buildPromptInput(prompt) {
  return [
    {
      type: "text",
      text: prompt,
      text_elements: []
    }
  ];
}

function formatRequestError(message = "Unknown app-server error.") {
  return new Error(message);
}

function formatTurnError(turnError) {
  if (!turnError) {
    return new Error("Codex turn failed.");
  }

  const parts = [turnError.message];
  if (turnError.additionalDetails) {
    parts.push(turnError.additionalDetails);
  }

  return new Error(parts.filter(Boolean).join("\n\n") || "Codex turn failed.");
}

export function startCodexTurn({
  codexBin,
  workspace,
  prompt,
  threadId = null,
  threadName = null,
  model = null,
  profile = null,
  search = false,
  fullAuto = true
}) {
  if (!prompt?.trim()) {
    throw new Error("Codex prompt cannot be empty.");
  }

  const child = spawn(codexBin, configArgs({ model, profile, search, fullAuto }), {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  let nextRequestId = 0;
  let resolvedThreadId = threadId;
  let activeTurnId = null;
  let settled = false;
  let exiting = false;
  let shutdownPromise = null;
  let stderr = "";
  let fallbackReply = "";
  let finalReply = "";

  const pendingRequests = new Map();
  const agentMessages = new Map();

  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  function cleanupRequest(requestId) {
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    return pending;
  }

  function settle(type, value) {
    if (settled) {
      return;
    }

    settled = true;
    if (type === "resolve") {
      resolveResult(value);
    } else {
      rejectResult(value);
    }
  }

  function shutdown(signal = "SIGTERM") {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      if (exiting) {
        return;
      }

      exiting = true;
      child.stdin.end();
      if (!child.killed) {
        child.kill(signal);
      }
    })();

    return shutdownPromise;
  }

  function rejectPending(error) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function handleAgentMessage(item) {
    const existing = agentMessages.get(item.id) ?? {
      phase: item.phase ?? null,
      text: ""
    };
    const text = item.text || existing.text;
    agentMessages.set(item.id, {
      phase: item.phase ?? existing.phase ?? null,
      text
    });

    if (!fallbackReply && text.trim()) {
      fallbackReply = text;
    }

    if (item.phase === "final_answer" && text.trim()) {
      finalReply = text;
    }
  }

  function handleNotification(message) {
    const { method, params } = message;
    if (!params) {
      return;
    }

    switch (method) {
      case "item/started":
        if (params.turnId !== activeTurnId || params.item?.type !== "agentMessage") {
          return;
        }

        agentMessages.set(params.item.id, {
          phase: params.item.phase ?? null,
          text: params.item.text ?? ""
        });
        return;
      case "item/agentMessage/delta": {
        if (params.turnId !== activeTurnId) {
          return;
        }

        const current = agentMessages.get(params.itemId) ?? {
          phase: null,
          text: ""
        };
        current.text += params.delta;
        agentMessages.set(params.itemId, current);
        return;
      }
      case "item/completed":
        if (params.turnId !== activeTurnId || params.item?.type !== "agentMessage") {
          return;
        }

        handleAgentMessage(params.item);
        return;
      case "turn/completed":
        if (params.turn.id !== activeTurnId) {
          return;
        }

        if (params.turn.status === "failed") {
          settle("reject", formatTurnError(params.turn.error));
        } else if (params.turn.status === "interrupted") {
          settle("reject", new Error("Codex run was interrupted."));
        } else {
          settle("resolve", {
            threadId: resolvedThreadId,
            replyText: finalReply || fallbackReply || "Codex completed without a final message."
          });
        }

        shutdown().catch(() => {});
        return;
      case "error":
        if (params.turnId !== activeTurnId && params.threadId !== resolvedThreadId) {
          return;
        }

        if (!params.willRetry) {
          settle("reject", formatTurnError(params.error));
          shutdown().catch(() => {});
        }
        return;
      default:
        return;
    }
  }

  function handleMessage(rawLine) {
    if (!rawLine.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      return;
    }

    if ("id" in message) {
      const pending = cleanupRequest(message.id);
      if (!pending) {
        return;
      }

      if (message.error) {
        pending.reject(formatRequestError(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      handleNotification(message);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleMessage(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.once("error", (error) => {
    rejectPending(error);
    settle("reject", error);
  });

  child.once("close", (code, signal) => {
    if (buffer.trim()) {
      handleMessage(buffer);
      buffer = "";
    }

    if (settled) {
      return;
    }

    rejectPending(
      new Error(signal ? `Codex app-server exited with signal ${signal}.` : "Codex app-server exited.")
    );

    const message =
      stderr.trim() ||
      (signal
        ? `Codex app-server exited with signal ${signal}.`
        : `Codex app-server exited with code ${code}.`);
    settle("reject", new Error(message));
  });

  function request(method, params) {
    const requestId = ++nextRequestId;
    const payload = JSON.stringify({
      id: requestId,
      method,
      params
    });

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, {
        resolve,
        reject
      });

      child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        cleanupRequest(requestId);
        reject(error);
      });
    });
  }

  const bootstrap = (async () => {
    await request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: OPT_OUT_NOTIFICATIONS
      }
    });

    const threadResult = threadId
      ? await request("thread/resume", {
          threadId,
          cwd: workspace,
          ...(model ? { model } : {}),
          ...(fullAuto !== false ? { approvalPolicy: "never" } : {}),
          persistExtendedHistory: false
        })
      : await request("thread/start", {
          cwd: workspace,
          ...(model ? { model } : {}),
          ...(fullAuto !== false ? { approvalPolicy: "never" } : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: false
        });

    resolvedThreadId = threadResult.thread.id;

    if (threadName?.trim()) {
      await request("thread/name/set", {
        threadId: resolvedThreadId,
        name: threadName.trim()
      }).catch(() => {});
    }

    const turnResult = await request("turn/start", {
      threadId: resolvedThreadId,
      input: buildPromptInput(prompt),
      cwd: workspace,
      ...(model ? { model } : {}),
      ...(fullAuto !== false ? { approvalPolicy: "never" } : {})
    });

    activeTurnId = turnResult.turn.id;
  })();

  bootstrap.catch((error) => {
    settle("reject", error);
    shutdown().catch(() => {});
  });

  resultPromise
    .finally(() => {
      shutdown().catch(() => {});
    })
    .catch(() => {});

  return {
    child,
    interrupt: async () => {
      try {
        await bootstrap;
      } catch {
        await shutdown("SIGKILL");
        return;
      }

      if (!resolvedThreadId || !activeTurnId) {
        await shutdown("SIGKILL");
        return;
      }

      try {
        await request("turn/interrupt", {
          threadId: resolvedThreadId,
          turnId: activeTurnId
        });
      } catch {
        await shutdown("SIGKILL");
        return;
      }

      await shutdown();
    },
    resultPromise
  };
}

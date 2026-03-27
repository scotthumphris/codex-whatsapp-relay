import { setTimeout as delay } from "node:timers/promises";

import { startCodexTurn } from "./codex-runner.mjs";
import {
  ControllerConfigStore,
  resolvePhoneKeyFromJid
} from "./controller-config.mjs";
import { drainControllerCommands } from "./controller-outbox.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { extractMessageText } from "./store.mjs";

const MAX_WHATSAPP_MESSAGE = 3500;
const HEARTBEAT_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 500;
const OUTBOX_POLL_MS = 1_000;

function normalizeTimestamp(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object") {
    if (typeof value.low === "number") {
      return value.low;
    }

    if (typeof value.toNumber === "function") {
      return value.toNumber();
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitMessage(text, limit = MAX_WHATSAPP_MESSAGE) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= limit) {
    return [trimmed];
  }

  const parts = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    let index = remaining.lastIndexOf("\n", limit);
    if (index < limit / 2) {
      index = remaining.lastIndexOf(" ", limit);
    }
    if (index < limit / 2) {
      index = limit;
    }

    parts.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function shortThreadId(threadId) {
  return threadId ? threadId.slice(0, 8) : "none";
}

function buildThreadName({ label, phoneKey }) {
  const base = String(label ?? "").trim() || phoneKey;
  const normalized = base.replace(/\s+/g, " ").trim();
  return `WhatsApp: ${normalized}`.slice(0, 120);
}

function helpText() {
  return [
    "WhatsApp Codex bridge commands:",
    "/status -> show the current Codex session",
    "/new [prompt] -> start a fresh session, optionally with a first prompt",
    "/stop -> stop the in-flight Codex run for this chat",
    "/help -> show this help",
    "",
    "Any other text in this direct chat continues your current Codex session."
  ].join("\n");
}

function parseIncomingCommand(text, captureAllDirectMessages) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { type: "empty" };
  }

  const commandMatch = trimmed.match(/^\/([a-z]+)(?:\s+([\s\S]+))?$/i);
  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const payload = commandMatch[2]?.trim() ?? "";

    switch (command) {
      case "help":
        return { type: "help" };
      case "status":
        return { type: "status" };
      case "new":
      case "reset":
        return { type: "new", prompt: payload };
      case "stop":
        return { type: "stop" };
      case "codex":
      case "ask":
        return payload ? { type: "prompt", prompt: payload } : { type: "help" };
      default:
        return { type: "unknown" };
    }
  }

  if (captureAllDirectMessages) {
    return { type: "prompt", prompt: trimmed };
  }

  return { type: "ignored" };
}

export class WhatsAppControllerBridge {
  constructor({
    runtime,
    configStore = new ControllerConfigStore(),
    stateStore = new ControllerStateStore()
  }) {
    this.runtime = runtime;
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.started = false;
    this.startedAtMs = null;
    this.heartbeat = null;
    this.outboxPoller = null;
    this.processingOutbox = false;
    this.activeRuns = new Map();
    this.recentMessageIds = [];
    this.recentMessageSet = new Set();
    this.recentOutgoingIds = [];
    this.recentOutgoingSet = new Set();
    this.unsubscribers = [];
  }

  async initialize() {
    await this.configStore.load();
    await this.stateStore.load();
  }

  async start() {
    await this.initialize();
    const config = this.configStore.data;

    if (!config.enabled) {
      throw new Error("Controller bridge is disabled. Enable it before starting.");
    }

    if (!config.allowedControllers.length) {
      throw new Error("No allowed controller numbers are configured yet.");
    }

    if (!this.runtime.hasSavedCreds()) {
      throw new Error("WhatsApp is not authenticated yet. Run `whatsapp_start_auth` first.");
    }

    if (this.started) {
      return this.summary();
    }

    this.started = true;
    this.startedAtMs = Date.now();

    this.unsubscribers.push(
      this.runtime.on("messages.upsert", (payload) => {
        this.handleMessagesUpsert(payload).catch((error) => {
          console.error("failed to handle WhatsApp controller message", error);
        });
      })
    );

    this.unsubscribers.push(
      this.runtime.on("connection.update", () => {
        this.touchHeartbeat().catch((error) => {
          console.error("failed to update WhatsApp controller heartbeat", error);
        });
      })
    );

    await this.runtime.start({ printQrToTerminal: false });
    await this.stateStore.setProcess({
      pid: process.pid,
      status: "running",
      startedAt: new Date(this.startedAtMs).toISOString(),
      heartbeatAt: new Date().toISOString()
    });

    this.heartbeat = setInterval(() => {
      this.touchHeartbeat().catch((error) => {
        console.error("failed to write WhatsApp controller heartbeat", error);
      });
    }, HEARTBEAT_MS);

    await this.processOutbox();
    this.outboxPoller = setInterval(() => {
      this.processOutbox().catch((error) => {
        console.error("failed to process WhatsApp controller outbox", error);
      });
    }, OUTBOX_POLL_MS);

    return this.summary();
  }

  async stop({ clearProcess = true } = {}) {
    this.started = false;

    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    if (this.outboxPoller) {
      clearInterval(this.outboxPoller);
      this.outboxPoller = null;
    }

    for (const [phoneKey, run] of this.activeRuns.entries()) {
      await run.interrupt().catch(() => {
        if (!run.child.killed) {
          run.child.kill("SIGTERM");
        }
      });
      this.activeRuns.delete(phoneKey);
    }

    if (clearProcess) {
      await this.stateStore.clearProcess();
    }
  }

  async touchHeartbeat() {
    await this.stateStore.setProcess({
      pid: process.pid,
      status: "running",
      heartbeatAt: new Date().toISOString(),
      whatsappStatus: this.runtime.summary().status,
      whatsappUserId: this.runtime.summary().user?.id ?? null,
      whatsappLastDisconnect: this.runtime.summary().lastDisconnect ?? null
    });
  }

  summary() {
    const sessions = this.stateStore.listSessions().map((session) => ({
      phoneKey: session.phoneKey,
      label: session.label ?? null,
      threadId: session.threadId ?? null,
      busy: this.activeRuns.has(session.phoneKey),
      lastPromptAt: session.lastPromptAt ?? null,
      lastReplyAt: session.lastReplyAt ?? null
    }));

    return {
      started: this.started,
      process: this.stateStore.data.process,
      config: this.configStore.data,
      sessions
    };
  }

  async processOutbox() {
    if (this.processingOutbox) {
      return;
    }

    this.processingOutbox = true;
    try {
      await drainControllerCommands(async (command) => {
        await this.handleOutboxCommand(command);
      });
    } finally {
      this.processingOutbox = false;
    }
  }

  async handleOutboxCommand(command = {}) {
    switch (command.type) {
      case "send_message":
        await this.sendTextMessage(command.payload.chatId, command.payload.text);
        return;
      default:
        throw new Error(`Unknown controller command type: ${command.type}`);
    }
  }

  rememberMessage(messageId) {
    if (!messageId || this.recentMessageSet.has(messageId)) {
      return false;
    }

    this.recentMessageSet.add(messageId);
    this.recentMessageIds.push(messageId);

    if (this.recentMessageIds.length > RECENT_MESSAGE_LIMIT) {
      const stale = this.recentMessageIds.shift();
      this.recentMessageSet.delete(stale);
    }

    return true;
  }

  rememberOutgoingMessage(messageId) {
    if (!messageId || this.recentOutgoingSet.has(messageId)) {
      return;
    }

    this.recentOutgoingSet.add(messageId);
    this.recentOutgoingIds.push(messageId);

    if (this.recentOutgoingIds.length > RECENT_MESSAGE_LIMIT) {
      const stale = this.recentOutgoingIds.shift();
      this.recentOutgoingSet.delete(stale);
    }
  }

  async handleMessagesUpsert(payload = {}) {
    if (payload.type && !["notify", "append"].includes(payload.type)) {
      return;
    }

    for (const message of payload.messages ?? []) {
      await this.handleIncomingMessage(message);
    }
  }

  async handleIncomingMessage(message) {
    const remoteJid = message?.key?.remoteJid;
    const messageId = message?.key?.id ?? null;
    const fromMe = Boolean(message?.key?.fromMe);

    if (!remoteJid || remoteJid.endsWith("@g.us")) {
      return;
    }

    if (fromMe && this.recentOutgoingSet.has(messageId)) {
      return;
    }

    if (!this.rememberMessage(messageId)) {
      return;
    }

    const timestamp = normalizeTimestamp(message.messageTimestamp);
    if (
      timestamp &&
      this.startedAtMs &&
      timestamp * 1000 < this.startedAtMs - 10_000
    ) {
      return;
    }

    const config = await this.configStore.load();
    const [controller, phoneKey] = await Promise.all([
      this.configStore.findControllerByJid(remoteJid),
      resolvePhoneKeyFromJid(remoteJid)
    ]);
    if (!config.enabled || !controller) {
      return;
    }

    if (!phoneKey) {
      return;
    }

    if (fromMe && phoneKey !== controller.phoneKey) {
      return;
    }

    const text = extractMessageText(message.message).trim();
    const session = this.stateStore.data.sessions[phoneKey] ?? {};

    await this.stateStore.upsertSession(phoneKey, {
      phoneKey,
      remoteJid,
      label: controller.label ?? message.pushName ?? null,
      lastInboundAt: new Date().toISOString(),
      lastInboundText: text || `[${message.key?.id ?? "message"}]`
    });

    if (!text) {
      await this.sendReply(
        remoteJid,
        "Only text messages are supported for Codex control right now."
      );
      return;
    }

    const command = parseIncomingCommand(text, config.captureAllDirectMessages);

    switch (command.type) {
      case "empty":
      case "ignored":
        return;
      case "help":
        await this.sendReply(remoteJid, helpText());
        return;
      case "unknown":
        await this.sendReply(
          remoteJid,
          `Unknown command.\n\n${helpText()}`
        );
        return;
      case "status":
        await this.sendReply(remoteJid, this.renderSessionStatus(phoneKey, session));
        return;
      case "stop":
        await this.stopActiveRun(phoneKey, remoteJid);
        return;
      case "new":
        await this.stateStore.removeSession(phoneKey);
        if (command.prompt) {
          await this.runPrompt({
            phoneKey,
            remoteJid,
            prompt: command.prompt,
            forceNewThread: true,
            label: controller.label ?? message.pushName ?? null
          });
        } else {
          await this.sendReply(
            remoteJid,
            "Started a fresh Codex session for this chat. Send the next message when you want me to do something."
          );
        }
        return;
      case "prompt":
        await this.runPrompt({
          phoneKey,
          remoteJid,
          prompt: command.prompt,
          forceNewThread: false,
          label: controller.label ?? message.pushName ?? null
        });
        return;
      default:
        return;
    }
  }

  renderSessionStatus(phoneKey, session = this.stateStore.data.sessions[phoneKey] ?? {}) {
    const active = this.activeRuns.get(phoneKey);
    return [
      "WhatsApp Codex bridge",
      `session: ${shortThreadId(session.threadId ?? null)}`,
      `busy: ${active ? "yes" : "no"}`,
      `workspace: ${this.configStore.data.workspace}`,
      session.lastPromptAt ? `last_prompt_at: ${session.lastPromptAt}` : null,
      session.lastReplyAt ? `last_reply_at: ${session.lastReplyAt}` : null,
      "",
      "Commands: /new, /status, /stop, /help"
    ]
      .filter(Boolean)
      .join("\n");
  }

  async stopActiveRun(phoneKey, remoteJid) {
    const active = this.activeRuns.get(phoneKey);
    if (!active) {
      await this.sendReply(remoteJid, "No Codex run is active for this chat.");
      return;
    }

    active.cancelled = true;
    await active.interrupt().catch(() => {
      if (!active.child.killed) {
        active.child.kill("SIGTERM");
      }
    });
    await delay(300);
    if (!active.child.killed) {
      active.child.kill("SIGKILL");
    }

    this.activeRuns.delete(phoneKey);
    await this.sendReply(
      remoteJid,
      "Stopped the active Codex run for this chat."
    );
  }

  async runPrompt({ phoneKey, remoteJid, prompt, forceNewThread, label }) {
    const active = this.activeRuns.get(phoneKey);
    if (active) {
      await this.sendReply(
        remoteJid,
        `Codex is already working on your previous request in session ${shortThreadId(
          active.threadId ?? null
        )}. Send /stop to cancel it first.`
      );
      return;
    }

    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const config = this.configStore.data;
    const existingThreadId = forceNewThread ? null : session.threadId ?? null;
    const { child, interrupt, resultPromise } = startCodexTurn({
      codexBin: config.codexBin,
      workspace: config.workspace,
      prompt,
      threadId: existingThreadId,
      threadName: buildThreadName({
        label,
        phoneKey
      }),
      model: config.model,
      profile: config.profile,
      search: config.search,
      fullAuto: config.fullAuto
    });

    const activeRun = {
      child,
      interrupt,
      threadId: existingThreadId,
      startedAt: new Date().toISOString(),
      cancelled: false
    };
    this.activeRuns.set(phoneKey, activeRun);

    await this.stateStore.upsertSession(phoneKey, {
      ...session,
      phoneKey,
      remoteJid,
      label,
      lastPromptAt: new Date().toISOString(),
      lastPromptText: prompt,
      threadId: existingThreadId
    });

    await this.sendReply(
      remoteJid,
      existingThreadId
        ? `Continuing Codex session ${shortThreadId(existingThreadId)}.`
        : "Starting a fresh Codex session for this chat."
    );

    try {
      const result = await resultPromise;
      this.activeRuns.delete(phoneKey);

      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        phoneKey,
        remoteJid,
        label,
        threadId: result.threadId,
        lastReplyAt: new Date().toISOString(),
        lastReplyPreview: result.replyText.slice(0, 200)
      });

      await this.sendReply(
        remoteJid,
        [
          `Session ${shortThreadId(result.threadId)}:`,
          "",
          result.replyText
        ].join("\n")
      );
    } catch (error) {
      this.activeRuns.delete(phoneKey);
      if (activeRun.cancelled) {
        return;
      }

      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        phoneKey,
        remoteJid,
        label,
        lastErrorAt: new Date().toISOString(),
        lastError: error.message
      });

      await this.sendReply(
        remoteJid,
        `Codex run failed: ${error.message}`
      );
    }
  }

  async sendReply(remoteJid, text) {
    await this.sendTextMessage(remoteJid, text);
  }

  async sendTextMessage(chatId, text) {
    const socket = await this.runtime.ensureConnected();

    for (const part of splitMessage(text)) {
      const sent = await socket.sendMessage(chatId, { text: part });
      this.rememberOutgoingMessage(sent?.key?.id ?? null);
    }
  }
}

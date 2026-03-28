import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TRANSCRIPTION_MODEL =
  process.env.WHATSAPP_RELAY_STT_MODEL ?? "mlx-community/parakeet-tdt-0.6b-v3";

const DEFAULT_TIMEOUT_MS = resolveTimeoutMs(
  process.env.WHATSAPP_RELAY_STT_TIMEOUT_MS,
  8 * 60 * 1000
);

function resolveTimeoutMs(value, fallbackMs) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return ".mp3";
  }
  if (normalized.includes("wav") || normalized.includes("wave")) {
    return ".wav";
  }
  if (normalized.includes("aac")) {
    return ".aac";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return ".m4a";
  }
  return ".audio";
}

function summarizeCommand(command, args) {
  return [command, ...args].join(" ");
}

function summarizeFailure(command, args, stderr, stdout, signal, code) {
  const output = [String(stderr ?? "").trim(), String(stdout ?? "").trim()]
    .filter(Boolean)
    .join("\n");
  const exitText = signal ? `signal ${signal}` : `exit code ${code}`;
  const preview = output ? `\n${output.slice(0, 800)}` : "";
  return `Command failed (${exitText}): ${summarizeCommand(command, args)}${preview}`;
}

async function runCommand(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let closed = false;
    let timeout = null;

    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 250).unref();
      }, timeoutMs);
      timeout.unref();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      closed = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (timedOut) {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms: ${summarizeCommand(command, args)}`
          )
        );
        return;
      }

      if (code !== 0) {
        reject(new Error(summarizeFailure(command, args, stderr, stdout, signal, code)));
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
  });
}

function normalizeSentence(sentence = {}) {
  return {
    text: String(sentence.text ?? "").trim(),
    start: Number.isFinite(sentence.start) ? sentence.start : null,
    end: Number.isFinite(sentence.end) ? sentence.end : null,
    duration: Number.isFinite(sentence.duration) ? sentence.duration : null,
    confidence: Number.isFinite(sentence.confidence) ? sentence.confidence : null
  };
}

function summarizeConfidence(sentences) {
  const confidences = sentences
    .map((sentence) => sentence.confidence)
    .filter((value) => Number.isFinite(value));

  if (!confidences.length) {
    return {
      avgConfidence: null,
      minConfidence: null
    };
  }

  const total = confidences.reduce((sum, value) => sum + value, 0);
  return {
    avgConfidence: total / confidences.length,
    minConfidence: Math.min(...confidences)
  };
}

export async function transcribeVoiceNote({
  audioBuffer,
  mimeType,
  model = DEFAULT_TRANSCRIPTION_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? "");
  if (!buffer.length) {
    throw new Error("Voice note is empty.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-stt-"));
  try {
    const sourceFile = path.join(tempDir, `voice-note${extensionForMimeType(mimeType)}`);
    const normalizedFile = path.join(tempDir, "voice-note.wav");
    const outputDir = path.join(tempDir, "output");
    const transcriptFile = path.join(outputDir, "transcript.json");

    await fs.writeFile(sourceFile, buffer);
    await fs.mkdir(outputDir, { recursive: true });

    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourceFile,
        "-ac",
        "1",
        "-ar",
        "16000",
        normalizedFile
      ],
      { timeoutMs }
    );

    await runCommand(
      "uvx",
      [
        "--from",
        "parakeet-mlx",
        "parakeet-mlx",
        normalizedFile,
        "--model",
        model,
        "--output-format",
        "json",
        "--output-dir",
        outputDir,
        "--output-template",
        "transcript"
      ],
      { timeoutMs }
    );

    const rawTranscript = await fs.readFile(transcriptFile, "utf8");
    const parsed = JSON.parse(rawTranscript);
    const transcript = String(parsed.text ?? "").trim();
    if (!transcript) {
      throw new Error("Voice note transcription was empty.");
    }

    const sentences = Array.isArray(parsed.sentences)
      ? parsed.sentences.map(normalizeSentence)
      : [];
    const confidenceSummary = summarizeConfidence(sentences);

    return {
      transcript,
      sentences,
      model,
      mimeType: String(mimeType ?? "") || null,
      ...confidenceSummary
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

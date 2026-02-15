import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";
import { TELETON_ROOT } from "../workspace/paths.js";

const SESSIONS_DIR = join(TELETON_ROOT, "sessions");

export function getTranscriptPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

export function appendToTranscript(sessionId: string, message: Message | AssistantMessage): void {
  ensureSessionsDir();

  const transcriptPath = getTranscriptPath(sessionId);
  const line = JSON.stringify(message) + "\n";

  try {
    appendFileSync(transcriptPath, line, "utf-8");
  } catch (error) {
    console.error(`Failed to append to transcript ${sessionId}:`, error);
  }
}

function extractToolCallIds(msg: Message | AssistantMessage): Set<string> {
  const ids = new Set<string>();
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      const blockType = (block as any).type;
      if (blockType === "toolCall" || blockType === "tool_use") {
        const id = (block as any).id || (block as any).toolCallId || (block as any).tool_use_id;
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Sanitize messages to remove orphaned or out-of-order toolResults.
 * Anthropic API requires tool_results IMMEDIATELY follow their corresponding tool_use.
 * Removes: 1) tool_results referencing non-existent tool_uses, 2) out-of-order tool_results.
 */
function sanitizeMessages(
  messages: (Message | AssistantMessage)[]
): (Message | AssistantMessage)[] {
  const sanitized: (Message | AssistantMessage)[] = [];
  let pendingToolCallIds = new Set<string>(); // IDs waiting for their results
  let removedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      const newToolIds = extractToolCallIds(msg);

      if (pendingToolCallIds.size > 0 && newToolIds.size > 0) {
        console.warn(
          `⚠️ Found ${pendingToolCallIds.size} pending tool results that were never received`
        );
      }

      pendingToolCallIds = newToolIds;
      sanitized.push(msg);
    } else if (msg.role === "toolResult" || (msg as any).role === "tool_result") {
      const toolCallId =
        (msg as any).toolCallId || (msg as any).tool_use_id || (msg as any).tool_call_id;

      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        pendingToolCallIds.delete(toolCallId);
        sanitized.push(msg);
      } else {
        removedCount++;
        console.warn(
          `🧹 Removing out-of-order/orphaned toolResult: ${toolCallId?.slice(0, 20)}...`
        );
        continue;
      }
    } else if (msg.role === "user") {
      if (pendingToolCallIds.size > 0) {
        console.warn(
          `⚠️ User message arrived while ${pendingToolCallIds.size} tool results pending - marking them as orphaned`
        );
        pendingToolCallIds.clear();
      }
      sanitized.push(msg);
    } else {
      sanitized.push(msg);
    }
  }

  if (removedCount > 0) {
    console.log(`🧹 Sanitized ${removedCount} orphaned/out-of-order toolResult(s) from transcript`);
  }

  return sanitized;
}

export function readTranscript(sessionId: string): (Message | AssistantMessage)[] {
  const transcriptPath = getTranscriptPath(sessionId);

  if (!existsSync(transcriptPath)) {
    return [];
  }

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    let corruptCount = 0;
    const messages = lines
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          corruptCount++;
          console.warn(`⚠️ Skipping corrupt line ${i + 1} in transcript ${sessionId}`);
          return null;
        }
      })
      .filter(Boolean);

    if (corruptCount > 0) {
      console.warn(`⚠️ ${corruptCount} corrupt line(s) skipped in transcript ${sessionId}`);
    }

    return sanitizeMessages(messages);
  } catch (error) {
    console.error(`Failed to read transcript ${sessionId}:`, error);
    return [];
  }
}

export function transcriptExists(sessionId: string): boolean {
  return existsSync(getTranscriptPath(sessionId));
}

export function getTranscriptSize(sessionId: string): number {
  try {
    const messages = readTranscript(sessionId);
    return messages.length;
  } catch {
    return 0;
  }
}

export function deleteTranscript(sessionId: string): boolean {
  const transcriptPath = getTranscriptPath(sessionId);

  if (!existsSync(transcriptPath)) {
    return false;
  }

  try {
    unlinkSync(transcriptPath);
    console.log(`🗑️ Deleted transcript: ${sessionId}`);
    return true;
  } catch (error) {
    console.error(`Failed to delete transcript ${sessionId}:`, error);
    return false;
  }
}

/**
 * Archive a transcript (rename with timestamped .archived suffix).
 */
export function archiveTranscript(sessionId: string): boolean {
  const transcriptPath = getTranscriptPath(sessionId);
  const timestamp = Date.now();
  const archivePath = `${transcriptPath}.${timestamp}.archived`;

  if (!existsSync(transcriptPath)) {
    return false;
  }

  try {
    renameSync(transcriptPath, archivePath);
    console.log(`📦 Archived transcript: ${sessionId} → ${timestamp}.archived`);
    return true;
  } catch (error) {
    console.error(`Failed to archive transcript ${sessionId}:`, error);
    return false;
  }
}

/**
 * Delete transcript and archived files older than maxAgeDays.
 */
export function cleanupOldTranscripts(maxAgeDays: number = 30): number {
  if (!existsSync(SESSIONS_DIR)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".jsonl") && !file.endsWith(".archived")) continue;
      const filePath = join(SESSIONS_DIR, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < cutoff) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {}
    }
  } catch (error) {
    console.error("Failed to cleanup old transcripts:", error);
  }

  if (deleted > 0) {
    console.log(`🧹 Cleaned up ${deleted} transcript(s) older than ${maxAgeDays} days`);
  }

  return deleted;
}

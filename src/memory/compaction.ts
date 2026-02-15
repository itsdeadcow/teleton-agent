import type { Context, Message } from "@mariozechner/pi-ai";
import { appendToTranscript, readTranscript } from "../session/transcript.js";
import { randomUUID } from "crypto";
import { writeSummaryToDailyLog } from "./daily-logs.js";
import { summarizeWithFallback } from "./ai-summarization.js";
import { saveSessionMemory } from "../session/memory-hook.js";
import { encodingForModel } from "js-tiktoken";
import type { SupportedProvider } from "../config/providers.js";
import { COMPACTION_MAX_MESSAGES, COMPACTION_KEEP_RECENT } from "../constants/limits.js";

export interface CompactionConfig {
  enabled: boolean;
  maxMessages?: number; // Trigger compaction after N messages
  maxTokens?: number; // Trigger compaction after N tokens (estimated)
  keepRecentMessages?: number; // Number of recent messages to preserve
  memoryFlushEnabled?: boolean; // Write memory to daily log before compaction
  softThresholdTokens?: number; // Token count to trigger pre-compaction flush
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  maxMessages: COMPACTION_MAX_MESSAGES,
  maxTokens: 96_000,
  keepRecentMessages: COMPACTION_KEEP_RECENT,
  memoryFlushEnabled: true,
  softThresholdTokens: 64_000,
};
let tokenizer: ReturnType<typeof encodingForModel> | null = null;

function getTokenizer() {
  if (!tokenizer) {
    tokenizer = encodingForModel("gpt-4");
  }
  return tokenizer;
}

function estimateTokens(content: string): number {
  try {
    const enc = getTokenizer();
    return enc.encode(content).length;
  } catch (error) {
    console.warn("Token encoding failed, using fallback:", error);
    return Math.ceil(content.length / 4);
  }
}

function calculateContextTokens(context: Context): number {
  let total = 0;

  if (context.systemPrompt) {
    total += estimateTokens(context.systemPrompt);
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      total += estimateTokens(message.content as string);
    } else if (message.role === "assistant") {
      const content = message.content as Array<{ type: string; text?: string }>;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          total += estimateTokens(block.text);
        }
      }
    }
  }

  return total;
}

export function shouldFlushMemory(
  context: Context,
  config: CompactionConfig,
  tokenCount?: number
): boolean {
  if (!config.enabled || !config.memoryFlushEnabled) {
    return false;
  }

  const tokens = tokenCount ?? calculateContextTokens(context);
  const softThreshold = config.softThresholdTokens ?? 6000;

  if (tokens >= softThreshold) {
    console.log(`💾 Memory flush needed: ~${tokens} tokens (soft threshold: ${softThreshold})`);
    return true;
  }

  return false;
}

function flushMemoryToDailyLog(context: Context): void {
  const recentMessages = context.messages.slice(-5);
  const summary: string[] = [];

  summary.push("**Recent Context:**\n");

  for (const msg of recentMessages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "[complex content]";
      summary.push(`- User: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`);
    } else if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((b: any) => b.type === "text");
      if (textBlocks.length > 0) {
        const text = (textBlocks[0] as any).text || "";
        summary.push(`- Assistant: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);
      }
    }
  }

  writeSummaryToDailyLog(summary.join("\n"));
  console.log(`✅ Memory flushed to daily log`);
}

export function shouldCompact(
  context: Context,
  config: CompactionConfig,
  tokenCount?: number
): boolean {
  if (!config.enabled) {
    return false;
  }

  const messageCount = context.messages.length;

  if (config.maxMessages && messageCount >= config.maxMessages) {
    console.log(`⚠️  Compaction needed: ${messageCount} messages (max: ${config.maxMessages})`);
    return true;
  }

  if (config.maxTokens) {
    const tokens = tokenCount ?? calculateContextTokens(context);
    if (tokens >= config.maxTokens) {
      console.log(`⚠️  Compaction needed: ~${tokens} tokens (max: ${config.maxTokens})`);
      return true;
    }
  }

  return false;
}

/**
 * Compact context by AI-summarizing old messages.
 * Preserves recent messages and replaces old ones with a summary.
 */
export async function compactContext(
  context: Context,
  config: CompactionConfig,
  apiKey: string,
  provider?: SupportedProvider,
  utilityModel?: string
): Promise<Context> {
  const keepCount = config.keepRecentMessages ?? 10;

  if (context.messages.length <= keepCount) {
    return context;
  }

  let cutIndex = context.messages.length - keepCount;
  const collectToolUseIds = (msgs: Message[]): Set<string> => {
    const ids = new Set<string>();
    for (const msg of msgs) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type === "toolCall" || block.type === "tool_use") {
            const id = block.id || block.toolCallId;
            if (id) ids.add(id);
          }
        }
      }
    }
    return ids;
  };

  const hasOrphanedToolResults = (msgs: Message[]): boolean => {
    const toolUseIds = collectToolUseIds(msgs);
    for (const msg of msgs) {
      if (msg.role === "toolResult") {
        const toolCallId = (msg as any).toolCallId;
        if (toolCallId && !toolUseIds.has(toolCallId)) {
          return true;
        }
      }
    }
    return false;
  };

  let iterations = 0;
  while (cutIndex > 0 && iterations < 50) {
    const keptMessages = context.messages.slice(cutIndex);
    if (!hasOrphanedToolResults(keptMessages)) {
      break;
    }
    cutIndex--;
    iterations++;
  }

  if (hasOrphanedToolResults(context.messages.slice(cutIndex))) {
    console.warn(`⚠️ Compaction: couldn't find clean cut point, keeping all messages`);
    return context;
  }

  const recentMessages = context.messages.slice(cutIndex);
  const oldMessages = context.messages.slice(0, cutIndex);

  console.log(
    `🗜️  Compacting ${oldMessages.length} old messages, keeping ${recentMessages.length} recent (cut at clean boundary)`
  );

  try {
    const result = await summarizeWithFallback({
      messages: oldMessages,
      apiKey,
      contextWindow: config.maxTokens ?? 150000,
      maxSummaryTokens: 2000,
      customInstructions: `Output a structured summary using EXACTLY these sections:

## User Intent
What the user is trying to accomplish (1-2 sentences).

## Key Decisions
Bullet list of decisions made and commitments agreed upon.

## Important Context
Critical facts, preferences, constraints, or technical details needed for continuity.

## Actions Taken
What was done: tools used, messages sent, transactions made (with specific values/addresses if relevant).

## Open Items
Unfinished tasks, pending questions, or next steps.

Keep each section concise. Omit a section if empty. Preserve specific names, numbers, and identifiers.`,
      provider,
      utilityModel,
    });

    console.log(
      `  ✅ AI Summary: ${result.tokensUsed} tokens, ${result.chunksProcessed} chunks processed`
    );

    const summaryText = `[Auto-compacted ${oldMessages.length} messages]\n\n${result.summary}`;

    const summaryMessage: Message = {
      role: "user",
      content: summaryText,
      timestamp: oldMessages[0]?.timestamp ?? Date.now(),
    };

    return {
      ...context,
      messages: [summaryMessage, ...recentMessages],
    };
  } catch (error) {
    console.error("AI summarization failed, using fallback:", error);

    const summaryText = `[Auto-compacted: ${oldMessages.length} earlier messages from this conversation]`;

    const summaryMessage: Message = {
      role: "user",
      content: summaryText,
      timestamp: oldMessages[0]?.timestamp ?? Date.now(),
    };

    return {
      ...context,
      messages: [summaryMessage, ...recentMessages],
    };
  }
}

export async function compactAndSaveTranscript(
  sessionId: string,
  context: Context,
  config: CompactionConfig,
  apiKey: string,
  chatId?: string,
  provider?: SupportedProvider,
  utilityModel?: string
): Promise<string> {
  const newSessionId = randomUUID();

  console.log(`📝 Creating compacted transcript: ${sessionId} → ${newSessionId}`);

  if (chatId) {
    await saveSessionMemory({
      oldSessionId: sessionId,
      newSessionId,
      context,
      chatId,
      apiKey,
      provider,
      utilityModel,
    });
  }

  const compactedContext = await compactContext(context, config, apiKey, provider, utilityModel);

  for (const message of compactedContext.messages) {
    appendToTranscript(newSessionId, message);
  }

  return newSessionId;
}

export class CompactionManager {
  private config: CompactionConfig;

  constructor(config: CompactionConfig = DEFAULT_COMPACTION_CONFIG) {
    this.config = config;
  }

  async checkAndCompact(
    sessionId: string,
    context: Context,
    apiKey: string,
    chatId?: string,
    provider?: SupportedProvider,
    utilityModel?: string
  ): Promise<string | null> {
    const tokenCount = calculateContextTokens(context);

    if (shouldFlushMemory(context, this.config, tokenCount)) {
      flushMemoryToDailyLog(context);
    }

    if (!shouldCompact(context, this.config, tokenCount)) {
      return null;
    }

    if (this.config.memoryFlushEnabled) {
      flushMemoryToDailyLog(context);
    }

    console.log(`🗜️  Auto-compacting session ${sessionId}`);
    const newSessionId = await compactAndSaveTranscript(
      sessionId,
      context,
      this.config,
      apiKey,
      chatId,
      provider,
      utilityModel
    );
    console.log(`✅ Compaction complete: ${newSessionId}`);

    return newSessionId;
  }

  updateConfig(config: Partial<CompactionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): CompactionConfig {
    return { ...this.config };
  }
}

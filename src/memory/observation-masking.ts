import type { Message, ToolResultMessage, UserMessage, TextContent } from "@mariozechner/pi-ai";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { MASKING_KEEP_RECENT_COUNT } from "../constants/limits.js";

export interface MaskingConfig {
  keepRecentCount: number; // Keep the N most recent tool results complete
  keepErrorResults: boolean; // Always keep error results complete
}

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  keepRecentCount: MASKING_KEEP_RECENT_COUNT,
  keepErrorResults: true,
};

/** Detect Cocoon-style tool results (UserMessage with `<tool_response>` CDATA). */
const isCocoonToolResult = (msg: Message): boolean =>
  msg.role === "user" &&
  Array.isArray(msg.content) &&
  msg.content.some((c) => c.type === "text" && c.text.includes("<tool_response>"));

/**
 * Mask old tool results to reduce context size.
 * Replaces old results with compact summaries (~90% savings per result).
 */
export function maskOldToolResults(
  messages: Message[],
  config: MaskingConfig = DEFAULT_MASKING_CONFIG,
  toolRegistry?: ToolRegistry
): Message[] {
  const toolResults = messages
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => msg.role === "toolResult" || isCocoonToolResult(msg));

  if (toolResults.length <= config.keepRecentCount) {
    return messages;
  }

  const toMask = toolResults.slice(0, -config.keepRecentCount);
  const result = [...messages];

  for (const { msg, index } of toMask) {
    // Cocoon tool results — mask to a compact summary
    if (isCocoonToolResult(msg)) {
      result[index] = {
        ...msg,
        content: [{ type: "text" as const, text: "[Tool response masked]" }],
      } as UserMessage;
      continue;
    }

    const toolMsg = msg as ToolResultMessage;

    if (config.keepErrorResults && toolMsg.isError) {
      continue;
    }

    if (toolRegistry) {
      const category = toolRegistry.getToolCategory(toolMsg.toolName);
      if (category === "data-bearing") {
        continue;
      }
    }

    let summaryText = "";
    try {
      const textBlock = toolMsg.content.find((c): c is TextContent => c.type === "text");
      if (textBlock) {
        const parsed = JSON.parse(textBlock.text);
        if (parsed.data?.summary) {
          summaryText = ` - ${parsed.data.summary}`;
        } else if (parsed.data?.message) {
          summaryText = ` - ${parsed.data.message}`;
        }
      }
    } catch {}

    result[index] = {
      ...toolMsg,
      content: [
        {
          type: "text",
          text: `[Tool: ${toolMsg.toolName} - ${toolMsg.isError ? "ERROR" : "OK"}${summaryText}]`,
        },
      ],
    };
  }

  return result;
}

export function calculateMaskingSavings(
  originalMessages: Message[],
  maskedMessages: Message[]
): { originalChars: number; maskedChars: number; savings: number } {
  const countChars = (messages: Message[]): number => {
    let total = 0;
    for (const msg of messages) {
      if (msg.role === "toolResult" || isCocoonToolResult(msg)) {
        for (const block of msg.content) {
          if (typeof block !== "string" && block.type === "text") {
            total += block.text.length;
          }
        }
      }
    }
    return total;
  };

  const originalChars = countChars(originalMessages);
  const maskedChars = countChars(maskedMessages);

  return {
    originalChars,
    maskedChars,
    savings: originalChars - maskedChars,
  };
}

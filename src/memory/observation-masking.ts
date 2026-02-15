import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ToolRegistry } from "../agent/tools/registry.js";

export interface MaskingConfig {
  keepRecentCount: number; // Keep the N most recent tool results complete
  keepErrorResults: boolean; // Always keep error results complete
}

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  keepRecentCount: 10,
  keepErrorResults: true,
};

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
    .filter(({ msg }) => msg.role === "toolResult");

  if (toolResults.length <= config.keepRecentCount) {
    return messages;
  }

  const toMask = toolResults.slice(0, -config.keepRecentCount);
  const result = [...messages];

  for (const { msg, index } of toMask) {
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
      const content = toolMsg.content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((c) => c.type === "text");
      if (textBlock?.text) {
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
      if (msg.role === "toolResult") {
        const content = msg.content as Array<{ type: string; text?: string }>;
        for (const block of content) {
          if (block.type === "text" && block.text) {
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

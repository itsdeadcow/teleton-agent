import type { TelegramMessage } from "./bridge.js";
import { DEBOUNCE_MAX_MULTIPLIER, DEBOUNCE_MAX_BUFFER_SIZE } from "../constants/limits.js";
import { verbose } from "../utils/logger.js";

interface DebounceBuffer {
  messages: TelegramMessage[];
  timer: NodeJS.Timeout | null;
}

interface DebounceConfig {
  debounceMs: number;
  maxDebounceMs?: number;
  maxBufferSize?: number;
}

export class MessageDebouncer {
  private buffers: Map<string, DebounceBuffer> = new Map();
  private readonly maxDebounceMs: number;
  private readonly maxBufferSize: number;

  constructor(
    private config: DebounceConfig,
    private shouldDebounce: (message: TelegramMessage) => boolean,
    private onFlush: (messages: TelegramMessage[]) => Promise<void>,
    private onError?: (error: unknown, messages: TelegramMessage[]) => void
  ) {
    this.maxDebounceMs = config.maxDebounceMs ?? config.debounceMs * DEBOUNCE_MAX_MULTIPLIER;
    this.maxBufferSize = config.maxBufferSize ?? DEBOUNCE_MAX_BUFFER_SIZE;
  }

  async enqueue(message: TelegramMessage): Promise<void> {
    const isGroup = message.isGroup ? "group" : "dm";
    const shouldDebounce = this.config.debounceMs > 0 && this.shouldDebounce(message);

    verbose(
      `📩 [Debouncer] Received ${isGroup} message from ${message.senderId} in ${message.chatId} (debounce: ${shouldDebounce})`
    );

    if (!shouldDebounce) {
      const key = message.chatId;
      if (this.buffers.has(key)) {
        verbose(`📤 [Debouncer] Flushing pending buffer for ${key} before immediate processing`);
        await this.flushKey(key);
      }
      verbose(`⚡ [Debouncer] Processing immediately (no debounce)`);
      await this.processMessages([message]);
      return;
    }

    const key = message.chatId;
    const existing = this.buffers.get(key);

    if (existing) {
      existing.messages.push(message);
      verbose(
        `📥 [Debouncer] Added to buffer for ${key} (${existing.messages.length} messages waiting)`
      );
      this.resetTimer(key, existing);
    } else {
      const buffer: DebounceBuffer = {
        messages: [message],
        timer: null,
      };
      this.buffers.set(key, buffer);
      this.resetTimer(key, buffer);
    }
  }

  private resetTimer(key: string, buffer: DebounceBuffer): void {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    buffer.timer = setTimeout(() => {
      this.flushKey(key).catch((error) => {
        console.error(`❌ Debouncer flush error for chat ${key}:`, error);
        this.onError?.(error, buffer.messages);
      });
    }, this.config.debounceMs);

    buffer.timer.unref?.();
  }

  private async flushKey(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) {
      verbose(`📭 [Debouncer] No buffer to flush for ${key}`);
      return;
    }

    this.buffers.delete(key);

    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    if (buffer.messages.length === 0) {
      verbose(`📭 [Debouncer] Empty buffer for ${key}, nothing to flush`);
      return;
    }

    verbose(`📤 [Debouncer] Flushing ${buffer.messages.length} message(s) for ${key}`);
    await this.processMessages(buffer.messages);
  }

  private async processMessages(messages: TelegramMessage[]): Promise<void> {
    const sorted = messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    verbose(`🔄 [Debouncer] Processing ${sorted.length} message(s)`);

    try {
      await this.onFlush(sorted);
    } catch (error) {
      this.onError?.(error, sorted);
    }
  }

  getBufferDepth(chatId: string): number {
    return this.buffers.get(chatId)?.messages.length ?? 0;
  }

  async flushAll(): Promise<void> {
    const keys = Array.from(this.buffers.keys());
    for (const key of keys) {
      await this.flushKey(key);
    }
  }
}

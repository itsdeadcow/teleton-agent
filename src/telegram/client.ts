import { TelegramClient, Api } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline";
import { markdownToTelegramHtml } from "./formatting.js";
import { withFloodRetry } from "./flood-retry.js";

function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export interface TelegramClientConfig {
  apiId: number;
  apiHash: string;
  phone: string;
  sessionPath: string;
  connectionRetries?: number;
  retryDelay?: number;
  autoReconnect?: boolean;
  floodSleepThreshold?: number;
}

export interface TelegramUser {
  id: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  isBot: boolean;
}

export class TelegramUserClient {
  private client: TelegramClient;
  private config: TelegramClientConfig;
  private connected = false;
  private me?: TelegramUser;

  constructor(config: TelegramClientConfig) {
    this.config = config;

    const sessionString = this.loadSession();
    const session = new StringSession(sessionString);

    const logger = new Logger(LogLevel.NONE);
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: config.connectionRetries ?? 5,
      retryDelay: config.retryDelay ?? 1000,
      autoReconnect: config.autoReconnect ?? true,
      floodSleepThreshold: config.floodSleepThreshold ?? 60,
      baseLogger: logger,
    });
  }

  private loadSession(): string {
    try {
      if (existsSync(this.config.sessionPath)) {
        return readFileSync(this.config.sessionPath, "utf-8").trim();
      }
    } catch (error) {
      console.warn("Failed to load session:", error);
    }
    return "";
  }

  private saveSession(): void {
    try {
      const sessionString = this.client.session.save() as string | undefined;
      if (typeof sessionString !== "string" || !sessionString) {
        console.warn("No session string to save");
        return;
      }
      const dir = dirname(this.config.sessionPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.config.sessionPath, sessionString, { encoding: "utf-8" });
      chmodSync(this.config.sessionPath, 0o600);
      console.log("✅ Session saved");
    } catch (error) {
      console.error("Failed to save session:", error);
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      console.log("Already connected");
      return;
    }

    try {
      const hasSession = existsSync(this.config.sessionPath);

      if (hasSession) {
        await this.client.connect();
      } else {
        console.log("Starting authentication flow...");
        await this.client.start({
          phoneNumber: async () => this.config.phone || (await promptInput("Phone number: ")),
          phoneCode: async () => await promptInput("Verification code: "),
          password: async () => await promptInput("2FA password (if enabled): "),
          onError: (err) => console.error("Auth error:", err),
        });
        console.log("✅ Authenticated");

        this.saveSession();
      }

      const me = (await this.client.getMe()) as Api.User;
      this.me = {
        id: BigInt(me.id.toString()),
        username: me.username,
        firstName: me.firstName,
        lastName: me.lastName,
        phone: me.phone,
        isBot: me.bot ?? false,
      };

      this.connected = true;
    } catch (error) {
      console.error("Connection error:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.disconnect();
      this.connected = false;
      console.log("Disconnected");
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  }

  getMe(): TelegramUser | undefined {
    return this.me;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): TelegramClient {
    return this.client;
  }

  addNewMessageHandler(
    handler: (event: NewMessageEvent) => void | Promise<void>,
    filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
      fromUsers?: number[];
      pattern?: RegExp;
    }
  ): void {
    const wrappedHandler = async (event: NewMessageEvent) => {
      if (process.env.DEBUG) {
        const chatId = event.message.chatId?.toString() ?? "unknown";
        const isGroup = chatId.startsWith("-");
        console.log(
          `🔔 RAW EVENT: chatId=${chatId} isGroup=${isGroup} text="${event.message.message?.substring(0, 30) ?? ""}"`
        );
      }
      await handler(event);
    };
    this.client.addEventHandler(wrappedHandler, new NewMessage(filters ?? {}));
  }

  addCallbackQueryHandler(handler: (event: any) => Promise<void>): void {
    this.client.addEventHandler(async (update) => {
      if (
        update.className === "UpdateBotCallbackQuery" ||
        update.className === "UpdateInlineBotCallbackQuery"
      ) {
        await handler(update);
      }
    });
  }

  async answerCallbackQuery(
    queryId: any,
    options?: {
      message?: string;
      alert?: boolean;
      url?: string;
    }
  ): Promise<boolean> {
    try {
      await this.client.invoke(
        new Api.messages.SetBotCallbackAnswer({
          queryId: queryId,
          message: options?.message,
          alert: options?.alert,
          url: options?.url,
        })
      );
      return true;
    } catch (error) {
      console.error("Error answering callback query:", error);
      return false;
    }
  }

  async sendMessage(
    entity: string | Api.TypePeer,
    options: {
      message: string;
      replyTo?: number;
      silent?: boolean;
      parseMode?: "html" | "md" | "md2" | "none";
    }
  ): Promise<Api.Message> {
    const parseMode = options.parseMode ?? "html";
    const formattedMessage =
      parseMode === "html" ? markdownToTelegramHtml(options.message) : options.message;

    return withFloodRetry(() =>
      this.client.sendMessage(entity as any, {
        message: formattedMessage,
        replyTo: options.replyTo,
        silent: options.silent,
        parseMode: parseMode === "none" ? undefined : parseMode,
        linkPreview: false,
      })
    );
  }

  async getMessages(
    entity: string | Api.TypePeer,
    options?: {
      limit?: number;
      offsetId?: number;
      search?: string;
    }
  ): Promise<Api.Message[]> {
    const messages = await this.client.getMessages(entity, {
      limit: options?.limit ?? 100,
      offsetId: options?.offsetId,
      search: options?.search,
    });
    return messages;
  }

  async getDialogs(): Promise<
    Array<{
      id: bigint;
      title: string;
      isGroup: boolean;
      isChannel: boolean;
    }>
  > {
    const dialogs = await this.client.getDialogs({});
    return dialogs.map((d) => ({
      id: BigInt(d.id?.toString() ?? "0"),
      title: d.title ?? "Unknown",
      isGroup: d.isGroup,
      isChannel: d.isChannel,
    }));
  }

  async setTyping(entity: string): Promise<void> {
    try {
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: entity,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch (error) {}
  }

  async resolveUsername(username: string): Promise<Api.TypeUser | Api.TypeChat | undefined> {
    const clean = username.replace("@", "");
    try {
      // Call ResolveUsername directly — bypasses GramJS's VALID_USERNAME_RE
      // which rejects collectible usernames shorter than 5 chars.
      const result = await this.client.invoke(
        new Api.contacts.ResolveUsername({ username: clean })
      );
      return result.users[0] || result.chats[0];
    } catch (error: any) {
      console.error(`Failed to resolve username ${clean}:`, error);
      return undefined;
    }
  }

  async getEntity(entity: string): Promise<Api.TypeUser | Api.TypeChat> {
    return await this.client.getEntity(entity);
  }
}

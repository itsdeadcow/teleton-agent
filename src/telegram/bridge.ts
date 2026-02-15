import { TelegramUserClient, type TelegramClientConfig } from "./client.js";
import { Api } from "telegram";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";

export interface TelegramMessage {
  id: number;
  chatId: string;
  senderId: number;
  senderUsername?: string;
  senderFirstName?: string;
  text: string;
  isGroup: boolean;
  isChannel: boolean;
  isBot: boolean;
  mentionsMe: boolean;
  timestamp: Date;
  _rawPeer?: Api.TypePeer;
  hasMedia: boolean;
  mediaType?: "photo" | "document" | "video" | "audio" | "voice" | "sticker";
  _rawMessage?: Api.Message;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  chatId: string;
  text: string;
  replyToId?: number;
  inlineKeyboard?: InlineButton[][];
}

export class TelegramBridge {
  private client: TelegramUserClient;
  private ownUserId?: bigint;
  private ownUsername?: string;
  private peerCache: Map<string, Api.TypePeer> = new Map();

  constructor(config: TelegramClientConfig) {
    this.client = new TelegramUserClient(config);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const me = this.client.getMe();
    if (me) {
      this.ownUserId = me.id;
      this.ownUsername = me.username?.toLowerCase();
    }

    try {
      await this.getDialogs();
    } catch (error) {
      console.warn("⚠️ Could not load dialogs:", error);
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  isAvailable(): boolean {
    return this.client.isConnected();
  }

  getOwnUserId(): bigint | undefined {
    return this.ownUserId;
  }

  getUsername(): string | undefined {
    const me = this.client.getMe();
    return me?.username;
  }

  async getMessages(chatId: string, limit: number = 50): Promise<TelegramMessage[]> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;
      const messages = await this.client.getMessages(peer, { limit });
      const results = await Promise.allSettled(messages.map((msg) => this.parseMessage(msg)));
      return results
        .filter((r): r is PromiseFulfilledResult<TelegramMessage> => r.status === "fulfilled")
        .map((r) => r.value);
    } catch (error) {
      console.error("Error getting messages:", error);
      return [];
    }
  }

  async sendMessage(
    options: SendMessageOptions & { _rawPeer?: Api.TypePeer }
  ): Promise<Api.Message> {
    try {
      const peer = options._rawPeer || this.peerCache.get(options.chatId) || options.chatId;

      if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
        const buttons = new Api.ReplyInlineMarkup({
          rows: options.inlineKeyboard.map(
            (row) =>
              new Api.KeyboardButtonRow({
                buttons: row.map(
                  (btn) =>
                    new Api.KeyboardButtonCallback({
                      text: btn.text,
                      data: Buffer.from(btn.callback_data),
                    })
                ),
              })
          ),
        });

        const gramJsClient = this.client.getClient();
        return await gramJsClient.sendMessage(peer, {
          message: options.text,
          replyTo: options.replyToId,
          buttons,
        });
      }

      return await this.client.sendMessage(peer, {
        message: options.text,
        replyTo: options.replyToId,
      });
    } catch (error) {
      console.error("Error sending message:", error);
      throw error;
    }
  }

  async editMessage(options: {
    chatId: string;
    messageId: number;
    text: string;
    inlineKeyboard?: InlineButton[][];
  }): Promise<Api.Message> {
    try {
      const peer = this.peerCache.get(options.chatId) || options.chatId;

      let buttons;
      if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
        buttons = new Api.ReplyInlineMarkup({
          rows: options.inlineKeyboard.map(
            (row) =>
              new Api.KeyboardButtonRow({
                buttons: row.map(
                  (btn) =>
                    new Api.KeyboardButtonCallback({
                      text: btn.text,
                      data: Buffer.from(btn.callback_data),
                    })
                ),
              })
          ),
        });
      }

      const gramJsClient = this.client.getClient();
      const result: any = await gramJsClient.invoke(
        new Api.messages.EditMessage({
          peer,
          id: options.messageId,
          message: options.text,
          replyMarkup: buttons,
        })
      );

      if (result.className === "Updates" && result.updates) {
        const messageUpdate = result.updates.find(
          (u: any) =>
            u.className === "UpdateEditMessage" || u.className === "UpdateEditChannelMessage"
        );
        if (messageUpdate?.message) {
          return messageUpdate.message;
        }
      }

      return result;
    } catch (error) {
      console.error("Error editing message:", error);
      throw error;
    }
  }

  async getDialogs(): Promise<
    Array<{
      id: string;
      title: string;
      isGroup: boolean;
      isChannel: boolean;
    }>
  > {
    try {
      const dialogs = await this.client.getDialogs();
      return dialogs.map((d) => ({
        id: d.id.toString(),
        title: d.title,
        isGroup: d.isGroup,
        isChannel: d.isChannel,
      }));
    } catch (error) {
      console.error("Error getting dialogs:", error);
      return [];
    }
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.client.setTyping(chatId);
    } catch (error) {
      console.error("Error setting typing:", error);
    }
  }

  async sendReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;

      await this.client.getClient().invoke(
        new Api.messages.SendReaction({
          peer,
          msgId: messageId,
          reaction: [
            new Api.ReactionEmoji({
              emoticon: emoji,
            }),
          ],
        })
      );
    } catch (error) {
      console.error("Error sending reaction:", error);
      throw error;
    }
  }

  onNewMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
    }
  ): void {
    this.client.addNewMessageHandler(
      async (event: NewMessageEvent) => {
        const message = await this.parseMessage(event.message);
        await handler(message);
      },
      {
        incoming: filters?.incoming,
        outgoing: filters?.outgoing,
        chats: filters?.chats,
      }
    );
  }

  private async parseMessage(msg: Api.Message): Promise<TelegramMessage> {
    const chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
    const senderIdBig = msg.senderId ? BigInt(msg.senderId.toString()) : BigInt(0);
    const senderId = Number(senderIdBig);

    let mentionsMe = msg.mentioned ?? false;
    if (!mentionsMe && this.ownUsername && msg.message) {
      mentionsMe = msg.message.toLowerCase().includes(`@${this.ownUsername}`);
    }

    const isChannel = msg.post ?? false;
    const isGroup = !isChannel && chatId.startsWith("-");

    if (msg.peerId) {
      this.peerCache.set(chatId, msg.peerId);
      if (this.peerCache.size > 5000) {
        const oldest = this.peerCache.keys().next().value;
        if (oldest !== undefined) this.peerCache.delete(oldest);
      }
    }

    let senderUsername: string | undefined;
    let senderFirstName: string | undefined;
    let isBot = false;
    try {
      const sender = await Promise.race([
        msg.getSender(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (sender && "username" in sender) {
        senderUsername = sender.username ?? undefined;
      }
      if (sender && "firstName" in sender) {
        senderFirstName = sender.firstName ?? undefined;
      }
      if (sender && "bot" in sender) {
        isBot = (sender as any).bot ?? false;
      }
    } catch (e) {}

    const hasMedia = !!(
      msg.photo ||
      msg.document ||
      msg.video ||
      msg.audio ||
      msg.voice ||
      msg.sticker
    );
    let mediaType: TelegramMessage["mediaType"];
    if (msg.photo) mediaType = "photo";
    else if (msg.video) mediaType = "video";
    else if (msg.audio) mediaType = "audio";
    else if (msg.voice) mediaType = "voice";
    else if (msg.sticker) mediaType = "sticker";
    else if (msg.document) mediaType = "document";

    let text = msg.message ?? "";
    if (!text && msg.media) {
      if (msg.media.className === "MessageMediaDice") {
        const dice = msg.media as Api.MessageMediaDice;
        text = `[Dice: ${dice.emoticon} = ${dice.value}]`;
      } else if (msg.media.className === "MessageMediaGame") {
        const game = msg.media as Api.MessageMediaGame;
        text = `[Game: ${game.game.title}]`;
      } else if (msg.media.className === "MessageMediaPoll") {
        const poll = msg.media as Api.MessageMediaPoll;
        text = `[Poll: ${poll.poll.question.text}]`;
      } else if (msg.media.className === "MessageMediaContact") {
        const contact = msg.media as Api.MessageMediaContact;
        text = `[Contact: ${contact.firstName} ${contact.lastName || ""} - ${contact.phoneNumber}]`;
      } else if (
        msg.media.className === "MessageMediaGeo" ||
        msg.media.className === "MessageMediaGeoLive"
      ) {
        text = `[Location shared]`;
      }
    }

    return {
      id: msg.id,
      chatId,
      senderId,
      senderUsername,
      senderFirstName,
      text,
      isGroup,
      isChannel,
      isBot,
      mentionsMe,
      timestamp: new Date(msg.date * 1000),
      _rawPeer: msg.peerId,
      hasMedia,
      mediaType,
      _rawMessage: hasMedia ? msg : undefined,
    };
  }

  getPeer(chatId: string): Api.TypePeer | undefined {
    return this.peerCache.get(chatId);
  }

  getClient(): TelegramUserClient {
    return this.client;
  }
}

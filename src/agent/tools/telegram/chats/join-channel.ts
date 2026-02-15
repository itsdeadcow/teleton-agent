import { Type } from "@sinclair/typebox";
import { Api } from "telegram";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";

function extractInviteHash(input: string): string | null {
  const patterns = [
    /t\.me\/\+([A-Za-z0-9_-]+)/,
    /t\.me\/joinchat\/([A-Za-z0-9_-]+)/,
    /tg:\/\/join\?invite=([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

interface JoinChannelParams {
  channel: string;
}

/**
 * Tool definition for joining a Telegram channel or group
 */
export const telegramJoinChannelTool: Tool = {
  name: "telegram_join_channel",
  description:
    "Join a Telegram channel or group. Supports public channels (username/@channelname), channel IDs, and private invite links (t.me/+XXXX, t.me/joinchat/XXXX).",
  parameters: Type.Object({
    channel: Type.String({
      description:
        "Channel username (with or without @), numeric channel ID, or invite link. Examples: '@mychannel', 'mychannel', '-1001234567890', 'https://t.me/+AbCdEf123'",
    }),
  }),
};

/**
 * Executor for telegram_join_channel tool
 */
export const telegramJoinChannelExecutor: ToolExecutor<JoinChannelParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const { channel } = params;

    // Get underlying GramJS client
    const gramJsClient = context.bridge.getClient().getClient();

    // Try invite link first if the input looks like one
    const inviteHash = extractInviteHash(channel);

    if (inviteHash) {
      // Check the invite before importing
      const checkResult = await gramJsClient.invoke(
        new Api.messages.CheckChatInvite({ hash: inviteHash })
      );

      if (checkResult instanceof Api.ChatInviteAlready) {
        const chat = checkResult.chat;
        return {
          success: true,
          data: {
            channel: channel,
            channelId: (chat as any)?.id?.toString() || null,
            channelTitle: (chat as any)?.title || channel,
            message: `Already a member of ${(chat as any)?.title || channel}`,
          },
        };
      }

      const updates = await gramJsClient.invoke(
        new Api.messages.ImportChatInvite({ hash: inviteHash })
      );

      // Extract chat info from updates
      const chats = (updates as any)?.chats || [];
      const joinedChat = chats[0];
      const chatTitle = joinedChat?.title || channel;
      const chatId = joinedChat?.id?.toString() || null;

      return {
        success: true,
        data: {
          channel: channel,
          channelId: chatId,
          channelTitle: chatTitle,
          message: `Successfully joined ${chatTitle}`,
        },
      };
    }

    // Resolve the channel entity (handles both usernames and IDs)
    let channelEntity;
    try {
      channelEntity = await gramJsClient.getEntity(channel);
    } catch {
      // GramJS VALID_USERNAME_RE rejects usernames <5 chars (collectible/Fragment usernames).
      // Bypass getEntity and call ResolveUsername directly.
      const clean = channel.replace(/^@/, "");
      try {
        const resolved = await gramJsClient.invoke(
          new Api.contacts.ResolveUsername({ username: clean })
        );
        channelEntity = resolved.chats[0] || resolved.users[0];
      } catch {
        // Genuinely not found
      }
      if (!channelEntity) {
        return {
          success: false,
          error: `Could not find channel "${channel}". Make sure it's a public channel or you have access to it.`,
        };
      }
    }

    await gramJsClient.invoke(
      new Api.channels.JoinChannel({
        channel: channelEntity,
      })
    );

    const channelTitle =
      (channelEntity as any)?.title || (channelEntity as any)?.username || channel;
    const channelId =
      (channelEntity as any)?.id?.toString() ||
      (channelEntity as any)?.channelId?.toString() ||
      null;

    return {
      success: true,
      data: {
        channel: channel,
        channelId: channelId,
        channelTitle: channelTitle,
        message: `Successfully joined ${channelTitle}`,
      },
    };
  } catch (error) {
    console.error("Error joining Telegram channel:", error);

    if (error instanceof Error) {
      if (error.message.includes("USER_ALREADY_PARTICIPANT")) {
        return {
          success: true,
          data: {
            channel: params.channel,
            message: `Already a member of ${params.channel}`,
          },
        };
      }
      if (error.message.includes("INVITE_HASH_INVALID")) {
        return {
          success: false,
          error: "Invalid invite link. The link may be malformed or revoked.",
        };
      }
      if (error.message.includes("INVITE_HASH_EXPIRED")) {
        return {
          success: false,
          error: "This invite link has expired.",
        };
      }
      if (error.message.includes("INVITE_REQUEST_SENT")) {
        return {
          success: true,
          data: {
            channel: params.channel,
            message: "Join request sent. Waiting for admin approval.",
          },
        };
      }
      if (error.message.includes("CHANNELS_TOO_MUCH")) {
        return {
          success: false,
          error: "You've joined too many channels. Leave some before joining new ones.",
        };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

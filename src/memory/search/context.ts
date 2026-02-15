import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { HybridSearch } from "./hybrid.js";
import { MessageStore } from "../feed/messages.js";

export interface ContextOptions {
  query: string;
  chatId: string;
  includeAgentMemory?: boolean;
  includeFeedHistory?: boolean;
  searchAllChats?: boolean; // Search across all chats, not just current
  maxRecentMessages?: number;
  maxRelevantChunks?: number;
  maxTokens?: number;
}

export interface Context {
  recentMessages: Array<{ role: string; content: string }>;
  relevantKnowledge: string[];
  relevantFeed: string[];
  estimatedTokens: number;
}

export class ContextBuilder {
  private hybridSearch: HybridSearch;
  private messageStore: MessageStore;

  constructor(
    private db: Database.Database,
    private embedder: EmbeddingProvider,
    vectorEnabled: boolean
  ) {
    this.hybridSearch = new HybridSearch(db, vectorEnabled);
    this.messageStore = new MessageStore(db, embedder, vectorEnabled);
  }

  async buildContext(options: ContextOptions): Promise<Context> {
    const {
      query,
      chatId,
      includeAgentMemory = true,
      includeFeedHistory = true,
      searchAllChats = false,
      maxRecentMessages = 20,
      maxRelevantChunks = 5,
    } = options;

    const queryEmbedding = await this.embedder.embedQuery(query);

    const recentTgMessages = this.messageStore.getRecentMessages(chatId, maxRecentMessages);
    const recentMessages = recentTgMessages.map((m) => ({
      role: m.isFromAgent ? "assistant" : "user",
      content: m.text ?? "",
    }));

    const relevantKnowledge: string[] = [];
    if (includeAgentMemory) {
      try {
        const knowledgeResults = await this.hybridSearch.searchKnowledge(query, queryEmbedding, {
          limit: maxRelevantChunks,
        });
        relevantKnowledge.push(...knowledgeResults.map((r) => r.text));
      } catch (error) {
        console.warn("Knowledge search failed:", error);
      }
    }

    const recentTextsSet = new Set(
      recentTgMessages.filter((m) => m.text && m.text.length > 0).map((m) => m.text!)
    );

    const relevantFeed: string[] = [];
    if (includeFeedHistory) {
      try {
        const feedResults = await this.hybridSearch.searchMessages(query, queryEmbedding, {
          chatId,
          limit: maxRelevantChunks,
        });
        for (const r of feedResults) {
          if (!recentTextsSet.has(r.text)) {
            relevantFeed.push(r.text);
          }
        }

        if (searchAllChats) {
          const globalResults = await this.hybridSearch.searchMessages(query, queryEmbedding, {
            limit: maxRelevantChunks,
          });
          const existingTexts = new Set(relevantFeed);
          for (const r of globalResults) {
            if (!existingTexts.has(r.text)) {
              relevantFeed.push(`[From chat ${r.source}]: ${r.text}`);
            }
          }
        }
      } catch (error) {
        console.warn("Feed search failed:", error);
      }

      if (relevantFeed.length === 0 && recentTgMessages.length > 0) {
        const recentTexts = recentTgMessages
          .filter((m) => m.text && m.text.length > 0)
          .slice(-maxRelevantChunks)
          .map((m) => {
            const sender = m.isFromAgent ? "Agent" : "User";
            return `[${sender}]: ${m.text}`;
          });
        relevantFeed.push(...recentTexts);
      }
    }

    const allText =
      recentMessages.map((m) => m.content).join(" ") +
      relevantKnowledge.join(" ") +
      relevantFeed.join(" ");
    const estimatedTokens = Math.ceil(allText.length / 4);

    return {
      recentMessages,
      relevantKnowledge,
      relevantFeed,
      estimatedTokens,
    };
  }
}

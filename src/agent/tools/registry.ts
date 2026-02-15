import { validateToolCall } from "@mariozechner/pi-ai";
import type { Tool as PiAiTool, ToolCall } from "@mariozechner/pi-ai";
import type {
  RegisteredTool,
  Tool,
  ToolContext,
  ToolExecutor,
  ToolResult,
  ToolScope,
} from "./types.js";
import type { ModulePermissions } from "./module-permissions.js";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../../constants/timeouts.js";
import type Database from "better-sqlite3";
import {
  loadAllToolConfigs,
  initializeToolConfig,
  saveToolConfig,
  type ToolConfig,
} from "../../memory/tool-config.js";

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private scopes: Map<string, ToolScope> = new Map();
  private toolModules: Map<string, string> = new Map();
  private permissions: ModulePermissions | null = null;
  private toolArrayCache: PiAiTool[] | null = null;
  private toolConfigs: Map<string, ToolConfig> = new Map(); // Runtime tool configurations
  private db: Database.Database | null = null;
  private pluginToolNames: Map<string, string[]> = new Map();

  register<TParams = unknown>(
    tool: Tool,
    executor: ToolExecutor<TParams>,
    scope?: ToolScope
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, { tool, executor: executor as ToolExecutor });
    if (scope && scope !== "always") {
      this.scopes.set(tool.name, scope);
    }
    this.toolModules.set(tool.name, tool.name.split("_")[0]);
    this.toolArrayCache = null;
  }

  setPermissions(mp: ModulePermissions): void {
    this.permissions = mp;
  }

  getAvailableModules(): string[] {
    const modules = new Set(this.toolModules.values());
    return Array.from(modules).sort();
  }

  getModuleToolCount(module: string): number {
    let count = 0;
    for (const mod of this.toolModules.values()) {
      if (mod === module) count++;
    }
    return count;
  }

  getModuleTools(module: string): Array<{ name: string; scope: ToolScope | "always" }> {
    const result: Array<{ name: string; scope: ToolScope | "always" }> = [];
    for (const [name, mod] of this.toolModules) {
      if (mod === module) {
        result.push({ name, scope: this.scopes.get(name) ?? "always" });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAll(): PiAiTool[] {
    if (!this.toolArrayCache) {
      this.toolArrayCache = Array.from(this.tools.values()).map((rt) => rt.tool);
    }
    return this.toolArrayCache;
  }

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const registered = this.tools.get(toolCall.name);

    if (!registered) {
      return {
        success: false,
        error: `Unknown tool: ${toolCall.name}`,
      };
    }

    // Check if tool is enabled
    if (!this.isToolEnabled(toolCall.name)) {
      return {
        success: false,
        error: `Tool "${toolCall.name}" is currently disabled`,
      };
    }

    const scope = this.getEffectiveScope(toolCall.name);
    if (scope === "dm-only" && context.isGroup) {
      return {
        success: false,
        error: `Tool "${toolCall.name}" is not available in group chats`,
      };
    }
    if (scope === "group-only" && !context.isGroup) {
      return {
        success: false,
        error: `Tool "${toolCall.name}" is only available in group chats`,
      };
    }
    if (scope === "admin-only") {
      const isAdmin = context.config?.telegram.admin_ids.includes(context.senderId) ?? false;
      if (!isAdmin) {
        return {
          success: false,
          error: `Tool "${toolCall.name}" is restricted to admin users`,
        };
      }
    }

    if (context.isGroup && this.permissions) {
      const module = this.toolModules.get(toolCall.name);
      if (module) {
        const level = this.permissions.getLevel(context.chatId, module);
        if (level === "disabled") {
          return {
            success: false,
            error: `Module "${module}" is disabled in this group`,
          };
        }
        if (level === "admin") {
          const isAdmin = context.config?.telegram.admin_ids.includes(context.senderId) ?? false;
          if (!isAdmin) {
            return {
              success: false,
              error: `Module "${module}" is restricted to admins in this group`,
            };
          }
        }
      }
    }

    try {
      const validatedArgs = validateToolCall(this.getAll(), toolCall);

      let timeoutHandle: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        registered.executor(validatedArgs, context),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(
                  `Tool "${toolCall.name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS / 1000}s`
                )
              ),
            TOOL_EXECUTION_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(timeoutHandle));

      return result;
    } catch (error) {
      console.error(`Error executing tool ${toolCall.name}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getForProvider(toolLimit: number | null): PiAiTool[] {
    const all = this.getAll();
    if (toolLimit === null || all.length <= toolLimit) {
      return all;
    }
    console.warn(
      `⚠️ Provider tool limit: ${toolLimit}, registered: ${all.length}. Truncating to ${toolLimit} tools.`
    );
    return all.slice(0, toolLimit);
  }

  getForContext(
    isGroup: boolean,
    toolLimit: number | null,
    chatId?: string,
    isAdmin?: boolean
  ): PiAiTool[] {
    const excluded = isGroup ? "dm-only" : "group-only";
    const filtered = Array.from(this.tools.values())
      .filter((rt) => {
        // Filter out disabled tools
        if (!this.isToolEnabled(rt.tool.name)) return false;

        // Use effective scope (with config override)
        const effectiveScope = this.getEffectiveScope(rt.tool.name);
        if (effectiveScope === excluded) return false;
        if (effectiveScope === "admin-only" && !isAdmin) return false;

        if (isGroup && chatId && this.permissions) {
          const module = this.toolModules.get(rt.tool.name);
          if (module) {
            const level = this.permissions.getLevel(chatId, module);
            if (level === "disabled") return false;
            if (level === "admin" && !isAdmin) return false;
          }
        }

        return true;
      })
      .map((rt) => rt.tool);

    if (toolLimit !== null && filtered.length > toolLimit) {
      console.warn(
        `⚠️ Provider tool limit: ${toolLimit}, after scope filter: ${filtered.length}. Truncating to ${toolLimit} tools.`
      );
      return filtered.slice(0, toolLimit);
    }
    return filtered;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get count(): number {
    return this.tools.size;
  }

  getToolCategory(name: string): "data-bearing" | "action" | undefined {
    const registered = this.tools.get(name);
    return registered?.tool.category;
  }

  /**
   * Load tool configurations from database and seed missing ones
   */
  loadConfigFromDB(db: Database.Database): void {
    this.db = db;
    this.toolConfigs = loadAllToolConfigs(db);

    // Seed DB with defaults for tools that don't have config yet
    let seeded = false;
    for (const [toolName] of this.tools) {
      if (!this.toolConfigs.has(toolName)) {
        const defaultScope = this.scopes.get(toolName) ?? "always";
        initializeToolConfig(db, toolName, true, defaultScope);
        seeded = true;
      }
    }
    // Reload once after all seeds
    if (seeded) {
      this.toolConfigs = loadAllToolConfigs(db);
    }

    // Clear cache to force regeneration with new configs
    this.toolArrayCache = null;
  }

  /**
   * Get effective scope for a tool (config override or default)
   */
  private getEffectiveScope(toolName: string): ToolScope {
    const config = this.toolConfigs.get(toolName);
    if (config?.scope !== null && config?.scope !== undefined) {
      return config.scope;
    }
    return this.scopes.get(toolName) ?? "always";
  }

  /**
   * Check if a tool is enabled
   */
  isToolEnabled(toolName: string): boolean {
    const config = this.toolConfigs.get(toolName);
    return config?.enabled ?? true;
  }

  /**
   * Update tool enabled status
   */
  setToolEnabled(toolName: string, enabled: boolean, updatedBy?: number): boolean {
    if (!this.tools.has(toolName) || !this.db) return false;

    const currentConfig = this.toolConfigs.get(toolName);
    const scope = currentConfig?.scope ?? this.scopes.get(toolName) ?? "always";

    saveToolConfig(this.db, toolName, enabled, scope, updatedBy);

    // Update in-memory cache
    this.toolConfigs = loadAllToolConfigs(this.db);
    this.toolArrayCache = null;

    return true;
  }

  /**
   * Update tool scope
   */
  updateToolScope(toolName: string, scope: ToolScope, updatedBy?: number): boolean {
    if (!this.tools.has(toolName) || !this.db) return false;

    const currentConfig = this.toolConfigs.get(toolName);
    const enabled = currentConfig?.enabled ?? true;

    saveToolConfig(this.db, toolName, enabled, scope, updatedBy);

    // Update in-memory cache
    this.toolConfigs = loadAllToolConfigs(this.db);
    this.toolArrayCache = null;

    return true;
  }

  /**
   * Get tool configuration
   */
  getToolConfig(toolName: string): { enabled: boolean; scope: ToolScope } | null {
    if (!this.tools.has(toolName)) return null;

    const config = this.toolConfigs.get(toolName);
    const enabled = config?.enabled ?? true;
    const scope = config?.scope ?? this.scopes.get(toolName) ?? "always";

    return { enabled, scope };
  }

  /**
   * Register all tools belonging to a plugin (tracks ownership for hot-reload).
   */
  registerPluginTools(
    pluginName: string,
    tools: Array<{ tool: Tool; executor: ToolExecutor; scope?: ToolScope }>
  ): number {
    const names: string[] = [];
    for (const { tool, executor, scope } of tools) {
      if (this.tools.has(tool.name)) continue;
      this.tools.set(tool.name, { tool, executor });
      if (scope && scope !== "always") {
        this.scopes.set(tool.name, scope);
      }
      this.toolModules.set(tool.name, pluginName);
      names.push(tool.name);
    }
    this.pluginToolNames.set(pluginName, names);
    this.toolArrayCache = null;
    return names.length;
  }

  /**
   * Replace all tools belonging to a plugin with new ones (hot-reload).
   * Atomically removes old tools then registers new ones.
   */
  replacePluginTools(
    pluginName: string,
    newTools: Array<{ tool: Tool; executor: ToolExecutor; scope?: ToolScope }>
  ): void {
    // Collect old tool names before removal (allowed to re-register these)
    const previousNames = new Set(this.pluginToolNames.get(pluginName) ?? []);
    this.removePluginTools(pluginName);
    const names: string[] = [];
    for (const { tool, executor, scope } of newTools) {
      // Prevent overwriting core/other-plugin tools
      if (this.tools.has(tool.name) && !previousNames.has(tool.name)) {
        console.warn(
          `[registry] Plugin "${pluginName}" tried to overwrite existing tool "${tool.name}" — skipped`
        );
        continue;
      }
      this.tools.set(tool.name, { tool, executor });
      if (scope && scope !== "always") {
        this.scopes.set(tool.name, scope);
      }
      this.toolModules.set(tool.name, pluginName);
      names.push(tool.name);
    }
    this.pluginToolNames.set(pluginName, names);
    this.toolArrayCache = null;
  }

  /**
   * Remove all tools belonging to a plugin.
   */
  removePluginTools(pluginName: string): void {
    const tracked = this.pluginToolNames.get(pluginName);
    if (tracked) {
      for (const name of tracked) {
        this.tools.delete(name);
        this.scopes.delete(name);
        this.toolModules.delete(name);
      }
      this.pluginToolNames.delete(pluginName);
    }
    this.toolArrayCache = null;
  }
}

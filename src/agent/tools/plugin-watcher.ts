/**
 * Plugin hot-reload watcher — watches ~/.teleton/plugins/ for changes
 * and reloads plugins without restarting the agent.
 *
 * Key design decisions:
 * - Validates new plugin BEFORE stopping old one ("keep old until new succeeds")
 * - Per-plugin debounce (300ms) to avoid reload storms
 * - ESM cache busting via ?t= query parameter
 * - Never crashes the main process on reload failure
 */

import chokidar from "chokidar";
import { basename, relative, resolve, sep } from "path";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { WORKSPACE_PATHS } from "../../workspace/paths.js";
import { adaptPlugin } from "./plugin-loader.js";
import type { PluginModule, PluginContext, Tool, ToolExecutor, ToolScope } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { Config } from "../../config/schema.js";
import type { SDKDependencies } from "../../sdk/index.js";

const RELOAD_DEBOUNCE_MS = 300;

interface PluginWatcherDeps {
  config: Config;
  registry: ToolRegistry;
  sdkDeps: SDKDependencies;
  modules: PluginModule[];
  pluginContext: PluginContext;
  loadedModuleNames: string[];
}

export class PluginWatcher {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private reloadTimers = new Map<string, NodeJS.Timeout>();
  private reloading = false;
  private deps: PluginWatcherDeps;
  private pluginsDir: string;

  constructor(deps: PluginWatcherDeps) {
    this.deps = deps;
    this.pluginsDir = WORKSPACE_PATHS.PLUGINS_DIR;
  }

  /**
   * Start watching the plugins directory for changes.
   */
  start(): void {
    this.watcher = chokidar.watch(this.pluginsDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      ignored: [
        "**/node_modules/**",
        "**/data/**",
        "**/.git/**",
        "**/*.map",
        "**/*.d.ts",
        "**/*.md",
      ],
      depth: 1,
      followSymlinks: false,
      ignorePermissionErrors: true,
      usePolling: false,
    });

    this.watcher.on("change", (filePath: string) => {
      const pluginName = this.resolvePluginName(filePath);
      if (pluginName) {
        this.scheduleReload(pluginName);
      }
    });

    this.watcher.on("error", (err: unknown) => {
      console.error("[hot-reload] Watcher error:", err instanceof Error ? err.message : err);
    });

    console.log("[hot-reload] Plugin watcher started");
  }

  /**
   * Resolve a changed file path to a plugin name.
   * Supports both directory plugins (pluginName/index.js) and single-file plugins (pluginName.js).
   */
  private resolvePluginName(filePath: string): string | null {
    const fileName = basename(filePath);

    // Only react to .js file changes
    if (!fileName.endsWith(".js")) return null;

    const rel = relative(this.pluginsDir, filePath);
    const segments = rel.split(sep);

    // Defense-in-depth: reject path traversal
    if (segments.some((s) => s === ".." || s === ".")) return null;

    // Directory plugin: pluginName/index.js
    if (segments.length === 2 && segments[1] === "index.js") {
      return segments[0];
    }

    // Single-file plugin: pluginName.js (at root level)
    if (segments.length === 1 && fileName.endsWith(".js")) {
      return fileName.replace(/\.js$/, "");
    }

    return null;
  }

  /**
   * Stop watching and clear pending reloads.
   */
  async stop(): Promise<void> {
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer);
    }
    this.reloadTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleReload(pluginName: string): void {
    const existing = this.reloadTimers.get(pluginName);
    if (existing) clearTimeout(existing);

    this.reloadTimers.set(
      pluginName,
      setTimeout(() => {
        this.reloadTimers.delete(pluginName);
        this.reloadPlugin(pluginName).catch((err) => {
          console.error(
            `[hot-reload] Unexpected error reloading "${pluginName}":`,
            err instanceof Error ? err.message : err
          );
        });
      }, RELOAD_DEBOUNCE_MS)
    );
  }

  /**
   * Resolve the entry file for a plugin (supports directory and single-file plugins).
   */
  private resolveModulePath(pluginName: string): string | null {
    // Directory plugin: pluginName/index.js
    const dirPath = resolve(this.pluginsDir, pluginName, "index.js");
    if (existsSync(dirPath)) return dirPath;

    // Single-file plugin: pluginName.js
    const filePath = resolve(this.pluginsDir, `${pluginName}.js`);
    if (existsSync(filePath)) return filePath;

    return null;
  }

  private async reloadPlugin(pluginName: string): Promise<boolean> {
    if (this.reloading) {
      console.warn(`[hot-reload] Reload already in progress, skipping "${pluginName}"`);
      return false;
    }

    this.reloading = true;

    const { config, registry, sdkDeps, modules, pluginContext, loadedModuleNames } = this.deps;

    // Find existing module
    const oldIndex = modules.findIndex((m) => m.name === pluginName);
    const oldModule = oldIndex >= 0 ? modules[oldIndex] : null;

    console.log(
      `[hot-reload] Reloading plugin "${pluginName}"${oldModule ? ` (v${oldModule.version})` : ""}...`
    );

    // Snapshot old tools for rollback before any changes
    let oldTools: Array<{ tool: Tool; executor: ToolExecutor; scope?: ToolScope }> | null = null;
    if (oldModule) {
      try {
        oldTools = oldModule.tools(config);
      } catch {
        // If we can't snapshot old tools, rollback won't restore them
      }
    }

    let oldStopped = false;

    try {
      // 1. Resolve module path
      const modulePath = this.resolveModulePath(pluginName);
      if (!modulePath) {
        throw new Error(`Plugin file not found for "${pluginName}"`);
      }

      // 2. Import with cache bust
      const moduleUrl = pathToFileURL(modulePath).href + `?t=${Date.now()}`;
      const freshMod = await import(moduleUrl);

      // 3. Validate exports BEFORE stopping old plugin
      if (
        !freshMod.tools ||
        (typeof freshMod.tools !== "function" && !Array.isArray(freshMod.tools))
      ) {
        throw new Error("No valid 'tools' export found");
      }

      // 4. Adapt and validate (old plugin still running)
      const entryName = basename(modulePath) === "index.js" ? pluginName : `${pluginName}.js`;
      const adapted = adaptPlugin(freshMod, entryName, config, loadedModuleNames, sdkDeps);
      const newTools = adapted.tools(config);
      if (newTools.length === 0) {
        throw new Error("Plugin produced zero valid tools");
      }

      // 5. Stop old plugin (new one is fully validated at this point)
      if (oldModule) {
        try {
          await oldModule.stop?.();
        } catch (stopErr) {
          console.warn(
            `[hot-reload] Old plugin "${pluginName}" stop() failed:`,
            stopErr instanceof Error ? stopErr.message : stopErr
          );
        }
        oldStopped = true;
      }

      // 6. Run migration if needed
      adapted.migrate?.(pluginContext.db);

      // 7. Replace tools in registry
      registry.replacePluginTools(pluginName, newTools);

      // 8. Start new plugin
      await adapted.start?.(pluginContext);

      // 9. Update modules array
      if (oldIndex >= 0) {
        modules[oldIndex] = adapted;
      } else {
        modules.push(adapted);
      }

      console.log(
        `[hot-reload] Plugin "${pluginName}" v${adapted.version} reloaded (${newTools.length} tools)`
      );
      return true;
    } catch (err) {
      console.error(
        `[hot-reload] Failed to reload "${pluginName}":`,
        err instanceof Error ? err.message : err
      );

      // Rollback: only if we actually stopped the old plugin (steps 1-4 errors
      // don't need rollback — old module is still running)
      if (oldModule && oldIndex >= 0 && oldStopped) {
        try {
          // Restore old tools in registry
          if (oldTools && oldTools.length > 0) {
            registry.replacePluginTools(pluginName, oldTools);
          }
          // Reopen plugin DB (stop() closed it)
          oldModule.migrate?.(pluginContext.db);
          await oldModule.start?.(pluginContext);
          console.warn(`[hot-reload] Rolled back to previous version of "${pluginName}"`);
        } catch {
          console.error(`[hot-reload] Rollback also failed for "${pluginName}" — plugin disabled`);
          registry.removePluginTools(pluginName);
          modules.splice(oldIndex, 1);
        }
      }

      return false;
    } finally {
      this.reloading = false;
    }
  }
}

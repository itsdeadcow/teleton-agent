import { Command } from "commander";
import { onboardCommand } from "./commands/onboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { main as startApp } from "../index.js";
import { configExists, getDefaultConfigPath } from "../config/loader.js";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

function findPackageJson(): Record<string, unknown> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8"));
    }
    dir = dirname(dir);
  }
  return { version: "0.0.0" };
}
const packageJson = findPackageJson();

const program = new Command();

program
  .name("teleton")
  .description("Teleton Agent - Personal AI Agent for Telegram")
  .version(packageJson.version as string);

// Setup command
program
  .command("setup")
  .description("Interactive wizard to set up Teleton")
  .option("--workspace <dir>", "Workspace directory")
  .option("--non-interactive", "Non-interactive mode")
  .option("--api-id <id>", "Telegram API ID")
  .option("--api-hash <hash>", "Telegram API Hash")
  .option("--phone <number>", "Phone number")
  .option("--api-key <key>", "Anthropic API key")
  .option("--user-id <id>", "Telegram User ID")
  .action(async (options) => {
    try {
      await onboardCommand({
        workspace: options.workspace,
        nonInteractive: options.nonInteractive,
        apiId: options.apiId ? parseInt(options.apiId) : undefined,
        apiHash: options.apiHash,
        phone: options.phone,
        apiKey: options.apiKey,
        userId: options.userId ? parseInt(options.userId) : undefined,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Start command
program
  .command("start")
  .description("Start the Teleton agent")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("--webui", "Enable WebUI server (overrides config)")
  .option("--webui-port <port>", "WebUI server port (default: 7777)")
  .action(async (options) => {
    try {
      // Check if config exists
      if (!configExists(options.config)) {
        console.error("❌ Configuration not found");
        console.error(`   Expected file: ${options.config}`);
        console.error("\n💡 Run first: teleton setup");
        process.exit(1);
      }

      // Set environment variables for WebUI flags (will be picked up by config loader)
      if (options.webui) {
        process.env.TELETON_WEBUI_ENABLED = "true";
      }
      if (options.webuiPort) {
        process.env.TELETON_WEBUI_PORT = options.webuiPort;
      }

      await startApp(options.config);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Run system health checks")
  .action(async () => {
    try {
      await doctorCommand();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.action(() => {
  program.help();
});

program.parse(process.argv);

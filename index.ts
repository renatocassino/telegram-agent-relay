import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { BridgeEngine, type BridgeConfig } from "./src/engine.ts";
import { StateStore } from "./src/state.ts";
import { SingleInstanceLock } from "./src/lock.ts";
import { relaxNetworkFamilyTimeout } from "./src/network.ts";

function loadEnv(): Record<string, string> {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = val;
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`
Telegram Agent Relay CLI 🚀
Walkie-talkie connecting Telegram to local AI agent sessions.

Usage:
  npx telegram-agent-relay [command] [options]
  telegram-agent-relay [command] [options]
Commands:
  start                     Start the bridge (default)
  status                    Check status and local lock
  --help, -h                Show this help message
  --version, -v             Show version

Options:
  --token <token>           Telegram Bot Token (or TELEGRAM_BOT_TOKEN)
  --chat <id>               Allowed Telegram Chat ID (or ALLOWED_CHAT_ID)
  --user <id>               Allowed Telegram User ID (or ALLOWED_USER_ID)
  --backend <orca|tmux|cmux> Terminal backend (default: orca)
  --target <id>             Specific target pane / handle (optional)
  --orca-bin <path>         Orca CLI binary (default: orca, or orca-ide on Linux/WSL)

Environment variables (.env file in working directory also supported):
  TELEGRAM_BOT_TOKEN        Bot token from @BotFather
  ALLOWED_CHAT_ID           Your Telegram chat id
  ALLOWED_USER_ID           Your Telegram user id
  TERMINAL_BACKEND          orca | tmux | cmux (default: orca)
  TARGET_ID                 Target handle or pane id
  ORCA_BIN                  Orca CLI binary (auto-detected: orca or orca-ide)
  NETWORK_FAMILY_TIMEOUT_MS Node only: per-attempt IPv6/IPv4 timeout (default 1000)
`);
}

function parseCliArgs(): {
  command: string;
  token?: string;
  chat?: string;
  user?: string;
  backend?: "orca" | "tmux" | "cmux";
  target?: string;
  orcaBin?: string;
} {
  const args = process.argv.slice(2);
  let command = "start";
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      console.log("telegram-agent-relay v0.1.1");
      process.exit(0);
    }
    if (!arg.startsWith("-") && i === 0) {
      command = arg;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("-")) {
        parsed[key] = val;
        i++;
      }
    }
  }

  const backendVal = parsed.backend;
  const backend =
    backendVal === "orca" || backendVal === "tmux" || backendVal === "cmux" ? backendVal : undefined;

  return {
    command,
    token: parsed.token,
    chat: parsed.chat,
    user: parsed.user,
    backend,
    target: parsed.target,
    orcaBin: parsed["orca-bin"],
  };
}

let lock: SingleInstanceLock | null = null;

async function main(): Promise<void> {
  const cli = parseCliArgs();
  const env = loadEnv();

  relaxNetworkFamilyTimeout({ ...env, ...process.env });
  const orcaBin = cli.orcaBin || process.env.ORCA_BIN || env.ORCA_BIN;
  if (orcaBin) process.env.ORCA_BIN = orcaBin;

  const botToken = cli.token || process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const allowedChatIdRaw = cli.chat || process.env.ALLOWED_CHAT_ID || env.ALLOWED_CHAT_ID;
  const allowedUserIdRaw = cli.user || process.env.ALLOWED_USER_ID || env.ALLOWED_USER_ID;
  const terminalBackend =
    cli.backend ||
    (process.env.TERMINAL_BACKEND as "orca" | "tmux" | "cmux") ||
    (env.TERMINAL_BACKEND as "orca" | "tmux" | "cmux") ||
    "orca";
  const targetId =
    cli.target ||
    process.env.TARGET_ID ||
    env.TARGET_ID ||
    process.env.ORCA_COORDINATOR_HANDLE ||
    env.ORCA_COORDINATOR_HANDLE;

  if (cli.command === "status") {
    const lockFile = join(process.cwd(), ".bridge.lock");
    const isRunning = SingleInstanceLock.isHeld(lockFile);
    const stale = !isRunning && existsSync(lockFile);
    console.log(`Telegram Agent Relay Status:`);
    console.log(`- Running locally: ${isRunning ? "Yes" : stale ? "No (stale lock from a crashed run)" : "No"}`);
    console.log(`- Backend: ${terminalBackend}`);
    console.log(`- Configured chat: ${allowedChatIdRaw || "None"}`);
    return;
  }

  if (!botToken || !allowedChatIdRaw || !allowedUserIdRaw) {
    console.error("❌ ERROR: Missing required configuration.");
    console.error("Provide via flags (--token, --chat, --user), .env file, or environment variables.\n");
    printUsage();
    process.exit(1);
  }

  const allowedChatId = parseInt(allowedChatIdRaw, 10);
  const allowedUserId = parseInt(allowedUserIdRaw, 10);

  if (isNaN(allowedChatId) || isNaN(allowedUserId)) {
    console.error("❌ ERROR: ALLOWED_CHAT_ID and ALLOWED_USER_ID must be valid integers.");
    process.exit(1);
  }

  lock = new SingleInstanceLock(join(process.cwd(), ".bridge.lock"));
  if (!lock.acquire()) {
    lock = null;
    console.error("❌ Another instance of telegram-agent-relay is already running in this directory!");
    process.exit(1);
  }

  const cleanup = () => {
    console.log("\n🛑 Shutting down Telegram Agent Relay Bridge...");
    lock?.release();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log("🚀 Starting Telegram Agent Relay Bridge...");
  const stateStore = new StateStore(join(process.cwd(), "state.json"));
  const config: BridgeConfig = {
    botToken,
    allowedChatId,
    allowedUserId,
    terminalBackend,
    targetId,
  };

  const engine = new BridgeEngine(config, stateStore);
  await engine.init();
  await engine.startPolling();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("💥 Fatal error:", msg);
  lock?.release();
  process.exit(1);
});

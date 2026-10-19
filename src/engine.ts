import { TelegramClient, type TelegramUpdate } from "./telegram.ts";
import { StateStore } from "./state.ts";
import { UniversalAgentWatcher } from "./backends/agents.ts";
import { OrcaBackend, TmuxBackend, CmuxBackend } from "./backends/terminals.ts";
import type { TerminalBackend } from "./backends/types.ts";
import { OrcaCLI } from "./orca.ts";

export interface BridgeConfig {
  botToken: string;
  allowedChatId: number;
  allowedUserId: number;
  terminalBackend?: "orca" | "tmux" | "cmux";
  targetId?: string;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class BridgeEngine {
  private telegram: TelegramClient;
  private backend: TerminalBackend;
  private orcaCli = new OrcaCLI();
  private agentWatcher: UniversalAgentWatcher;
  private messageQueue: string[] = [];
  private isProcessing = false;
  private isListening = true;
  private targetId: string | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private lastDeliveredId: string | null = null;

  private config: BridgeConfig;
  private stateStore: StateStore;

  constructor(config: BridgeConfig, stateStore: StateStore) {
    this.config = config;
    this.stateStore = stateStore;
    this.telegram = new TelegramClient(config.botToken);
    this.agentWatcher = new UniversalAgentWatcher();

    const backendType = config.terminalBackend || "orca";
    if (backendType === "tmux") {
      this.backend = new TmuxBackend();
    } else if (backendType === "cmux") {
      this.backend = new CmuxBackend();
    } else {
      this.backend = new OrcaBackend();
    }

    const state = this.stateStore.read();
    this.isListening = state.isListening ?? true;
    this.targetId = config.targetId || state.coordinatorHandle || null;

    const initial = this.agentWatcher.getLatestSettled();
    if (initial) {
      this.lastDeliveredId = initial.id;
    }
  }

  async init(): Promise<void> {
    const me = await this.telegram.getMe();
    console.log(`[BridgeEngine] Connected as @${me.username || me.first_name} (id: ${me.id})`);
    console.log(`[BridgeEngine] Active backend: ${this.backend.name}`);

    await this.ensureTarget();
    this.startSettledWatcher();
  }

  private async ensureTarget(): Promise<string> {
    if (this.targetId) {
      const list = await this.backend.listTargets();
      if (list.some((t) => t.id === this.targetId)) {
        return this.targetId;
      }
    }

    const resolved = await this.backend.resolveDefaultTarget();
    if (!resolved) {
      throw new Error(`Failed to find target on backend ${this.backend.name}`);
    }
    this.targetId = resolved;
    this.stateStore.save({ coordinatorHandle: resolved });
    console.log(`[BridgeEngine] Bound target on ${this.backend.name}: ${resolved}`);
    return resolved;
  }

  async startPolling(): Promise<void> {
    console.log("[BridgeEngine] Starting Telegram long polling loop...");
    let offset = this.stateStore.read().lastUpdateId;

    while (true) {
      try {
        const updates = await this.telegram.getUpdates(offset);
        for (const update of updates) {
          offset = update.update_id + 1;
          this.stateStore.save({ lastUpdateId: offset });
          await this.handleUpdate(update);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[BridgeEngine] Polling error, retrying:", msg);
        await delay(3000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (chatId !== this.config.allowedChatId || userId !== this.config.allowedUserId) {
      console.warn(`[BridgeEngine] Blocked unauthorized message from user ${userId}`);
      await this.telegram.sendMessage(chatId, "⛔ Acesso não autorizado.");
      return;
    }

    const text = msg.text.trim();
    if (chatId !== this.config.allowedChatId || userId !== this.config.allowedUserId) {
      console.warn(`[BridgeEngine] Blocked unauthorized message from user ${userId}`);
      await this.telegram.sendMessage(chatId, "⛔ Unauthorized access.");
      return;
    }

    if (!this.isListening) {
      await this.telegram.sendMessage(
        this.config.allowedChatId,
        "⏸️ Message listening is paused. Send /listen to resume."
      );
      return;
    }

    await this.enqueueMessage(text);
  }

  private async handleBuiltinCommand(cmd: string): Promise<boolean> {
    const parts = cmd.split(" ");
    const command = (parts[0] ?? "").toLowerCase();

    switch (command) {
      case "/help":
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `🛠️ **Telegram Agent Relay Commands**\n\n` +
            `• /status - View active backend, target handle/pane, and queue\n` +
            `• /listen - Resume forwarding messages to the terminal\n` +
            `• /stop - Pause forwarding messages\n` +
            `• /backend <orca|tmux|cmux> - Switch terminal backend\n` +
            `• /targets - List available windows/panes/tabs\n` +
            `• /runs - List multi-agent orchestration runs (Orca)\n` +
            `• /tasks <run_id> - List tasks for an orchestration run (Orca)\n` +
            `• /clear - Clear pending message queue\n` +
            `• /help - Show this command reference`
        );
        return true;

      case "/status":
        const target = this.targetId || "None";
        const stateText = this.isListening ? "🟢 Active (Listening)" : "🟡 Paused";
        const procText = this.isProcessing ? "⏳ Processing" : "💤 Idle";
        const queueCount = this.messageQueue.length;

        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `📊 **Telegram Agent Relay Status**\n\n` +
            `• Backend: \`${this.backend.name}\`\n` +
            `• Target: \`${target}\`\n` +
            `• Listening: ${stateText}\n` +
            `• State: ${procText}\n` +
            `• Queue: ${queueCount} message(s)`
        );
        return true;

      case "/backend":
        const newBackend = parts[1]?.toLowerCase();
        if (newBackend === "tmux") {
          this.backend = new TmuxBackend();
        } else if (newBackend === "cmux") {
          this.backend = new CmuxBackend();
        } else if (newBackend === "orca") {
          this.backend = new OrcaBackend();
        } else {
          await this.telegram.sendMessage(this.config.allowedChatId, "Usage: /backend <orca|tmux|cmux>");
          return true;
        }
        this.targetId = null;
        await this.ensureTarget();
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `🔄 Backend switched to \`${this.backend.name}\`. New target: \`${this.targetId}\``
        );
        return true;

      case "/targets":
        const list = await this.backend.listTargets();
        if (list.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, "No targets found on active backend.");
        } else {
          const formatted = list.map((t) => `• \`${t.id}\`: ${t.name}`).join("\n");
          await this.telegram.sendMessage(
            this.config.allowedChatId,
            `🎯 **Targets on ${this.backend.name}:**\n\n${formatted}`
          );
        }
        return true;

      case "/listen":
        this.isListening = true;
        this.stateStore.save({ isListening: true });
        await this.telegram.sendMessage(this.config.allowedChatId, "👂 Listening activated!");
        return true;

      case "/stop":
        this.isListening = false;
        this.stateStore.save({ isListening: false });
        await this.telegram.sendMessage(this.config.allowedChatId, "🛑 Listening paused!");
        return true;

      case "/runs":
        const runs = await this.orcaCli.listRuns();
        if (runs.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, "No active runs found in Orca.");
        } else {
          const runList = runs.map((r) => `• \`${r.id}\`: ${r.objective.slice(0, 80)}`).join("\n");
          await this.telegram.sendMessage(this.config.allowedChatId, `📋 **Orca Runs:**\n\n${runList}`);
        }
        return true;

      case "/tasks":
        const runId = parts[1];
        if (!runId) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Usage: /tasks <run_id>");
          return true;
        }
        const tasks = await this.orcaCli.listTasks(runId);
        if (tasks.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, `No tasks found for run ${runId}.`);
        } else {
          const taskList = tasks.map((t) => `• [${t.status}] \`${t.id}\`: ${t.task_title}`).join("\n");
          await this.telegram.sendMessage(this.config.allowedChatId, `📋 **Tasks \`${runId}\`:**\n\n${taskList}`);
        }
        return true;

      case "/clear":
        this.messageQueue = [];
        await this.telegram.sendMessage(this.config.allowedChatId, "🧹 Message queue cleared.");
        return true;
    }

    return false;
  }

  private async enqueueMessage(text: string): Promise<void> {
    if (this.isProcessing) {
      this.messageQueue.push(text);
      await this.telegram.sendMessage(
        this.config.allowedChatId,
        `⏳ Agent busy. Message enqueued (${this.messageQueue.length} ahead).`
      );
      return;
    }

    await this.processMessage(text);
  }

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    try {
      const handle = await this.ensureTarget();
      console.log(`[BridgeEngine] Dispatching to ${this.backend.name} [${handle}]: "${text}"`);
      const sent = await this.backend.send(handle, text);
      if (!sent) {
        await this.telegram.sendMessage(this.config.allowedChatId, `❌ Failed to dispatch to ${this.backend.name}.`);
      }
    } finally {
      setTimeout(() => {
        this.isProcessing = false;
        if (this.messageQueue.length > 0) {
          const next = this.messageQueue.shift();
          if (next) void this.processMessage(next);
        }
      }, 3000);
    }
  }

  private startSettledWatcher(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer);

    this.watcherTimer = setInterval(async () => {
      if (!this.isListening) return;

      const settled = this.agentWatcher.getLatestSettled();
      if (settled && settled.id !== this.lastDeliveredId) {
        this.lastDeliveredId = settled.id;
        console.log(`[BridgeEngine] Delivering ${settled.source} response to Telegram...`);
        await this.telegram.sendMessage(this.config.allowedChatId, settled.text);
      }
    }, 1500);
  }
}

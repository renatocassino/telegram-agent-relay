import { existsSync, readFileSync, writeFileSync } from "fs";

export interface BridgeState {
  lastUpdateId?: number;
  coordinatorHandle?: string;
  boundRunId?: string;
  isListening?: boolean;
}

export class StateStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): BridgeState {
    if (!existsSync(this.filePath)) {
      return {};
    }
    try {
      const content = readFileSync(this.filePath, "utf-8");
      return JSON.parse(content) as BridgeState;
    } catch {
      return {};
    }
  }

  save(partial: Partial<BridgeState>): void {
    const current = this.read();
    const updated = { ...current, ...partial };
    writeFileSync(this.filePath, JSON.stringify(updated, null, 2), "utf-8");
  }
}

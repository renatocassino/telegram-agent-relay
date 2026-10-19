export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
    };
    date: number;
    text?: string;
  };
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export class TelegramClient {
  private baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getMe(): Promise<TelegramUser> {
    const res = await fetch(`${this.baseUrl}/getMe`);
    const data = (await res.json()) as { ok: boolean; result: TelegramUser; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram getMe error: ${data.description}`);
    }
    return data.result;
  }

  async getUpdates(offset?: number, timeout: number = 25): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams();
    if (offset !== undefined) params.append("offset", offset.toString());
    params.append("timeout", timeout.toString());
    params.append("allowed_updates", JSON.stringify(["message"]));

    const res = await fetch(`${this.baseUrl}/getUpdates?${params.toString()}`, {
      signal: AbortSignal.timeout((timeout + 10) * 1000),
    });
    const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram getUpdates error: ${data.description}`);
    }
    return data.result;
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    const chunks = this.chunkText(text, 4000);
    for (const chunk of chunks) {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
        }),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        console.error(`[TelegramClient] Failed to send message: ${data.description}`);
      }
    }
  }

  private chunkText(str: string, size: number): string[] {
    const chunks: string[] = [];
    let remaining = str;
    while (remaining.length > 0) {
      if (remaining.length <= size) {
        chunks.push(remaining);
        break;
      }
      let sliceIdx = remaining.lastIndexOf("\n", size);
      if (sliceIdx <= 0) {
        sliceIdx = size;
      }
      chunks.push(remaining.slice(0, sliceIdx));
      remaining = remaining.slice(sliceIdx).replace(/^\n/, "");
    }
    return chunks;
  }
}

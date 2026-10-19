import net from "net";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * Node's fetch tries IPv6 and IPv4 in parallel ("happy eyeballs") and gives each attempt only 250 ms.
 * On WSL, where IPv6 is unreachable and the IPv4 handshake to api.telegram.org takes longer than that,
 * every request fails with ETIMEDOUT. A longer per-attempt timeout keeps happy eyeballs (IPv6 still works
 * where it exists) and fixes WSL. Bun has its own networking and does not expose this setting.
 * Override with NETWORK_FAMILY_TIMEOUT_MS.
 */
export function relaxNetworkFamilyTimeout(env: NodeJS.ProcessEnv = process.env): void {
  const n = net as typeof net & {
    getDefaultAutoSelectFamilyAttemptTimeout?: () => number;
    setDefaultAutoSelectFamilyAttemptTimeout?: (ms: number) => void;
  };
  if (typeof n.setDefaultAutoSelectFamilyAttemptTimeout !== "function") return;
  const wanted = Number(env.NETWORK_FAMILY_TIMEOUT_MS) || DEFAULT_ATTEMPT_TIMEOUT_MS;
  const current = n.getDefaultAutoSelectFamilyAttemptTimeout?.() ?? 0;
  if (current < wanted) n.setDefaultAutoSelectFamilyAttemptTimeout(wanted);
}

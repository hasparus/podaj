import type { Server } from "partyserver";

import type { Env } from "../env.js";

/** Push "ready" to agents listening on the handoff party room (best-effort). */
export const notifyHandoffReady = async (
  env: Env,
  handoffId: string,
  receiveUrl: string,
): Promise<void> => {
  try {
    const { getServerByName } = await import("partyserver");
    const stub = await getServerByName(
      env.HANDOFF_PARTY as DurableObjectNamespace<
        Server<{ HANDOFFS: KVNamespace }>
      >,
      handoffId,
    );
    await stub.fetch(
      new Request("https://handoff-party/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiveUrl }),
      }),
    );
  } catch {
    // WebSocket notify is optional; status polling remains the fallback.
  }
};

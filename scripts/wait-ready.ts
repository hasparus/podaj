export interface WaitOptions { timeoutMs?: number; connectTimeoutMs?: number; pollIntervalMs?: number }
type SocketResult = "gone" | "poll" | "ready" | "timeout";

import WebSocket from "ws";

/** WebSocket first; poll only after failure, under one bounded deadline. */
export const waitReady = async (id: string, base: string, subscribeToken: string, options: WaitOptions = {}) => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 8_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const statusUrl = new URL(`/api/handoffs/${id}/status`, base);
  const wsUrl = new URL(`/parties/handoff-party/${id}`, base);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const headers = { Authorization: `Bearer ${subscribeToken}` };

  const socketResult = await new Promise<SocketResult>((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl, { headers });
    const connectTimer = setTimeout(() => settle("poll"), connectTimeoutMs);
    const onDeadline = () => settle("timeout");

    function settle(result: SocketResult) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      deadline.removeEventListener("abort", onDeadline);
      socket.terminate();
      resolve(result);
    }

    deadline.addEventListener("abort", onDeadline, { once: true });
    if (deadline.aborted) onDeadline();
    socket.on("open", () => clearTimeout(connectTimer));
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "ready") settle("ready");
      if (message.type === "gone") {
        settle("gone");
      }
    });
    socket.on("error", () => settle("poll"));
    socket.on("close", () => settle("poll"));
  });

  if (socketResult === "ready") return;
  if (socketResult === "gone") throw new Error("handoff slot gone");
  if (socketResult === "timeout") throw new Error("timed out waiting for ready");

  try {
    while (!deadline.aborted) {
      const response = await fetch(statusUrl, {
        headers,
        redirect: "error",
        signal: deadline,
      });
      if (response.status === 401) throw new Error("subscription capability rejected");
      if (response.status === 503) throw new Error("this podaj is locked — run podaj config");
      const body: unknown = await response.json();
      const status = typeof body === "object" && body !== null && "status" in body
        ? body.status
        : undefined;
      if (response.status === 410 || status === "gone") {
        throw new Error("handoff slot gone");
      }
      if (response.status === 200 && status === "ready") return;
      if (!response.ok) throw new Error(`status check failed (${response.status})`);
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(timer);
          deadline.removeEventListener("abort", finish);
          resolve(undefined);
        };
        timer = setTimeout(finish, pollIntervalMs);
        deadline.addEventListener("abort", finish, { once: true });
        if (deadline.aborted) finish();
      });
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
  }
  throw new Error("timed out waiting for ready");
};

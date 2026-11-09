import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { recipientIdentity } from "../../scripts/instance.js";
import { seal } from "../../src/crypto/podaj1.js";

export type Malformation = "approval-fingerprint" | "overlap" | "malformed-capability" | "reservation-fingerprint" | "id" | "consumed-fingerprint" | "ciphertext-key";

/** An intentionally dishonest peer, only for CLI rejection tests; never a lifecycle success fixture. */
export const malformedServer = async (malformation: Malformation) => {
  const id = "1".repeat(32);
  const writeToken = "2".repeat(64);
  const readToken = "3".repeat(64);
  const subscribeToken = "4".repeat(64);
  let publicPem = "";
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/api/config") {
      send(200, { access: malformation === "approval-fingerprint" ? "public" : "private", handoffTtlSeconds: 7200, maxHandoffBytes: 32768 });
    } else if (path === "/api/demo/status") {
      send(200, { status: "approved", expiresAt: Date.now() + 60_000, recipientFingerprint: "f".repeat(64) });
    } else if (path === "/api/handoffs/reserve") {
      publicPem = (JSON.parse(body) as { recipientPublicKey: string }).recipientPublicKey;
      send(201, {
        id: malformation === "id" ? "../other" : id, writeToken, readToken,
        subscribeToken: malformation === "overlap" ? readToken : malformation === "malformed-capability" ? "bad" : subscribeToken,
        expiresAt: Date.now() + 60_000,
        recipientFingerprint: malformation === "reservation-fingerprint" ? "f".repeat(64) : recipientIdentity(publicPem).fingerprint,
      });
    } else if (path === `/api/handoffs/${id}/consume`) {
      const wrong = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      send(200, {
        sealed: await seal({ vars: [{ key: "API_KEY", value: "must-not-output" }] }, malformation === "ciphertext-key" ? wrong.publicKey : publicPem),
        recipientFingerprint: malformation === "consumed-fingerprint" ? "f".repeat(64) : recipientIdentity(publicPem).fingerprint,
      });
    } else send(404, {});
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send(JSON.stringify({ type: "ready" })));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing local address");
  return {
    paths, origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((done) => sockets.close(() => done()));
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
};

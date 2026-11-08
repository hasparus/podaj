import { createServer } from "node:http";

export const syntheticAccounts = ["a".repeat(32), "b".repeat(32)];
export const localCloudflare = async (onSecretWrite?: () => void) => {
  const requests: { method: string; path: string; secretMatched?: boolean }[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url!;
    const method = request.method!;
    const item: (typeof requests)[number] = { method, path };
    requests.push(item);
    response.setHeader("Content-Type", "application/json");
    const ok = (result: unknown) => response.end(JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page: 1, per_page: 50, total_pages: 1, count: 2, total_count: 2 } }));
    if (path.startsWith("/memberships")) {
      ok(syntheticAccounts.map((id, index) => ({ id, status: "accepted", account: { id, name: `Synthetic account ${index + 1}` } })));
    } else if (path === "/user/tokens/verify") {
      ok({ id: "synthetic-token", status: "active" });
    } else if (path === "/user") {
      ok({ id: "synthetic-user", email: "synthetic@example.test" });
    } else if (/^\/accounts\/[ab]{32}\/workers\/scripts\/synthetic-worker\/secrets$/u.test(path)) {
      if (method === "PUT") {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const value = JSON.parse(body) as { name?: string; text?: string; type?: string };
        item.secretMatched = value.name === "PODAJ_API_AUTH_SECRET" && value.text === "synthetic-adapter-secret" && value.type === "secret_text";
        onSecretWrite?.();
        ok({ name: "PODAJ_API_AUTH_SECRET", type: "secret_text" });
      } else ok([]);
    } else {
      response.writeHead(403);
      response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "synthetic API stops before deployment" }], result: null }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no local API address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
};

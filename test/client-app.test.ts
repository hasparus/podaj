import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { init, Message, update, type Model } from "../src/client/app.js";
import { open } from "../src/crypto/podaj1.js";

const ID = "a".repeat(32);
const WRITE = "b".repeat(64);
const NAME = "PRIVATE_DATABASE_CREDENTIAL_FOR_TEST";
const VALUE = "synthetic-sensitive-value-not-for-the-server-12345";
const fetchMock = vi.fn<typeof fetch>();
let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64")}\n-----END PUBLIC KEY-----`;
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`;
});
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const noCommands = (result: ReturnType<typeof update>) => expect(result.commands ?? []).toHaveLength(0);
const run = async (result: ReturnType<typeof update>) => {
  expect(result.commands).toHaveLength(1);
  const command = result.commands?.[0];
  if (!command) throw new Error("missing command");
  return Effect.runPromise(command.effect);
};
const ready = async () => {
  const initial = init({ page: "compose", handoffId: ID, writeToken: WRITE, publicKeyPem });
  fetchMock.mockResolvedValueOnce(Response.json({ mode: "private", maxHandoffBytes: 32768, handoffTtlSeconds: 7200 }));
  let model = initial.model;
  for (const command of initial.commands ?? []) model = update(model, await Effect.runPromise(command.effect)).model;
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/config", expect.anything());
  fetchMock.mockClear();
  return model;
};
const filled = (model: Model) => update(model, Message.PastedEnv({ text: `${NAME}=${VALUE}\n` })).model;
const editMessages = (id: string) => [
  Message.ChangedRowKey({ rowId: id, key: "CHANGED" }),
  Message.ChangedRowValue({ rowId: id, value: "changed" }),
  Message.ClickedAdd(), Message.ClickedRemoveRow({ rowId: id }),
  Message.ClickedToggleReveal({ rowId: id }), Message.PastedEnv({ text: "OTHER=value\n" }),
];

describe("CLI-created human fill form", () => {
  it("does not create browser recipients, keys, links, or reservations on the landing page", () => {
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    const initial = init({ page: "landing" });
    noCommands(initial);
    noCommands(update(initial.model, Message.ClickedSend()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect("ClickedCreate" in Message).toBe(false);
    expect("privateKey" in initial.model).toBe(false);
  });

  it("requires a complete CLI fill link before loading anything", () => {
    const initial = init({ page: "compose", handoffId: ID, writeToken: null, publicKeyPem: null });
    noCommands(initial);
    noCommands(update(initial.model, Message.ClickedSend()));
    expect(initial.model.status).toMatchObject({ _tag: "Error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never uploads on typing, adding/removing rows, revealing, or pasting", async () => {
    let model = await ready();
    for (const message of editMessages("1")) {
      const result = update(model, message);
      noCommands(result);
      model = result.model;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only ciphertext with the write capability, never plaintext, a private key, or owner auth", async () => {
    const model = filled(await ready());
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    const submitted = update(model, Message.ClickedSend());
    fetchMock.mockResolvedValueOnce(Response.json({ id: ID, expiresAt: Date.now() + 7200000 }));
    const sent = await run(submitted);
    expect(sent._tag).toBe("SucceededSend");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/handoffs/${ID}`);
    expect(options?.method).toBe("PUT");
    expect(options?.headers).toEqual({ Authorization: `Bearer ${WRITE}`, "Content-Type": "application/json" });
    const wire = String(options?.body);
    expect(wire).not.toContain(NAME);
    expect(wire).not.toContain(VALUE);
    expect(wire).not.toContain("PRIVATE KEY");
    const body = JSON.parse(wire);
    expect(Object.keys(body)).toEqual(["sealed"]);
    expect(body.sealed).toMatch(/^PODAJ1\./u);
    expect((await open(body.sealed, privateKeyPem)).payload).toEqual({ vars: [{ key: NAME, value: VALUE }] });
    expect(generate.mock.calls.every(([algorithm]) => typeof algorithm === "object" && algorithm.name === "AES-GCM")).toBe(true);
    const done = update(submitted.model, sent).model;
    expect(done.sent).toBe(true);
    expect(done.rows.every((row) => row.value === "")).toBe(true);
  });

  it.each(["sending", "sent"] as const)("ignores edits and double submissions when %s", async (state) => {
    const model = { ...filled(await ready()), [state]: true };
    for (const message of [...editMessages(model.rows[0].id), Message.ClickedSend()]) {
      const result = update(model, message);
      noCommands(result);
      expect(result.model).toBe(model);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["", "value", "Complete each"], ["INCOMPLETE", "", "Complete each"],
    ["BAD-NAME", "value", "valid environment"], [NAME, "duplicate", "Duplicate key"],
  ])("rejects incomplete, invalid, and duplicate rows: %s", async (key, value, error) => {
    let model = filled(await ready());
    const rowId = model.rows.at(-1)!.id;
    model = update(model, Message.ChangedRowKey({ rowId, key })).model;
    model = update(model, Message.ChangedRowValue({ rowId, value })).model;
    const result = update(model, Message.ClickedSend());
    noCommands(result);
    expect(result.model.status).toEqual({ _tag: "Error", text: expect.stringContaining(error) });
    expect(result.model.rows).toEqual(model.rows);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([409, 410, 503])("retains values after a failed %i send", async (status) => {
    const model = filled(await ready());
    const submitted = update(model, Message.ClickedSend());
    fetchMock.mockResolvedValueOnce(Response.json({ error: status === 409 ? "already shared" : "gone" }, { status }));
    const failed = update(submitted.model, await run(submitted)).model;
    expect(failed.sent).toBe(false);
    expect(failed.sending).toBe(false);
    expect(failed.rows).toEqual(model.rows);
    expect(failed.status._tag).toBe("Error");
  });

  it("does not upload an encrypted bundle over the configured limit", async () => {
    const model = { ...filled(await ready()), maxHandoffBytes: 1 };
    const submitted = update(model, Message.ClickedSend());
    expect((await run(submitted))._tag).toBe("FailedSend");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

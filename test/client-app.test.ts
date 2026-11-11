import { Effect, Option } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Scene from "foldkit/scene";
import { init, Message, update, view, type Model } from "../src/client/app.js";
import { openPodaj1 } from "../scripts/open-podaj1.js";

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
const ready = async (access: "private" | "public" = "private", origin = "", requestedKeys: readonly string[] = []) => {
  const initial = init({ page: "compose", source: { _tag: "Expanded", id: ID, writeToken: WRITE, recipientPublicKey: publicKeyPem, requestedKeys } }, origin);
  fetchMock.mockResolvedValueOnce(Response.json({ access, maxHandoffBytes: 32768, handoffTtlSeconds: 7200 }));
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

  it("copies the exact command only after a landing-page click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const initial = init({ page: "landing" });
    expect(writeText).not.toHaveBeenCalled();
    const clicked = update(initial.model, Message.ClickedCopyCommand());
    const copied = update(clicked.model, await run(clicked));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("podaj wait API_KEY");
    expect(copied.model.status).toEqual({ _tag: "Ok", text: "Command copied." });
    noCommands(copied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["denied", "unavailable"] as const)("offers manual copying when clipboard access is %s", async (mode) => {
    const clipboard = mode === "denied" ? { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) } : undefined;
    vi.stubGlobal("navigator", { clipboard });
    const clicked = update(init({ page: "landing" }).model, Message.ClickedCopyCommand());
    const failed = update(clicked.model, await run(clicked));
    expect(failed.model.status).toEqual({ _tag: "Error", text: "Couldn't copy. Select the command and copy it manually." });
    noCommands(failed);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not copy from the secret entry form", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    noCommands(update(await ready(), Message.ClickedCopyCommand()));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("requires a complete CLI fill link before loading anything", () => {
    const initial = init({ page: "compose", source: { _tag: "Invalid", id: ID } });
    noCommands(initial);
    noCommands(update(initial.model, Message.ClickedSend()));
    expect(initial.model.status).toMatchObject({ _tag: "Error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["private", "public"] as const)("loads a capability fill form with %s access without an admission handshake", async (access) => {
    const model = await ready(access);
    expect(Option.isSome(model.sender)).toBe(true);
    expect(model.sending).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefills requested labels with empty hidden values and stable editable rows", async () => {
    let model = await ready("private", "", ["PASSWORD", "my access token"]);
    expect(model.rows).toEqual([
      { id: "1", key: "PASSWORD", value: "", revealed: false },
      { id: "2", key: "my access token", value: "", revealed: false },
    ]);
    expect(model.nextRowId).toBe(3);
    for (const message of [
      Message.ChangedRowKey({ rowId: "1", key: "renamed label" }),
      Message.ChangedRowValue({ rowId: "1", value: VALUE }),
      Message.ClickedRemoveRow({ rowId: "2" }), Message.ClickedAdd(),
    ]) {
      const result = update(model, message);
      noCommands(result);
      model = result.model;
    }
    expect(model.rows).toEqual([
      { id: "1", key: "renamed label", value: VALUE, revealed: false },
      { id: "3", key: "", value: "", revealed: false },
    ]);
    expect(model.nextRowId).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders untrusted label markup as a plain editable input value", async () => {
    const key = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const model = await ready("private", "", [key]);
    Scene.scene({ update, view },
      Scene.given(model),
      Scene.expect(Scene.label("key")).toHaveValue(key),
      Scene.expect(Scene.label("key")).toBeEnabled(),
      Scene.expect(Scene.label("value")).toHaveValue(""),
      Scene.expect(Scene.selector('input[type="password"]')).toExist(),
      Scene.expect(Scene.selector("script")).toBeAbsent(),
      Scene.expect(Scene.selector("img")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "show" })).toBeAbsent(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a single blank row for legacy links without requested labels", async () => {
    const model = await ready();
    expect(model.rows).toEqual([{ id: "1", key: "", value: "", revealed: false }]);
    expect(model.nextRowId).toBe(2);
  });

  it("matches pasted names to empty requested rows and encrypts all extra fields only after send", async () => {
    let model = await ready("private", "", ["PASSWORD", "other label"]);
    model = update(model, Message.ClickedAdd()).model;
    const result = update(model, Message.PastedEnv({ text: `EXTRA=unexpected\nother label=another\nPASSWORD=${VALUE}\n` }));
    noCommands(result);
    model = result.model;
    expect(model.rows).toEqual([
      { id: "1", key: "PASSWORD", value: VALUE, revealed: false },
      { id: "2", key: "other label", value: "another", revealed: false },
      { id: "3", key: "EXTRA", value: "unexpected", revealed: false },
      { id: "4", key: "", value: "", revealed: false },
    ]);
    expect(model.nextRowId).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ id: ID, expiresAt: Date.now() + 7200000 }));
    expect((await run(update(model, Message.ClickedSend())))._tag).toBe("SucceededSend");
    const wire = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(wire).not.toContain("PASSWORD");
    expect(wire).not.toContain("other label");
    expect(wire).not.toContain("EXTRA");
    expect(wire).not.toContain(VALUE);
    expect(JSON.parse(openPodaj1(JSON.parse(wire).sealed, privateKeyPem))).toEqual({ vars: [
      { key: "PASSWORD", value: VALUE }, { key: "other label", value: "another" }, { key: "EXTRA", value: "unexpected" },
    ] });
  });

  it("preserves edited requested rows, value-only partial rows, and conflicting pasted values", async () => {
    let model = await ready("private", "", ["PASSWORD", "IN_PROGRESS", "OTHER"]);
    model = update(model, Message.ChangedRowValue({ rowId: "1", value: VALUE })).model;
    model = update(model, Message.ChangedRowKey({ rowId: "3", key: "" })).model;
    model = update(model, Message.ChangedRowValue({ rowId: "3", value: "unfinished value" })).model;
    const before = model.rows;
    const result = update(model, Message.PastedEnv({ text: "PASSWORD=conflict\nEXTRA=extra\n" }));
    noCommands(result);
    expect(result.model.rows.slice(0, 3)).toEqual(before);
    expect(result.model.rows.slice(3).map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "PASSWORD", value: "conflict" }, { key: "EXTRA", value: "extra" }, { key: "", value: "" },
    ]);
    expect(new Set(result.model.rows.map((row) => row.id)).size).toBe(result.model.rows.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves duplicate pasted names for existing duplicate validation", async () => {
    const model = await ready("private", "", ["PASSWORD"]);
    const pasted = update(model, Message.PastedEnv({ text: "PASSWORD=\nPASSWORD=second\n" }));
    noCommands(pasted);
    expect(pasted.model.rows.filter((row) => row.key === "PASSWORD").map((row) => row.value)).toEqual(["", "second"]);
    const completed = update(pasted.model, Message.ChangedRowValue({ rowId: "1", value: "first" })).model;
    const submitted = update(completed, Message.ClickedSend());
    noCommands(submitted);
    expect(submitted.model.status).toEqual({ _tag: "Error", text: "Duplicate key: PASSWORD." });
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
    expect(JSON.parse(openPodaj1(body.sealed, privateKeyPem))).toEqual({ vars: [{ key: NAME, value: VALUE }] });
    expect(generate.mock.calls.every(([algorithm]) => typeof algorithm === "object" && algorithm.name === "AES-GCM")).toBe(true);
    const done = update(submitted.model, sent).model;
    expect(done.sent).toBe(true);
    expect(done.rows.every((row) => row.value === "")).toBe(true);
  });

  it("merges pasted rows without losing edits, partial rows, or row identity", async () => {
    let model = filled(await ready());
    const original = model.rows[0];
    model = update(model, Message.ClickedToggleReveal({ rowId: original.id })).model;
    const spare = model.rows.at(-1)!;
    model = update(model, Message.ChangedRowKey({ rowId: spare.id, key: "IN_PROGRESS" })).model;
    model = update(model, Message.ClickedAdd()).model;
    const vacantId = model.rows.at(-1)!.id;
    const before = model.rows.slice(0, -1);
    const result = update(model, Message.PastedEnv({ text: "EXTRA=one\nANOTHER=two\n" }));
    noCommands(result);
    expect(result.model.rows.slice(0, before.length)).toEqual(before);
    expect(result.model.rows[0].revealed).toBe(true);
    expect(result.model.rows.find((row) => row.id === vacantId)).toMatchObject({ key: "EXTRA", value: "one" });
    expect(result.model.rows.at(-2)).toMatchObject({ key: "ANOTHER", value: "two" });
    expect(result.model.rows.at(-1)).toMatchObject({ key: "", value: "" });
    expect(new Set(result.model.rows.map((row) => row.id)).size).toBe(result.model.rows.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps both values when a paste conflicts with an existing name", async () => {
    const model = filled(await ready());
    const pasted = update(model, Message.PastedEnv({ text: `${NAME}=another-value\n` })).model;
    expect(pasted.rows.filter((row) => row.key === NAME).map((row) => row.value)).toEqual([VALUE, "another-value"]);
    const submitted = update(pasted, Message.ClickedSend());
    noCommands(submitted);
    expect(submitted.model.status).toEqual({ _tag: "Error", text: `Duplicate key: ${NAME}.` });
    expect(fetchMock).not.toHaveBeenCalled();
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
    [NAME, "duplicate", "Duplicate key"],
  ])("rejects incomplete and duplicate rows: %s", async (key, value, error) => {
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
    fetchMock.mockResolvedValueOnce(Response.json({ error: status === 409 ? "already filled" : "gone" }, { status }));
    const failed = update(submitted.model, await run(submitted)).model;
    expect(failed.sent).toBe(false);
    expect(failed.sending).toBe(false);
    expect(failed.rows).toEqual(model.rows);
    expect(failed.status._tag).toBe("Error");
  });

  it.each(["MY.KEY", "service-token", "the token I use to call this service", "🔑 access"])("encrypts arbitrary name labels unchanged: %s", async (key) => {
    let model = await ready();
    model = update(model, Message.ChangedRowKey({ rowId: "1", key })).model;
    model = update(model, Message.ChangedRowValue({ rowId: "1", value: VALUE })).model;
    fetchMock.mockResolvedValueOnce(Response.json({ id: ID, expiresAt: Date.now() + 7200000 }));
    expect((await run(update(model, Message.ClickedSend())))._tag).toBe("SucceededSend");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(openPodaj1(body.sealed, privateKeyPem))).toEqual({ vars: [{ key, value: VALUE }] });
  });

  it.each([
    ["https://podaj.fyi", "public", true],
    ["https://self-hosted.example", "public", false],
    ["https://private.example", "private", false],
    ["https://podaj.fyi.attacker.example", "public", false],
  ] as const)("explains quotas on every instance and identifies only the actual demo: %s", async (origin, access, demo) => {
    const model = filled(await ready(access, origin));
    const submitted = update(model, Message.ClickedSend());
    fetchMock.mockResolvedValueOnce(Response.json({ error: "limit reached", quota: {
      kind: "reservations_daily", limit: 137, periodSeconds: 86400, resetAt: Date.UTC(2030, 0, 2),
    } }, { status: 429 }));
    const result = update(submitted.model, await run(submitted)).model;
    expect(result.sending).toBe(false);
    expect(result.rows).toEqual(model.rows);
    expect(result.hostedDemo).toBe(demo);
    expect(result.status).toMatchObject({ _tag: "RateLimited", text: expect.stringContaining("Daily handoff limit reached (137)"), ownerHelp: expect.stringContaining("DEMO_LIMITS.reservationsPerDay") });
    if (result.status._tag === "RateLimited") {
      expect(result.status.text).toContain("00:00 UTC");
      expect(result.status.text).not.toContain("Collect");
      expect(result.status.ownerHelp).not.toContain("HANDOFF_TTL_SECONDS");
    }
  });

  it("also recognizes a demo limit while loading configuration", async () => {
    const initial = init({ page: "compose", source: { _tag: "Expanded", id: ID, writeToken: WRITE, recipientPublicKey: publicKeyPem, requestedKeys: [] } }, "https://podaj.fyi");
    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate limited" }, { status: 429 }));
    let model = initial.model;
    for (const command of initial.commands ?? []) {
      model = update(model, await Effect.runPromise(command.effect)).model;
    }
    expect(model.status).toMatchObject({ _tag: "RateLimited", text: "Request limit reached.", ownerHelp: "" });
    expect(Option.isNone(model.sender)).toBe(true);
  });

  it("does not label unrelated demo failures as quota exhaustion", async () => {
    const submitted = update(filled(await ready("public", "https://podaj.fyi")), Message.ClickedSend());
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    expect(update(submitted.model, await run(submitted)).model.status).toEqual({ _tag: "Error", text: "This instance is unavailable or not fully configured. Try again later." });
  });

  it("does not upload an encrypted bundle over the configured limit", async () => {
    const filledModel = filled(await ready());
    const model = { ...filledModel, sender: Option.map(filledModel.sender, (sender) => ({ ...sender, maxHandoffBytes: 1 })) };
    const submitted = update(model, Message.ClickedSend());
    expect((await run(submitted))._tag).toBe("FailedSend");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

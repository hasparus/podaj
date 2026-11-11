import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAuthorizationPage } from "../src/authorize.js";
import { publicKeyToFragment } from "../src/crypto/podaj1.js";
import { sealRequestContext } from "../src/crypto/request-context.js";
import { AUTHORIZATION_STATUS } from "../src/client/user-facing.js";

const id = "a".repeat(32);
const writeToken = "b".repeat(64);
const challenge = "c".repeat(64);
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
type Render = NonNullable<Window["turnstile"]>["render"];

class ElementStub {
  textContent = "";
  className = "";
  readonly listeners = new Map<string, () => void>();
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, callback); }
  appendChild() { }
  replaceChildren() { }
}

const deferred = <T>() => {
  let resolve: (value: T) => void;
  let reject: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve: (value: T) => { resolve(value); }, reject: (reason: Error) => { reject(reason); } };
};

const approvalResponse = () => Response.json({ approved: true, expiresAt: Date.now() + 60_000 });
const writableResponse = () => Response.json({ authorized: true });
const goneResponse = () => Response.json({ status: "gone" }, { status: 410 });
const cleanups: (() => Promise<void>)[] = [];
const page = async (legacyHash?: string) => {
  const encrypted = await sealRequestContext(id, { version: 1, recipientPublicKey: publicKey, writeToken, requestedKeys: ["PASSWORD"], challenge });
  const status = new ElementStub();
  const widget = new ElementStub();
  const replace = vi.fn();
  const render = vi.fn<Render>().mockReturnValue("local-test");
  const appendChild = vi.fn((script: ElementStub) => { script.listeners.get("load")?.(); });
  const markers = new Map<string, string>();
  const session = {
    getItem: vi.fn((key: string) => markers.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { markers.set(key, value); }),
  };
  const reservation = deferred<Response>();
  const preflight = vi.fn(async () => goneResponse());
  const approval = vi.fn(async () => approvalResponse());
  const config = vi.fn(async () => Response.json({ access: "public", turnstileSiteKey: "local-test" }));
  let contextBody = encrypted.encryptedContext;
  let writerCalls = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url === `/api/contexts/${id}`) { return Response.json({ id, encryptedContext: contextBody, expiresAt: Date.now() + 60_000 }); }
    if (url === `/api/handoffs/${id}/writable`) {
      writerCalls += 1;
      return writerCalls === 1 ? await preflight() : await reservation.promise;
    }
    if (url === "/api/demo/approve") { return await approval(); }
    if (url === "/api/config") { return await config(); }
    throw new Error(`unexpected request ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("window", { turnstile: { render } });
  vi.stubGlobal("location", { pathname: legacyHash === undefined ? `/authorize/${id}` : "/authorize", hash: legacyHash ?? `#${encrypted.key}`, origin: "https://podaj.fyi", replace });
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#authorize-status" ? status : widget,
    createElement: () => new ElementStub(),
    createTextNode: () => new ElementStub(),
    head: { appendChild },
  });
  cleanups.push(async () => {
    reservation.resolve(writableResponse());
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  const options = () => {
    const value = render.mock.calls[0]?.[1];
    if (value === undefined) { throw new Error("missing challenge"); }
    return value;
  };
  return {
    ...encrypted, status, replace, render, appendChild, session, fetcher, preflight, approval, config, options,
    reserve: () => reservation.resolve(writableResponse()),
    reservationFailure: () => reservation.resolve(Response.json({}, { status: 503 })),
    tamper: () => { contextBody = `${contextBody[0] === "A" ? "B" : "A"}${contextBody.slice(1)}`; },
  };
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) { await cleanup(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("production verification-page continuation", () => {
  it("automatically returns to the short prefilled form and ignores duplicate approval callbacks", async () => {
    const fixture = await page();
    await mountAuthorizationPage();
    expect(fixture.status.textContent).toBe(AUTHORIZATION_STATUS.waiting);
    const options = fixture.options();
    expect(options.action).toBe("podaj-admission");
    expect(options.cData).toMatch(/^[a-f0-9]{64}$/u);
    await Promise.all([options.callback("synthetic-proof"), options.callback("synthetic-proof")]);
    expect(fixture.status.textContent).toBe(AUTHORIZATION_STATUS.verified);
    expect(fixture.replace).not.toHaveBeenCalled();
    fixture.reserve();
    await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/s/${id}#${fixture.key}`));
    expect(fixture.session.setItem).toHaveBeenCalledExactlyOnceWith(`podaj:approved:${id}`, challenge);
    const approval = fixture.fetcher.mock.calls.filter(([url]) => url === "/api/demo/approve");
    expect(approval).toHaveLength(1);
    expect(Object.keys(JSON.parse(String(approval[0][1]?.body)))).toEqual(["challenge", "recipientPublicKey", "turnstileToken"]);
    expect(JSON.stringify(fixture.fetcher.mock.calls)).not.toContain(fixture.key);
    expect(JSON.stringify(fixture.fetcher.mock.calls)).not.toContain("PASSWORD");
    options["error-callback"](); options["expired-callback"]();
    await options.callback("late-proof");
    expect(fixture.status.textContent).toBe(AUTHORIZATION_STATUS.verified);
    expect(fixture.approval).toHaveBeenCalledTimes(1);
  });

  it("skips another captcha on reload when the CLI already reserved", async () => {
    const fixture = await page();
    fixture.preflight.mockResolvedValueOnce(writableResponse());
    await mountAuthorizationPage();
    expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/s/${id}#${fixture.key}`);
    expect(fixture.render).not.toHaveBeenCalled();
    expect(fixture.appendChild).not.toHaveBeenCalled();
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  });

  it("resumes waiting from only a public challenge marker, still requiring writer preflight", async () => {
    const fixture = await page();
    fixture.session.setItem(`podaj:approved:${id}`, challenge);
    await mountAuthorizationPage();
    expect(fixture.status.textContent).toBe(AUTHORIZATION_STATUS.verified);
    expect(fixture.replace).not.toHaveBeenCalled();
    fixture.reserve();
    await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/s/${id}#${fixture.key}`));
    expect(fixture.render).not.toHaveBeenCalled();
    expect(fixture.appendChild).not.toHaveBeenCalled();
    expect(fixture.fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/api/contexts/${id}`, `/api/handoffs/${id}/writable`, `/api/handoffs/${id}/writable`,
    ]);
  });

  it("continues an already-approved challenge while requiring writer authorization", async () => {
    const fixture = await page();
    fixture.approval.mockResolvedValueOnce(Response.json({ error: "already approved" }, { status: 409 }));
    await mountAuthorizationPage();
    await fixture.options().callback("synthetic-proof");
    expect(fixture.replace).not.toHaveBeenCalled();
    fixture.reserve();
    await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/s/${id}#${fixture.key}`));
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/writable")).every(([, options]) =>
      new Headers(options?.headers).get("Authorization") === `Bearer ${writeToken}`)).toBe(true);
  });

  it("recovers after server acceptance when reload lost the response and marker, without another approval", async () => {
    const fixture = await page();
    await mountAuthorizationPage();
    fixture.reserve();
    await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/s/${id}#${fixture.key}`));
    expect(fixture.session.setItem).not.toHaveBeenCalled();
    expect(fixture.approval).not.toHaveBeenCalled();
  });

  it("keeps a reservation failure terminal even when approval resolves later", async () => {
    const fixture = await page();
    const pending = deferred<Response>();
    fixture.approval.mockReturnValueOnce(pending.promise);
    await mountAuthorizationPage();
    const options = fixture.options();
    const callback = options.callback("synthetic-proof");
    fixture.reservationFailure();
    await vi.waitFor(() => expect(fixture.status.className).toBe("status error"));
    const failure = fixture.status.textContent;
    pending.resolve(approvalResponse());
    await callback;
    options["error-callback"](); options["expired-callback"]();
    await options.callback("late-proof");
    expect(fixture.status.textContent).toBe(failure);
    expect(fixture.session.setItem).not.toHaveBeenCalled();
    expect(fixture.replace).not.toHaveBeenCalled();
    expect(fixture.approval).toHaveBeenCalledTimes(1);
  });

  it("ignores late approval failures after the watcher has navigated", async () => {
    const fixture = await page();
    const pending = deferred<Response>();
    fixture.approval.mockReturnValueOnce(pending.promise);
    await mountAuthorizationPage();
    const callback = fixture.options().callback("synthetic-proof");
    fixture.reserve();
    await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledTimes(1));
    const text = fixture.status.textContent;
    pending.reject(new Error("synthetic-untrusted-reason"));
    await callback;
    fixture.options()["error-callback"]();
    expect(fixture.status.textContent).toBe(text);
    expect(fixture.status.className).not.toBe("status error");
  });

  it("does not load third-party scripts or navigate if context authentication fails", async () => {
    const fixture = await page();
    fixture.tamper();
    await mountAuthorizationPage();
    expect(fixture.status.className).toBe("status error");
    expect(fixture.status.textContent).toContain("Ask for a new link");
    expect(fixture.render).not.toHaveBeenCalled();
    expect(fixture.appendChild).not.toHaveBeenCalled();
    expect(fixture.replace).not.toHaveBeenCalled();
  });
});

describe("published 0.1.0 authorization links", () => {
  const legacy = `#challenge=${challenge}&recipient=${publicKeyToFragment(publicKey)}`;
  it("accepts the exact published two-field fragment without writer authority or a reservation watcher", async () => {
    const fixture = await page(legacy);
    await mountAuthorizationPage();
    await fixture.options().callback("synthetic-proof");
    expect(fixture.status.textContent).toBe("Verified. Return to your CLI.");
    expect(fixture.status.className).toBe("status ok");
    expect(fixture.fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/config", "/api/demo/approve"]);
    expect(fixture.replace).not.toHaveBeenCalled();
    expect(fixture.session.setItem).not.toHaveBeenCalled();
    fixture.options()["error-callback"](); fixture.options()["expired-callback"]();
    await fixture.options().callback("duplicate-proof");
    expect(fixture.status.textContent).toBe("Verified. Return to your CLI.");
    expect(fixture.approval).toHaveBeenCalledTimes(1);
  });

  it.each(["", `${legacy}&id=${id}`, `${legacy}&write=${writeToken}`, `${legacy}&keys=[]`, `${legacy}&id=${id}&write=${writeToken}&keys=[]`, `${legacy}&challenge=${challenge}`, `${legacy}&recipient=${publicKeyToFragment(publicKey)}`])("rejects incomplete or unshipped expanded authorization fragments: %s", async (hash) => {
    const fixture = await page(hash);
    await mountAuthorizationPage();
    expect(fixture.status.textContent).toContain("incomplete");
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.render).not.toHaveBeenCalled();
  });
});

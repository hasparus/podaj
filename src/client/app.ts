import { Effect, Option, Schema } from "effect";
import { Runtime, type Update } from "foldkit";
import { define as DefineCommand } from "foldkit/command";
import { Document, HtmlBuilder, type Html } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { publicKeyFingerprint, seal, validateRecipientPublicKey, type HandoffVariables } from "../crypto/podaj1.js";
import { eyeOffPaths, eyePaths, trashPaths } from "./icons.js";
import { looksLikeEnvPaste, parseEnvText } from "./parse-env.js";
import type { AppRoute } from "./parse-route.js";
import { apiHandoffErrorText, causeMessage, HOW_IT_WORKS, statusError } from "./user-facing.js";

const Row = Schema.Struct({ id: Schema.String, key: Schema.String, revealed: Schema.Boolean, value: Schema.String });
const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Hidden") }),
  Schema.Struct({ _tag: Schema.Literal("Ok"), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Error"), text: Schema.String }),
]);
const Limits = Schema.Struct({ maxHandoffBytes: Schema.Number });
const Sent = Schema.Struct({ id: Schema.String, expiresAt: Schema.Number });

export const ModelSchema = Schema.Struct({
  page: Schema.Literals(["landing", "compose"]),
  handoffId: Schema.Option(Schema.String),
  writeToken: Schema.Option(Schema.String),
  publicKeyPem: Schema.Option(Schema.String),
  fingerprint: Schema.Option(Schema.String),
  recipientReady: Schema.Boolean,
  limitsReady: Schema.Boolean,
  maxHandoffBytes: Schema.Number,
  nextRowId: Schema.Number,
  rows: Schema.Array(Row),
  sending: Schema.Boolean,
  sent: Schema.Boolean,
  status: Status,
});
export type Model = typeof ModelSchema.Type;

export const Message = defineMessageUnion({
  ChangedRowKey: { key: Schema.String, rowId: Schema.String },
  ChangedRowValue: { value: Schema.String, rowId: Schema.String },
  ClickedAdd: {},
  ClickedRemoveRow: { rowId: Schema.String },
  ClickedToggleReveal: { rowId: Schema.String },
  PastedEnv: { text: Schema.String },
  ClickedSend: {},
  SucceededRecipient: { fingerprint: Schema.String },
  SucceededLimits: { maxHandoffBytes: Schema.Number },
  FailedLoad: { text: Schema.String },
  SucceededSend: {},
  FailedSend: { text: Schema.String },
});
export type Message = typeof Message.Type;

const newRow = (id: number): typeof Row.Type => ({ id: String(id), key: "", revealed: false, value: "" });
const hiddenStatus = (): typeof Status.Type => ({ _tag: "Hidden" });
const locked = (model: Model): boolean => model.sending || model.sent;

const toPayload = (rows: ReadonlyArray<typeof Row.Type>): HandoffVariables => {
  const vars: HandoffVariables["vars"] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.length === 0) { continue; }
    if (key.length === 0 || row.value.length === 0) { throw new Error("Complete each key and value, or remove the unfinished row."); }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) { throw new Error("Use a valid environment variable name."); }
    if (names.has(key)) { throw new Error(`Duplicate key: ${key}.`); }
    names.add(key);
    vars.push({ key, value: row.value });
  }
  if (vars.length === 0) { throw new Error("Add a key and value."); }
  return { vars };
};

const responseJson = async (response: Response): Promise<unknown> => {
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : undefined;
    throw new Error(apiHandoffErrorText(code, response.status));
  }
  return data;
};

const LoadRecipient = DefineCommand("LoadRecipient", {
  args: { publicKeyPem: Schema.String },
  messages: [Message.SucceededRecipient, Message.FailedLoad],
  execute: ({ publicKeyPem }) => Effect.tryPromise({
    try: async () => {
      await validateRecipientPublicKey(publicKeyPem);
      return Message.SucceededRecipient({ fingerprint: await publicKeyFingerprint(publicKeyPem) });
    },
    catch: () => new Error("This fill link has an invalid recipient key. Ask for a new link."),
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedLoad({ text: causeMessage(error) })))),
});

const LoadLimits = DefineCommand("LoadLimits", {
  messages: [Message.SucceededLimits, Message.FailedLoad],
  execute: Effect.tryPromise({
    try: async () => {
      const data = Schema.decodeUnknownSync(Limits)(await responseJson(await fetch("/api/config", {
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      })));
      if (!Number.isInteger(data.maxHandoffBytes) || data.maxHandoffBytes <= 0 || data.maxHandoffBytes > 1_048_576) {
        throw new Error("This instance has invalid limits.");
      }
      return Message.SucceededLimits(data);
    },
    catch: (error) => error,
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedLoad({ text: causeMessage(error) })))),
});

const SendHandoff = DefineCommand("SendHandoff", {
  args: {
    handoffId: Schema.String, writeToken: Schema.String, publicKeyPem: Schema.String,
    maxHandoffBytes: Schema.Number, rows: Schema.Array(Row),
  },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ handoffId, writeToken, publicKeyPem, maxHandoffBytes, rows }) => Effect.tryPromise({
    try: async () => {
      const sealed = await seal(toPayload(rows), publicKeyPem);
      if (new TextEncoder().encode(sealed).byteLength > maxHandoffBytes) { throw new Error("That's too large to send."); }
      const response = await fetch(`/api/handoffs/${handoffId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sealed }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      const data = Schema.decodeUnknownSync(Sent)(await responseJson(response));
      if (data.id !== handoffId || !Number.isFinite(data.expiresAt)) { throw new Error("Couldn't confirm this handoff was sent."); }
      return Message.SucceededSend();
    },
    catch: (error) => error,
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSend({ text: causeMessage(error) })))),
});

export const init = (route: AppRoute): ReturnType<Runtime.ApplicationInit<Model, typeof Message.Type>> => {
  const model: Model = {
    page: route.page,
    handoffId: route.page === "compose" ? Option.some(route.handoffId) : Option.none(),
    writeToken: route.page === "compose" ? Option.fromNullishOr(route.writeToken) : Option.none(),
    publicKeyPem: route.page === "compose" ? Option.fromNullishOr(route.publicKeyPem) : Option.none(),
    fingerprint: Option.none(), recipientReady: false, limitsReady: false, maxHandoffBytes: 32_768,
    nextRowId: 2, rows: [newRow(1)], sending: false, sent: false, status: hiddenStatus(),
  };
  if (route.page === "landing") { return { model }; }
  if (route.writeToken === null || route.publicKeyPem === null) {
    return { model: { ...model, status: statusError("This fill link is incomplete. Ask for a new link from the CLI.") } };
  }
  return { model, commands: [LoadRecipient({ publicKeyPem: route.publicKeyPem }), LoadLimits()] };
};

export const update = (model: Model, message: Message) => Message.match<Update.Return<Model, Message>>(message, {
  ChangedRowKey: ({ key, rowId }) => ({ model: locked(model) ? model : { ...model, rows: model.rows.map((row) => row.id === rowId ? { ...row, key } : row) } }),
  ChangedRowValue: ({ value, rowId }) => ({ model: locked(model) ? model : { ...model, rows: model.rows.map((row) => row.id === rowId ? { ...row, value } : row) } }),
  ClickedAdd: () => ({ model: locked(model) ? model : { ...model, rows: [...model.rows, newRow(model.nextRowId)], nextRowId: model.nextRowId + 1 } }),
  ClickedRemoveRow: ({ rowId }) => ({ model: locked(model) || model.rows.length <= 1 ? model : { ...model, rows: model.rows.filter((row) => row.id !== rowId) } }),
  ClickedToggleReveal: ({ rowId }) => ({ model: locked(model) ? model : { ...model, rows: model.rows.map((row) => row.id === rowId ? { ...row, revealed: !row.revealed } : row) } }),
  PastedEnv: ({ text }) => {
    if (locked(model)) { return { model }; }
    const vars = parseEnvText(text);
    if (vars.length === 0) { return { model: { ...model, status: statusError("Couldn't read pasted text as KEY=value lines.") } }; }
    const rows = vars.map((entry, index) => ({ ...entry, id: String(model.nextRowId + index), revealed: false }));
    const next = model.nextRowId + rows.length;
    return { model: { ...model, rows: [...rows, newRow(next)], nextRowId: next + 1, status: hiddenStatus() } };
  },
  ClickedSend: () => {
    if (model.page !== "compose" || locked(model) || !model.recipientReady || !model.limitsReady) { return { model }; }
    const handoffId = Option.getOrNull(model.handoffId);
    const writeToken = Option.getOrNull(model.writeToken);
    const publicKeyPem = Option.getOrNull(model.publicKeyPem);
    if (handoffId === null || writeToken === null || publicKeyPem === null) { return { model }; }
    try { toPayload(model.rows); } catch (error) { return { model: { ...model, status: statusError(causeMessage(error)) } }; }
    return {
      model: { ...model, sending: true, status: hiddenStatus() },
      commands: [SendHandoff({ handoffId, writeToken, publicKeyPem, rows: model.rows, maxHandoffBytes: model.maxHandoffBytes })],
    };
  },
  SucceededRecipient: ({ fingerprint }) => ({ model: { ...model, fingerprint: Option.some(fingerprint), recipientReady: true } }),
  SucceededLimits: ({ maxHandoffBytes }) => ({ model: { ...model, maxHandoffBytes, limitsReady: true } }),
  FailedLoad: ({ text }) => ({ model: { ...model, status: statusError(text) } }),
  FailedSend: ({ text }) => ({ model: { ...model, sending: false, status: statusError(text) } }),
  SucceededSend: () => ({ model: { ...model, sending: false, sent: true, rows: model.rows.map((row) => ({ ...row, value: "", revealed: false })), status: { _tag: "Ok", text: "sent." } } }),
});

const pixelIcon = (h: HtmlBuilder<Message>, paths: readonly string[]): Html => h.svg(
  [h.Class("pixel-icon"), h.ViewBox("0 0 24 24"), h.Width("16"), h.Height("16"), h.AriaHidden(true)],
  paths.map((d) => h.path([h.Fill("currentColor"), h.D(d)])),
);

const statusView = (model: Model, h: HtmlBuilder<Message>): Html => model.status._tag === "Hidden" ? null :
  h.div([h.Class(`status ${model.status._tag === "Ok" ? "ok" : "error"}`), h.AriaLive("polite")], [model.status.text]);

const fillView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!model.recipientReady || !model.limitsReady) {
    return h.main([h.Class("main")], [statusView(model, h), ...(model.status._tag === "Hidden" ? [h.p([h.Class("compose-hint")], ["loading request…"])] : [])]);
  }
  const onPaste = h.OnPastePreventDefault((text) => looksLikeEnvPaste(text) ? Option.some(Message.PastedEnv({ text })) : Option.none());
  return h.main([h.Class("main")], [
    h.p([h.Class("compose-hint")], ["Fill in the values, then send. Edits stay in this tab until you send."]),
    h.div([h.Class("var-table"), h.Title("Paste a .env file or KEY=value lines"), onPaste], [
      h.div([h.Class("var-head")], [h.span([], ["key"]), h.span([], ["value"]), h.span([], [""])]),
      ...model.rows.map((row) => h.div([h.Class("var-row"), h.Key(row.id)], [
        h.input([h.Class("cell-key"), h.AriaLabel("key"), h.Placeholder("OPENAI_API_KEY"), h.Value(row.key), h.Disabled(locked(model)), h.Autocomplete("off"), h.Spellcheck(false), h.OnInput((key) => Message.ChangedRowKey({ key, rowId: row.id })), onPaste]),
        h.input([h.Type(row.revealed ? "text" : "password"), h.AriaLabel("value"), h.Placeholder("value"), h.Value(row.value), h.Disabled(locked(model)), h.Autocomplete("off"), h.OnInput((value) => Message.ChangedRowValue({ value, rowId: row.id })), onPaste]),
        h.div([h.Class("row-actions")], [
          ...(row.value.length === 0 ? [] : [h.button([h.Class("icon-btn"), h.Type("button"), h.AriaLabel(row.revealed ? "hide" : "show"), h.Disabled(locked(model)), h.OnClick(Message.ClickedToggleReveal({ rowId: row.id }))], [pixelIcon(h, row.revealed ? eyeOffPaths : eyePaths)])]),
          h.button([h.Class("icon-btn"), h.Type("button"), h.AriaLabel("remove"), h.Disabled(locked(model) || model.rows.length <= 1), h.OnClick(Message.ClickedRemoveRow({ rowId: row.id }))], [pixelIcon(h, trashPaths)]),
        ]),
      ])),
    ]),
    h.div([h.Class("toolbar")], [
      h.button([h.Class("btn"), h.Type("button"), h.Disabled(locked(model)), h.OnClick(Message.ClickedAdd())], ["add"]),
      h.button([h.Class("btn btn-primary"), h.Type("button"), h.Disabled(locked(model)), h.OnClick(Message.ClickedSend())], [model.sending ? "sending…" : "send"]),
    ]),
    statusView(model, h),
  ]);
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "podaj",
  body: h.div([h.Class("shell")], [
    h.header([h.Class("site-header")], [h.span([h.Class("brand")], ["podaj"]), ...Option.match(model.fingerprint, {
      onNone: () => [], onSome: (fingerprint) => [h.span([h.Class("key-meta")], [fingerprint.slice(0, 16)])],
    })]),
    model.page === "compose" ? fillView(model, h) : h.main([h.Class("main")], [
      h.p([h.Class("compose-hint")], ["Open the fill link from your CLI."]),
      h.code([], ["podaj wait API_KEY"]),
    ]),
    h.footer([h.Class("site-footer")], [HOW_IT_WORKS]),
  ]),
});

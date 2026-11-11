import { Effect, Option, Schema } from "effect";
import { Runtime, type Update } from "foldkit";
import { define as DefineCommand } from "foldkit/command";
import { Document, HtmlBuilder, type Html } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { publicKeyFingerprint, seal, validateRecipientPublicKey, type HandoffVariables } from "../crypto/podaj1.js";
import { eyeOffPaths, eyePaths, trashPaths } from "./icons.js";
import { looksLikeEnvPaste, parseEnvText } from "./parse-env.js";
import type { AppRoute } from "./parse-route.js";
import { causeMessage, handoffApiError, HandoffApiError, HOSTED_DEMO_ORIGIN, HOW_IT_WORKS, SELF_HOST_URL, statusError } from "./user-facing.js";

const START_COMMAND = "podaj wait API_KEY";

const Row = Schema.Struct({ id: Schema.String, key: Schema.String, revealed: Schema.Boolean, value: Schema.String });
const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Hidden") }),
  Schema.Struct({ _tag: Schema.Literal("Ok"), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Error"), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("RateLimited"), text: Schema.String, ownerHelp: Schema.String }),
]);
const Limits = Schema.Struct({ maxHandoffBytes: Schema.Number });
const Sent = Schema.Struct({ id: Schema.String, expiresAt: Schema.Number });

export const ModelSchema = Schema.Struct({
  page: Schema.Literals(["landing", "compose"]),
  hostedDemo: Schema.Boolean,
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
  ClickedCopyCommand: {},
  SucceededCopyCommand: {},
  FailedCopyCommand: {},
  SucceededRecipient: { fingerprint: Schema.String },
  SucceededLimits: { maxHandoffBytes: Schema.Number },
  FailedLoad: { text: Schema.String },
  SucceededSend: {},
  FailedSend: { text: Schema.String },
  ReachedRateLimit: { text: Schema.String, ownerHelp: Schema.String },
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
    throw handoffApiError(response.status, data);
  }
  return data;
};

const CopyCommand = DefineCommand("CopyCommand", {
  messages: [Message.SucceededCopyCommand, Message.FailedCopyCommand],
  execute: Effect.tryPromise({
    try: () => navigator.clipboard.writeText(START_COMMAND),
    catch: () => new Error("clipboard unavailable"),
  }).pipe(Effect.match({
    onSuccess: () => Message.SucceededCopyCommand(),
    onFailure: () => Message.FailedCopyCommand(),
  })),
});

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
  messages: [Message.SucceededLimits, Message.FailedLoad, Message.ReachedRateLimit],
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
  }).pipe(Effect.catch((error) => Effect.succeed(error instanceof HandoffApiError && error.status === 429
    ? Message.ReachedRateLimit({ text: error.message, ownerHelp: error.ownerHelp })
    : Message.FailedLoad({ text: causeMessage(error) })))),
});

const SendHandoff = DefineCommand("SendHandoff", {
  args: {
    handoffId: Schema.String, writeToken: Schema.String, publicKeyPem: Schema.String,
    maxHandoffBytes: Schema.Number, rows: Schema.Array(Row),
  },
  messages: [Message.SucceededSend, Message.FailedSend, Message.ReachedRateLimit],
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
  }).pipe(Effect.catch((error) => Effect.succeed(error instanceof HandoffApiError && error.status === 429
    ? Message.ReachedRateLimit({ text: error.message, ownerHelp: error.ownerHelp })
    : Message.FailedSend({ text: causeMessage(error) })))),
});

export const init = (route: AppRoute, origin = ""): ReturnType<Runtime.ApplicationInit<Model, typeof Message.Type>> => {
  const model: Model = {
    page: route.page,
    hostedDemo: origin === HOSTED_DEMO_ORIGIN,
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
  ClickedCopyCommand: () => model.page === "landing"
    ? { model: { ...model, status: hiddenStatus() }, commands: [CopyCommand()] } : { model },
  SucceededCopyCommand: () => ({ model: { ...model, status: { _tag: "Ok", text: "Command copied." } } }),
  FailedCopyCommand: () => ({ model: { ...model, status: statusError("Couldn't copy. Select the command and copy it manually.") } }),
  ClickedAdd: () => ({ model: locked(model) ? model : { ...model, rows: [...model.rows, newRow(model.nextRowId)], nextRowId: model.nextRowId + 1 } }),
  ClickedRemoveRow: ({ rowId }) => ({ model: locked(model) || model.rows.length <= 1 ? model : { ...model, rows: model.rows.filter((row) => row.id !== rowId) } }),
  ClickedToggleReveal: ({ rowId }) => ({ model: locked(model) ? model : { ...model, rows: model.rows.map((row) => row.id === rowId ? { ...row, revealed: !row.revealed } : row) } }),
  PastedEnv: ({ text }) => {
    if (locked(model)) { return { model }; }
    const vars = parseEnvText(text);
    if (vars.length === 0) { return { model: { ...model, status: statusError("Couldn't read pasted text as KEY=value lines.") } }; }
    let pasted = 0;
    let nextRowId = model.nextRowId;
    const rows = model.rows.map((row) => {
      if (row.key.length > 0 || row.value.length > 0 || pasted >= vars.length) { return row; }
      const entry = vars[pasted];
      pasted += 1;
      return { ...row, ...entry, revealed: false };
    });
    for (const entry of vars.slice(pasted)) {
      rows.push({ ...entry, id: String(nextRowId), revealed: false });
      nextRowId += 1;
    }
    const last = rows.at(-1);
    if (last !== undefined && (last.key.length > 0 || last.value.length > 0)) {
      rows.push(newRow(nextRowId));
      nextRowId += 1;
    }
    return { model: { ...model, rows, nextRowId, status: hiddenStatus() } };
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
  ReachedRateLimit: ({ text, ownerHelp }) => ({ model: { ...model, sending: false, status: { _tag: "RateLimited", text, ownerHelp } } }),
  SucceededSend: () => ({ model: { ...model, sending: false, sent: true, rows: model.rows.map((row) => ({ ...row, value: "", revealed: false })), status: { _tag: "Ok", text: "Sent." } } }),
});

const pixelIcon = (h: HtmlBuilder<Message>, paths: readonly string[]): Html => h.svg(
  [h.Class("pixel-icon"), h.ViewBox("0 0 24 24"), h.Width("12"), h.Height("12"), h.AriaHidden(true)],
  paths.map((d) => h.path([h.Fill("currentColor"), h.D(d)])),
);

const statusView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.status._tag === "Hidden") { return null; }
  const content: (Html | string)[] = [model.status.text];
  if (model.status._tag === "RateLimited") {
    if (model.hostedDemo) {
      content.push(" You can also ", h.a([h.Href(SELF_HOST_URL), h.Target("_blank"), h.Rel("noopener noreferrer")], ["self-host Podaj"]), ".");
    }
    if (model.status.ownerHelp) {
      content.push(h.details([h.Class("limit-help")], [
        h.summary([], ["Owner settings"]),
        h.p([], [model.status.ownerHelp]),
      ]));
    }
  }
  return h.div([h.Class(`status ${model.status._tag === "Ok" ? "ok" : "error"}`), h.AriaLive("polite")], content);
};

const fillView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!model.recipientReady || !model.limitsReady) {
    return h.main([h.Class("main container")], [statusView(model, h), ...(model.status._tag === "Hidden" ? [h.p([h.Class("compose-hint")], ["Loading request…"])] : [])]);
  }
  const onPaste = h.OnPastePreventDefault((text) => looksLikeEnvPaste(text) ? Option.some(Message.PastedEnv({ text })) : Option.none());
  const onValuePaste = h.OnPastePreventDefault((text) => /[\r\n]/u.test(text.trim()) && looksLikeEnvPaste(text) ? Option.some(Message.PastedEnv({ text })) : Option.none());
  return h.main([h.Class("main container")], [
    h.p([h.Class("compose-hint")], ["Fill in the values, then send. Edits stay in this tab until you send."]),
    h.div([h.Class("var-table"), h.Title("Paste .env lines into a key field to add rows")], [
      h.div([h.Class("var-head")], [h.span([], ["key"]), h.span([], ["value"]), h.span([], [""])]),
      ...model.rows.map((row) => h.div([h.Class("var-row"), h.Key(row.id)], [
        h.input([h.Class("cell-key"), h.AriaLabel("key"), h.Placeholder("VARIABLE_NAME"), h.Value(row.key), h.Disabled(locked(model)), h.Autocomplete("off"), h.Spellcheck(false), h.OnInput((key) => Message.ChangedRowKey({ key, rowId: row.id })), onPaste]),
        h.input([h.Type(row.revealed ? "text" : "password"), h.AriaLabel("value"), h.Placeholder("value"), h.Value(row.value), h.Disabled(locked(model)), h.Autocomplete("off"), h.OnInput((value) => Message.ChangedRowValue({ value, rowId: row.id })), onValuePaste]),
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
    model.page === "compose" ? fillView(model, h) : h.main([h.Class("main container")], [
      h.p([h.Class("compose-hint")], ["Open the fill link from your CLI."]),
      h.pre([h.Class("cli-command")], [
        h.code([], [START_COMMAND]),
        h.button([h.Class("btn command-copy"), h.Type("button"), h.AriaLabel("copy command"), h.OnClick(Message.ClickedCopyCommand())], [model.status._tag === "Ok" ? "copied" : "copy"]),
      ]),
      statusView(model, h),
    ]),
    h.footer([h.Class("site-footer container")], [HOW_IT_WORKS]),
  ]),
});

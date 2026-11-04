import { Effect, Option, Schema } from "effect";
import { Http, Runtime, type Update } from "foldkit";
import { define as DefineCommand } from "foldkit/command";
import { Document, HtmlBuilder, type Html } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import {
  open,
  publicKeyFingerprint,
  seal,
  type HandoffVariables,
} from "../crypto/podaj1.js";
import { looksLikeEnvPaste, parseEnvText } from "./parse-env.js";
import type { AppRoute } from "./parse-route.js";
import {
  apiHandoffErrorText,
  causeMessage,
  HOW_IT_WORKS,
  statusError,
  userStatusText,
} from "./user-facing.js";

const RECIPIENT_SLUG = "default";

const Row = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  revealed: Schema.Boolean,
  value: Schema.String,
});

const EnvVarRow = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});

const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Hidden") }),
  Schema.Struct({ _tag: Schema.Literal("Ok"), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Error"), text: Schema.String }),
]);

export const ModelSchema = Schema.Struct({
  autosaveRevision: Schema.Number,
  composeReady: Schema.Boolean,
  fingerprint: Schema.Option(Schema.String),
  handoffId: Schema.Option(Schema.String),
  nextRowId: Schema.Number,
  page: Schema.Literals(["compose", "receive", "send"]),
  writeToken: Schema.Option(Schema.String),
  publicKeyPem: Schema.Option(Schema.String),
  rows: Schema.Array(Row),
  sealed: Schema.Option(Schema.String),
  sending: Schema.Boolean,
  showKeyPicker: Schema.Boolean,
  status: Status,
  vars: Schema.Array(EnvVarRow),
});

export type Model = typeof ModelSchema.Type;

export const Message = defineMessageUnion({
  ChangedRowKey: { key: Schema.String, rowId: Schema.String },
  ChangedRowValue: { rowId: Schema.String, value: Schema.String },
  ClickedAdd: {},
  ClickedShare: {},
  ClickedRemoveRow: { rowId: Schema.String },
  ClickedToggleReveal: { rowId: Schema.String },
  PastedEnv: { text: Schema.String },
  FailedShare: { text: Schema.String },
  FailedDecrypt: { text: Schema.String },
  FailedLoadHandoff: { text: Schema.String },
  FailedLoadRecipient: { text: Schema.String },
  SelectedKeyFile: { file: Schema.instanceOf(File) },
  SucceededShare: { url: Schema.String },
  SucceededDecrypt: { vars: Schema.Array(EnvVarRow) },
  SucceededLoadHandoff: { sealed: Schema.String },
  SucceededLoadRecipient: {
    fingerprint: Schema.String,
    publicKeyPem: Schema.String,
  },
  SkippedFilePick: {},
});

export type Message = typeof Message.Type;

const newRow = (id: number): typeof Row.Type => ({
  id: String(id),
  key: "",
  revealed: false,
  value: "",
});

const hiddenStatus = (): typeof Status.Type => ({ _tag: "Hidden" });

const toPayload = (rows: ReadonlyArray<typeof Row.Type>): HandoffVariables => ({
  vars: rows
    .filter((d) => d.key.trim().length > 0 && d.value.length > 0)
    .map((d) => ({ key: d.key.trim(), value: d.value })),
});

const rowsFromEnvVars = (
  vars: ReadonlyArray<typeof EnvVarRow.Type>,
  nextRowId: number,
): { nextRowId: number; rows: Array<typeof Row.Type> } => {
  if (vars.length === 0) {
    return { nextRowId, rows: [newRow(nextRowId)] };
  }
  const rows = vars.map((v, index) => ({
    id: String(nextRowId + index),
    key: v.key,
    revealed: false,
    value: v.value,
  }));
  const trailingId = nextRowId + vars.length;
  return {
    nextRowId: trailingId + 1,
    rows: [...rows, newRow(trailingId)],
  };
};

const LoadRecipientKey = DefineCommand("LoadRecipientKey", {
  messages: [Message.SucceededLoadRecipient, Message.FailedLoadRecipient],
  execute: Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch("/recipient.pem"),
      catch: (error) => error,
    });
    if (!response.ok) {
      return Message.FailedLoadRecipient({
        text: `This site isn't set up yet (${response.status}).`,
      });
    }
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => error,
    });
    const pem = text.trim();
    if (!pem.includes("BEGIN PUBLIC KEY")) {
      return Message.FailedLoadRecipient({
        text: "No recipient key is configured yet.",
      });
    }
    const fingerprint = yield* Effect.tryPromise({
      try: () => publicKeyFingerprint(pem),
      catch: (error) => error,
    });
    return Message.SucceededLoadRecipient({ fingerprint, publicKeyPem: pem });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedLoadRecipient({
          text: userStatusText(causeMessage(error)),
        }),
      ),
    ),
    Effect.provide(Http.layer),
  ),
});

const LoadHandoff = DefineCommand("LoadHandoff", {
  args: { handoffId: Schema.String },
  messages: [Message.SucceededLoadHandoff, Message.FailedLoadHandoff],
  execute: ({ handoffId }) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch(`/api/handoffs/${handoffId}`),
        catch: (error) => error,
      });
      if (response.status === 410) {
        return Message.FailedLoadHandoff({
          text: "This link was already used or expired.",
        });
      }
      if (!response.ok) {
        return Message.FailedLoadHandoff({
          text: `Couldn't load this link (${response.status}).`,
        });
      }
      const data = (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (error) => error,
      })) as { sealed?: unknown };
      if (typeof data.sealed !== "string") {
        return Message.FailedLoadHandoff({
          text: "Couldn't load this link (invalid response).",
        });
      }
      return Message.SucceededLoadHandoff({ sealed: data.sealed });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadHandoff({
            text: userStatusText(causeMessage(error)),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

const ShareHandoff = DefineCommand("ShareHandoff", {
  args: {
    handoffId: Schema.Option(Schema.String),
    publicKeyPem: Schema.String,
    revision: Schema.Number,
    rows: Schema.Array(Row),
    waitMs: Schema.Number,
    writeToken: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededShare, Message.FailedShare],
  execute: ({ handoffId, publicKeyPem, rows, waitMs, writeToken }) =>
    Effect.gen(function* () {
      if (waitMs > 0) {
        yield* Effect.sleep(`${waitMs} millis`);
      }
      const payload = toPayload(rows);
      if (payload.vars.length === 0) {
        return Message.FailedShare({ text: "Add a key and value." });
      }
      const sealed = yield* Effect.tryPromise({
        try: () => seal(payload, publicKeyPem, RECIPIENT_SLUG),
        catch: (error) => error,
      });
      const slotId = Option.getOrNull(handoffId);
      const token = Option.getOrNull(writeToken);
      const useReserved = slotId !== null && token !== null;
      const response = yield* Effect.tryPromise({
        try: () =>
          useReserved
            ? fetch(`/api/handoffs/${slotId}`, {
                body: JSON.stringify({ sealed, writeToken: token }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
              })
            : fetch("/api/handoffs", {
                body: JSON.stringify({ sealed }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              }),
        catch: (error) => error,
      });
      if (!response.ok) {
        const err = (yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => ({}),
        })) as { error?: string };
        if (
          useReserved &&
          response.status === 409 &&
          err.error === "already shared"
        ) {
          return Message.SucceededShare({
            url: new URL(`/h/${slotId}`, globalThis.location.origin).toString(),
          });
        }
        return Message.FailedShare({
          text: apiHandoffErrorText(err.error, response.status),
        });
      }
      const data = (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (error) => error,
      })) as { url?: unknown };
      if (typeof data.url !== "string") {
        return Message.FailedShare({
          text: "Couldn't send (invalid response).",
        });
      }
      return Message.SucceededShare({ url: data.url });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedShare({
            text: userStatusText(causeMessage(error)),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

const DecryptHandoff = DefineCommand("DecryptHandoff", {
  args: { file: Schema.instanceOf(File), sealed: Schema.String },
  messages: [Message.SucceededDecrypt, Message.FailedDecrypt],
  execute: ({ file, sealed }) =>
    Effect.gen(function* () {
      const pem = yield* Effect.tryPromise({
        try: () => file.text(),
        catch: (error) => error,
      });
      const { payload } = yield* Effect.tryPromise({
        try: () => open(sealed, pem),
        catch: (error) => error,
      });
      return Message.SucceededDecrypt({ vars: payload.vars });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDecrypt({
            text: userStatusText(causeMessage(error)),
          }),
        ),
      ),
    ),
});

const emptySendModel = (): Model => ({
  autosaveRevision: 0,
  composeReady: false,
  fingerprint: Option.none(),
  handoffId: Option.none(),
  nextRowId: 2,
  page: "send",
  publicKeyPem: Option.none(),
  rows: [newRow(1)],
  sealed: Option.none(),
  sending: false,
  showKeyPicker: false,
  status: hiddenStatus(),
  vars: [],
  writeToken: Option.none(),
});

const dispatchComposeReady = (url: string): void => {
  if (typeof globalThis.dispatchEvent !== "function") {
    return;
  }
  globalThis.dispatchEvent(
    new CustomEvent("podaj:ready", { detail: { url } }),
  );
};

const scheduleComposeUpload = (
  model: Model,
  waitMs: number,
): Update.Return<Model, Message> | null => {
  if (model.page !== "compose" || Option.isNone(model.writeToken)) {
    return null;
  }
  const pem = Option.getOrNull(model.publicKeyPem);
  const handoffId = Option.getOrNull(model.handoffId);
  const writeToken = Option.getOrNull(model.writeToken);
  if (pem === null || handoffId === null || writeToken === null) {
    return null;
  }
  if (toPayload(model.rows).vars.length === 0) {
    return null;
  }
  const revision = model.autosaveRevision + 1;
  return {
    commands: [
      ShareHandoff({
        handoffId: Option.some(handoffId),
        publicKeyPem: pem,
        revision,
        rows: model.rows,
        waitMs,
        writeToken: Option.some(writeToken),
      }),
    ],
    model: modifyFields(model, {
      autosaveRevision: () => revision,
      sending: () => true,
    }),
  };
};

const afterComposeEdit = (
  model: Model,
  waitMs: number,
): Update.Return<Model, Message> => {
  const scheduled = scheduleComposeUpload(model, waitMs);
  return scheduled ?? { model };
};

export const init = (
  route: AppRoute,
): ReturnType<Runtime.ApplicationInit<Model, typeof Message.Type>> => {
  if (route.page === "receive") {
    return {
      commands: [LoadHandoff({ handoffId: route.handoffId })],
      model: {
        ...emptySendModel(),
        handoffId: Option.some(route.handoffId),
        page: "receive",
      },
    };
  }
  if (route.page === "compose") {
    const missingWrite = route.writeToken === null;
    return {
      commands: [LoadRecipientKey()],
      model: {
        ...emptySendModel(),
        handoffId: Option.some(route.handoffId),
        page: "compose",
        writeToken:
          route.writeToken === null
            ? Option.none()
            : Option.some(route.writeToken),
        status: missingWrite
          ? statusError("This compose link is incomplete.")
          : hiddenStatus(),
      },
    };
  }
  return {
    commands: [LoadRecipientKey()],
    model: emptySendModel(),
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedRowKey: ({ key, rowId }) =>
      afterComposeEdit(
        modifyFields(model, {
          rows: (rows) =>
            rows.map((row) =>
              row.id === rowId
                ? { id: row.id, key, revealed: row.revealed, value: row.value }
                : row,
            ),
        }),
        600,
      ),
    ChangedRowValue: ({ rowId, value }) =>
      afterComposeEdit(
        modifyFields(model, {
          rows: (rows) =>
            rows.map((row) =>
              row.id === rowId
                ? { id: row.id, key: row.key, revealed: row.revealed, value }
                : row,
            ),
        }),
        600,
      ),
    ClickedAdd: () => ({
      model: modifyFields(model, {
        nextRowId: (nextRowId) => nextRowId + 1,
        rows: (rows) => [...rows, newRow(model.nextRowId)],
      }),
    }),
    ClickedShare: () => {
      const pem = Option.getOrNull(model.publicKeyPem);
      if (pem === null) {
        return {
          model: modifyFields(model, {
            status: () =>
              statusError("No recipient key is configured yet."),
          }),
        };
      }
      if (
        model.page === "compose" &&
        Option.isNone(model.writeToken)
      ) {
        return {
          model: modifyFields(model, {
            status: () => statusError("This compose link is incomplete."),
          }),
        };
      }
      return {
        commands: [
          ShareHandoff({
            handoffId: model.handoffId,
            publicKeyPem: pem,
            revision: model.autosaveRevision + 1,
            rows: model.rows,
            waitMs: 0,
            writeToken: model.writeToken,
          }),
        ],
        model: modifyFields(model, {
          sending: () => true,
          status: () => hiddenStatus(),
        }),
      };
    },
    ClickedRemoveRow: ({ rowId }) => ({
      model: modifyFields(model, {
        rows: (rows) =>
          rows.length <= 1 ? rows : rows.filter((row) => row.id !== rowId),
      }),
    }),
    PastedEnv: ({ text }) => {
      const vars = parseEnvText(text);
      if (vars.length === 0) {
        return {
          model: modifyFields(model, {
            status: () =>
              statusError("Couldn't read pasted text as KEY=value lines."),
          }),
        };
      }
      const { nextRowId, rows } = rowsFromEnvVars(vars, model.nextRowId);
      return afterComposeEdit(
        modifyFields(model, {
          nextRowId: () => nextRowId,
          rows: () => rows,
          status: () => hiddenStatus(),
        }),
        0,
      );
    },
    ClickedToggleReveal: ({ rowId }) => ({
      model: modifyFields(model, {
        rows: (rows) =>
          rows.map((row) =>
            row.id === rowId
              ? {
                  id: row.id,
                  key: row.key,
                  revealed: !row.revealed,
                  value: row.value,
                }
              : row,
          ),
      }),
    }),
    FailedShare: ({ text }) => ({
      model: modifyFields(model, {
        sending: () => false,
        status: () => statusError(text),
      }),
    }),
    FailedDecrypt: ({ text }) => ({
      model: modifyFields(model, {
        status: () => statusError(text),
      }),
    }),
    FailedLoadHandoff: ({ text }) => ({
      model: modifyFields(model, {
        status: () => statusError(text),
      }),
    }),
    FailedLoadRecipient: ({ text }) => ({
      model: modifyFields(model, {
        status: () => statusError(text),
      }),
    }),
    SelectedKeyFile: ({ file }) => {
      const sealed = Option.getOrNull(model.sealed);
      if (sealed === null) {
        return { model };
      }
      return {
        commands: [DecryptHandoff({ file, sealed })],
        model: modifyFields(model, { status: () => hiddenStatus() }),
      };
    },
    SucceededShare: ({ url }) => {
      if (model.page === "compose") {
        dispatchComposeReady(url);
      }
      const statusText =
        model.page === "compose"
          ? "Ready."
          : `Share this once.\n${url}`;
      return {
        model: modifyFields(model, {
          composeReady: () => model.page === "compose",
          rows: (rows) =>
            rows.map((row) => ({
              id: row.id,
              key: row.key,
              revealed: row.revealed,
              value: "",
            })),
          sending: () => false,
          status: () => ({ _tag: "Ok", text: statusText }),
        }),
      };
    },
    SucceededDecrypt: ({ vars }) => ({
      model: modifyFields(model, {
        showKeyPicker: () => false,
        status: () => hiddenStatus(),
        vars: () => vars,
      }),
    }),
    SucceededLoadHandoff: ({ sealed }) => ({
      model: modifyFields(model, {
        sealed: () => Option.some(sealed),
        showKeyPicker: () => true,
        status: () => hiddenStatus(),
      }),
    }),
    SucceededLoadRecipient: ({ fingerprint, publicKeyPem }) => ({
      model: modifyFields(model, {
        fingerprint: () => Option.some(fingerprint),
        publicKeyPem: () => Option.some(publicKeyPem),
        status: () => hiddenStatus(),
      }),
    }),
    SkippedFilePick: () => ({ model }),
  });

const siteHeader = (model: Model, h: HtmlBuilder<Message>): Html => {
  const meta = Option.match(model.fingerprint, {
    onNone: () => null,
    onSome: (fp) => h.span([h.Class("key-meta")], [fp]),
  });
  return h.header(
    [h.Class("site-header")],
    [h.span([h.Class("brand")], ["podaj"]), ...(meta === null ? [] : [meta])],
  );
};

const siteFooter = (h: HtmlBuilder<Message>): Html =>
  h.footer([h.Class("site-footer")], [HOW_IT_WORKS]);

const statusView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.status._tag === "Hidden") {
    return null;
  }
  const kind = model.status._tag === "Ok" ? "ok" : "error";
  return h.div([h.Class(`status ${kind}`)], [model.status.text]);
};

const sendView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const onEnvPaste = h.OnPastePreventDefault((text) =>
    looksLikeEnvPaste(text)
      ? Option.some(Message.PastedEnv({ text }))
      : Option.none(),
  );

  const tableBody = model.rows.map((row) =>
    h.div(
      [h.Class("var-row"), h.Key(row.id)],
      [
        h.input([
          h.Class("cell-key"),
          h.Placeholder("OPENAI_API_KEY"),
          h.Value(row.key),
          h.OnInput((value) =>
            Message.ChangedRowKey({ key: value, rowId: row.id }),
          ),
          onEnvPaste,
          h.Autocomplete("off"),
          h.Spellcheck(false),
        ]),
        h.input([
          h.Type(row.revealed ? "text" : "password"),
          h.Placeholder("Value"),
          h.Value(row.value),
          h.OnInput((value) =>
            Message.ChangedRowValue({ rowId: row.id, value }),
          ),
          onEnvPaste,
          h.Autocomplete("off"),
        ]),
        h.div(
          [h.Class("row-actions")],
          [
            h.button(
              [
                h.Class("icon-btn"),
                h.Type("button"),
                h.OnClick(Message.ClickedToggleReveal({ rowId: row.id })),
              ],
              [row.revealed ? "Hide" : "Show"],
            ),
            h.button(
              [
                h.Class("icon-btn"),
                h.Type("button"),
                h.Disabled(model.rows.length <= 1),
                h.OnClick(Message.ClickedRemoveRow({ rowId: row.id })),
              ],
              ["Remove"],
            ),
          ],
        ),
      ],
    ),
  );

  const composePickup =
    model.page === "compose"
      ? Option.match(model.handoffId, {
          onNone: () => null,
          onSome: (id) => {
            const pickup = `${globalThis.location.origin}/h/${id}`;
            return h.p(
              [h.Class("compose-meta")],
              [
                "Recipient link (already set): ",
                h.code([h.Class("pickup-url")], [pickup]),
                model.sending ? " · Uploading…" : "",
                model.composeReady ? " · Ready." : "",
              ],
            );
          },
        })
      : null;

  const shareButton =
    model.page === "send"
      ? h.button(
          [
            h.Class("btn btn-primary"),
            h.Type("button"),
            h.Disabled(model.sending),
            h.OnClick(Message.ClickedShare()),
          ],
          ["Share"],
        )
      : null;

  const composeHint =
    model.page === "compose"
      ? h.p([h.Class("compose-hint")], [
          "Paste or edit — uploads automatically when rows are complete.",
        ])
      : null;

  return h.main(
    [
      h.Class(
        model.composeReady ? "main compose-ready" : "main",
      ),
    ],
    [
      composePickup,
      composeHint,
      h.div(
        [
          h.Class("var-table"),
          h.Title("Paste a .env file or KEY=value lines to fill the table"),
          onEnvPaste,
        ],
        [
          h.div(
            [h.Class("var-head")],
            [
              h.span([], ["Key"]),
              h.span([], ["Value"]),
              h.span([], [""]),
            ],
          ),
          ...tableBody,
        ],
      ),
      h.div(
        [h.Class("toolbar")],
        [
          h.button(
            [h.Class("btn"), h.Type("button"), h.OnClick(Message.ClickedAdd())],
            ["Add"],
          ),
          ...(shareButton === null ? [] : [shareButton]),
        ],
      ),
      statusView(model, h),
    ].filter((node): node is Html => node !== null),
  );
};

const receiveView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const filePicker =
    model.showKeyPicker && model.vars.length === 0
      ? h.div(
          [h.Class("file-row")],
          [
            h.label(
              [h.Title("Usually ~/.local/share/podaj/private.pem")],
              ["Key file"],
            ),
            h.input([
              h.Type("file"),
              h.Accept(".pem"),
              h.Id("key-file"),
              h.OnFileChange((files) => {
                const file = files[0];
                return file === undefined
                  ? Message.SkippedFilePick()
                  : Message.SelectedKeyFile({ file });
              }),
            ]),
          ],
        )
      : null;

  const table =
    model.vars.length > 0
      ? h.div([h.Class("var-table")], [
          h.div(
            [h.Class("var-head")],
            [
              h.span([], ["Key"]),
              h.span([], ["Value"]),
              h.span([], [""]),
            ],
          ),
          ...model.vars.map((row) =>
            h.div(
              [h.Class("var-row var-row-readonly"), h.Key(row.key)],
              [
                h.code([h.Class("cell-key")], [row.key]),
                h.code([h.Class("cell-value")], [row.value]),
                h.span([], [""]),
              ],
            ),
          ),
        ])
      : null;

  return h.main(
    [h.Class("main")],
    [statusView(model, h), filePicker, table].filter(
      (node): node is Html => node !== null,
    ),
  );
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  body: h.div(
    [h.Class("shell")],
    [
      siteHeader(model, h),
      model.page === "receive" ? receiveView(model, h) : sendView(model, h),
      siteFooter(h),
    ],
  ),
  title: "podaj",
});

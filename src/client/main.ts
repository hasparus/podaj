import {
  open,
  publicKeyFingerprint,
  seal,
  type EnvVar,
  type HandoffVariables,
} from "../crypto/podaj1.js";
import { HOW_IT_WORKS, userError } from "./user-facing.js";

/** Stored in the sealed envelope for implementers; not shown in the UI. */
const RECIPIENT_SLUG = "default";

type Draft = EnvVar & { id: string; revealed: boolean };

const mount = (parent: Node, ...children: Node[]) => {
  for (const child of children) parent.appendChild(child);
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const setStatus = (
  node: HTMLElement,
  text: string,
  kind: "ok" | "error" | "",
) => {
  node.textContent = text;
  node.classList.remove("ok", "error", "hidden");
  if (kind) node.classList.add(kind);
  if (!text) node.classList.add("hidden");
};

const loadRecipientPublicKey = async (): Promise<string> => {
  const res = await fetch("/recipient.pem");
  if (!res.ok) throw new Error("could not load recipient.pem");
  const pem = (await res.text()).trim();
  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error("recipient.pem needs a public key");
  }
  return pem;
};

const handoffId = (): string | null => {
  const m = location.pathname.match(/^\/h\/([a-f0-9]{32})$/u);
  return m?.[1] ?? null;
};

const readFileText = (file: File): Promise<string> => file.text();

const toPayload = (drafts: Draft[]): HandoffVariables => ({
  vars: drafts
    .filter((d) => d.key.trim().length > 0 && d.value.length > 0)
    .map((d) => ({ key: d.key.trim(), value: d.value })),
});

const shellHeader = (meta?: string): HTMLElement => {
  const header = el("header", "site-header");
  const brand = el("span", "brand");
  brand.textContent = "podaj";
  if (meta) {
    const metaEl = el("span", "key-meta");
    metaEl.textContent = meta;
    mount(header, brand, metaEl);
  } else {
    header.appendChild(brand);
  }
  return header;
};

const siteFooter = (): HTMLElement => {
  const footer = el("footer", "site-footer");
  footer.textContent = HOW_IT_WORKS;
  return footer;
};

async function renderReceive(root: HTMLElement, id: string): Promise<void> {
  root.replaceChildren();
  const shell = el("div", "shell");
  const header = shellHeader();
  const main = el("main", "main");
  const status = el("div", "status hidden");
  const fileRow = el("div", "file-row hidden");
  const fileLabel = el("label");
  fileLabel.textContent = "Key file";
  fileLabel.title = "Usually ~/.local/share/podaj/private.pem";
  const fileInput = el("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".pem";
  fileInput.id = "key-file";
  fileLabel.htmlFor = fileInput.id;
  mount(fileRow, fileLabel, fileInput);

  const table = el("div", "var-table hidden");
  const head = el("div", "var-head");
  const hk = el("span");
  hk.textContent = "Key";
  const hv = el("span");
  hv.textContent = "Value";
  const ha = el("span");
  ha.textContent = "";
  mount(head, hk, hv, ha);
  const body = el("div");
  mount(table, head, body);

  mount(main, status, fileRow, table);
  mount(shell, header, main, siteFooter());
  root.appendChild(shell);

  let sealed: string;
  try {
    const res = await fetch(`/api/handoffs/${id}`);
    if (res.status === 410) {
      setStatus(status, "This link was already used or expired.", "error");
      return;
    }
    if (!res.ok) {
      setStatus(status, "Couldn't load this link.", "error");
      return;
    }
    const data = (await res.json()) as { sealed: string };
    sealed = data.sealed;
    fileRow.classList.remove("hidden");
  } catch (e) {
    setStatus(status, userError(e), "error");
    return;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const pem = await readFileText(file);
      const { payload } = await open(sealed, pem);
      body.replaceChildren();
      for (const v of payload.vars) {
        const row = el("div", "var-row var-row-readonly");
        const k = el("code", "cell-key");
        k.textContent = v.key;
        const val = el("code", "cell-value");
        val.textContent = v.value;
        mount(row, k, val, el("span"));
        body.appendChild(row);
      }
      table.classList.remove("hidden");
      setStatus(status, "", "");
      fileRow.classList.add("hidden");
    } catch (e) {
      setStatus(status, userError(e), "error");
    }
  });
}

async function renderSend(root: HTMLElement): Promise<void> {
  const publicKeyPem = await loadRecipientPublicKey();
  const fingerprint = await publicKeyFingerprint(publicKeyPem);

  let drafts: Draft[] = [
    { id: crypto.randomUUID(), key: "", value: "", revealed: false },
  ];

  root.replaceChildren();
  const shell = el("div", "shell");
  const header = shellHeader(fingerprint);
  const main = el("main", "main");

  const toolbar = el("div", "toolbar");
  const addBtn = el("button", "btn");
  addBtn.textContent = "Add";
  const sendBtn = el("button", "btn btn-primary");
  sendBtn.textContent = "Create link";
  mount(toolbar, addBtn, sendBtn);

  const table = el("div", "var-table");
  const head = el("div", "var-head");
  const hk = el("span");
  hk.textContent = "Key";
  const hv = el("span");
  hv.textContent = "Value";
  const ha = el("span");
  ha.textContent = "";
  mount(head, hk, hv, ha);
  const body = el("div");
  mount(table, head, body);

  const status = el("div", "status hidden");
  mount(main, table, toolbar, status);
  mount(shell, header, main, siteFooter());
  root.appendChild(shell);

  const renderRows = () => {
    body.replaceChildren();
    for (const d of drafts) {
      const row = el("div", "var-row");
      const keyInput = el("input") as HTMLInputElement;
      keyInput.className = "cell-key";
      keyInput.placeholder = "OPENAI_API_KEY";
      keyInput.value = d.key;
      keyInput.autocomplete = "off";
      keyInput.spellcheck = false;
      keyInput.addEventListener("input", () => {
        d.key = keyInput.value;
      });
      const valInput = el("input") as HTMLInputElement;
      valInput.placeholder = "Value";
      valInput.type = d.revealed ? "text" : "password";
      valInput.value = d.value;
      valInput.autocomplete = "off";
      valInput.addEventListener("input", () => {
        d.value = valInput.value;
      });
      const remove = el("button", "icon-btn");
      remove.textContent = "Remove";
      remove.type = "button";
      remove.disabled = drafts.length <= 1;
      remove.addEventListener("click", () => {
        if (drafts.length <= 1) return;
        drafts = drafts.filter((x) => x.id !== d.id);
        renderRows();
      });
      const reveal = el("button", "icon-btn");
      reveal.textContent = d.revealed ? "Hide" : "Show";
      reveal.type = "button";
      reveal.addEventListener("click", () => {
        d.revealed = !d.revealed;
        renderRows();
      });
      const actions = el("div", "row-actions");
      mount(actions, reveal, remove);
      mount(row, keyInput, valInput, actions);
      body.appendChild(row);
    }
  };

  addBtn.addEventListener("click", () => {
    drafts = [
      ...drafts,
      { id: crypto.randomUUID(), key: "", value: "", revealed: false },
    ];
    renderRows();
  });

  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    setStatus(status, "", "");
    const payload = toPayload(drafts);
    if (payload.vars.length === 0) {
      setStatus(status, "Add a key and value.", "error");
      sendBtn.disabled = false;
      return;
    }
    try {
      const sealed = await seal(payload, publicKeyPem, RECIPIENT_SLUG);
      const res = await fetch("/api/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sealed }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `store failed (${res.status})`);
      }
      const data = (await res.json()) as { url: string };
      setStatus(status, `Share this once.\n${data.url}`, "ok");
      drafts = drafts.map((d) => ({ ...d, value: "" }));
      renderRows();
    } catch (e) {
      setStatus(status, userError(e), "error");
    } finally {
      sendBtn.disabled = false;
    }
  });

  renderRows();
}

const boot = async (): Promise<void> => {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app missing");
  const id = handoffId();
  if (id) await renderReceive(root, id);
  else await renderSend(root);
};

boot().catch((e) => {
  const root = document.getElementById("app");
  if (!root) return;
  const p = el("p", "status error");
  p.textContent = userError(e);
  root.appendChild(p);
});

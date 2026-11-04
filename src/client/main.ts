import {
  open,
  publicKeyFingerprint,
  seal,
  type EnvVar,
  type HandoffVariables,
} from "../crypto/podaj1.js";

type Environment = {
  slug: string;
  name: string;
  description?: string;
  publicKeyPem: string;
};

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

const loadEnvironments = async (): Promise<Environment[]> => {
  const res = await fetch("/environments.json");
  if (!res.ok) throw new Error("could not load environments.json");
  return (await res.json()) as Environment[];
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

async function renderReceive(root: HTMLElement, id: string): Promise<void> {
  root.replaceChildren();
  const main = el("div", "main");
  const h1 = el("h1");
  h1.textContent = "Environment variables";
  const lead = el("p", "lead");
  lead.textContent =
    "One-shot ciphertext from KV. Decrypt locally with your private key — it never leaves this browser.";
  const status = el("div", "status hidden");
  const fileRow = el("div", "file-row hidden");
  const fileInput = el("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".pem";
  fileRow.appendChild(
    document.createTextNode("private key (~/.local/share/podaj/private.pem) "),
  );
  fileRow.appendChild(fileInput);
  const list = el("div", "reveal-list hidden");
  mount(main, h1, lead, status, fileRow, list);
  root.appendChild(main);

  let sealed: string;
  try {
    const res = await fetch(`/api/handoffs/${id}`);
    if (res.status === 410) {
      setStatus(status, "Already consumed or expired.", "error");
      return;
    }
    if (!res.ok) {
      setStatus(status, `Fetch failed (${res.status}).`, "error");
      return;
    }
    const data = (await res.json()) as { sealed: string };
    sealed = data.sealed;
    setStatus(status, "Ciphertext retrieved (one use). Choose private key to decrypt.", "ok");
    fileRow.classList.remove("hidden");
  } catch (e) {
    setStatus(status, e instanceof Error ? e.message : "Fetch failed", "error");
    return;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const pem = await readFileText(file);
      const { env, payload } = await open(sealed, pem);
      list.replaceChildren();
      for (const v of payload.vars) {
        const row = el("div", "reveal-row");
        const k = el("span");
        k.textContent = v.key;
        const val = el("span");
        val.textContent = v.value;
        mount(row, k, val);
        list.appendChild(row);
      }
      list.classList.remove("hidden");
      setStatus(
        status,
        `Decrypted for “${env}”. Copy what you need — this link cannot be fetched again.`,
        "ok",
      );
    } catch (e) {
      setStatus(status, e instanceof Error ? e.message : "Decrypt failed", "error");
    }
  });
}

async function renderSend(root: HTMLElement): Promise<void> {
  const envs = await loadEnvironments();
  if (envs.length === 0) throw new Error("no environments configured");

  let selected = envs[0]!.slug;
  let drafts: Draft[] = [
    { id: crypto.randomUUID(), key: "", value: "", revealed: false },
  ];

  root.replaceChildren();
  const layout = el("div", "layout");
  const sidebar = el("aside", "sidebar");
  const envTitle = el("h2");
  envTitle.textContent = "Environments";
  const envList = el("ul", "env-list");
  mount(sidebar, envTitle, envList);

  const main = el("div", "main");
  const h1 = el("h1");
  const lead = el("p", "lead");
  const meta = el("p", "meta");
  const toolbar = el("div", "toolbar");
  const addBtn = el("button", "btn");
  addBtn.textContent = "Add variable";
  const sendBtn = el("button", "btn btn-primary");
  sendBtn.textContent = "Encrypt & send";
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
  mount(main, h1, lead, meta, toolbar, table, status);
  mount(layout, sidebar, main);
  root.appendChild(layout);

  const renderRows = () => {
    body.replaceChildren();
    for (const d of drafts) {
      const row = el("div", "var-row");
      const keyInput = el("input") as HTMLInputElement;
      keyInput.placeholder = "OPENAI_API_KEY";
      keyInput.value = d.key;
      keyInput.autocomplete = "off";
      keyInput.addEventListener("input", () => {
        d.key = keyInput.value;
      });
      const valInput = el("input") as HTMLInputElement;
      valInput.placeholder = "secret value";
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
      const actions = el("div");
      mount(actions, reveal, remove);
      mount(row, keyInput, valInput, actions);
      body.appendChild(row);
    }
  };

  const syncEnv = async (env: Environment) => {
    selected = env.slug;
    h1.textContent = "Environment variables";
    lead.textContent =
      "Store API keys and config for your remote agent. Encrypts in your browser with this environment's public key, then writes only PODAJ1 ciphertext to a one-shot KV slot.";
    meta.textContent = `Target: ${env.name} · public key sha-256 prefix: ${await publicKeyFingerprint(env.publicKeyPem)}`;
    for (const btn of envList.querySelectorAll("button")) {
      btn.setAttribute(
        "aria-current",
        btn.dataset.slug === env.slug ? "true" : "false",
      );
    }
  };

  for (const env of envs) {
    const btn = el("button");
    btn.type = "button";
    btn.textContent = env.name;
    btn.dataset.slug = env.slug;
    btn.addEventListener("click", () => void syncEnv(env));
    envList.appendChild(btn);
  }

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
    const env = envs.find((e) => e.slug === selected);
    if (!env) {
      setStatus(status, "Unknown environment.", "error");
      sendBtn.disabled = false;
      return;
    }
    const payload = toPayload(drafts);
    if (payload.vars.length === 0) {
      setStatus(status, "Add at least one key and value.", "error");
      sendBtn.disabled = false;
      return;
    }
    try {
      const sealed = await seal(payload, env.publicKeyPem, env.slug);
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
      setStatus(status, `One-time link:\n${data.url}`, "ok");
      drafts = drafts.map((d) => ({ ...d, value: "" }));
      renderRows();
    } catch (e) {
      setStatus(status, e instanceof Error ? e.message : "Failed", "error");
    } finally {
      sendBtn.disabled = false;
    }
  });

  renderRows();
  await syncEnv(envs[0]!);
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
  p.textContent = e instanceof Error ? e.message : "Startup failed";
  root.appendChild(p);
});

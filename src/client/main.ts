import {
  open,
  publicKeyFingerprint,
  seal,
  type HandoffPayload,
} from "../crypto/podaj1";

type Environment = {
  slug: string;
  name: string;
  description?: string;
  publicKeyPem: string;
};

const mount = (parent: Node, ...children: Node[]) => {
  for (const child of children) parent.appendChild(child);
};

const dom = (tag: string, props?: Record<string, string>): HTMLElement => {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  return node;
};

const setStatus = (node: HTMLElement, text: string, kind: "ok" | "error" | "") => {
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

const handoffRoute = (): string | null => {
  const m = location.pathname.match(/^\/h\/([a-f0-9]{32})$/);
  return m ? m[1] : null;
};

const readFileText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });

async function renderReceive(root: HTMLElement, id: string): Promise<void> {
  root.replaceChildren();
  const main = dom("div", { className: "main" });
  const h2 = dom("h2");
  h2.textContent = "one-shot handoff";
  const lead = dom("p", { className: "lead" });
  lead.textContent =
    "fetching ciphertext from kv. decrypt locally with your private key — it never leaves this browser.";
  const status = dom("div", { className: "status hidden" });
  const fileRow = dom("div", { className: "file-row hidden" });
  const fileLabel = dom("label");
  fileLabel.textContent = "private key (~/.local/share/podaj/private.pem)";
  const fileInput = dom("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".pem";
  mount(fileRow, fileLabel, fileInput);

  const fields = dom("div", { className: "hidden" });
  const mkField = (name: string, label: string, secret = false) => {
    const wrap = dom("div", { className: "field" });
    const lab = dom("label");
    lab.textContent = label;
    const input = dom("input") as HTMLInputElement;
    input.name = name;
    input.readOnly = true;
    if (secret) input.type = "password";
    mount(wrap, lab, input);
    return { wrap, input };
  };
  const profile = mkField("profile", "auth profile name");
  const loginUrl = mkField("loginUrl", "login url");
  const username = mkField("username", "username");
  const password = mkField("password", "password", true);
  mount(fields, profile.wrap, loginUrl.wrap, username.wrap, password.wrap);

  mount(main, h2, lead, status, fileRow, fields);
  root.appendChild(main);

  let sealed: string;
  try {
    const res = await fetch(`/api/handoffs/${id}`);
    if (res.status === 410) {
      setStatus(status, "already consumed or expired.", "error");
      return;
    }
    if (!res.ok) {
      setStatus(status, `fetch failed (${res.status})`, "error");
      return;
    }
    const data = (await res.json()) as { sealed: string };
    sealed = data.sealed;
    setStatus(status, "ciphertext retrieved (one use). choose private key to decrypt.", "ok");
    fileRow.classList.remove("hidden");
  } catch (e) {
    setStatus(status, e instanceof Error ? e.message : "fetch failed", "error");
    return;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const pem = await readFileText(file);
      const { env, payload } = await open(sealed, pem);
      profile.input.value = payload.profile;
      loginUrl.input.value = payload.loginUrl;
      username.input.value = payload.username;
      password.input.value = payload.password;
      fields.classList.remove("hidden");
      setStatus(
        status,
        `decrypted for environment “${env}”. copy what you need — this page cannot fetch again.`,
        "ok",
      );
    } catch (e) {
      setStatus(status, e instanceof Error ? e.message : "decrypt failed", "error");
    }
  });
}

async function renderSend(root: HTMLElement): Promise<void> {
  const envs = await loadEnvironments();
  if (envs.length === 0) throw new Error("no environments configured");

  let selected = envs[0]!.slug;

  root.replaceChildren();
  const layout = dom("div", { className: "layout" });
  const sidebar = dom("aside", { className: "sidebar" });
  const h1 = dom("h1");
  h1.textContent = "Environments";
  const list = dom("ul", { className: "env-list" });
  mount(sidebar, h1, list);

  const main = dom("div", { className: "main" });
  const title = dom("h2");
  const lead = dom("p", { className: "lead" });
  const meta = dom("p", { className: "meta" });
  const form = dom("form");
  const status = dom("div", { className: "status hidden" });

  const mkInput = (
    name: keyof HandoffPayload,
    label: string,
    secret = false,
  ): { wrap: HTMLElement; input: HTMLInputElement } => {
    const wrap = dom("div", { className: "field" });
    const lab = dom("label");
    lab.textContent = label;
    const input = dom("input") as HTMLInputElement;
    input.name = name;
    input.required = true;
    input.autocomplete = "off";
    if (secret) input.type = "password";
    mount(wrap, lab, input);
    return { wrap, input };
  };

  const profile = mkInput("profile", "auth profile name");
  const login = mkInput("loginUrl", "login url");
  const user = mkInput("username", "username");
  const pass = mkInput("password", "password", true);

  const actions = dom("div", { className: "actions" });
  const submit = dom("button", { type: "submit" }) as HTMLButtonElement;
  submit.textContent = "encrypt & send";
  actions.appendChild(submit);

  const foot = dom("div", { className: "footnote" });
  foot.textContent =
    "aes-256-gcm + rsa-oaep-256. private key never leaves the recipient machine. do not share the handoff url in public channels.";

  mount(form, profile.wrap, login.wrap, user.wrap, pass.wrap, actions);
  mount(main, title, lead, meta, form, status, foot);
  mount(layout, sidebar, main);
  root.appendChild(layout);

  const syncEnv = async (env: Environment) => {
    selected = env.slug;
    title.textContent = `handoff → ${env.name}`;
    lead.textContent =
      "encrypts in your browser with this environment's public key, then stores only PODAJ1 ciphertext in a one-shot kv slot.";
    const fp = await publicKeyFingerprint(env.publicKeyPem);
    meta.textContent = `public key sha-256 prefix: ${fp}`;
    for (const btn of list.querySelectorAll("button")) {
      btn.setAttribute(
        "aria-current",
        btn.dataset.slug === env.slug ? "true" : "false",
      );
    }
  };

  for (const env of envs) {
    const btn = dom("button", { type: "button" });
    btn.textContent = env.name;
    btn.dataset.slug = env.slug;
    btn.addEventListener("click", () => void syncEnv(env));
    list.appendChild(btn);
  }

  await syncEnv(envs[0]!);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    setStatus(status, "", "");
    const env = envs.find((e) => e.slug === selected);
    if (!env) {
      setStatus(status, "unknown environment", "error");
      submit.disabled = false;
      return;
    }
    const payload: HandoffPayload = {
      profile: profile.input.value.trim(),
      loginUrl: login.input.value.trim(),
      username: user.input.value.trim(),
      password: pass.input.value,
    };
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
      setStatus(status, `stored. one-time link:\n${data.url}`, "ok");
      pass.input.value = "";
    } catch (e) {
      setStatus(status, e instanceof Error ? e.message : "failed", "error");
    } finally {
      submit.disabled = false;
    }
  });
}

const boot = async (): Promise<void> => {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app missing");
  const id = handoffRoute();
  if (id) await renderReceive(root, id);
  else await renderSend(root);
};

boot().catch((e) => {
  const root = document.getElementById("app");
  if (root) {
    const p = document.createElement("p");
    p.className = "status error";
    p.textContent = e instanceof Error ? e.message : "startup failed";
    root.appendChild(p);
  }
});

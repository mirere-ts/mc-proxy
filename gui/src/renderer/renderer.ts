/**
 * 画面側のロジック。DOM を組み立てるのは index.html に任せ、
 * ここでは状態の反映と入力の検証だけを担う。
 */

interface McProxyApi {
  getConfig(): Promise<unknown>;
  saveConfig(partial: unknown): Promise<unknown>;
  startBridge(input: unknown): Promise<{ ok: boolean; error?: string }>;
  stopBridge(): Promise<{ ok: boolean }>;
  startServer(input: unknown): Promise<{ ok: boolean; error?: string }>;
  stopServer(): Promise<{ ok: boolean }>;
  getStatus(): Promise<unknown>;
  logHistory(): Promise<unknown[]>;
  clearLogs(): Promise<unknown>;
  appInfo(): Promise<{ version: string; platform: string }>;
  openExternal(url: string): Promise<unknown>;
  on(channel: "log" | "status", callback: (data: unknown) => void): () => void;
}

declare global {
  interface Window {
    mcproxy: McProxyApi;
  }
}

const api = window.mcproxy;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

// ---------------------------------------------------------------- 状態

interface SideState {
  state: "stopped" | "starting" | "running";
  error: string | null;
}

interface Status {
  bridge: SideState & { connections: number };
  server: SideState & { sessions: number };
}

interface LogEntry {
  t: string;
  source: string;
  level: "info" | "error";
  line: string;
}

let status: Status = {
  bridge: { state: "stopped", connections: 0, error: null },
  server: { state: "stopped", sessions: 0, error: null },
};

const logEntries: LogEntry[] = [];
let logFilter: "all" | "bridge" | "server" | "error" = "all";

// ---------------------------------------------------------------- 反映

const PILL_LABEL: Record<string, string> = {
  stopped: "停止中",
  starting: "起動中…",
  running: "稼働中",
  error: "エラー",
};

function pillState(side: SideState): string {
  if (side.state === "stopped" && side.error) return "error";
  return side.state;
}

function renderStatus(): void {
  const bridge = status.bridge;
  const server = status.server;

  // ピル
  const bridgePill = $("pill-bridge");
  const serverPill = $("pill-server");
  bridgePill.dataset.state = pillState(bridge);
  serverPill.dataset.state = pillState(server);
  bridgePill.textContent = PILL_LABEL[pillState(bridge)];
  serverPill.textContent = PILL_LABEL[pillState(server)];

  // サイドバーの点
  $("dot-bridge").dataset.state = pillState(bridge);
  $("dot-server").dataset.state = pillState(server);

  // 開始 / 停止ボタン
  const bridgeBtn = $("bridge-toggle") as HTMLButtonElement;
  bridgeBtn.dataset.mode = bridge.state === "running" ? "stop" : "start";
  bridgeBtn.textContent = bridge.state === "running" ? "停止" : bridge.state === "starting" ? "起動中…" : "開始";
  bridgeBtn.disabled = bridge.state === "starting";

  const serverBtn = $("server-toggle") as HTMLButtonElement;
  serverBtn.dataset.mode = server.state === "running" ? "stop" : "start";
  serverBtn.textContent = server.state === "running" ? "停止" : server.state === "starting" ? "起動中…" : "開始";
  serverBtn.disabled = server.state === "starting";

  // 動作中は入力をロックする
  const bridgeLocked = bridge.state !== "stopped";
  for (const id of ["bridge-url", "bridge-port", "bridge-autostart"]) input(id).disabled = bridgeLocked;

  const serverLocked = server.state !== "stopped";
  for (const id of ["server-port", "server-wspath", "server-uphost", "server-upport", "server-autostart"]) {
    input(id).disabled = serverLocked;
  }

  // 成功カード
  $("bridge-running").hidden = bridge.state !== "running";
  if (bridge.state === "running") {
    const port = Number.parseInt(input("bridge-port").value, 10);
    const addr = port === 25565 ? "localhost" : "localhost:" + port;
    $("bridge-addr").textContent = addr;
  }
  $("bridge-conns").textContent = String(bridge.connections);

  $("server-running").hidden = server.state !== "running";
  if (server.state === "running") {
    const port = Number.parseInt(input("server-port").value, 10);
    const wsPath = normalizePath(input("server-wspath").value);
    $("server-addr").textContent = ":" + port + wsPath;
  }
  $("server-sessions").textContent = String(server.sessions);

  // エラーバナー
  const bridgeBanner = $("bridge-banner") as HTMLElement;
  bridgeBanner.hidden = !bridge.error;
  if (bridge.error) bridgeBanner.textContent = bridge.error;
  const serverBanner = $("server-banner") as HTMLElement;
  serverBanner.hidden = !server.error;
  if (server.error) serverBanner.textContent = server.error;
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim() || "/minecraft";
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

// ---------------------------------------------------------------- 検証

const URL_RE = /^wss?:\/\/\S+$/;

function setFieldError(id: string, message: string | null): void {
  const err = $("err-" + id) as HTMLElement;
  const field = input(id);
  if (message) {
    err.textContent = message;
    err.hidden = false;
    field.classList.add("invalid");
  } else {
    err.hidden = true;
    field.classList.remove("invalid");
  }
}

function validateBridge(): boolean {
  const url = input("bridge-url").value.trim();
  const port = input("bridge-port").value.trim();
  let ok = true;

  setFieldError("bridge-url", null);
  if (!url) {
    setFieldError("bridge-url", "サーバーのアドレスを入力してください");
    ok = false;
  } else if (!URL_RE.test(url)) {
    setFieldError("bridge-url", "wss:// か ws:// で始まる URL を入力してください");
    ok = false;
  }

  setFieldError("bridge-port", null);
  const portNum = Number.parseInt(port, 10);
  if (!/^[0-9]+$/.test(port) || portNum < 1 || portNum > 65535) {
    setFieldError("bridge-port", "1〜65535 のポート番号を入れてください");
    ok = false;
  }
  return ok;
}

function validateServer(): boolean {
  const port = input("server-port").value.trim();
  const wsPath = input("server-wspath").value.trim();
  const uphost = input("server-uphost").value.trim();
  const upport = input("server-upport").value.trim();
  let ok = true;

  setFieldError("server-port", null);
  const portNum = Number.parseInt(port, 10);
  if (!/^[0-9]+$/.test(port) || portNum < 1 || portNum > 65535) {
    setFieldError("server-port", "1〜65535 のポート番号を入れてください");
    ok = false;
  }

  setFieldError("server-wspath", null);
  if (!wsPath || !wsPath.startsWith("/")) {
    setFieldError("server-wspath", "/ で始まるパスを入れてください(例: /minecraft)");
    ok = false;
  }

  setFieldError("server-uphost", null);
  if (!uphost) {
    setFieldError("server-uphost", "バックエンドのアドレスを入力してください");
    ok = false;
  }

  setFieldError("server-upport", null);
  const upportNum = Number.parseInt(upport, 10);
  if (!/^[0-9]+$/.test(upport) || upportNum < 1 || upportNum > 65535) {
    setFieldError("server-upport", "1〜65535 のポート番号を入れてください");
    ok = false;
  }
  return ok;
}

// ---------------------------------------------------------------- 設定の保存

let saveTimer: number | undefined;

function queueSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.saveConfig({
      bridge: {
        url: input("bridge-url").value.trim(),
        port: input("bridge-port").value,
        autoStart: input("bridge-autostart").checked,
      },
      server: {
        port: input("server-port").value,
        wsPath: input("server-wspath").value,
        upstreamHost: input("server-uphost").value,
        upstreamPort: input("server-upport").value,
        autoStart: input("server-autostart").checked,
      },
    });
  }, 400);
}

// ---------------------------------------------------------------- ログ

function formatLog(entry: LogEntry): string {
  return "[" + entry.t + "] [" + entry.source + "] " + entry.line;
}

function passFilter(entry: LogEntry): boolean {
  if (logFilter === "all") return true;
  if (logFilter === "error") return entry.level === "error";
  return entry.source === logFilter;
}

function renderLogs(): void {
  const view = $("log-view") as HTMLElement;
  const follow = input("log-follow").checked;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  view.textContent = "";
  for (const entry of logEntries) {
    if (!passFilter(entry)) continue;
    const row = document.createElement("span");
    if (entry.level === "error") row.className = "l-error";
    const time = document.createElement("span");
    time.className = "l-time";
    time.textContent = "[" + entry.t + "] ";
    const src = document.createElement("span");
    src.className = "l-src s-" + entry.source;
    src.textContent = "[" + entry.source + "] ";
    const text = document.createElement("span");
    text.textContent = entry.line + "\n";
    row.append(time, src, text);
    view.append(row);
  }
  if (follow || nearBottom) view.scrollTop = view.scrollHeight;
}

function appendLog(entry: LogEntry): void {
  logEntries.push(entry);
  if (logEntries.length > 2000) logEntries.splice(0, logEntries.length - 2000);
  renderLogs();
}

// ---------------------------------------------------------------- 起動・停止

async function toggleBridge(): Promise<void> {
  const btn = $("bridge-toggle") as HTMLButtonElement;
  $("bridge-note").textContent = "";
  if (status.bridge.state === "running") {
    btn.disabled = true;
    await api.stopBridge();
    return;
  }
  if (!validateBridge()) return;
  btn.disabled = true;
  $("bridge-note").textContent = "接続を確立しています…";
  const result = await api.startBridge({
    url: input("bridge-url").value.trim(),
    port: input("bridge-port").value,
    host: "127.0.0.1",
    autoStart: input("bridge-autostart").checked,
  });
  // 成功・失敗どちらでもノートは消す(失敗時はバナー、成功時はカードが出る)。
  $("bridge-note").textContent = "";
}

async function toggleServer(): Promise<void> {
  const btn = $("server-toggle") as HTMLButtonElement;
  $("server-note").textContent = "";
  if (status.server.state === "running") {
    btn.disabled = true;
    await api.stopServer();
    return;
  }
  if (!validateServer()) return;
  btn.disabled = true;
  $("server-note").textContent = "ポートを開いています…";
  const result = await api.startServer({
    port: input("server-port").value,
    wsPath: input("server-wspath").value,
    upstreamHost: input("server-uphost").value.trim(),
    upstreamPort: input("server-upport").value,
    autoStart: input("server-autostart").checked,
  });
  // 成功・失敗どちらでもノートは消す(失敗時はバナー、成功時はカードが出る)。
  $("server-note").textContent = "";
}

// ---------------------------------------------------------------- クリップボード

async function copyText(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const old = button.textContent;
  button.textContent = "コピーしました";
  window.setTimeout(() => {
    button.textContent = old;
  }, 1200);
}

// ---------------------------------------------------------------- 初期化

function switchView(name: string): void {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === "view-" + name);
  });
}

async function init(): Promise<void> {
  // 設定をフォームに載せる
  try {
    const config = (await api.getConfig()) as {
      bridge: { url: string; port: number; autoStart: boolean };
      server: { port: number; wsPath: string; upstreamHost: string; upstreamPort: number; autoStart: boolean };
    };
    if (config.bridge.url) input("bridge-url").value = config.bridge.url;
    if (config.bridge.port) input("bridge-port").value = String(config.bridge.port);
    input("bridge-autostart").checked = Boolean(config.bridge.autoStart);
    if (config.server.port) input("server-port").value = String(config.server.port);
    if (config.server.wsPath) input("server-wspath").value = config.server.wsPath;
    if (config.server.upstreamHost) input("server-uphost").value = config.server.upstreamHost;
    if (config.server.upstreamPort) input("server-upport").value = String(config.server.upstreamPort);
    input("server-autostart").checked = Boolean(config.server.autoStart);
  } catch {
    // 既定値のまま進める
  }

  const info = await api.appInfo();
  $("app-version").textContent = "MC Proxy Console v" + info.version;

  // ログ履歴
  const history = await api.logHistory();
  for (const entry of history as LogEntry[]) appendLog(entry);

  api.on("log", (data) => appendLog(data as LogEntry));
  api.on("status", (data) => {
    status = data as Status;
    renderStatus();
  });
  status = (await api.getStatus()) as Status;
  renderStatus();

  // イベント
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView((btn as HTMLElement).dataset.view ?? "play"));
  });

  ($("bridge-toggle") as HTMLButtonElement).addEventListener("click", () => void toggleBridge());
  ($("server-toggle") as HTMLButtonElement).addEventListener("click", () => void toggleServer());

  // Enter でも開始・停止
  for (const id of ["bridge-url", "bridge-port"]) {
    input(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") void toggleBridge();
    });
  }
  for (const id of ["server-port", "server-wspath", "server-uphost", "server-upport"]) {
    input(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") void toggleServer();
    });
  }

  // 変更したら保存し、検証を張り直す
  for (const id of ["bridge-url", "bridge-port", "server-port", "server-wspath", "server-uphost", "server-upport"]) {
    input(id).addEventListener("input", () => {
      queueSave();
      setFieldError(id, null);
    });
  }
  input("bridge-autostart").addEventListener("change", queueSave);
  input("server-autostart").addEventListener("change", queueSave);

  // 外部リンク
  document.querySelectorAll("a[data-ext]").forEach((a) => {
    a.addEventListener("click", (event) => {
      event.preventDefault();
      void api.openExternal((a as HTMLAnchorElement).href);
    });
  });

  // コピー
  document.querySelectorAll(".chip-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = (btn as HTMLElement).dataset.copyTarget ?? "";
      const code = document.getElementById(target);
      if (code) void copyText(code.textContent ?? "", btn as HTMLElement);
    });
  });

  // ログ
  document.querySelectorAll("#log-filter .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      logFilter = (btn as HTMLElement).dataset.filter as typeof logFilter;
      document.querySelectorAll("#log-filter .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderLogs();
    });
  });
  input("log-follow").addEventListener("change", renderLogs);
  ($("log-clear") as HTMLButtonElement).addEventListener("click", async () => {
    logEntries.length = 0;
    renderLogs();
    await api.clearLogs();
  });
  ($("log-copy") as HTMLButtonElement).addEventListener("click", () => {
    void copyText(logEntries.filter(passFilter).map(formatLog).join("\n"), $("log-copy"));
  });
}

void init();

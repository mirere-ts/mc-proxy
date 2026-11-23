/**
 * Electron のメインプロセス。
 *
 * bridge/ と server/ のコア実装をこのプロセスに直接組み込んで動かす。
 * 画面(renderer)とは contextBridge を挟んだ IPC だけでやり取りする。
 */
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { startBridge, normalizeBridgeUrl, type BridgeHandle } from "../../bridge/bridge.ts";
import { startServer, type WsServerHandle } from "../../server/server.ts";
import { createUpdater, type UpdateState } from "./updater.ts";

// ---------------------------------------------------------------- 設定

interface BridgeConfig {
  url: string;
  port: number;
  host: string;
  autoStart: boolean;
}

interface ServerConfig {
  port: number;
  wsPath: string;
  upstreamHost: string;
  upstreamPort: number;
  autoStart: boolean;
}

interface AppConfig {
  bridge: BridgeConfig;
  server: ServerConfig;
  update: UpdateConfig;
}

interface UpdateConfig {
  /** 更新の確認先。GitHub リポジトリ URL(github.com/owner/repo)または generic フィードの URL。 */
  url: string;
  /** 起動時に自動で更新を確認するか。 */
  autoCheck: boolean;
}

const defaultConfig: AppConfig = {
  bridge: { url: "", port: 25565, host: "127.0.0.1", autoStart: false },
  server: { port: 80, wsPath: "/minecraft", upstreamHost: "127.0.0.1", upstreamPort: 25565, autoStart: false },
  update: { url: "https://github.com/mirere-ts/mc-proxy", autoCheck: true },
};

let config: AppConfig = JSON.parse(JSON.stringify(defaultConfig));

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<AppConfig>;
    config = {
      bridge: { ...defaultConfig.bridge, ...(raw.bridge ?? {}) },
      server: { ...defaultConfig.server, ...(raw.server ?? {}) },
      update: { ...defaultConfig.update, ...(raw.update ?? {}) },
    };
  } catch {
    config = JSON.parse(JSON.stringify(defaultConfig));
  }
}

function saveConfig(): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (error) {
    addLog("app", "error", "設定の保存に失敗しました: " + String(error));
  }
}

// ---------------------------------------------------------------- ログ

interface LogEntry {
  /** 時刻(HH:MM:SS)。 */
  t: string;
  /** 発生源: app | bridge | server */
  source: string;
  /** info | error */
  level: "info" | "error";
  line: string;
}

const LOG_RING_MAX = 2000;
const logRing: LogEntry[] = [];

function addLog(source: string, level: "info" | "error", line: string): void {
  const entry: LogEntry = {
    t: new Date().toTimeString().slice(0, 8),
    source,
    level,
    line,
  };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  send("log", entry);
}

// ---------------------------------------------------------------- 状態

type RunState = "stopped" | "starting" | "running";

let bridgeHandle: BridgeHandle | null = null;
let bridgeStarting = false;
let bridgeError: string | null = null;

let serverHandle: WsServerHandle | null = null;
let serverStarting = false;
let serverError: string | null = null;

function emitStatus(): void {
  send("status", {
    bridge: {
      state: bridgeHandle !== null ? "running" : bridgeStarting ? "starting" : "stopped",
      connections: bridgeHandle ? bridgeHandle.connections() : 0,
      error: bridgeError,
    },
    server: {
      state: serverHandle !== null ? "running" : serverStarting ? "starting" : "stopped",
      sessions: serverHandle ? serverHandle.sessions() : 0,
      error: serverError,
    },
  });
}

// ---------------------------------------------------------------- 更新

const updater = createUpdater((state) => {
  send("update", state);
  if (state.status === "available") {
    addLog("app", "info", "新しい版 v" + state.latest + (state.manualOnly ? " があります(手動で入れ替えてください)" : " をダウンロードします"));
  } else if (state.status === "downloaded") {
    addLog("app", "info", "更新 v" + state.latest + " のダウンロードが完了しました。「更新を適用」で再起動します。");
  } else if (state.status === "up-to-date") {
    addLog("app", "info", "v" + state.current + " は最新です");
  } else if (state.status === "error" && state.error) {
    addLog("app", "error", "更新の確認に失敗しました: " + state.error);
  }
});

/** 更新の確認先。環境変数 MCPROXY_UPDATE_URL があればそちらを優先する。 */
function feedUrl(): string {
  return (process.env.MCPROXY_UPDATE_URL ?? "").trim() || config.update.url;
}

/** 起動時の自動チェック(パッケージ済み・確認先設定済みのときだけ)。 */
function autoCheckUpdate(): void {
  if (!app.isPackaged || !config.update.autoCheck || !feedUrl()) return;
  win?.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void updater.check(feedUrl());
    }, 3000);
  });
}

// ---------------------------------------------------------------- ウィンドウ

let win: BrowserWindow | null = null;

function send(channel: string, data: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.on("closed", () => {
    win = null;
  });
  // 検証用: MCPROXY_SHOT=<path> を付けると起動直後にスクリーンショットを保存して終わる。
  const shot = process.env.MCPROXY_SHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await win!.webContents.capturePage();
          fs.writeFileSync(shot, image.toPNG());
        } catch (error) {
          console.error("screenshot failed:", error);
        }
        app.quit();
      }, 600);
    });
  }
  void win.loadFile(path.join(__dirname, "index.html"));
}

// ---------------------------------------------------------------- バリデーション

function validatePort(raw: unknown, name: string): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(name + " は 1〜65535 のポート番号で指定してください");
  }
  return value;
}

function friendlyError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "EADDRINUSE") return "指定のポートは既に使われています。別のポートを指定してください。";
  if (code === "EACCES") return "指定のポートを開く権限がありません。管理者権限の要らないポート(1024 以上)をお試しください。";
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

// ---------------------------------------------------------------- 操作(IPC の中身)

async function startBridgeOp(input: Partial<BridgeConfig>): Promise<{ ok: true } | { ok: false; error: string }> {
  if (bridgeHandle) return { ok: false, error: "ブリッジは既に動作しています。" };
  if (bridgeStarting) return { ok: false, error: "ブリッジを起動中です。少しお待ちください。" };
  try {
    const url = normalizeBridgeUrl(String(input.url ?? "").trim());
    const port = validatePort(input.port, "待ち受けポート");
    const host = String(input.host ?? "127.0.0.1").trim() || "127.0.0.1";
    config.bridge = { url, port, host, autoStart: Boolean(input.autoStart) };
    saveConfig();

    bridgeStarting = true;
    bridgeError = null;
    emitStatus();
    addLog("bridge", "info", "起動中... " + host + ":" + port + " -> " + url);

    bridgeHandle = await startBridge({ url, port, host }, {
      log: (line) => addLog("bridge", "info", line),
      error: (line) => addLog("bridge", "error", line),
    });
    bridgeStarting = false;
    emitStatus();
    return { ok: true };
  } catch (error) {
    bridgeStarting = false;
    bridgeError = friendlyError(error);
    addLog("bridge", "error", bridgeError);
    emitStatus();
    return { ok: false, error: bridgeError };
  }
}

async function stopBridgeOp(): Promise<{ ok: true }> {
  const handle = bridgeHandle;
  if (!handle) return { ok: true };
  bridgeHandle = null;
  emitStatus();
  addLog("bridge", "info", "停止中...");
  await handle.stop();
  addLog("bridge", "info", "停止しました");
  emitStatus();
  return { ok: true };
}

async function startServerOp(input: Partial<ServerConfig>): Promise<{ ok: true } | { ok: false; error: string }> {
  if (serverHandle) return { ok: false, error: "サーバーは既に動作しています。" };
  if (serverStarting) return { ok: false, error: "サーバーを起動中です。少しお待ちください。" };
  try {
    const port = validatePort(input.port, "待ち受けポート");
    let wsPath = String(input.wsPath ?? "/minecraft").trim() || "/minecraft";
    if (!wsPath.startsWith("/")) wsPath = "/" + wsPath;
    const upstreamHost = String(input.upstreamHost ?? "").trim();
    if (!upstreamHost) throw new Error("バックエンドのアドレスを入力してください");
    const upstreamPort = validatePort(input.upstreamPort, "バックエンドのポート");
    config.server = { port, wsPath, upstreamHost, upstreamPort, autoStart: Boolean(input.autoStart) };
    saveConfig();

    serverStarting = true;
    serverError = null;
    emitStatus();
    addLog("server", "info", "起動中... :" + port + wsPath + " -> " + upstreamHost + ":" + upstreamPort);

    serverHandle = await startServer({ port, wsPath, upstreamHost, upstreamPort }, {
      log: (line) => addLog("server", "info", line),
      error: (line) => addLog("server", "error", line),
    });
    serverStarting = false;
    emitStatus();
    return { ok: true };
  } catch (error) {
    serverStarting = false;
    serverError = friendlyError(error);
    addLog("server", "error", serverError);
    emitStatus();
    return { ok: false, error: serverError };
  }
}

async function stopServerOp(): Promise<{ ok: true }> {
  const handle = serverHandle;
  if (!handle) return { ok: true };
  serverHandle = null;
  emitStatus();
  addLog("server", "info", "停止中...");
  await handle.stop();
  addLog("server", "info", "停止しました");
  emitStatus();
  return { ok: true };
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle("config:get", () => config);
  ipcMain.handle("config:save", (_event, partial: Partial<AppConfig>) => {
    if (partial && typeof partial === "object") {
      if (partial.bridge) config.bridge = { ...config.bridge, ...partial.bridge };
      if (partial.server) config.server = { ...config.server, ...partial.server };
      if (partial.update) config.update = { ...config.update, ...partial.update };
      saveConfig();
    }
    return config;
  });
  ipcMain.handle("bridge:start", (_event, input) => startBridgeOp(input ?? {}));
  ipcMain.handle("bridge:stop", () => stopBridgeOp());
  ipcMain.handle("server:start", (_event, input) => startServerOp(input ?? {}));
  ipcMain.handle("server:stop", () => stopServerOp());
  ipcMain.handle("status:get", () => ({
    bridge: {
      state: bridgeHandle !== null ? "running" : bridgeStarting ? "starting" : "stopped",
      connections: bridgeHandle ? bridgeHandle.connections() : 0,
      error: bridgeError,
    },
    server: {
      state: serverHandle !== null ? "running" : serverStarting ? "starting" : "stopped",
      sessions: serverHandle ? serverHandle.sessions() : 0,
      error: serverError,
    },
  }));
  ipcMain.handle("log:history", () => logRing);
  ipcMain.handle("log:clear", () => {
    logRing.length = 0;
    return { ok: true };
  });
  ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform }));
  ipcMain.handle("update:state", () => updater.getState());
  ipcMain.handle("update:check", () => updater.check(feedUrl()));
  ipcMain.handle("update:install", () => updater.install());
  ipcMain.handle("shell:open", (_event, raw: unknown) => {
    const url = String(raw ?? "");
    if (!/^https?:\/\//.test(url)) return { ok: false };
    void shell.openExternal(url);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 起動

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    registerIpc();
    createWindow();
    autoCheckUpdate();

    setInterval(emitStatus, 1000);

    // 設定で「自動開始」が付いていたら、起動時にそのまま動かす。
    if (config.bridge.autoStart && config.bridge.url) {
      void startBridgeOp(config.bridge);
    }
    if (config.server.autoStart) {
      void startServerOp(config.server);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  const handles = [bridgeHandle, serverHandle].filter(Boolean) as (BridgeHandle | WsServerHandle)[];
  if (handles.length === 0) return;
  event.preventDefault();
  bridgeHandle = null;
  serverHandle = null;
  void Promise.all(handles.map((handle) => handle.stop())).then(() => app.quit());
});

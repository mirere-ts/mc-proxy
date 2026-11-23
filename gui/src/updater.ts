/**
 * 自動アップデート(electron-updater のラッパ)。
 *
 * - 確認先(update.url)は設定から受け取る:
 *     - GitHub リポジトリ URL(https://github.com/owner/repo)
 *       → GitHub provider。Releases に electron-builder の成果物
 *         (AppImage と latest-linux.yml など)を置いて使う。
 *     - それ以外の http(s) URL
 *       → generic provider。URL 直下に latest.yml / latest-linux.yml を置いて使う。
 * - AppImage は「確認 → 自動ダウンロード → 再起動時に適用」まで自動。
 * - Windows portable exe は仕様上セルフ更新できないため、確認だけを行い
 *   新しい版があれば手動での入れ替えを促す(manualOnly)。
 */
import { app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "unconfigured"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** 現在のアプリのバージョン */
  current: string;
  /** 新しい版のバージョン(available 以降のみ) */
  latest?: string;
  /** リリースノート(markdown そのまま) */
  notes?: string;
  /** ダウンロード進捗 0〜100(downloading のみ) */
  percent?: number;
  /** リリースページ(GitHub provider のときだけ分かる) */
  releasePage?: string;
  /** 自動適用ができない環境(portable 版など)で新しい版があるとき true */
  manualOnly?: boolean;
  error?: string;
}

const GITHUB_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/;

/** Windows portable で動いているか(electron-builder の portable target が付ける環境変数で判定)。 */
function isPortable(): boolean {
  return process.platform === "win32" && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

interface ParsedFeed {
  url: { provider: "github"; owner: string; repo: string } | { provider: "generic"; url: string };
  releasePage?: string;
}

type FeedUrlArg = Parameters<typeof autoUpdater.setFeedURL>[0];

export function parseFeedUrl(raw: string): ParsedFeed | null {
  const url = String(raw ?? "").trim();
  if (!url) return null;
  const github = GITHUB_RE.exec(url);
  if (github) {
    const [, owner, repo] = github;
    return {
      url: { provider: "github", owner, repo },
      releasePage: `https://github.com/${owner}/${repo}/releases/latest`,
    };
  }
  if (!/^https?:\/\//i.test(url)) return null;
  // 末尾のファイル名まで含めて渡す(generic provider はその場所の latest*.yml を読む)。
  return { url: { provider: "generic", url } };
}

export interface UpdaterHandle {
  getState(): UpdateState;
  /** 更新の確認を実行する。連続実行は 1 本にまとめる。 */
  check(feedUrl: string): Promise<UpdateState>;
  /** ダウンロード済みの更新を適用して再起動する。 */
  install(): Promise<{ ok: boolean; error?: string }>;
}

export function createUpdater(notify: (state: UpdateState) => void): UpdaterHandle {
  const manualOnly = isPortable();
  const state: UpdateState = { status: "idle", current: app.getVersion(), manualOnly };

  function set(patch: Partial<UpdateState>): void {
    Object.assign(state, patch);
    notify({ ...state });
  }

  autoUpdater.autoDownload = !manualOnly;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => {
    set({ status: "checking", error: undefined });
  });
  autoUpdater.on("update-not-available", () => {
    set({ status: "up-to-date", latest: undefined, notes: undefined, releasePage: undefined, error: undefined });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    set({
      status: manualOnly ? "available" : "downloading",
      latest: info.version,
      notes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      error: undefined,
    });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    set({ status: "downloading", percent: progress.percent });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    set({ status: "downloaded", latest: info.version, percent: undefined, error: undefined });
  });
  autoUpdater.on("error", (error: Error) => {
    set({ status: "error", percent: undefined, error: friendlyUpdaterError(error) });
  });

  let running: Promise<UpdateState> | null = null;

  async function check(feedUrl: string): Promise<UpdateState> {
    if (running) return running;
    const feed = parseFeedUrl(feedUrl);
    if (!feed) {
      set({ status: "unconfigured", percent: undefined, error: undefined });
      return { ...state };
    }
    if (!app.isPackaged) {
      // 開発実行では updater が使えない(dev-app-update.yml が必要になる)。
      set({ status: "error", percent: undefined, error: "開発モードでは更新チェックを実行できません" });
      return { ...state };
    }
    autoUpdater.setFeedURL(feed.url as FeedUrlArg);
    if (feed.releasePage) set({ releasePage: feed.releasePage });
    running = autoUpdater.checkForUpdates().then(
      () => ({ ...state }),
      (error: unknown) => {
        set({
          status: "error",
          percent: undefined,
          error: friendlyUpdaterError(error instanceof Error ? error : new Error(String(error))),
        });
        return { ...state };
      },
    );
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  async function install(): Promise<{ ok: boolean; error?: string }> {
    if (manualOnly) return { ok: false, error: "この形式(portable)では自動適用できません。手動で入れ替えてください。" };
    if (state.status !== "downloaded") return { ok: false, error: "まだ更新のダウンロードが済んでいません。" };
    // (isSilent, isForceRunAfter)=Windows 用。AppImage ではそのまま適用・再起動。
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  return { getState: () => ({ ...state }), check, install };
}

function friendlyUpdaterError(error: Error): string {
  const message = error.message ?? String(error);
  // electron-updater のエラー文は長いので、よくある原因だけ短く言い換える。
  if (message.includes("ERR_INTERNET_DISCONNECTED")) return "インターネットに接続されていません";
  if (message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) return "確認先に接続できません";
  if (message.includes("HttpError") || message.includes("404")) return "確認先にリリース情報が見つかりません";
  if (message.includes("dev-app-update.yml")) return "開発モードでは更新チェックを実行できません";
  return message.length > 160 ? message.slice(0, 160) + "…" : message;
}

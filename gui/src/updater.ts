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
  url: FeedUrlArg;
  releasePage?: string;
  /** GitHub provider のときの軽量チェック用 API URL(portable 環境で latest.yml 無しに確認するため)。 */
  api?: string;
}

type FeedUrlArg = Parameters<typeof autoUpdater.setFeedURL>[0];

/** 単純な semver 比較(candidate が current より新しいなら true)。prerelease は除外前提。 */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => {
    const core = v.trim().replace(/^v/i, "").split("-")[0];
    return [0, 1, 2].map((i) => {
      const n = Number.parseInt(core.split(".")[i] ?? "0", 10);
      return Number.isNaN(n) ? 0 : n;
    });
  };
  const c = parts(candidate);
  const u = parts(current);
  return c[0] !== u[0] ? c[0] > u[0] : c[1] !== u[1] ? c[1] > u[1] : c[2] > u[2];
}

export function parseFeedUrl(raw: string): ParsedFeed | null {
  const url = String(raw ?? "").trim();
  if (!url) return null;
  const github = GITHUB_RE.exec(url);
  if (github) {
    const [, owner, repo] = github;
    return {
      url: { provider: "github", owner, repo },
      releasePage: `https://github.com/${owner}/${repo}/releases/latest`,
      api: `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    };
  }
  if (!/^https?:\/\//i.test(url)) return null;
  // generic provider は URL 直下の latest*.yml を読む(ファイル名まで含めない)。
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

  /** portable 環境向けの軽量チェック。GitHub API で最新リリースのバージョンだけを見る。 */
  async function checkManually(feed: ParsedFeed): Promise<void> {
    if (!feed.api) throw new Error("この確認先では portable 版の更新確認ができません");
    const res = await fetch(feed.api, {
      headers: { "User-Agent": "mc-proxy-console-updater", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("確認先にリリース情報が見つかりません");
    const release = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    const latest = String(release.tag_name ?? "").trim().replace(/^v/, "");
    if (!latest) throw new Error("リリース情報にバージョンがありません");
    if (isNewer(latest, state.current)) {
      set({
        status: "available",
        latest,
        notes: typeof release.body === "string" ? release.body : undefined,
        releasePage: release.html_url ?? feed.releasePage,
        percent: undefined,
        error: undefined,
      });
    } else {
      set({ status: "up-to-date", latest: undefined, notes: undefined, percent: undefined, error: undefined });
    }
  }

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
    if (feed.releasePage) set({ releasePage: feed.releasePage });
    if (manualOnly) {
      // portable は autoUpdater が動かない(メタデータも無い)ので、自前で確認する。
      running = checkManually(feed)
        .catch((error: unknown) => {
          set({
            status: "error",
            percent: undefined,
            error: friendlyUpdaterError(error instanceof Error ? error : new Error(String(error))),
          });
          return { ...state };
        })
        .finally(() => {
          running = null;
        });
      return running;
    }
    autoUpdater.setFeedURL(feed.url as FeedUrlArg);
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

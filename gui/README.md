# MC Proxy Console

mc-proxy の GUI。**ブリッジ(遊ぶ側)** と **WS サーバー(公開側)** を 1 つのデスクトップアプリに内蔵した、Linux / Windows 対応の Electron アプリです。

配布物は **1 ファイルの実行ファイル** です。

- Linux: `MCProxyConsole-<version>-linux.AppImage`(ダブルクリックで起動)
- Windows: `MCProxyConsole-<version>-win-portable.exe`(インストール不要、起動するだけ)

## 開発

```bash
cd gui
pnpm install
pnpm start        # esbuild でバンドルして electron を起動
```

配布物を作る:

```bash
pnpm dist:linux   # Linux AppImage
pnpm dist:win     # Windows portable exe(Linux 上からもクロスビルド可)
pnpm dist         # 両方
```

成果物は `gui/release/` に出る。

## 構成

```
gui/
├── package.json            # electron-builder の設定(build フィールド)もここ
├── build.mjs               # esbuild で main / preload / renderer を 1 ファイルずつに束ねる
├── build/icon.png          # アプリアイコン(scripts/make-icon.mjs で生成)
├── scripts/
│   ├── make-icon.mjs       # 依存なしで icon.png を描く
│   └── probe-embedded.mjs  # 起動中のアプリに対する中継テスト(開発用)
├── src/
│   ├── main.ts             # メインプロセス。../../bridge/bridge.ts と ../../server/server.ts を
│   │                       # バンドルして直接内蔵し、IPC で起動・停止・ログ・状態を提供する
│   ├── updater.ts          # electron-updater のラッパ(自動更新)
│   ├── preload.ts          # contextBridge で安全な API だけを renderer に渡す
│   └── renderer/           # index.html / style.css / renderer.ts(vanilla TS、フレームワークなし)
└── dist/                   # ビルド成果物(main.cjs に bridge+server を同梱)
```

## 画面

- **遊びに行く(ブリッジ)**: サーバー主からもらった `wss://...` を入れて「開始」。Minecraft に `localhost`(ポート変更時は `localhost:ポート`)を追加するだけで参加できる。自動再接続(§10)も内蔵。
- **公開する(WS サーバー)**: 待ち受けポート・WS パス・バックエンドを設定して「開始」。起動中は Cloudflare 側設定(A レコード / Flexible / IP 帯制限)のチェックリストを出す。
- **ログ**: 発生源(ブリッジ / サーバー)やエラーだけで絞り込み、コピーもできる。

設定は自動保存され、「次回の起動時に自動で開始」を付けた項目はアプリ起動時にそのまま動き出す。

## 更新

アプリは electron-updater による自動更新に対応しています。

- **Linux(AppImage)**: 起動時とサイドバーの「更新を確認」で新しい版を確認 → 見つかれば自動ダウンロード → ダウンロード完了後に「更新を適用」で再起動して適用(未適用のまま終了した場合は次回の終了時に適用)。
- **Windows(portable exe)**: 仕様上セルフ更新ができないため、確認までを行い新しい版があれば「手動で入れ替え」と表示する。配布ページから新しい exe を取り直してください。

### 確認先の設定

既定ではこのリポジトリ(`https://github.com/mirere-ts/mc-proxy`)の Releases を確認します。設定は不要です。

確認先を変えるときだけ設定ファイル(`config.json` の `update.url`)を編集します。`config.json` は OS ごとのアプリデータディレクトリにあります(例: Linux なら `~/.config/mc-proxy-console/config.json`)。

```json
{
  "update": {
    "url": "https://github.com/別のowner/別のリポジトリ",
    "autoCheck": true
  }
}
```

`url` には次のどちらかを書けます:

- **GitHub リポジトリ URL**(`https://github.com/owner/repo`): GitHub Releases に electron-builder の成果物と更新メタデータ(`latest-linux.yml` など)を置いて使う。`pnpm dist` で `gui/release/` に成果物と一緒に生成される。
- **それ以外の http(s) URL**: generic フィード。その URL 直下に `latest.yml` / `latest-linux.yml`(Windows 向けは `latest.yml`)を置いて使う。GitHub 以外のホスティングに配布物を置く場合用。

`autoCheck` を `false` にすると起動時の自動確認を止める(「更新を確認」ボタンは使える)。

環境変数 `MCPROXY_UPDATE_URL` がある場合は設定より優先される(テストや一時的な切り替え用)。

### リリースの手順

1. `gui/package.json` の `version` を上げる。
2. `pnpm dist`(または `dist:linux` / `dist:win`)で成果物を作る。
3. `gui/release/` の実行ファイルと `latest*.yml` を確認先にアップロードする。

### 開発中

開発実行(`pnpm start`)では electron-updater が使えないため、更新確認は「確認に失敗しました」と表示される。パッケージ後(AppImage / exe)に動作する。

## 仕組み

- 既存の `bridge/bridge.ts`・`server/server.ts` を**そのまま**メインプロセスに読み込んで動かす(esbuild で同梱)。CLI(`npm run bridge` / `npm run server`)と同じ実装なので、挙動は e2e テスト(`tests/e2e.test.ts`)で検証済みの経路と同一。
- renderer は contextIsolation 有効・nodeIntegration 無効。IPC は preload で列挙したチャンネルだけを通す。
- アプリを閉じると内蔵の bridge / server も gracefully に停止する。

## 動作確認の手早い方法

アプリを起動してブリッジとサーバーを動かした状態で:

```bash
node gui/scripts/probe-embedded.mjs   # 環境変数のポート番号はスクリプト内で調整
```

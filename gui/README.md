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
│   ├── preload.ts          # contextBridge で安全な API だけを renderer に渡す
│   └── renderer/           # index.html / style.css / renderer.ts(vanilla TS、フレームワークなし)
└── dist/                   # ビルド成果物(main.cjs に bridge+server を同梱)
```

## 画面

- **遊びに行く(ブリッジ)**: サーバー主からもらった `wss://...` を入れて「開始」。Minecraft に `localhost`(ポート変更時は `localhost:ポート`)を追加するだけで参加できる。自動再接続(§10)も内蔵。
- **公開する(WS サーバー)**: 待ち受けポート・WS パス・バックエンドを設定して「開始」。起動中は Cloudflare 側設定(A レコード / Flexible / IP 帯制限)のチェックリストを出す。
- **ログ**: 発生源(ブリッジ / サーバー)やエラーだけで絞り込み、コピーもできる。

設定は自動保存され、「次回の起動時に自動で開始」を付けた項目はアプリ起動時にそのまま動き出す。

## 仕組み

- 既存の `bridge/bridge.ts`・`server/server.ts` を**そのまま**メインプロセスに読み込んで動かす(esbuild で同梱)。CLI(`npm run bridge` / `npm run server`)と同じ実装なので、挙動は e2e テスト(`tests/e2e.test.ts`)で検証済みの経路と同一。
- renderer は contextIsolation 有効・nodeIntegration 無効。IPC は preload で列挙したチャンネルだけを通す。
- アプリを閉じると内蔵の bridge / server も gracefully に停止する。

## 動作確認の手早い方法

アプリを起動してブリッジとサーバーを動かした状態で:

```bash
node gui/scripts/probe-embedded.mjs   # 環境変数のポート番号はスクリプト内で調整
```

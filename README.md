# mc-proxy

Minecraft Java Edition サーバーを **Cloudflare 無料プランのオレンクラウド**越しに WebSocket で公開するプロキシ。オリジン(自宅サーバー)の IP を隠したまま、月額 0 円でプレイヤーに開放できます。

バニラクライアントからそのまま参加できます。各プレイヤーは小さなブリッジを起動するか、GUI アプリを使います。

```
Minecraft クライアント
   │ TCP localhost:25565
   ▼
ブリッジ(プレイヤー側 / GUI に内蔵)
   │ WSS (wss://mc.example.com)
   ▼
Cloudflare Free(オレンクラウド・WebSocket 通過)
   │ HTTP + WebSocket → オリジン 80 番
   ▼
WS サーバー(オリジン側)
   │ WS ⇔ TCP 変換 / オフライン応答
   ▼
Minecraft バックエンド
```

## 構成

| パス | 内容 |
|---|---|
| `server/` | オリジンで常駐する WS サーバー。WS ⇔ TCP 中継と、バックエンド停止時のオフライン応答 |
| `bridge/` | プレイヤー PC で動くブリッジ。クライアントの生 TCP を WSS に変換 |
| `frames.ts` | 切断耐性のためのフレーミング(連番 + リプレイ + ACK)。bridge / server 共通 |
| `gui/` | **MC Proxy Console**: bridge と server を 1 つに内蔵した Electron デスクトップアプリ。自動更新対応 |
| `tests/` | 単体テスト(43 checks)と e2e テスト(12 checks) |

## 使い方

### 公開する側(オリジン)

```bash
UPSTREAM_HOST=127.0.0.1 PORT=80 node server/index.ts
```

- `UPSTREAM_HOST`(必須)/ `UPSTREAM_PORT`(既定 25565)/ `PORT`(既定 80)/ `WS_PATH`(既定 `/minecraft`)
- Cloudflare 側: A レコード(プロキシ ON)+ SSL/TLS **Flexible** + **80 番への接続を Cloudflare IP 帯のみに制限**(これが無いと IP を隠せない)

### 遊ぶ側

CLI:

```bash
node bridge/index.ts --url wss://mc.example.com
# Minecraft に「localhost」を追加するだけ
```

GUI アプリ(Linux AppImage / Windows portable):

```bash
cd gui && pnpm install && pnpm dist:linux   # または dist:win
# gui/release/ に 1 ファイルの実行アプリが出る
```

WS が切れてもバックエンド TCP を維持したまま自動再接続し、フレーム連番とリプレイでバイト連続性を保ちます(詳細は `gui/README.md` と `frames.ts` のコメント)。

## テスト

```bash
npm test          # 単体 + e2e
npm run test:unit # server/protocol.ts の単体テスト
```

## 更新(アプリ)

GUI アプリは electron-updater で自動更新します。確認先の設定とリリース手順は [gui/README.md](gui/README.md) の「更新」を参照してください。

## ライセンス

[AGPL-3.0](LICENSE)。本ソフトウェアを改変しネットワークサービスとして提供する場合も、ソースコードの開示と同一ライセンスの適用が必須です。

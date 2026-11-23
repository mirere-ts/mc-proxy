/**
 * WS サーバー(オリジンで常駐)の CLI 起動口。
 *
 * 実体は server/server.ts(GUI からも使う)。このファイルは環境変数の解析と
 * コンソール出力だけを担う。
 *
 * 実行: UPSTREAM_HOST=127.0.0.1 PORT=80 node server/index.ts
 */
import { startServer } from "./server.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(name + " is required");
    process.exit(1);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(name + " must be a port number, got: " + raw);
    process.exit(1);
  }
  return value;
}

function log(line: string): void {
  console.log("[" + new Date().toISOString() + "] " + line);
}

async function main(): Promise<void> {
  const config = {
    upstreamHost: requireEnv("UPSTREAM_HOST"),
    upstreamPort: intEnv("UPSTREAM_PORT", 25565),
    port: intEnv("PORT", 80),
    wsPath: process.env.WS_PATH ?? "/minecraft",
    dropHook: process.env.DROP_HOOK === "1",
  };

  let handle: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    handle = await startServer(config, { log, error: (line) => console.error("[" + new Date().toISOString() + "] " + line) });
  } catch {
    process.exit(1);
  }

  function stop(): void {
    clearInterval(keepalive);
    void handle!.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  // GUI は無いので間隔を短くして、停止要求にすぐ応じる。
  const keepalive = setInterval(() => {}, 30_000);
  keepalive.unref();

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();

/**
 * ブリッジ(プレイヤーの PC で実行)の CLI 起動口。
 *
 * 実体は bridge/bridge.ts(GUI からも使う)。このファイルは引数解析と
 * コンソール出力だけを担う。
 *
 * 実行: node bridge/index.ts --url wss://mc.example.com
 */
import { startBridge } from "./bridge.ts";

interface Options {
  url: string;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), "");
    }
  }

  const raw = flags.get("url") ?? process.env.BRIDGE_URL;
  if (!raw) {
    console.error("--url (or BRIDGE_URL) is required, e.g. --url wss://mc.example.com");
    process.exit(1);
  }
  if (!/^wss?:\/\//.test(raw)) {
    console.error("--url must start with ws:// or wss://, got: " + raw);
    process.exit(1);
  }

  const port = Number.parseInt(flags.get("port") ?? process.env.BRIDGE_PORT ?? "25565", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port (or BRIDGE_PORT) must be a port number");
    process.exit(1);
  }

  const host = flags.get("host") ?? process.env.BRIDGE_HOST ?? "127.0.0.1";

  return { url: raw, port, host };
}

function log(line: string): void {
  console.log("[" + new Date().toISOString() + "] " + line);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let handle: Awaited<ReturnType<typeof startBridge>> | null = null;

  try {
    handle = await startBridge(options, { log, error: (line) => console.error("[" + new Date().toISOString() + "] " + line) });
  } catch {
    process.exit(1);
  }

  log("add \"localhost\" in Minecraft (or " + options.host + ":" + options.port + ")");

  function stop(): void {
    log("shutting down (" + handle!.connections() + " active)");
    void handle!.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();

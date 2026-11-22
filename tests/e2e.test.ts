/**
 * e2e テスト(§6 + 再接続)。
 *
 * ダミー MC サーバー(net)+ WS サーバー + ブリッジをローカルで直結し、
 * (a) バックエンド生存時のハンドシェイク透過
 * (b) 停止時の Status / Disconnect のオフライン応答
 * (c) WS が切れても TCP とバックエンド接続が維持され、再開できること
 * を確認する。実行: node tests/e2e.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  OFFLINE_DISCONNECT_JSON,
  OFFLINE_STATUS_JSON,
  encodeHandshake,
  encodePacket,
  encodePing,
  encodeStatusRequest,
  readPacket,
  readString,
  writeString,
} from "../server/protocol.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let checks = 0;
let failures = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  checks++;
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (error) {
    failures++;
    console.log("  FAIL " + name);
    console.log("       " + (error instanceof Error ? error.message : String(error)));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for port " + port);
    await sleep(50);
  }
}

/** 読み取りを蓄積し、条件を満たすまで待てる TCP クライアント。 */
class TcpClient {
  buffer = Buffer.alloc(0);
  socket: net.Socket;
  private waiters: (() => void)[] = [];
  closed = false;

  constructor(port: number) {
    this.socket = net.connect({ host: "127.0.0.1", port });
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    this.socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  write(data: Buffer): void {
    this.socket.write(data);
  }

  async until(predicate: (buffer: Buffer) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.buffer)) {
      if (Date.now() > deadline) {
        const head = this.buffer.subarray(0, 32).toString("hex");
        throw new Error("timed out; have " + this.buffer.length + " bytes (head: " + head + ")");
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100).unref();
      });
    }
  }

  async readPacket(timeoutMs = 10_000) {
    await this.until((buf) => {
      try {
        return readPacket(buf) !== null;
      } catch {
        return true;
      }
    }, timeoutMs);
    const packet = readPacket(this.buffer);
    assert.ok(packet !== null, "no packet available");
    this.buffer = this.buffer.subarray(packet.size);
    return packet;
  }

  async waitClosed(timeoutMs = 10_000): Promise<void> {
    await this.until(() => this.closed, timeoutMs);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

function startProcess(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.E2E_VERBOSE) {
    child.stdout?.on("data", (d: Buffer) => process.stdout.write("    | " + d.toString().trimEnd() + "\n"));
    child.stderr?.on("data", (d: Buffer) => process.stdout.write("    ! " + d.toString().trimEnd() + "\n"));
  }
  return child;
}

function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const backendPort = await freePort();
  const serverPort = await freePort();
  const bridgePort = await freePort();

  // --- ダミー MC サーバー ---
  // ハンドシェイクを受けたらそのままエコーする。接続本数も数えて、
  // 再開時にバックエンドへ新しい TCP を張っていないことを確認する。
  const backendSockets: net.Socket[] = [];
  let backendConnections = 0;
  const backend = net.createServer((socket) => {
    backendConnections++;
    backendSockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => backend.listen(backendPort, "127.0.0.1", resolve));

  const server = startProcess("server/index.ts", {
    UPSTREAM_HOST: "127.0.0.1",
    UPSTREAM_PORT: String(backendPort),
    PORT: String(serverPort),
    WS_PATH: "/minecraft",
    DROP_HOOK: "1",
  });
  await waitForPort(serverPort);

  const bridge = startProcess("bridge/index.ts", {
    BRIDGE_URL: "ws://127.0.0.1:" + serverPort + "/minecraft",
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_HOST: "127.0.0.1",
  });
  await waitForPort(bridgePort);

  try {
    console.log("e2e: backend alive");

    await check("handshake is relayed to the backend verbatim", async () => {
      const client = new TcpClient(bridgePort);
      const handshake = encodeHandshake(767, "mc.example.com", 25565, 1);
      client.write(handshake);
      await client.until((buf) => buf.length >= handshake.length);
      assert.deepEqual([...client.buffer.subarray(0, handshake.length)], [...handshake]);
      client.destroy();
    });

    await check("packets after the handshake are relayed both ways", async () => {
      const client = new TcpClient(bridgePort);
      const handshake = encodeHandshake(767, "mc.example.com", 25565, 1);
      client.write(handshake);
      const statusRequest = encodeStatusRequest();
      client.write(statusRequest);
      await client.until((buf) => buf.length >= handshake.length + statusRequest.length);
      const echoed = client.buffer.subarray(handshake.length);
      assert.deepEqual([...echoed], [...statusRequest]);
      client.destroy();
    });

    await check("login handshake is relayed verbatim", async () => {
      const client = new TcpClient(bridgePort);
      const handshake = encodeHandshake(767, "mc.example.com", 25565, 2);
      const loginStart = encodePacket(0x00, writeString("Player"));
      client.write(Buffer.concat([handshake, loginStart]));
      const expected = Buffer.concat([handshake, loginStart]);
      await client.until((buf) => buf.length >= expected.length);
      assert.deepEqual([...client.buffer.subarray(0, expected.length)], [...expected]);
      client.destroy();
    });

    await check("bulk bytes survive the relay", async () => {
      const client = new TcpClient(bridgePort);
      const handshake = encodeHandshake(767, "mc.example.com", 25565, 2);
      client.write(handshake);
      const payload = Buffer.alloc(64 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
      client.write(payload);
      const expected = Buffer.concat([handshake, payload]);
      await client.until((buf) => buf.length >= expected.length, 20_000);
      assert.equal(client.buffer.length, expected.length);
      assert.ok(client.buffer.equals(expected), "relayed bytes differ");
      client.destroy();
    });

    console.log("e2e: reconnect");

    // (c) WS を切ってもクライアント TCP とバックエンド TCP を維持し、張り直しで再開する
    await check("the mc client survives a WS drop and the session resumes", async () => {
      const before = backendConnections;
      const client = new TcpClient(bridgePort);
      const handshake = encodeHandshake(767, "mc.example.com", 25565, 2);
      client.write(handshake);
      await client.until((buf) => buf.length >= handshake.length);

      // サーバー側の WS を全部ぶった切る(CF のメンテや回線断の再現)
      await killSocketsOnServer();
      await sleep(300);
      assert.equal(client.closed, false, "client TCP must stay open");

      // 切断中にクライアントが送ったバイトも、再開後に順番どおり届くこと
      const writtenWhileDown = encodePacket(0x02, Buffer.from([9, 9, 9]));
      client.write(writtenWhileDown);
      await sleep(300);

      // 再接続後に新しいパケットが通ること
      const probePacket = encodePacket(0x03, Buffer.from([1, 2, 3, 4]));
      client.write(probePacket);
      await client.until((buf) => buf.length >= handshake.length + probePacket.length, 15_000);
      const tail = client.buffer.subarray(handshake.length);
      const expected = Buffer.concat([writtenWhileDown, probePacket]);
      assert.deepEqual([...tail.subarray(0, expected.length)], [...expected]);

      // バックエンドへ新しい接続を張っていない = 同じ MC セッションが続いている
      assert.equal(backendConnections, before + 1, "backend must not reconnect");
      client.destroy();
    });

    console.log("e2e: backend down");

    for (const socket of backendSockets) socket.destroy();
    backendSockets.length = 0;
    await new Promise<void>((resolve) => backend.close(() => resolve()));

    await check("offline Status returns the §4.3 Status Response", async () => {
      const client = new TcpClient(bridgePort);
      client.write(Buffer.concat([encodeHandshake(767, "mc.example.com", 25565, 1), encodeStatusRequest()]));
      const response = await client.readPacket();
      assert.equal(response.id, 0x00);
      const text = readString(response.payload);
      assert.ok(text !== null);
      assert.equal(text.value, OFFLINE_STATUS_JSON);
      const json = JSON.parse(text.value);
      assert.equal(json.version.name, "Offline");
      assert.equal(json.version.protocol, -1);
      client.destroy();
    });

    await check("offline Status echoes Ping and closes", async () => {
      const client = new TcpClient(bridgePort);
      const pingPayload = Buffer.from([0, 0, 0, 0, 0, 0, 0, 42]);
      client.write(
        Buffer.concat([
          encodeHandshake(767, "mc.example.com", 25565, 1),
          encodeStatusRequest(),
          encodePing(pingPayload),
        ]),
      );
      const response = await client.readPacket();
      assert.equal(response.id, 0x00);
      const pong = await client.readPacket();
      assert.equal(pong.id, 0x01);
      assert.deepEqual([...pong.payload], [...pingPayload]);
      await client.waitClosed();
    });

    await check("offline Login returns the §4.3 Disconnect", async () => {
      const client = new TcpClient(bridgePort);
      client.write(
        Buffer.concat([
          encodeHandshake(767, "mc.example.com", 25565, 2),
          encodePacket(0x00, writeString("Player")),
        ]),
      );
      const response = await client.readPacket();
      assert.equal(response.id, 0x00);
      assert.equal(readString(response.payload)!.value, OFFLINE_DISCONNECT_JSON);
      await client.waitClosed();
    });

    await check("offline Transfer returns the §4.3 Disconnect", async () => {
      const client = new TcpClient(bridgePort);
      client.write(encodeHandshake(767, "mc.example.com", 25565, 3));
      const response = await client.readPacket();
      assert.equal(response.id, 0x00);
      assert.equal(readString(response.payload)!.value, OFFLINE_DISCONNECT_JSON);
      await client.waitClosed();
    });

    await check("non-Minecraft traffic is rejected", async () => {
      const client = new TcpClient(bridgePort);
      client.write(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n", "ascii"));
      await client.waitClosed(10_000);
    });

    await check("a wrong WS path is rejected with 404", async () => {
      const response = await new Promise<string>((resolve, reject) => {
        const request = [
          "GET /wrong HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        const socket = net.connect({ host: "127.0.0.1", port: serverPort });
        let text = "";
        socket.on("data", (chunk) => {
          text += chunk.toString();
        });
        socket.on("close", () => resolve(text));
        socket.on("error", reject);
        socket.write(request);
        setTimeout(() => {
          socket.destroy();
          resolve(text);
        }, 3000).unref();
      });
      assert.match(response, /^HTTP\/1\.1 404/);
    });
  } finally {
    kill(bridge);
    kill(server);
    for (const socket of backendSockets) socket.destroy();
    backend.close();
  }

  console.log("");
  console.log(checks + " checks, " + failures + " failures");
  process.exit(failures > 0 ? 1 : 0);

  /** サーバープロセスに接続中の WS を切る(CF 側の切断を模す)。 */
  async function killSocketsOnServer(): Promise<void> {
    // 別プロセスなので、サーバーのデバッグ用フックではなく TCP RST で切る。
    // サーバーは TCP を維持するので、WS だけ落ちる。
    await fetch("http://127.0.0.1:" + serverPort + "/__drop").catch(() => {});
    await sleep(50);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

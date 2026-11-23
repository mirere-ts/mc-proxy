/**
 * esbuild でアプリを 1 つに束ねる。
 * - dist/main.cjs      : メインプロセス(bridge/server を内蔵してバンドル)
 * - dist/preload.cjs   : preload
 * - dist/renderer.js   : 画面
 * - dist/index.html / dist/style.css : 画面のコピー
 */
import { build, context } from "esbuild";
import { cp, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "src");
const dist = path.join(root, "dist");

await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  absWorkingDir: root,
};

const watch = process.argv.includes("--watch");

/** electron は外に置く(実行時に本体が差し込まれる)。それ以外は全部 1 ファイルにする。 */
const externals = { external: ["electron"], platform: "node", format: "cjs", target: "node20" };

const jobs = [
  build({
    ...common,
    ...externals,
    entryPoints: [path.join(src, "main.ts")],
    outfile: path.join(dist, "main.cjs"),
  }),
  build({
    ...common,
    ...externals,
    entryPoints: [path.join(src, "preload.ts")],
    outfile: path.join(dist, "preload.cjs"),
  }),
  build({
    ...common,
    entryPoints: [path.join(src, "renderer/renderer.ts")],
    outfile: path.join(dist, "renderer.js"),
    format: "iife",
    platform: "browser",
    target: "chrome120",
  }),
];

if (watch) {
  const contexts = await Promise.all(jobs.map((job) => context(job)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching...");
} else {
  await Promise.all(jobs);
  await copyFile(path.join(src, "renderer/index.html"), path.join(dist, "index.html"));
  await copyFile(path.join(src, "renderer/style.css"), path.join(dist, "style.css"));
  console.log("build done -> dist/");
}

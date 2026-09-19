import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 通过脚本位置计算仓库根目录，避免依赖执行时 cwd（与 build-win-portable.mjs 一致）。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

// 版本号单一来源是根目录 package.json：tauri.conf.json 的 version 指向它，
// Cargo.toml 仅承载 Windows 资源里的版本字符串，构建前在这里自动对齐，避免手动多处修改。
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json 中的 version 不是合法 semver: ${version}`);
  process.exit(1);
}

const tomlPath = join(rootDir, "src-tauri", "Cargo.toml");
const toml = readFileSync(tomlPath, "utf8");
const matched = toml.match(/^version = "([^"]+)"/m);
if (!matched) {
  console.error("Cargo.toml 中未找到 version 字段");
  process.exit(1);
}
if (matched[1] === version) {
  console.log(`Cargo.toml 版本已是 ${version}，无需同步`);
  process.exit(0);
}
// 仅在内容变化时写盘，避免触碰 mtime 触发无谓的 cargo 重编译
writeFileSync(tomlPath, toml.replace(/^version = "[^"]+"/m, `version = "${version}"`));
console.log(`Cargo.toml 版本已同步: ${matched[1]} -> ${version}`);

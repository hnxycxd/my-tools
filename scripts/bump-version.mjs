import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// 通过脚本位置计算仓库根目录，避免依赖执行时 cwd（与 sync-version.mjs 一致）。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

// 用法: node bump-version.mjs <major|minor|patch>
const bumpType = process.argv[2];
const bumpIndex = { major: 0, minor: 1, patch: 2 }[bumpType];
if (bumpIndex === undefined) {
  console.error(`用法: node ./scripts/bump-version.mjs <major|minor|patch>，收到: ${bumpType ?? "(未提供)"}`);
  process.exit(1);
}

const pkgPath = join(rootDir, "package.json");
const raw = readFileSync(pkgPath, "utf8");
const fieldMatch = raw.match(/(^\s*"version":\s*")([^"]+)(")/m);
if (!fieldMatch) {
  console.error("package.json 中未找到 version 字段");
  process.exit(1);
}
const versionMatch = fieldMatch[2].match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
if (!versionMatch) {
  console.error(`package.json 中的 version 不是合法 semver: ${fieldMatch[2]}`);
  process.exit(1);
}

// 所选维度 +1，低于它的维度归零，其余保持不变；预发布后缀（如 -beta.1）原样保留
const parts = [Number(versionMatch[1]), Number(versionMatch[2]), Number(versionMatch[3])];
parts[bumpIndex] += 1;
for (let i = bumpIndex + 1; i < parts.length; i += 1) {
  parts[i] = 0;
}
const nextVersion = `${parts.join(".")}${versionMatch[4]}`;

// 定点替换 version 字段而非整体 JSON 序列化，避免重排 package.json 其余格式
writeFileSync(pkgPath, raw.replace(fieldMatch[0], `${fieldMatch[1]}${nextVersion}${fieldMatch[3]}`));
console.log(`package.json 版本已升级: ${fieldMatch[2]} -> ${nextVersion}`);

// 复用 sync-version.mjs 把新版本同步到 Cargo.toml（Windows 资源里的版本号来源）
const sync = spawnSync(process.execPath, [join(scriptDir, "sync-version.mjs")], { stdio: "inherit" });
if (sync.status !== 0) {
  process.exit(sync.status ?? 1);
}

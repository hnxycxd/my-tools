import { rm, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// 通过脚本位置计算仓库根目录，避免依赖执行时 cwd。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

// 统一维护关键路径：release exe、根目录 exe、历史 bundle 目录。
const releaseDir = join(rootDir, "src-tauri", "target", "release");
const releaseExe = join(releaseDir, "my-tools.exe");
const rootExe = join(rootDir, "my-tools.exe");
const legacyBundleDir = join(releaseDir, "bundle");

/**
 * 安全删除文件或目录（不存在时忽略），用于构建前清理旧产物。
 * @param {{ targetPath: string; recursive?: boolean }} params 删除参数
 */
async function safeRemove({ targetPath, recursive = false }) {
  await rm(targetPath, { force: true, recursive });
}

/**
 * 运行子进程命令，并把输出透传到当前终端。
 * @param {{ command: string; args: string[] }} params 命令参数
 * @returns {Promise<void>}
 */
async function runCommand({ command, args }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`命令执行失败: ${command} ${args.join(" ")} (exit ${code ?? "unknown"})`));
    });
  });
}

/**
 * 检查文件是否存在，不存在则抛出明确错误。
 * @param {{ targetPath: string; hint: string }} params 检查参数
 */
async function assertExists({ targetPath, hint }) {
  try {
    await access(targetPath, constants.F_OK);
  } catch {
    throw new Error(`${hint}: ${targetPath}`);
  }
}

async function main() {
  // 每次打包前清理旧 exe 与旧 bundle，避免误用历史产物。
  await safeRemove({ targetPath: rootExe });
  await safeRemove({ targetPath: releaseExe });
  await safeRemove({ targetPath: legacyBundleDir, recursive: true });

  // 执行 Tauri 构建（会先触发 beforeBuildCommand 生成前端 dist）。
  await runCommand({ command: "npx", args: ["tauri", "build"] });

  // 校验并复制最新 exe 到项目根目录，作为绿色版直启入口。
  await assertExists({ targetPath: releaseExe, hint: "未找到 Tauri release 产物" });
  await copyFile(releaseExe, rootExe);
  console.log(`已生成绿色版: ${rootExe}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

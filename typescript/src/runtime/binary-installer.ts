import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { HarnessError } from "../utils/harness-error.js";

const require = createRequire(import.meta.url);

/**
 * 二进制下载与 scripts/install.sh 同源：取 `$BASE_URL/latest.json`，
 * 按 Rust target triple 下载 `zuno-v<version>-<target>.zip`，
 * 解压出 `zuno` 缓存到 `~/.zuno/sdk/<platform>-<arch>/`。
 * `ZUNO_RELEASE_BASE` 可覆盖基地址，`ZUNO_VERSION` 可锁定版本。
 */

const TARGET_MAP: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

const RELEASES_BASE = (
  process.env.ZUNO_RELEASE_BASE ?? "https://releases.73zls.com/zuno"
).replace(/\/+$/, "");

interface ManifestAsset {
  target: string;
  name: string;
  url?: string;
}

interface Manifest {
  version: string;
  assets: ManifestAsset[];
}

/** 本机对应的 Rust target triple（发布资产命名用）。 */
export function releaseTarget(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return TARGET_MAP[`${platform}-${arch}`];
}

/** 旧的 npm 平台包名（诊断与兼容查找用）。 */
export function platformBinaryPackage(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return TARGET_MAP[`${platform}-${arch}`]
    ? `@sohaha/zuno-${platform}-${arch}`
    : undefined;
}

function binaryName(platform = process.platform): string {
  return platform === "win32" ? "zuno.exe" : "zuno";
}

function targetDir(platform = process.platform, arch = process.arch): string {
  const home = process.env.ZUNO_HOME ?? path.join(os.homedir(), ".zuno");
  return path.join(home, "sdk", `${platform}-${arch}`);
}

function cachedBinary(): string | undefined {
  const p = path.join(targetDir(), binaryName());
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    return undefined;
  }
}

/** 旧的 npm 平台包查找，仅为兼容保留。 */
function legacyBundledBinary(): string | undefined {
  const pkg = platformBinaryPackage();
  if (!pkg) return undefined;
  try {
    const p = path.join(
      path.dirname(require.resolve(`${pkg}/package.json`)),
      "bin",
      binaryName(),
    );
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ENOENT" || code === "EACCES") {
      return undefined;
    }
    throw error;
  }
}

/** 同步解析已存在的 zuno：旧 npm 包 → 下载缓存。 */
export function bundledZunoBinary(): string | undefined {
  return legacyBundledBinary() ?? cachedBinary();
}

/**
 * 确保 zuno 可用，必要时下载。
 * 顺序：`ZUNO_BINARY` → 下载缓存 → 旧 npm 包 → 发布服务器。
 */
export async function ensureZunoBinary(): Promise<string> {
  return (
    process.env.ZUNO_BINARY ??
    cachedBinary() ??
    legacyBundledBinary() ??
    (await downloadBinary())
  );
}

async function fetchJson(url: string): Promise<Manifest> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(
    (e) => {
      throw new HarnessError("download_failed", `无法获取发布清单 ${url}：${e.message}`);
    },
  );
  if (!response.ok) {
    throw new HarnessError(
      "download_failed",
      `无法获取发布清单 ${url}：HTTP ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as Manifest;
}

/** 最小 zip 解压：解析中央目录，解压所有顶层文件（store/deflate）。 */
function extractZip(zipPath: string, outDir: string): void {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new HarnessError("download_failed", "下载的发布包不是有效的 zip");
  }
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const end = off + 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const local = buf.readUInt32LE(off + 42);
    off = end;
    if (name.includes("/") || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const dataOff =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataOff, dataOff + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) fs.writeFileSync(path.join(outDir, name), data);
  }
}

/** 从发布服务器下载本平台的 zuno 二进制。 */
async function downloadBinary(): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const target = releaseTarget();
  if (!target) {
    throw new HarnessError("download_failed", `不支持的平台组合 ${key}`);
  }

  const manifest = await fetchJson(`${RELEASES_BASE}/latest.json`);
  const pinned = process.env.ZUNO_VERSION?.replace(/^v/, "");
  const asset = (manifest.assets ?? []).find(
    (a) => a.target === target && (!pinned || a.name.includes(`-v${pinned}-`)),
  );
  if (!asset) {
    throw new HarnessError(
      "download_failed",
      `latest.json 中没有 ${target} 的发布资产（版本 ${manifest.version}）`,
    );
  }

  const dir = targetDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const zipPath = path.join(dir, `.download.${process.pid}.zip`);
  const url = asset.url ?? `${RELEASES_BASE}/${asset.name}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) }).catch(
    (e) => {
      throw new HarnessError("download_failed", `无法下载 ${url}：${e.message}`);
    },
  );
  if (!response.ok) {
    throw new HarnessError(
      "download_failed",
      `无法下载 ${url}：HTTP ${response.status} ${response.statusText}`,
    );
  }
  fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  try {
    extractZip(zipPath, dir);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  const bin = path.join(dir, binaryName());
  if (!fs.existsSync(bin)) {
    throw new HarnessError(
      "download_failed",
      `下载的压缩包中缺少预期的二进制文件：${binaryName()}`,
    );
  }
  if (process.platform !== "win32") {
    for (const name of [binaryName(), `${binaryName()}.bin`]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  }
  try {
    fs.writeFileSync(path.join(dir, "version.txt"), `${manifest.version}\n`);
  } catch {
    // 版本记录失败不影响使用。
  }
  return bin;
}

/** 缓存二进制的版本字符串（没有缓存时返回 `undefined`）。 */
export function cachedBinaryVersion(): string | undefined {
  try {
    return fs.readFileSync(path.join(targetDir(), "version.txt"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** 发布清单 URL（诊断用；具体资产 URL 由清单决定）。 */
export function binaryDownloadUrl(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return releaseTarget(platform, arch) ? `${RELEASES_BASE}/latest.json` : undefined;
}

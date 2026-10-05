import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standaloneRoot = join(projectRoot, '.next', 'standalone');

const help = `ChatPony 生产启动（先运行 bun run build）

用法：bun run start [选项]

  -p, --port <端口>                 监听端口，默认 PORT 或 3000
  -H, --hostname <地址>             监听地址，默认 HOSTNAME 或 0.0.0.0
      --keepAliveTimeout <毫秒>     非活动连接超时，默认由 Next.js 决定
      --database-path <文件>        数据库位置，默认项目 data/chatpony.sqlite
      --check                       检查参数与构建，不复制文件或启动服务器
  -h, --help                        显示帮助

部署环境变量：PORT、HOSTNAME、KEEP_ALIVE_TIMEOUT、DATABASE_PATH。
命令行参数优先；数据库的相对路径始终相对于项目根目录。
启动时自动复制 public 与 .next/static，并使用 .next/standalone/server.js。
站点、账号、模型和 SMTP 配置在管理后台完成，无需业务 .env。`;

function integer(value, label, minimum, maximum) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label}必须是 ${minimum}–${maximum} 之间的整数。`);
  }
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum}–${maximum} 之间的整数。`);
  }
  return number;
}

function hostname(value) {
  const name = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const domain =
    /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.?$/i;
  if (!isIP(name) && !domain.test(name)) {
    throw new Error('监听地址应为 IP 或主机名，例如 127.0.0.1、0.0.0.0、:: 或 localhost。');
  }
  return name;
}

function isWithin(root, path) {
  const result = relative(root, path);
  return result !== '' && result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result);
}

function validateBuild() {
  const server = join(standaloneRoot, 'server.js');
  const originalBuildId = join(projectRoot, '.next', 'BUILD_ID');
  const standaloneBuildId = join(standaloneRoot, '.next', 'BUILD_ID');
  const staticDirectory = join(projectRoot, '.next', 'static');
  if (
    ![server, originalBuildId, standaloneBuildId].every(
      (path) => existsSync(path) && statSync(path).isFile(),
    ) ||
    !existsSync(staticDirectory) ||
    !statSync(staticDirectory).isDirectory()
  ) {
    throw new Error('未找到完整的 standalone 生产构建，请先在项目根目录运行 bun run build。');
  }
  const buildId = readFileSync(originalBuildId, 'utf8').trim();
  if (!buildId || buildId !== readFileSync(standaloneBuildId, 'utf8').trim()) {
    throw new Error('生产构建与 standalone 目录版本不一致，请重新运行 bun run build。');
  }
  if (!isWithin(realpathSync(projectRoot), realpathSync(standaloneRoot))) {
    throw new Error('standalone 目录必须位于项目目录内。');
  }
  const publicDirectory = join(projectRoot, 'public');
  if (existsSync(publicDirectory) && !statSync(publicDirectory).isDirectory()) {
    throw new Error('项目 public 路径必须是目录。');
  }
  return { server, staticDirectory, publicDirectory };
}

function copyAssets(source, destination) {
  // Both lexical and real paths are checked before replacing a generated asset tree.
  const root = realpathSync(standaloneRoot);
  const parent = realpathSync(dirname(destination));
  if (
    !isWithin(standaloneRoot, resolve(destination)) ||
    (parent !== root && !isWithin(root, parent))
  ) {
    throw new Error('静态资源目标超出了 standalone 目录，已取消复制。');
  }
  if (
    existsSync(destination) &&
    (lstatSync(destination).isSymbolicLink() || !isWithin(root, realpathSync(destination)))
  ) {
    throw new Error('静态资源目标不能是指向其他目录的链接。');
  }
  // next build recreates standalone; replacing these generated directories also removes stale public files.
  rmSync(destination, { recursive: true, force: true });
  if (existsSync(source))
    cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

async function main() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    allowPositionals: false,
    options: {
      port: { type: 'string', short: 'p' },
      hostname: { type: 'string', short: 'H' },
      keepAliveTimeout: { type: 'string' },
      'keep-alive-timeout': { type: 'string' },
      'database-path': { type: 'string' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('ChatPony 需要 Node.js 24 或更高版本，请升级 Node.js 后再启动。');
  }
  const port = integer(values.port ?? process.env.PORT ?? '3000', '监听端口', 1, 65535);
  const host = hostname(values.hostname ?? process.env.HOSTNAME ?? '0.0.0.0');
  const rawKeepAlive =
    values.keepAliveTimeout ?? values['keep-alive-timeout'] ?? process.env.KEEP_ALIVE_TIMEOUT;
  const keepAlive =
    rawKeepAlive === undefined
      ? undefined
      : integer(rawKeepAlive, '非活动连接超时', 0, 2_147_483_647);
  const database = values['database-path'] ?? process.env.DATABASE_PATH ?? 'data/chatpony.sqlite';
  if (!database.trim() || database.includes('\0'))
    throw new Error('数据库路径不能为空或包含空字符。');
  const databasePath = resolve(projectRoot, database);
  if (existsSync(databasePath) && !statSync(databasePath).isFile()) {
    throw new Error('数据库路径应指向文件，不能指向目录。');
  }
  const build = validateBuild();

  if (values.check) {
    console.log(
      `[ChatPony] 检查通过；未复制资源或启动服务器。\n监听地址：${host}\n端口：${port}\n数据库：${databasePath}\n入口：${build.server}`,
    );
    return;
  }

  copyAssets(build.publicDirectory, join(standaloneRoot, 'public'));
  copyAssets(build.staticDirectory, join(standaloneRoot, '.next', 'static'));
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(port);
  process.env.HOSTNAME = host;
  if (keepAlive !== undefined) process.env.KEEP_ALIVE_TIMEOUT = String(keepAlive);
  // The generated server changes cwd to standalone. Fix the database and key location first.
  process.env.DATABASE_PATH = databasePath;
  console.log(`[ChatPony] 使用数据库：${databasePath}`);
  await import(pathToFileURL(build.server).href);
}

main().catch((error) => {
  console.error(
    `[ChatPony] ${error instanceof Error ? error.message : '生产启动失败。'}\n使用 bun run start --help 查看参数。`,
  );
  process.exitCode = 1;
});

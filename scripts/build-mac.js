const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const APP_BUNDLE = path.join(RELEASE_DIR, 'mac-arm64', 'WorkWeb.app');
const ELECTRON_BUILDER_CLI = path.join(ROOT_DIR, 'node_modules', 'electron-builder', 'cli.js');

// macOS 26 (Tahoe) 只有在 Mach-O 的 LC_BUILD_VERSION 里声明 SDK >= 26 时，
// 才会给窗口使用新版红绿灯与更大的圆角。Electron 37 是用 SDK 15.4 构建的，
// 所以打包后把这两个二进制的 SDK 声明改写成 26.0，再重新做 ad-hoc 签名。
const MACOS_SDK_VERSION = process.env.WORKWEB_MAC_SDK || '26.0';
const MIN_MACOS_VERSION = '11.0';
const PATCH_TARGETS = [
  path.join('Contents', 'MacOS', 'WorkWeb'),
  path.join('Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT_DIR, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 失败，退出码 ${code}`));
    });
  });
}

function hasCommand(command) {
  try {
    const result = require('child_process').spawnSync('which', [command], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function patchMacosSdk() {
  if (!fs.existsSync(APP_BUNDLE)) {
    throw new Error(`未找到打包后的应用：${APP_BUNDLE}`);
  }

  if (!hasCommand('vtool')) {
    console.warn('未找到 vtool（Xcode Command Line Tools），跳过 macOS SDK 补丁，红绿灯将保持旧版样式');
    return;
  }

  for (const target of PATCH_TARGETS) {
    const filePath = path.join(APP_BUNDLE, target);
    if (!fs.existsSync(filePath)) {
      console.warn(`跳过不存在的补丁目标：${target}`);
      continue;
    }
    await run('vtool', [
      '-set-build-version', 'macos', MIN_MACOS_VERSION, MACOS_SDK_VERSION,
      filePath, '-output', filePath
    ]);
  }

  // 改写 Mach-O 会让原有签名失效，这里重新做 ad-hoc 签名；
  // 若要发布签名版本，应在这一步之后改用 Developer ID 证书重签并公证。
  await run('codesign', ['--force', '--deep', '--sign', '-', APP_BUNDLE]);
}

async function main() {
  await run(process.execPath, [ELECTRON_BUILDER_CLI, '--mac', 'dir', '--publish', 'never']);
  await patchMacosSdk();
  await run(process.execPath, [
    ELECTRON_BUILDER_CLI,
    // macOS 的 --prepackaged 要给 .app 本身的路径；给父目录会被当成一个
    // 普通文件夹打包，dmg 里就会出现 WorkWeb.app/WorkWeb.app 的嵌套结构。
    '--prepackaged', APP_BUNDLE,
    '--mac', 'dmg',
    '--publish', 'never'
  ]);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

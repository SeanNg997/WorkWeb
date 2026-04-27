const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, 'win-unpacked');
const EXE_PATH = path.join(UNPACKED_DIR, 'WorkWeb.exe');
const ICON_SOURCE = path.join(ROOT_DIR, 'image', 'icon.ico');
const NODE_COMMAND = process.execPath;
const ELECTRON_BUILDER_CLI = path.join(ROOT_DIR, 'node_modules', 'electron-builder', 'cli.js');
const RCEDIT_EXE = path.join(ROOT_DIR, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      shell: false
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 失败，退出码 ${code}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      shell: false
    });
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      errorOutput += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(errorOutput.trim() || `${command} ${args.join(' ')} 失败，退出码 ${code}`));
    });
  });
}

async function toWindowsPath(filePath) {
  if (process.platform === 'win32') return filePath;
  return runCapture('wslpath', ['-w', filePath]);
}

async function patchWindowsExecutable() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const exePath = await toWindowsPath(EXE_PATH);
  const iconPath = await toWindowsPath(ICON_SOURCE);

  await run(RCEDIT_EXE, [
    exePath,
    '--set-icon', iconPath,
    '--set-file-version', pkg.version,
    '--set-product-version', pkg.version,
    '--set-version-string', 'CompanyName', pkg.author || 'WorkWeb',
    '--set-version-string', 'FileDescription', pkg.description || 'WorkWeb',
    '--set-version-string', 'InternalName', 'WorkWeb',
    '--set-version-string', 'OriginalFilename', 'WorkWeb.exe',
    '--set-version-string', 'ProductName', 'WorkWeb'
  ]);
}

async function main() {
  await run(NODE_COMMAND, [ELECTRON_BUILDER_CLI, '--win', 'dir']);

  if (!fs.existsSync(EXE_PATH)) {
    throw new Error(`未找到打包后的程序：${EXE_PATH}`);
  }

  await patchWindowsExecutable();
  await run(NODE_COMMAND, [ELECTRON_BUILDER_CLI, '--prepackaged', UNPACKED_DIR, '--win', 'nsis']);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

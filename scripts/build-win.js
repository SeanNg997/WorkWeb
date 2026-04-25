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

async function patchWindowsExecutable() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const { rcedit } = await import('rcedit');

  try {
    await rcedit(EXE_PATH, {
      icon: ICON_SOURCE,
      'file-version': pkg.version,
      'product-version': pkg.version,
      'version-string': {
        CompanyName: pkg.author || 'WorkWeb',
        FileDescription: pkg.description || 'WorkWeb',
        InternalName: 'WorkWeb',
        OriginalFilename: 'WorkWeb.exe',
        ProductName: 'WorkWeb'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`跳过 exe 资源修正：${message}`);
  }
}

async function main() {
  await run(NODE_COMMAND, [ELECTRON_BUILDER_CLI, '--win', 'dir']);

  if (!fs.existsSync(EXE_PATH)) {
    throw new Error(`未找到打包后的程序：${EXE_PATH}`);
  }

  await patchWindowsExecutable();
  await run(NODE_COMMAND, [ELECTRON_BUILDER_CLI, '--prepackaged', UNPACKED_DIR, '--win', 'nsis', 'portable']);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

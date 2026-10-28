import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Package an existing prebuilt image for offline Linux installation.

Usage:
  node scripts/package-offline.mjs
  node scripts/package-offline.mjs --platform linux/arm64
  node scripts/package-offline.mjs --image-dir artifacts --output-dir artifacts

Options:
  --platform    linux/amd64 (default) or linux/arm64.
  --image-dir   Existing image archive directory. Default: artifacts.
  --output-dir  Offline package output directory. Default: artifacts.
  --help        Show help without Docker, tar or image archives.

Paths are relative to the project root unless absolute. The application version
is read from package.json. Docker is never invoked. Input checksums are required;
existing output files are never replaced. Only explicitly listed files are
packaged, never .env, databases, encryption keys or runtime volumes.
`;

function parse(args) {
  const options = { platform: 'linux/amd64', imageDir: 'artifacts', outputDir: 'artifacts' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return null;
    const key = { '--platform': 'platform', '--image-dir': 'imageDir', '--output-dir': 'outputDir' }[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--') || /[\r\n\0]/.test(value)) {
      throw new Error(`Missing or invalid value for ${argument}`);
    }
    options[key] = value;
  }
  if (!['linux/amd64', 'linux/arm64'].includes(options.platform)) {
    throw new Error('Platform must be linux/amd64 or linux/arm64.');
  }
  return options;
}

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular file: ${filename}`);
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertAbsent(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${filename}`);
}

async function compress(temporary, bundle, filenames, archive) {
  const implementation = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (implementation.error) throw implementation.error;
  let args;
  if (/\bbsdtar\b/.test(implementation.stdout)) {
    // An mtree input gives Windows bsdtar explicit POSIX modes instead of 777/666.
    const entries = [`#mtree`, `./${bundle} type=dir mode=0700 uid=0 gid=0 time=0`];
    for (const filename of filenames) {
      const { size } = await lstat(path.join(temporary, bundle, filename));
      entries.push(`./${bundle}/${filename} type=file mode=0600 uid=0 gid=0 time=0 size=${size} contents=${bundle}/${filename}`);
    }
    const manifest = path.join(temporary, 'archive.mtree');
    await writeFile(manifest, `${entries.join('\n')}\n`);
    args = ['--format=ustar', '-cf', '-', '-C', temporary, `@${manifest}`];
  } else if (/GNU tar/.test(implementation.stdout)) {
    args = ['--format=ustar', '--mode=u=rwX,go=', '--owner=0', '--group=0', '--mtime=@0',
      '--sort=name', '-cf', '-', '-C', temporary, bundle];
  } else {
    throw new Error('Packaging requires GNU tar or bsdtar.');
  }
  const tar = spawn('tar', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let diagnostics = '';
  tar.stderr.setEncoding('utf8');
  tar.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-8192); });
  const exited = new Promise((resolve, reject) => {
    tar.once('error', reject);
    tar.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${diagnostics.trim()}`));
    });
  });
  const streamed = pipeline(tar.stdout, createGzip(), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  try {
    await Promise.all([exited, streamed]);
  } catch (error) {
    tar.kill();
    await Promise.allSettled([exited, streamed]);
    throw error;
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options) {
    process.stdout.write(help);
    return;
  }
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) {
    throw new Error('package.json version must be a valid Docker tag.');
  }
  const imageDirectory = path.resolve(root, options.imageDir);
  const outputDirectory = path.resolve(root, options.outputDir);
  const imageName = `dingshi-tanhuo-${version}-${options.platform.replace('/', '-')}.tar.gz`;
  const bundleName = `dingshi-tanhuo-${version}-${options.platform.replace('/', '-')}-offline`;
  const image = path.join(imageDirectory, imageName);
  const checksum = `${image}.sha256`;
  const archiveName = `${bundleName}.tar.gz`;
  const archive = path.join(outputDirectory, archiveName);
  const archiveChecksum = `${archive}.sha256`;
  await assertAbsent(archive);
  await assertAbsent(archiveChecksum);
  await regularFile(image);
  await regularFile(checksum);
  const expected = /^([a-fA-F0-9]{64}) {2}([A-Za-z0-9._-]+)\r?\n?$/.exec(await readFile(checksum, 'utf8'));
  if (!expected || expected[2] !== imageName) throw new Error('Invalid image checksum file.');
  if (await sha256(image) !== expected[1].toLowerCase()) throw new Error('Image SHA256 verification failed.');
  const installer = await readFile(path.join(root, 'scripts/install.sh'), 'utf8');
  if (!installer.includes(`version=${version} `) || !installer.includes('--offline-dir')) {
    throw new Error('Installer does not support this offline package version.');
  }

  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(outputDirectory, '.tanhuo-offline-'));
  let archiveCreated = false;
  let checksumCreated = false;
  let complete = false;
  try {
    const stage = path.join(temporary, bundleName);
    await mkdir(stage, { mode: 0o700 });
    const payload = [
      ['scripts/install.sh', 'install.sh'],
      ['scripts/offline/install-offline.sh', 'install-offline.sh'],
      ['compose.yaml', 'compose.yaml'],
      ['.env.example', 'env.example'],
    ];
    for (const [source, destination] of payload) {
      await regularFile(path.join(root, source));
      await copyFile(path.join(root, source), path.join(stage, destination));
    }
    const documentationPath = path.join(root, 'scripts/offline/README-OFFLINE.md');
    await regularFile(documentationPath);
    const documentation = await readFile(documentationPath, 'utf8');
    await writeFile(path.join(stage, 'README-OFFLINE.md'), documentation.replaceAll('{{BUNDLE_NAME}}', bundleName));
    await copyFile(image, path.join(stage, imageName));
    await writeFile(path.join(stage, `${imageName}.sha256`), `${expected[1].toLowerCase()}  ${imageName}\n`);
    const filenames = [...payload.map(([, destination]) => destination), 'README-OFFLINE.md', imageName, `${imageName}.sha256`].sort();
    const hashes = await Promise.all(filenames.map(async (filename) => `${await sha256(path.join(stage, filename))}  ${filename}\n`));
    await writeFile(path.join(stage, 'SHA256SUMS'), hashes.join(''));

    const compressed = path.join(temporary, archiveName);
    await compress(temporary, bundleName, [...filenames, 'SHA256SUMS'].sort(), compressed);
    await copyFile(compressed, archive, constants.COPYFILE_EXCL);
    archiveCreated = true;
    const hash = await sha256(archive);
    await writeFile(archiveChecksum, `${hash}  ${archiveName}\n`, { flag: 'wx', mode: 0o600 });
    checksumCreated = true;
    complete = true;
    process.stdout.write(`Archive: ${archive}\nChecksum: ${archiveChecksum}\nSHA256: ${hash}\n`);
  } finally {
    if (!complete && archiveCreated) await rm(archive, { force: true });
    if (!complete && checksumCreated) await rm(archiveChecksum, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});

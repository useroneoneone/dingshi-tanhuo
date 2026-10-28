import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const imageName = `dingshi-tanhuo-${version}-linux-amd64.tar.gz`;
const bundleName = `dingshi-tanhuo-${version}-linux-amd64-offline`;
const digest = (content) => createHash('sha256').update(content).digest('hex');
const run = (args) => spawnSync(process.execPath, ['scripts/package-offline.mjs', ...args], {
  cwd: root, encoding: 'utf8', timeout: 30000,
});

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tanhuo-package-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  mkdirSync(input);
  const content = gzipSync(Buffer.from('synthetic image archive used only by packaging tests'));
  writeFileSync(path.join(input, imageName), content);
  writeFileSync(path.join(input, `${imageName}.sha256`), `${digest(content)}  ${imageName}\n`);
  return { directory, input, output, args: ['--image-dir', input, '--output-dir', output] };
}

test('offline packager help and invalid options do not need Docker or image archives', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Docker is never invoked/);
  const invalid = run(['--platform', 'linux/mips64']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Platform must be/);
  assert.notEqual(run(['--output-dir']).status, 0);
  assert.notEqual(run(['--unexpected']).status, 0);
});

test('offline packager rejects corrupt image archives and checksum filename mismatches', (t) => {
  const files = fixture(t);
  writeFileSync(path.join(files.input, imageName), 'corrupt archive');
  const corrupt = run(files.args);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /Image SHA256 verification failed/);
  writeFileSync(path.join(files.input, `${imageName}.sha256`), `${'0'.repeat(64)}  other-image.tar.gz\n`);
  const wrongName = run(files.args);
  assert.notEqual(wrongName.status, 0);
  assert.match(wrongName.stderr, /Invalid image checksum file/);
});

test('offline package includes only approved deployment files with a complete checksum manifest', (t) => {
  const files = fixture(t);
  const packed = run(files.args);
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const archiveName = `${bundleName}.tar.gz`;
  const archive = path.join(files.output, archiveName);
  const hash = digest(readFileSync(archive));
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${hash}  ${archiveName}\n`);
  const listing = spawnSync('tar', ['-tzvf', archive], { encoding: 'utf8', timeout: 15000 });
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout.trimEnd().split('\n');
  assert.equal(entries.length, 9);
  for (const entry of entries) {
    assert.match(entry, /^(?:drwx------|-rw[x-]------)\s/, 'Archive permissions must not grant group/other access.');
  }
  const extracted = path.join(files.directory, 'extracted');
  mkdirSync(extracted);
  const result = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(extracted, bundleName);
  const expected = ['README-OFFLINE.md', 'SHA256SUMS', 'compose.yaml', 'env.example', 'install-offline.sh',
    'install.sh', imageName, `${imageName}.sha256`].sort();
  assert.deepEqual(readdirSync(bundle).sort(), expected);
  const manifest = readFileSync(path.join(bundle, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
  assert.equal(manifest.length, expected.length - 1);
  for (const entry of manifest) {
    const [checksum, filename] = entry.split('  ');
    assert.ok(expected.includes(filename));
    assert.equal(digest(readFileSync(path.join(bundle, filename))), checksum);
  }
  assert.match(readFileSync(path.join(bundle, 'env.example'), 'utf8'), /^ADMIN_PASSWORD=$/m);
  const wrapper = readFileSync(path.join(bundle, 'install-offline.sh'), 'utf8');
  assert.match(wrapper, /"\$@" --offline-dir "\$bundle"/);
  const documentation = readFileSync(path.join(bundle, 'README-OFFLINE.md'), 'utf8');
  assert.ok(documentation.includes(bundleName));
  assert.doesNotMatch(documentation, /\{\{BUNDLE_NAME\}\}/);
  assert.match(documentation, /NOT included/);
});

test('offline packager never overwrites an existing archive or checksum', (t) => {
  const files = fixture(t);
  mkdirSync(files.output);
  const checksum = path.join(files.output, `${bundleName}.tar.gz.sha256`);
  writeFileSync(checksum, 'keep this existing file');
  const checksumConflict = run(files.args);
  assert.notEqual(checksumConflict.status, 0);
  assert.match(checksumConflict.stderr, /Output already exists/);
  assert.equal(readFileSync(checksum, 'utf8'), 'keep this existing file');
  rmSync(checksum);
  const archive = path.join(files.output, `${bundleName}.tar.gz`);
  writeFileSync(archive, 'keep this existing archive');
  const archiveConflict = run(files.args);
  assert.notEqual(archiveConflict.status, 0);
  assert.match(archiveConflict.stderr, /Output already exists/);
  assert.equal(readFileSync(archive, 'utf8'), 'keep this existing archive');
});

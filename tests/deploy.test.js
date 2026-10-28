import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('cloud compose runs prebuilt images without a build section and preserves persistent volume identity', () => {
  const compose = read('compose.yaml');
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.match(compose, /image: "\$\{TANHUO_IMAGE:-dingshi-tanhuo:local\}"/);
  assert.match(compose, /tanhuo-data:\/app\/data/);
  assert.match(compose, /^  tanhuo:/m);
  assert.match(compose, /^\s+tanhuo-data:$/m);
  assert.match(compose, /HOST_BIND:-127\.0\.0\.1/);
  const build = read('compose.build.yaml');
  assert.match(build, /^\s+build:/m);
  assert.match(build, /NODE_IMAGE/);
});

test('Docker build context excludes deploy artifacts, backups and runtime secrets', () => {
  const rules = new Set(read('.dockerignore').split(/\r?\n/));
  for (const pattern of ['artifacts', 'backups', '.env', 'data', '*.tar.gz', '*.db', '*.db-*', 'master.key', '*.key']) {
    assert.ok(rules.has(pattern), `Missing Docker context exclusion: ${pattern}`);
  }
});

test('image exporters publish only by explicit opt-in and export images, not containers', () => {
  for (const name of ['scripts/build-image.ps1', 'scripts/build-image.sh']) {
    const text = read(name);
    assert.match(text, /linux\/amd64/);
    assert.match(text, /linux\/arm64/);
    assert.match(text, /--load/);
    assert.match(text, /sha256|SHA256/);
    assert.match(text, /image['", ]+save/);
    assert.doesNotMatch(text, /docker\s+(?:container\s+)?export\b/);
    assert.doesNotMatch(text, /docker\s+commit\b/);
  }
});

test('local exporter help and invalid versions finish without invoking Docker', () => {
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'bash';
  const prefix = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-image.ps1']
    : ['scripts/build-image.sh'];
  const help = spawnSync(command, [...prefix, windows ? '-Help' : '--help'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /No registry publication occurs/);
  const invalid = spawnSync(command, [...prefix, windows ? '-Version' : '--version', '../invalid'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /Version must be/);
});

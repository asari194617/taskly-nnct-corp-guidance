import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const validator = resolve('deploy/validate-image-archive.py');
const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const repository = 'ghcr.io/asari194617/taskly-nnct-corp-guidance';
const config = `${'c'.repeat(64)}.json`;
const layerDir = 'd'.repeat(64);
const layer = `${layerDir}/layer.tar`;

function fixture(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'nnct-image-archive-'));
  const files = join(root, 'files');
  mkdirSync(files);
  mkdirSync(join(files, layerDir));
  const manifest = [{ Config: config, RepoTags: [`${repository}:${sha}`], Layers: [layer] }];
  const imageConfig = { config: { Labels: { 'org.opencontainers.image.revision': sha } } };
  const repositories = { [repository]: { [sha]: layerDir } };
  change({ root, files, manifest, imageConfig, repositories });
  writeFileSync(join(files, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(files, config), JSON.stringify(imageConfig));
  writeFileSync(join(files, 'repositories'), JSON.stringify(repositories));
  writeFileSync(join(files, layer), 'synthetic-layer');
  const input = join(root, 'input.tar.gz');
  const output = join(root, 'validated.tar');
  const archive = spawnSync('tar', ['-cf', join(root, 'input.tar'), '-C', files, ...readdirSync(files)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  writeFileSync(input, gzipSync(readFileSync(join(root, 'input.tar'))));
  return {
    root, input, output,
    validate: (requested = sha) => spawnSync('python3', [validator, input, output, requested], { encoding: 'utf8' }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('one image with the requested tag and revision is sanitized', () => {
  const f = fixture();
  try {
    const result = f.validate();
    assert.equal(result.status, 0, result.stderr);
    const names = spawnSync('tar', ['-tf', f.output], { encoding: 'utf8' });
    assert.equal(names.status, 0, names.stderr);
    assert.deepEqual(names.stdout.trim().split('\n').sort(), [config, layer, 'manifest.json'].sort());
  } finally { f.close(); }
});

for (const [name, change] of [
  ['another repository tag', ({ manifest }) => { manifest[0].RepoTags = ['synthetic-other-service:latest']; }],
  ['another revision tag', ({ manifest }) => { manifest[0].RepoTags = [`${repository}:${other}`]; }],
  ['an additional image', ({ manifest }) => { manifest.push({ ...manifest[0] }); }],
  ['a mismatched revision label', ({ imageConfig }) => { imageConfig.config.Labels['org.opencontainers.image.revision'] = other; }],
  ['a missing target image', ({ manifest }) => { manifest[0].RepoTags = []; }],
  ['an additional legacy tag', ({ repositories }) => { repositories[repository].latest = layerDir; }],
  ['an unlisted file', ({ files }) => { writeFileSync(join(files, 'extra.json'), '{}'); }],
]) {
  test(`rejects ${name} without emitting a loadable archive`, () => {
    const f = fixture(change);
    try {
      const result = f.validate();
      assert.equal(result.status, 2, result.stderr);
      assert.equal(existsSync(f.output), false);
    } finally { f.close(); }
  });
}

for (const duplicate of ['manifest.json', config]) {
  test(`rejects a second ${duplicate} archive entry`, () => {
    const f = fixture();
    try {
      const append = spawnSync('tar', ['-rf', join(f.root, 'input.tar'), '-C', join(f.root, 'files'), duplicate], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      assert.equal(append.status, 0, append.stderr?.toString());
      writeFileSync(f.input, gzipSync(readFileSync(join(f.root, 'input.tar'))));
      const result = f.validate();
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /duplicate archive path/);
      assert.equal(existsSync(f.output), false);
    } finally { f.close(); }
  });
}

test('isolated Docker daemon keeps a pre-existing unrelated tag unchanged on rejection', { skip: !dockerAvailable() && !process.env.CI }, () => {
  const root = mkdtempSync(join(tmpdir(), 'nnct-docker-archive-'));
  const sentinel = `nnct-archive-test-sentinel:${process.pid}`;
  const target = `${repository}:${sha}`;
  try {
    const context = join(root, 'context');
    mkdirSync(context);
    writeFileSync(join(context, 'marker'), 'target');
    writeFileSync(join(context, 'Dockerfile'), `FROM scratch\nLABEL org.opencontainers.image.revision=${sha}\nCOPY marker /marker\n`);
    const build = spawnSync('docker', ['build', '-q', '-t', target, context], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    writeFileSync(join(context, 'marker'), 'attacker');
    const attacker = spawnSync('docker', ['build', '-q', '-t', sentinel, context], { encoding: 'utf8' });
    assert.equal(attacker.status, 0, attacker.stderr);
    const extra = join(root, 'extra.tar.gz');
    const extraSave = spawnSync('docker', ['save', '-o', join(root, 'extra.tar'), target, sentinel], { encoding: 'utf8' });
    assert.equal(extraSave.status, 0, extraSave.stderr);
    writeFileSync(extra, gzipSync(readFileSync(join(root, 'extra.tar'))));
    const unrelated = join(root, 'unrelated.tar.gz');
    const unrelatedSave = spawnSync('docker', ['save', '-o', join(root, 'unrelated.tar'), sentinel], { encoding: 'utf8' });
    assert.equal(unrelatedSave.status, 0, unrelatedSave.stderr);
    writeFileSync(unrelated, gzipSync(readFileSync(join(root, 'unrelated.tar'))));
    writeFileSync(join(context, 'marker'), 'victim');
    const victim = spawnSync('docker', ['build', '-q', '-t', sentinel, context], { encoding: 'utf8' });
    assert.equal(victim.status, 0, victim.stderr);
    const original = dockerId(sentinel);
    const valid = join(root, 'valid.tar');
    const save = spawnSync('docker', ['save', '-o', valid, target], { encoding: 'utf8' });
    assert.equal(save.status, 0, save.stderr);
    writeFileSync(join(context, 'Dockerfile'), `FROM scratch\nLABEL org.opencontainers.image.revision=${other}\nCOPY marker /marker\n`);
    const wrongBuild = spawnSync('docker', ['build', '-q', '-t', target, context], { encoding: 'utf8' });
    assert.equal(wrongBuild.status, 0, wrongBuild.stderr);
    const wrongRevision = join(root, 'wrong-revision.tar.gz');
    const wrongSave = spawnSync('docker', ['save', '-o', join(root, 'wrong-revision.tar'), target], { encoding: 'utf8' });
    assert.equal(wrongSave.status, 0, wrongSave.stderr);
    writeFileSync(wrongRevision, gzipSync(readFileSync(join(root, 'wrong-revision.tar'))));
    const invalid = join(root, 'invalid.tar.gz');
    const output = join(root, 'validated.tar');
    writeFileSync(invalid, gzipSync(readFileSync(valid)));
    const useEntrypoint = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
    if (useEntrypoint) {
      const entrypoint = readFileSync(resolve('deploy/deploy-entrypoint.sh'), 'utf8')
        .replace('/home/ubuntu/taskly-nnct-corp-guidance', root);
      writeFileSync(join(root, 'deploy-entrypoint.sh'), entrypoint, { mode: 0o700 });
      writeFileSync(join(root, 'validate-image-archive.py'), readFileSync(validator));
      writeFileSync(join(root, 'remote-deploy.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    const attempt = (archive, requested) => useEntrypoint
      ? spawnSync('bash', [join(root, 'deploy-entrypoint.sh')], {
          cwd: root, input: readFileSync(archive), encoding: 'utf8',
          env: { ...process.env, SSH_ORIGINAL_COMMAND: `deploy ${requested}` },
        })
      : spawnSync('python3', [validator, archive, output, requested], { encoding: 'utf8' });
    for (const [name, archive, requested] of [
      ['unrelated repository', unrelated, sha],
      ['additional image', extra, sha],
      ['different requested SHA', invalid, other],
      ['revision mismatch', wrongRevision, sha],
    ]) {
      const rejected = attempt(archive, requested);
      assert.equal(rejected.status, 2, `${name}: ${rejected.stderr}`);
      assert.equal(existsSync(output), false, name);
      assert.equal(dockerId(sentinel), original, name);
    }
    const accepted = attempt(invalid, sha);
    assert.equal(accepted.status, 0, accepted.stderr);
    if (!useEntrypoint) {
      const load = spawnSync('docker', ['load', '-i', output], { encoding: 'utf8' });
      assert.equal(load.status, 0, load.stderr);
    }
    assert.equal(dockerId(sentinel), original);
  } finally {
    spawnSync('docker', ['image', 'rm', '-f', sentinel, target]);
    rmSync(root, { recursive: true, force: true });
  }
});

function dockerAvailable() {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' }).status === 0;
}

function dockerId(tag) {
  const result = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

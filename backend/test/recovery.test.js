const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.join(__dirname, '..', 'scripts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triplee-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\nset -eu\n' + body, { mode: 0o700 });
  stub('pg_dump', 'while [ "$1" != "--file" ]; do shift; done\nshift\nprintf fixture > "$1"\nexit "${DUMP_EXIT:-0}"\n');
  stub('pg_restore', 'touch "$RESTORE_MARKER"\nexit "${RESTORE_EXIT:-0}"\n');
  stub('psql', 'printf "%s\\n" "${COUNT_RESULT:-0}"\nexit "${COUNT_EXIT:-0}"\n');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
    DATABASE_URL: 'postgresql://synthetic.invalid/source', TARGET_URL: 'postgresql://synthetic.invalid/scratch',
    RESTORE_MARKER: path.join(root, 'restore-started') };
  const run = (script, args = [], extra = {}) => spawnSync('bash', [path.join(scripts, script), ...args], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const out = path.join(root, 'backups');
  const backup = () => {
    const result = run('backup.sh', [out]); assert.equal(result.status, 0, result.stderr);
    return path.join(out, fs.readdirSync(out).find((p) => p.endsWith('.dump')));
  };
  return { root, out, run, backup, env };
}

test('backups are private, checksummed, and unique even in the same second', (t) => {
  const f = fixture(t), file = f.backup();
  assert.equal(fs.statSync(f.out).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file + '.sha256').mode & 0o777, 0o600);
  assert.equal(f.run('backup.sh', [f.out]).status, 0);
  assert.equal(fs.readdirSync(f.out).filter((p) => p.endsWith('.dump')).length, 2);
  assert.equal(f.run('restore-test.sh', [file]).status, 0);
});

test('unsafe backup destinations, invalid retention, and failed dumps cannot publish a backup', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.out, { mode: 0o755 }); fs.chmodSync(f.out, 0o755);
  assert.notEqual(f.run('backup.sh', [f.out]).status, 0);
  assert.deepEqual(fs.readdirSync(f.out), []);
  fs.chmodSync(f.out, 0o700);
  assert.notEqual(f.run('backup.sh', [f.out, '-1']).status, 0);
  assert.notEqual(f.run('backup.sh', [f.out], { DUMP_EXIT: '1' }).status, 0);
  assert.deepEqual(fs.readdirSync(f.out), []);
  const link = path.join(f.root, 'link'); fs.symlinkSync(f.out, link);
  assert.notEqual(f.run('backup.sh', [link]).status, 0);
});

test('missing or mismatched checksums fail before restore starts', (t) => {
  const f = fixture(t), file = f.backup();
  const checksum = fs.readFileSync(file + '.sha256');
  fs.unlinkSync(file + '.sha256');
  assert.notEqual(f.run('restore-test.sh', [file]).status, 0);
  assert.ok(!fs.existsSync(f.env.RESTORE_MARKER));
  fs.writeFileSync(file + '.sha256', checksum);
  fs.appendFileSync(file, 'corrupted');
  assert.notEqual(f.run('restore-test.sh', [file]).status, 0);
  assert.ok(!fs.existsSync(f.env.RESTORE_MARKER));
});

test('restore errors, failed verification, invalid counts, and a source URL as target fail the drill', (t) => {
  const f = fixture(t), file = f.backup();
  for (const extra of [{ RESTORE_EXIT: '1' }, { COUNT_EXIT: '1' }, { COUNT_RESULT: '(missing)' },
    { TARGET_URL: f.env.DATABASE_URL }]) {
    const result = f.run('restore-test.sh', [file], extra);
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('That record is your evidence'));
  }
});

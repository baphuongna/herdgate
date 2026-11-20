import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const skill = join(import.meta.dirname, '..', '.agents', 'skills', 'herdr');
const helper = join(skill, 'herdr_pi.py');
const probeArgs = ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))'];
const python = (process.env.TEST_PYTHON_BIN ? [process.env.TEST_PYTHON_BIN] : [process.platform === 'win32' ? 'python' : 'python3'])
  .find(binary => spawnSync(binary, probeArgs, { timeout: 3000, windowsHide: true }).status === 0);
const skip = !python && 'Python 3.11+ is optional for the skill pack';
const run = (...args: string[]) => {
  const child = spawnSync(python!, [helper, ...args], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  assert.ifError(child.error);
  assert.ok(child.stdout, child.stderr);
  return { code: child.status, result: JSON.parse(child.stdout) };
};

const request = '00000000-0000-4000-8000-000000000001';
const user = { type: 'message', id: 'user', parentId: null,
  message: { role: 'user', content: `[herdr-request:${request}]\nfixture prompt` } };
const reply = { type: 'message', id: 'reply', parentId: user.id,
  message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'fixture reply' }] } };

function snapshot(dir: string, session: string, entries: object[]) {
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, [{ type: 'session', version: 3, id: session }, ...entries].map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('a reply copied into a different Pi session is not evidence for the expected session', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg pi observation '));
  try {
    const original = snapshot(dir, 'original', [user, reply]);
    const fork = snapshot(dir, 'fork', [user, reply]);
    const observe = (path: string, ...args: string[]) => run('observe', request, '--session-file', path, ...args);
    assert.equal(observe(fork).result.status, 'response_observed', 'an unpinned snapshot observes the copied reply');
    const pinned = observe(original, '--expect-session', 'original');
    assert.equal(pinned.code, 0);
    assert.equal(pinned.result.session_id, 'original');
    assert.equal(pinned.result.response_entry_id, 'reply');
    assert.equal(Object.hasOwn(pinned.result, 'answer'), false);
    const wrong = observe(fork, '--expect-session', 'original', '--include-answer');
    assert.deepEqual(wrong, { code: 2, result: { status: 'unverified', reason: 'unexpected_session_id', request_id: request } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pinned observation does not infer a reply from tool output or accept a fork inside the same session', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg pi branches '));
  try {
    const tool = { type: 'message', id: 'tool', parentId: user.id, message: { role: 'toolResult', content: 'not an answer' } };
    const observe = (entries: object[]) => run('observe', request, '--session-file', snapshot(dir, 'same', entries), '--expect-session', 'same');
    const pending = observe([user, tool]);
    assert.equal(pending.code, 1);
    assert.equal(pending.result.status, 'request_observed');
    const ambiguous = observe([user, tool, reply]);
    assert.equal(ambiguous.code, 2);
    assert.equal(ambiguous.result.reason, 'ambiguous_request_branch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the bundled Pi profile catalog exposes only model/thinking arguments', { skip }, () => {
  const { code, result } = run('profile', 'show', 'advisor', '--file', join(skill, 'profiles.example.toml'));
  assert.equal(code, 0);
  assert.equal(result.profile.kind, 'pi');
  assert.deepEqual(result.profile.pi_args, ['--thinking', 'high']);
});

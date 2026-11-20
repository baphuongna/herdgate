// Offline research probe for Pi (verified against 1.5.2; requires at least the
// MIN_PI_VERSION floor from plugin/server/pi-worker.mjs). Not a shipped Herdgate extension.
// Usage: node pi-settlement.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionAtLeast, MIN_PI_VERSION } from '../../../plugin/server/pi-worker.mjs';

assert.ok(process.argv[2], 'pass the Pi coding-agent package directory');
const root = resolve(process.argv[2]);
globalThis.fetch = () => { throw new Error('network is not allowed in this probe'); };
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } =
  await import(join(root, 'dist/index.js'));
const { createAssistantMessageEventStream, InMemoryModelsStore } =
  await import(join(root, '../pi-ai/dist/index.js'));
assert.ok(versionAtLeast(VERSION, MIN_PI_VERSION),
  `Pi ${VERSION} is older than the verified minimum ${MIN_PI_VERSION}`);

const marker = '[herdr-request:00000000-0000-4000-8000-000000000001]';
const prompt = `${marker}\nSynthetic request`;
const provider = 'herdgate-research-fake';
const workspace = mkdtempSync(join(tmpdir(), 'herdgate-pi-probe-'));
process.env.HERDGATE_PI_RECEIPT_DIR = join(workspace, 'pi-receipts');
let cases = 0;
function message(model, { text = 'synthetic reply', stopReason = 'stop', errorMessage } = {}) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api,
    provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: zero }, stopReason, errorMessage, timestamp: Date.now(),
  };
}
function roleEntries(manager, role) {
  return manager.getBranch().filter(e => e.type === 'message' && e.message.role === role);
}
async function run(label, body, { responses = [{}], hooks = () => {}, retry = false, inMemory = false, observer = false } = {}) {
  const cwd = join(workspace, String(++cases));
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
  }, { projectTrusted: false });
  settingsManager.setEnableInstallTelemetry(false);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null, modelsStore: new InMemoryModelsStore(), authPath: join(agentDir, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  let calls = 0;
  modelRuntime.registerProvider(provider, {
    baseUrl: 'https://no-network.invalid', apiKey: 'fake', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const response = responses[calls++];
      assert.ok(response, 'unexpected fake provider call');
      const output = message(model, response);
      if (output.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: output });
      else stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end(output);
      return stream;
    },
  });
  const sessionManager = inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(cwd, 'sessions'));
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true,
    noThemes: true, noPromptTemplates: true, noExtensions: true, extensionFactories: [hooks],
    additionalExtensionPaths: observer ? [fileURLToPath(new URL('../../../experiments/pi-receipt/observer.js', import.meta.url))] : [],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, modelRuntime, model: modelRuntime.getModel(provider, 'fixture'),
    sessionManager, resourceLoader, noTools: 'all',
  });
  const extensionErrors = [];
  try {
    let notification;
    await session.bindExtensions({
      mode: 'tui', uiContext: { notify: text => { notification = JSON.parse(text); } },
      onError: error => extensionErrors.push(error),
    });
    const command = async (name, args = '') => {
      notification = undefined;
      await session.prompt(`/herdgate-${name}${args ? ` ${args}` : ''}`);
      assert.ok(notification, 'slash command must reply locally');
      return notification;
    };
    await body(session, sessionManager, command);
    assert.deepEqual(extensionErrors, []);
    assert.equal(calls, responses.length);
    console.log(`ok - ${label}`);
  } finally {
    session.dispose();
  }
}

try {
  const phases = [];
  await run('message_end precedes append; turn_end sees written entry; settle follows', async (session, manager) => {
    assert.ok(manager.getSessionFile(), 'a path can be assigned before the file exists');
    assert.equal(existsSync(manager.getSessionFile()), false);
    await session.prompt(prompt);
    assert.deepEqual(phases, [['input', 0], ['message_end', 0], ['turn_end', 1, 1, true], ['settled', false, 1]]);
  }, { hooks(pi) {
    pi.on('input', (_e, ctx) => { phases.push(['input', roleEntries(ctx.sessionManager, 'user').length]); });
    pi.on('message_end', (e, ctx) => {
      if (e.message.role === 'user') phases.push(['message_end', roleEntries(ctx.sessionManager, 'user').length]);
    });
    pi.on('turn_end', (e, ctx) => {
      const written = readFileSync(ctx.sessionManager.getSessionFile(), 'utf8').trimEnd().split('\n').map(JSON.parse);
      phases.push(['turn_end', roleEntries(ctx.sessionManager, 'user').length,
        roleEntries(ctx.sessionManager, 'assistant').length, written.some(entry => entry.id === e.messageEntryId)]);
    });
    pi.on('agent_settled', (e, ctx) => { phases.push(['settled', e.aborted, roleEntries(ctx.sessionManager, 'user').length]); });
  } });

  await run('handled input does not append a user entry or emit settle', async (session, manager) => {
    await session.prompt(prompt);
    assert.equal(roleEntries(manager, 'user').length, 0);
  }, { responses: [], hooks(pi) {
    pi.on('input', () => ({ action: 'handled' }));
    pi.on('agent_settled', () => { assert.fail('unexpected settle'); });
  } });

  await run('message_end observers can see a marker that a later handler removes', async (session, manager) => {
    await session.prompt(prompt);
    const [user] = roleEntries(manager, 'user');
    assert.equal(user.message.content[0].text, 'Rewritten synthetic input');
  }, { hooks(pi) {
    pi.on('message_end', e => {
      if (e.message.role === 'user') assert.equal(e.message.content[0].text, prompt);
    });
    pi.on('message_end', e => {
      if (e.message.role === 'user') {
        return { message: { ...e.message, content: [{ type: 'text', text: 'Rewritten synthetic input' }] } };
      }
    });
  } });

  const runs = [];
  await run('a retry has two agent_end events but only one settle', async session => {
    await session.prompt(prompt);
    assert.deepEqual(runs, ['end', 'end', 'settled:false:stop']);
  }, { retry: true, responses: [{ stopReason: 'error', errorMessage: 'overloaded_error' }, {}], hooks(pi) {
    pi.on('agent_end', () => { runs.push('end'); });
    pi.on('agent_settled', (e, ctx) => {
      runs.push(`settled:${e.aborted}:${roleEntries(ctx.sessionManager, 'assistant').at(-1).message.stopReason}`);
    });
  } });

  let failed;
  await run('non-aborted settle can carry a final provider error', async session => {
    await session.prompt(prompt);
    assert.deepEqual(failed, [false, 'error']);
  }, { responses: [{ stopReason: 'error', errorMessage: 'Synthetic provider failure' }], hooks(pi) {
    pi.on('agent_settled', (e, ctx) => {
      failed = [e.aborted, roleEntries(ctx.sessionManager, 'assistant').at(-1).message.stopReason];
    });
  } });

  const usersAtSettle = [];
  await run('a follow-up adds another user message before the same settle', async session => {
    await session.prompt(prompt);
    assert.deepEqual(usersAtSettle, [2]);
  }, { responses: [{}, {}], hooks(pi) {
    let queued = false;
    pi.on('agent_end', () => {
      if (queued) return;
      queued = true;
      pi.sendUserMessage('Unmarked follow-up', { deliverAs: 'followUp' });
    });
    pi.on('agent_settled', (_e, ctx) => { usersAtSettle.push(roleEntries(ctx.sessionManager, 'user').length); });
  } });

  const boundaryRuns = [];
  await run('agent_before_settle can turn a normal reply into an intermediate reply', async session => {
    await session.prompt(prompt);
    assert.deepEqual(boundaryRuns, ['end', 'end', 'settled:1:2']);
  }, { responses: [{}, {}], hooks(pi) {
    let continued = false;
    pi.on('agent_end', () => { boundaryRuns.push('end'); });
    pi.on('agent_before_settle', e => {
      if (continued) return;
      continued = true;
      return { entries: [...e.entries, { type: 'custom_message', customType: 'fixture',
        content: 'Synthetic continuation', display: false }], continue: true };
    });
    pi.on('agent_settled', (_e, ctx) => { boundaryRuns.push(`settled:${roleEntries(ctx.sessionManager, 'user').length}:${roleEntries(ctx.sessionManager, 'assistant').length}`); });
  } });

  const afterSettle = [];
  await run('work requested during settle starts only after the current notification', async session => {
    await session.prompt(prompt);
    assert.deepEqual(afterSettle, ['start', 'settled:1', 'start', 'settled:2']);
  }, { responses: [{}, {}], hooks(pi) {
    let requested = false;
    pi.on('agent_start', () => { afterSettle.push('start'); });
    pi.on('agent_settled', () => {
      if (requested) return;
      requested = true;
      pi.sendUserMessage('Synthetic next run');
    });
    pi.on('agent_settled', (_e, ctx) => { afterSettle.push(`settled:${roleEntries(ctx.sessionManager, 'user').length}`); });
  } });

  let projection;
  await run('a context edit can omit the raw final reply without changing its stopReason', async session => {
    await session.prompt(prompt);
    assert.deepEqual(projection, { aborted: false, raw: 'stop', visible: false });
  }, { hooks(pi) {
    pi.on('turn_end', e => ({ entries: [...e.entries, { type: 'context_edit', targetId: e.messageEntryId, replacement: null }] }));
    pi.on('agent_settled', (e, ctx) => {
      const raw = roleEntries(ctx.sessionManager, 'assistant').at(-1);
      const visible = ctx.sessionManager.buildSessionProjection().entries.some(entry =>
        entry.sourceEntry.id === raw.id && entry.messages.some(msg => msg.role === 'assistant'));
      projection = { aborted: e.aborted, raw: raw.message.stopReason, visible };
    });
  } });

  const boundary = Promise.withResolvers();
  const release = Promise.withResolvers();
  let abortedWithReply;
  await run('abort can coexist with a normal reply already on the active branch', async session => {
    const running = session.prompt(prompt);
    await boundary.promise;
    const aborting = session.abort();
    release.resolve();
    await Promise.all([running, aborting]);
    assert.deepEqual(abortedWithReply, [true, 'stop']);
  }, { hooks(pi) {
    pi.on('agent_before_settle', async () => { boundary.resolve(); await release.promise; });
    pi.on('agent_settled', (e, ctx) => {
      abortedWithReply = [e.aborted, roleEntries(ctx.sessionManager, 'assistant').at(-1).message.stopReason];
    });
  } });

  const lifecycle = [];
  const tree = [];
  await run('tree round-trip restores the same leaf and reload preserves session ID', async (session, manager) => {
    await session.prompt(prompt);
    const leaf = manager.getLeafId();
    const ancestor = roleEntries(manager, 'user')[0].id;
    await session.navigateTree(ancestor, { summarize: false });
    assert.notEqual(manager.getLeafId(), leaf);
    await session.navigateTree(leaf, { summarize: false });
    assert.equal(manager.getLeafId(), leaf);
    assert.equal(tree.length, 2);
    const sessionId = manager.getSessionId();
    await session.reload();
    assert.deepEqual(lifecycle, ['startup', 'shutdown:reload', 'reload']);
    assert.equal(manager.getSessionId(), sessionId);
    assert.equal(manager.getLeafId(), leaf);
  }, { hooks(pi) {
    pi.on('session_start', e => { lifecycle.push(e.reason); });
    pi.on('session_shutdown', e => { lifecycle.push(`shutdown:${e.reason}`); });
    pi.on('session_tree', e => { tree.push([e.oldLeafId, e.newLeafId]); });
  } });

  let memory;
  await run('in-memory sessions settle with branch entries but no JSONL', async session => {
    await session.prompt(prompt);
    assert.deepEqual(memory, [1, undefined]);
  }, { inMemory: true, hooks(pi) {
    pi.on('agent_settled', (_e, ctx) => {
      memory = [roleEntries(ctx.sessionManager, 'assistant').length, ctx.sessionManager.getSessionFile()];
    });
  } });
  console.log(`${cases} offline lifecycle scenarios, Pi ${VERSION}`);

  await run('observer loads explicitly; arm and receipt do not call the provider', async (session, manager, command) => {
    const armed = await command('arm');
    assert.equal(armed.status, 'armed');
    assert.equal(roleEntries(manager, 'user').length, 0);
    assert.equal((await command('receipt', armed.id)).status, 'armed');
    await session.prompt(`${armed.marker}\nSynthetic brief`);
    const request = roleEntries(manager, 'user')[0];
    const reply = roleEntries(manager, 'assistant')[0];
    assert.deepEqual(await command('receipt', armed.id), {
      id: armed.id, status: 'replied', requestEntryId: request.id, responseEntryId: reply.id,
    });
    const pending = await command('arm');
    await session.reload();
    assert.deepEqual(await command('receipt', pending.id), { id: pending.id, status: 'unknown', reason: 'runtime_changed' });
    assert.deepEqual(await command('receipt', armed.id), {
      id: armed.id, status: 'replied', requestEntryId: request.id, responseEntryId: reply.id,
    });
  }, { observer: true });

  const waiting = Promise.withResolvers();
  const resume = Promise.withResolvers();
  await run('observer reports received before settle and canceled after abort with a raw reply', async (session, manager, command) => {
    const armed = await command('arm');
    const pending = session.prompt(`${armed.marker}\nSynthetic abort`);
    await waiting.promise;
    const request = roleEntries(manager, 'user')[0];
    const received = await command('receipt', armed.id);
    const abort = session.abort();
    resume.resolve();
    await Promise.all([pending, abort]);
    assert.deepEqual(received, { id: armed.id, status: 'received', requestEntryId: request.id });
    assert.deepEqual(await command('receipt', armed.id), {
      id: armed.id, status: 'canceled', reason: 'pi_aborted', requestEntryId: request.id,
    });
  }, { observer: true, hooks(pi) {
    pi.on('agent_before_settle', async () => { waiting.resolve(); await resume.promise; });
  } });

  await run('observer distinguishes a settled provider error from a reply', async (session, manager, command) => {
    const armed = await command('arm');
    await session.prompt(`${armed.marker}\nSynthetic error`);
    assert.deepEqual(await command('receipt', armed.id), {
      id: armed.id, status: 'failed', reason: 'pi_error', requestEntryId: roleEntries(manager, 'user')[0].id,
    });
  }, { observer: true, responses: [{ stopReason: 'error', errorMessage: 'Synthetic failure' }] });

  await run('observer does not mistake a follow-up for the marked request reply', async (session, _manager, command) => {
    const armed = await command('arm');
    await session.prompt(`${armed.marker}\nSynthetic first request`);
    const receipt = await command('receipt', armed.id);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.reason, 'competing_input');
  }, { observer: true, responses: [{}, {}], hooks(pi) {
    let sent = false;
    pi.on('agent_end', () => {
      if (sent) return;
      sent = true;
      pi.sendUserMessage('Unmarked follow-up', { deliverAs: 'followUp' });
    });
  } });
  console.log('4 offline observer scenarios via actual SDK slash commands');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

#!/usr/bin/env node
// pi-durable evaluation probe for the Herdgate Pi worker (experiment, NOT shipped).
// Answers ONE question with runnable evidence: if a job process dies mid-model-turn,
// does reopening @earendil-works/pi-durable storage finish the interrupted submission
// (instead of the worker's fail-closed unknown/worker_restarted)?
//
//   PI_DURABLE_EVAL_DIR=<dir with node_modules> node durable-probe.mjs phase-a   # crash mid-stream
//   PI_DURABLE_EVAL_DIR=<...> node durable-probe.mjs phase-b                     # reopen, resume, settle
//
// phase-a submits input with requestId 'hg-eval-1' against a faux provider streaming
// at ~8 tokens/s, waits until the model is actually called, then SIGKILLs itself —
// the pi.user entry is committed, the assistant entry is not.
// phase-b reopens the same SQLite storage, resumes, re-submits the SAME requestId
// (must return the existing submission, not a second one) with an instant answer,
// and reports what settled. The faux provider is pi-ai's own test provider: no network.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const evalDir = process.env.PI_DURABLE_EVAL_DIR ?? '/tmp/hg-durable-eval';
const nm = name => pathToFileURL(join(evalDir, 'node_modules', '@earendil-works', name)).href;
const { BACKGROUND_CONTEXT } = await import(nm('chord/dist/context/index.js'));
const { createModels, fauxAssistantMessage, fauxProvider } = await import(nm('pi-ai/dist/index.js'));
const durable = await import(nm('pi-durable/dist/index.js'));
const { openNodeSqliteStorage } = await import(nm('pi-durable/dist/storage/sqlite/node.js'));
const { Harness, AssistantEntry, createRegistry } = durable;

const db = join(evalDir, 'durable-probe.sqlite');
const REQUEST_ID = 'hg-eval-1';
const phase = process.argv[2];
if (!['phase-a', 'phase-b'].includes(phase)) {
  console.error('usage: durable-probe.mjs phase-a|phase-b');
  process.exit(1);
}

async function openHarness(faux) {
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: faux.getModel().id } } });
  return { harness, root };
}

if (phase === 'phase-a') {
  rmSync(db, { force: true });
  // Slow stream: die in the middle of it, after the model was called once.
  const faux = fauxProvider({ tokensPerSecond: 8, tokenSize: { min: 24, max: 40 } });
  faux.setResponses([fauxAssistantMessage(`NEVER LANDS ${'x'.repeat(400)}`)]);
  const { harness, root } = await openHarness(faux);
  await root.submit({ type: 'input', content: 'Herdgate durable evaluation', requestId: REQUEST_ID }, BACKGROUND_CONTEXT);
  const deadline = Date.now() + 10_000;
  while (faux.state.callCount < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  if (faux.state.callCount < 1) { console.error('phase-a: model was never called'); process.exit(1); }
  writeFileSync(join(evalDir, 'phase-a.called'), `${Date.now()}\n`);
  console.log(JSON.stringify({ phase: 'a', modelCalls: faux.state.callCount, killing: 'SIGKILL mid-stream' }));
  process.kill(process.pid, 'SIGKILL'); // no finally, no close: a hard crash
}

// phase-b
mkdirSync(evalDir, { recursive: true });
if (!existsSync(join(evalDir, 'phase-a.called'))) {
  console.error('phase-b: run phase-a first (no crash marker)');
  process.exit(1);
}
const faux = fauxProvider(); // instant answers; its state counts only this process's calls
faux.setResponses([fauxAssistantMessage('DURABLE-RESUME-OK')]);
const { harness, root } = await openHarness(faux);
harness.resume(); // continue the run the crashed process left unfinished
const again = await root.submit({ type: 'input', content: 'Herdgate durable evaluation', requestId: REQUEST_ID }, BACKGROUND_CONTEXT);
const settled = await again.wait(BACKGROUND_CONTEXT);
const answer = settled.status === 'done'
  ? await root.commit(tx => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT)
  : null;
const message = answer?.model?.[0];
const text = Array.isArray(message?.content)
  ? message.content.filter(b => b.type === 'text').map(b => b.text).join('') : null;
console.log(JSON.stringify({
  phase: 'b',
  status: settled.status,           // done | unanswered
  reason: settled.reason ?? null,
  answerText: text,
  modelCallsThisProcess: faux.state.callCount, // 1 => the interrupted turn was retried, not lost
}));
await harness.close(BACKGROUND_CONTEXT);

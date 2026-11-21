// Scripted provider for the Herdgate pipeline E2E test (no network, no account).
// Mirrors pi-receipt-provider.mjs's stream shape, but answers from a script:
// the WORKER's first call ships buggy code (so the pipeline's retry loop has
// something real to do), every later call ships the fix; the REVIEWER (detected
// by its 'REVIEW:' instruction in the brief) returns a review whose final line
// is REVIEW: PASS. The provider is the fake agent's hands: side effects (the
// pipe-answer.mjs writes) happen in-process inside the spawned Pi.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const BUGGY = 'export default 1 + 1;\n'; // wrong: the task asks for 4
const FIXED = 'export default 2 + 2;\n'; // the retry feedback lands the fix

export default function fixture(pi) {
  const dir = process.env.HG_PIPE_FIXTURE_DIR;
  const worktree = process.env.HG_PIPE_WORKTREE || process.cwd();
  const log = (event, fields = {}) => {
    if (!dir) return;
    try { appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ event, ...fields }) + '\n'); } catch { /* best effort */ }
  };
  const cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };
  let count = 0;
  pi.registerProvider('hg-pipe-fixture', {
    api: 'openai-completions', apiKey: 'dummy', baseUrl: 'https://no-network.invalid',
    models: [{ id: 'test', name: 'test', input: ['text'], reasoning: true, cost, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const call = ++count;
      const content = context.messages.findLast(message => message.role === 'user')?.content;
      const text = typeof content === 'string' ? content
        : (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '');
      const reviewer = /REVIEW:\s*(PASS|FAIL)/.test(text ?? '');
      let reply;
      if (reviewer) {
        reply = 'Diff summary: pipe-answer.mjs — 1 file changed.\nThe change is minimal and matches the task.\nREVIEW: PASS';
      } else {
        const buggy = call === 1;
        writeFileSync(join(worktree, 'pipe-answer.mjs'), buggy ? BUGGY : FIXED);
        reply = buggy
          ? 'Created pipe-answer.mjs with my first attempt.'
          : 'Understood — fixed pipe-answer.mjs so the check passes.';
      }
      log('call', { call, reviewer, fixed: !reviewer && call > 1 });
      const stream = createAssistantMessageEventStream();
      const finish = aborted => {
        const message = {
          role: 'assistant', api: model.api, model: model.id, provider: model.provider,
          content: aborted ? [] : [{ type: 'text', text: reply }],
          stopReason: aborted ? 'aborted' : 'stop', timestamp: Date.now(),
          usage: { ...cost, totalTokens: 1234, cost },
        };
        stream.push(aborted ? { type: 'error', reason: 'aborted', error: message } : { type: 'done', reason: 'stop', message });
        stream.end(message);
      };
      stream.push({ type: 'start', partial: {
        role: 'assistant', api: model.api, model: model.id, provider: model.provider, content: [],
        stopReason: 'stop', timestamp: Date.now(), usage: { ...cost, totalTokens: 1234, cost },
      } });
      finish(Boolean(options?.signal?.aborted));
      return stream;
    },
  });
  pi.on('session_start', ({ reason }, ctx) => {
    log('session_start', { reason, model: ctx.model?.id, provider: ctx.model?.provider });
    ctx.ui.notify('HG_PIPE_FIXTURE_READY', 'info');
  });
}

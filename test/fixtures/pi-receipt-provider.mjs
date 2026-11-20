// Provider for the isolated Herdr/Pi E2E test. No HTTP calls or real credentials.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function fixture(pi) {
  const dir = process.env.HG_RECEIPT_FIXTURE_DIR;
  if (!dir) throw new Error('pi receipt fixture requires a temporary test directory');
  const log = (event, fields = {}) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ event, ...fields }) + '\n');
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let count = 0;
  let held = false;
  pi.registerProvider('hg-receipt-fixture', {
    api: 'openai-completions', apiKey: 'dummy', baseUrl: 'https://no-network.invalid',
    models: ['test', 'override'].map(id => ({ id, name: id, input: ['text'], reasoning: true, cost, contextWindow: 128000, maxTokens: 4096 })),
    streamSimple(model, context, options) {
      const call = ++count;
      const content = context.messages.findLast(message => message.role === 'user')?.content;
      const text = typeof content === 'string' ? content : content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
      log('call', { call, inputHash: createHash('sha256').update(text ?? '').digest('hex') });
      const stream = createAssistantMessageEventStream();
      const finish = aborted => {
        const message = {
          role: 'assistant', api: model.api, model: model.id, provider: model.provider,
          content: aborted ? [] : [{ type: 'text', text: `SYNTHETIC_REPLY_${call}` }],
          stopReason: aborted ? 'aborted' : 'stop', timestamp: Date.now(),
          usage: { ...cost, totalTokens: 0, cost },
        };
        stream.push(aborted ? { type: 'error', reason: 'aborted', error: message } : { type: 'done', reason: 'stop', message });
        stream.end(message);
      };
      stream.push({ type: 'start', partial: {
        role: 'assistant', api: model.api, model: model.id, provider: model.provider, content: [],
        stopReason: 'stop', timestamp: Date.now(), usage: { ...cost, totalTokens: 0, cost },
      } });
      if (call === 3) {
        // Hold the model stream open so Escape traverses the real TUI cancellation path.
        const signal = options?.signal;
        if (!signal) throw new Error('fake provider expected a Pi abort signal');
        log('waiting_for_escape');
        if (signal.aborted) finish(true);
        else signal.addEventListener('abort', () => finish(true), { once: true });
      } else finish(false);
      return stream;
    },
  });
  pi.on('session_start', ({ reason }, ctx) => {
    log('session_start', { reason, model: ctx.model?.id, provider: ctx.model?.provider,
      thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() });
    ctx.ui.notify('HG_RECEIPT_FIXTURE_READY', 'info');
  });
  pi.on('agent_before_settle', async () => {
    if (count !== 1 || held) return;
    held = true;
    log('holding_first_settle');
    const deadline = performance.now() + 25_000;
    while (!existsSync(join(dir, 'release'))) {
      if (performance.now() >= deadline) throw new Error('test did not release settlement');
      await sleep(20);
    }
  });
  pi.on('agent_settled', ({ aborted }) => { log('settled', { call: count, aborted }); });
}

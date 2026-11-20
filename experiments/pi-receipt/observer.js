// Experimental Pi extension (verified against Pi 1.5.2, minimum-supported release; newer
// Pi releases run it unchanged). Load explicitly with pi -e; no network I/O.
// Receipts live in a bounded per-workspace JSONL journal so they survive reload/restart.
// Journal format/readers are shared with the publisher (plugin/server/pi-receipts.mjs);
// the journal writer is shared with the worker experiment (experiments/pi-receipt/journal.mjs).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { journalBase } from '../../plugin/server/pi-receipts.mjs';
import { MAX_JOURNAL, appendReceipt, compact as compactJournal, loadJournal, openScope, writeBody } from './journal.mjs';

const TTL_MS = 10 * 60 * 1000;
const MAX_SUFFIX = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['replied', 'failed', 'canceled', 'unknown']);
const METADATA = new Set(['model_change', 'thinking_level_change', 'usage', 'custom', 'label', 'session_info']);

// Consumption numbers are legitimate receipt metadata (Paseo surfaces per-turn
// usage); they carry no prompt or answer text. Kept small and validated.
function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
  const costUsd = Number.isFinite(usage.cost?.total) ? usage.cost.total : undefined;
  if (totalTokens === undefined && costUsd === undefined) return undefined;
  return { ...(totalTokens !== undefined ? { totalTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

function hasMarker(content, marker) {
  const text = typeof content === 'string' ? content : content?.[0]?.type === 'text' ? content[0].text : undefined;
  if (typeof text !== 'string' || !text.startsWith(marker)) return false;
  const tail = text.slice(marker.length, marker.length + 2);
  return tail === '' || tail.startsWith('\n') || tail === '\r\n';
}

function readSuffix(manager, baseline) {
  const suffix = [];
  const seen = new Set();
  let id = manager.getLeafId();
  while (id !== baseline) {
    if (typeof id !== 'string' || seen.has(id)) return { reason: 'branch_changed' };
    if (suffix.length === MAX_SUFFIX) return { reason: 'branch_limit' };
    const entry = manager.getEntry(id);
    if (!entry || entry.id !== id) return { reason: 'branch_changed' };
    suffix.push(entry);
    seen.add(id);
    id = entry.parentId;
  }
  return { entries: suffix.reverse() };
}

export default function observer(pi) {
  const base = journalBase(); // resolved once per runtime, before any env changes
  const paneId = process.env.HERDR_ENV === '1' ? process.env.HERDR_PANE_ID || undefined : undefined;
  let sessionId;
  let active;
  let receipts = new Map();
  let file;
  let loaded = false;
  let journalBroken = false;
  let warned = false;

  const warn = error => {
    journalBroken = true;
    if (!warned) { warned = true; console.error(`herdgate-receipt: journal disabled (${error})`); }
  };
  function ensure(ctx) {
    if (loaded) return;
    loaded = true;
    try {
      file = openScope(base, ctx.cwd);
      const { entries, receipts: map } = loadJournal(file);
      receipts = map;
      if (entries.length > MAX_JOURNAL) compactJournal(file, entries.slice(-MAX_JOURNAL));
    } catch (error) { warn(error.message); }
  }
  function record(entry) {
    if (journalBroken) { receipts.set(entry.id, entry); return; }
    try { receipts = appendReceipt(file, receipts, entry); }
    catch (error) { receipts.set(entry.id, entry); warn(error.message); }
  }
  function finish(status, fields = {}) {
    const { id, requestEntryId, sessionId: session, cwd, retainBody, bodyText } = active;
    if (status === 'replied' && retainBody && bodyText) {
      try { writeBody(base, cwd, id, bodyText); }
      catch (error) { console.error(`herdgate-receipt: body archive failed (${error.code ?? 'unknown'})`); }
    }
    const entry = { v: 1, id, status, ...(requestEntryId ? { requestEntryId } : {}), sessionId: session, ts: Date.now(), ...(paneId ? { paneId } : {}), ...fields };
    const receipt = { id, status, ...(requestEntryId ? { requestEntryId } : {}), ...fields };
    active = undefined;
    record(entry);
    return receipt;
  }
  function expire() {
    if (active && performance.now() >= active.deadline) finish('unknown', { reason: 'expired' });
  }
  function invalidate(reason) {
    if (active) finish('unknown', { reason });
  }
  function notify(ctx, value) {
    ctx.ui.notify(JSON.stringify(value), 'info');
  }

  pi.on('session_start', (_event, ctx) => {
    ensure(ctx);
    active = undefined;
    sessionId = ctx.sessionManager.getSessionId();
  });
  pi.on('session_shutdown', () => {
    invalidate('runtime_changed');
    sessionId = undefined;
  });
  pi.on('session_tree', () => { invalidate('branch_changed'); });

  pi.registerCommand('herdgate-arm', {
    description: 'Prepare a one-request receipt; --body also retains the final reply (no send)',
    handler(args, ctx) {
      ensure(ctx);
      expire();
      const option = args.trim();
      if (option && option !== '--body') return notify(ctx, { status: 'not_armed', reason: 'usage' });
      const retainBody = option === '--body';
      if (retainBody && process.env.HERDGATE_PI_RECEIPT_BODY === '0') {
        return notify(ctx, { status: 'not_armed', reason: 'body_disabled' });
      }
      if (ctx.mode !== 'tui' || !sessionId || ctx.sessionManager.getSessionId() !== sessionId) {
        return notify(ctx, { status: 'not_armed', reason: 'requires_current_tui' });
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return notify(ctx, { status: 'not_armed', reason: 'busy' });
      if (active) return notify(ctx, { id: active.id, status: 'not_armed', reason: 'already_armed' });
      const id = randomUUID();
      const marker = `[herdr-request:${id}]`;
      active = { id, marker, sessionId, baseline: ctx.sessionManager.getLeafId(), deadline: performance.now() + TTL_MS, cwd: ctx.cwd, retainBody };
      notify(ctx, { id, status: 'armed', marker, expiresInSeconds: TTL_MS / 1000, ...(retainBody ? { retainBody } : {}) });
    },
  });
  pi.registerCommand('herdgate-receipt', {
    description: 'Show metadata for a Herdgate request ID from this Pi workspace',
    handler(args, ctx) {
      ensure(ctx);
      expire();
      const id = args.trim();
      if (!UUID.test(id)) return notify(ctx, { status: 'unknown', reason: 'expected_request_id' });
      if (ctx.sessionManager.getSessionId() !== sessionId) invalidate('runtime_changed');
      if (active?.id === id) {
        const requestEntryId = active.requestEntryId;
        return notify(ctx, requestEntryId ? { id, status: 'received', requestEntryId } : { id, status: 'armed' });
      }
      const stored = receipts.get(id);
      if (!stored) return notify(ctx, { id, status: 'unknown', reason: 'not_retained_in_runtime' });
      const { v, ts, sessionId: _session, paneId: _pane, ...receipt } = stored;
      notify(ctx, { id, ...receipt });
    },
  });

  // turn_end is after append, but Pi may retry, continue, take more input, or abort.
  // Only settle may finalize a reply. Nothing in this observer modifies an event or input.
  function inspect(ctx, settled, event) {
    ensure(ctx);
    expire();
    if (!active) return;
    const manager = ctx.sessionManager;
    if (manager.getSessionId() !== sessionId) return invalidate('runtime_changed');
    const { entries, reason } = readSuffix(manager, active.baseline);
    if (!entries) return invalidate(reason);
    const users = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
    if (users.length !== 1 || !hasMarker(users[0].message.content, active.marker)) {
      return invalidate(users.length > 1 ? 'competing_input' : 'request_not_observed');
    }
    const request = users[0];
    const requestIndex = entries.indexOf(request);
    if (entries.slice(0, requestIndex).some(entry => entry.type === 'message' &&
        (entry.message?.role === 'assistant' || entry.message?.role === 'toolResult'))) {
      return invalidate('competing_input');
    }
    if (active.requestEntryId && active.requestEntryId !== request.id) return invalidate('branch_changed');
    active.requestEntryId = request.id;
    if (!settled) {
      active.lastTurnEntryId = event.messageEntryId;
      return;
    }

    const after = entries.slice(requestIndex + 1);
    const assistants = after.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant');
    const response = assistants.at(-1);
    if (entries.some(entry => {
      if (entry.type === 'context_edit') return entry.targetId === request.id || entry.targetId === response?.id;
      return entry.type !== 'message' && !METADATA.has(entry.type);
    })) return invalidate('unsupported_context');
    if (event.aborted === true) return finish('canceled', { reason: 'pi_aborted' });
    if (event.aborted !== false || !response || response.id !== active.lastTurnEntryId) {
      return invalidate('no_final_turn');
    }

    const { stopReason, content } = response.message;
    if (stopReason === 'error' || stopReason === 'length') {
      return finish('failed', { reason: stopReason === 'error' ? 'pi_error' : 'pi_length' });
    }
    const pending = new Set();
    for (const entry of after) {
      if (entry.type !== 'message') continue;
      const msg = entry.message;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) if (block.type === 'toolCall') pending.add(block.id);
      }
      if (msg.role === 'toolResult') pending.delete(msg.toolCallId);
    }
    if (stopReason !== 'stop' || !Array.isArray(content) || pending.size ||
        content.some(block => block.type === 'toolCall') ||
        !content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
      return invalidate('no_final_reply');
    }
    if (active.retainBody) active.bodyText = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const usage = summarizeUsage(response.message.usage);
    finish('replied', { responseEntryId: response.id, ...(usage ? { usage } : {}) });
  }
  pi.on('turn_start', () => {
    // A new turn can fail before it appends an assistant entry or reaches turn_end.
    if (active) active.lastTurnEntryId = undefined;
  });
  pi.on('turn_end', (event, ctx) => { inspect(ctx, false, event); });
  pi.on('agent_settled', (event, ctx) => { inspect(ctx, true, event); });
}

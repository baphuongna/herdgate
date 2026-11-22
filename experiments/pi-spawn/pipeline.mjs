#!/usr/bin/env node
// Herdgate pipeline e2e, odysseus-style but tiny (experiment, NOT shipped):
// task.md → git worktree (+ bootstrap hook) → Pi agent (one-id registry spawn)
// → test → retry with feedback on the SAME agent → second reviewer agent →
// report → STOP for human approval. It never merges and never cleans up after
// itself: `clean <id> --approved` is the explicit teardown hook.
//
//   node experiments/pi-spawn/pipeline.mjs run <task.md> [--cwd REPO] [--fake]
//        [--max-retry 2] [--test-cmd "node --test test/x.test.ts"] [--timeout-ms 900000]
//   node experiments/pi-spawn/pipeline.mjs clean <id> [--cwd REPO] --approved
//
// run steps (each one lands in the state JSON, pipe-<id>.state.json):
//   B1 worktree <repo>/../hg-pipe-<id>, branch pipe/<id> from HEAD; bootstrap
//      hook (the worktrunk lesson): copy .env if the repo has one, and
//      `npm install --no-audit --no-fund` only when package.json exists and
//      node_modules does not.
//   B2 worker agent in its own tab via the spawn registry (one id: registry
//      entry == receipt request == Pi --session-id), cwd = the worktree.
//      --fake points the tab at the scripted fixture provider through
//      PI_CODING_AGENT_DIR (+ TEST_PI_BIN's dir on the tab PATH) — no account,
//      no network. Prompt = task.md + marker.
//   B3 settle = plain `herdr agent get <pane>` polling (a script can poll it;
//      NOT a controller watch), ramping 0.5s→5s so a fast first turn is not
//      missed, steady cadence 5s. Timeout records state and leaves the agent
//      ALIVE (timeout ≠ abort).
//   B4 --test-cmd inside the worktree (sh -c, output capped at 64KB).
//   B5 fail → re-prompt the SAME agent with the failing output (≤ --max-retry),
//      back to B3. Pass or exhausted retries → B6.
//   B6 reviewer agent (second one-id spawn, same worktree): read
//      `git diff --stat` + `git diff`, final reply line 'REVIEW: PASS' or
//      'REVIEW: FAIL <reason>'; verdict parsed from the pane output.
//   B7 pipe-<id>.report.json + a summary table; nextAction: 'human-approval'.
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { recordSpawn, spawnBase } from './registry.mjs';
import { gitRead, scrubEnv } from '../../plugin/server/git-safe.mjs';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROVIDER = resolve(here, '../../test/fixtures/pipeline-fake-provider.mjs');
const IDLE_GRACE_MS = 8_000; // idle without any observed turn: settle anyway (ultra-fast scripted turn or dropped prompt)
const OUTPUT_CAP = 64 * 1024;
const FEEDBACK_CAP = 8 * 1024;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);
const fail = message => { console.error(message); process.exit(1); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const herdr = () => process.env.HERDR_BIN_PATH || 'herdr';
const run = (...a) => JSON.parse(execFileSync(herdr(), a, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const runSafe = (...a) => {
  try { return { ok: true, out: run(...a) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 300) }; }
};
// Git writes (worktree add/remove, branch -D) keep their plain argv and sync
// spawn, but run with git-safe's scrubbed env: no GIT_* inherited from this
// process's environment can redirect which repository gets written.
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: scrubEnv() });

const agentStatus = paneId => {
  const res = runSafe('agent', 'get', paneId);
  return res.ok ? (res.out?.result?.agent?.agent_status ?? 'unknown') : 'unknown';
};

/** One-id spawn (spawn.mjs's flow imported as a library, not forked): own tab,
 *  pre-assigned session id, recorded in spawns.jsonl beside the receipt journal. */
function spawnAgent({ name, cwd, env, extraPiArgs }) {
  const sessionId = randomUUID(); // one id: registry entry == receipt request == Pi session
  const tabArgs = ['tab', 'create', '--label', `hg-${name}`, '--no-focus', '--cwd', cwd];
  for (const [key, value] of Object.entries(env ?? {})) tabArgs.push('--env', `${key}=${value}`);
  const pane = run(...tabArgs).result.root_pane.pane_id;
  try {
    run('agent', 'start', name, '--kind', 'pi', '--pane', pane, '--timeout', '45000',
      '--', '--session-id', sessionId, ...(extraPiArgs ?? []));
  } catch (error) {
    throw new Error(`agent start failed for ${name}: ${String(error.message).slice(0, 300)}`);
  }
  // The registry scopes spawns by the recording process's cwd (spawn.mjs runs
  // from the controller's workspace); scope this record to the WORKTREE, where
  // the agent actually lives — same scope recordSelf uses for worker jobs.
  const prevCwd = process.cwd();
  let entry;
  try {
    process.chdir(cwd);
    entry = recordSpawn(spawnBase(), { id: sessionId, sessionId, paneId: pane, name, tab: true, cwd, ts: Date.now() });
  } finally {
    process.chdir(prevCwd);
  }
  const sessionFile = ((run('pane', 'list').result.panes ?? []).find(p => p.pane_id === pane)?.agent_session?.value) ?? '';
  return { ...entry, paneId: pane, bound: sessionFile.includes(sessionId) };
}

/** B3: poll `herdr agent get` until the agent settles. Timeout is recorded, the
 *  agent is never killed — the human (or a later retry) still owns that pane. */
async function waitSettle(paneId, timeoutMs, label, log) {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  let idleSince = 0;
  let loggedBusy = false;
  let wait = 500;
  while (Date.now() < deadline) {
    const status = agentStatus(paneId);
    if (status === 'working' || status === 'blocked') {
      sawBusy = true;
      idleSince = 0;
      if (!loggedBusy) { loggedBusy = true; log('settle', { label, phase: 'working' }); }
    } else if (status === 'idle') {
      if (sawBusy) { log('settle', { label, phase: 'idle' }); return { status: 'idle', sawBusy: true }; }
      if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince >= IDLE_GRACE_MS) {
        log('settle', { label, phase: 'idle', note: 'no-working-observed' });
        return { status: 'idle', sawBusy: false };
      }
    } else {
      idleSince = 0;
    }
    await sleep(wait);
    wait = Math.min(5000, wait * 2); // ramp to the 5s polling cadence
  }
  log('settle', { label, phase: 'timeout' });
  return { status: 'timeout' };
}

/** B4: run the test command in the worktree, output capped at 64KB. */
async function runTestCmd(testCmd, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await execFile('sh', ['-c', testCmd], { cwd, maxBuffer: OUTPUT_CAP, timeout: timeoutMs });
    return { code: 0, output: `${stdout}\n${stderr}`.slice(0, OUTPUT_CAP) };
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.slice(0, OUTPUT_CAP);
    return { code: typeof error?.code === 'number' ? error.code : 1, output };
  }
}

/** The reviewer's verdict: the LAST 'REVIEW: …' line of its pane output. */
const readPaneText = (paneId, lines = 160) => {
  try {
    return execFileSync(herdr(), ['agent', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  } catch { return ''; }
};

function parseReview(text) {
  const matches = [...text.matchAll(/REVIEW:[ \t]*(PASS|FAIL[^\n]*)/g)];
  if (!matches.length) return { verdict: 'unknown', reason: 'no REVIEW line in the reviewer output' };
  const last = matches.at(-1)[1].trim();
  if (last.startsWith('PASS')) return { verdict: 'PASS', reason: null };
  return { verdict: 'FAIL', reason: last.replace(/^FAIL\s*/, '').slice(0, 200) || null };
}

async function runPipeline() {
  const taskFile = args[1];
  if (!taskFile || taskFile.startsWith('--')) fail('usage: pipeline.mjs run <task.md> [--cwd REPO] [--fake] [--max-retry 2] [--test-cmd CMD] [--timeout-ms 900000]');
  const repo = resolve(flag('cwd', process.cwd()));
  if (!existsSync(join(repo, '.git'))) fail(`--cwd ${repo} is not a git repository`);
  const task = readFileSync(taskFile, 'utf8');
  const maxRetry = Number(flag('max-retry', '2'));
  const testCmd = flag('test-cmd', 'npm test');
  const timeoutMs = Number(flag('timeout-ms', '900000'));
  const fake = has('fake');

  const id = randomBytes(4).toString('hex');
  const worktree = join(dirname(repo), `hg-pipe-${id}`);
  const branch = `pipe/${id}`;
  const stateFile = join(repo, `pipe-${id}.state.json`);
  const reportFile = join(repo, `pipe-${id}.report.json`);
  const fixtureDir = join(repo, `pipe-${id}.fixture`);
  const state = { v: 1, id, repo, branch, worktree, fake, createdAt: Date.now(), steps: [] };
  const log = (step, detail = {}) => {
    state.steps.push({ step, ts: Date.now(), ...detail });
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  };
  const marker = `[herdgate-pipe:${id}]`;

  // B1 — worktree + bootstrap hook
  git(repo, 'worktree', 'add', worktree, '-b', branch);
  log('bootstrap', { phase: 'worktree_added', worktree, branch });
  if (existsSync(join(repo, '.env')) && !existsSync(join(worktree, '.env'))) {
    copyFileSync(join(repo, '.env'), join(worktree, '.env'));
    log('bootstrap', { phase: 'env_copied' });
  } else {
    log('bootstrap', { phase: 'env_skipped', reason: existsSync(join(repo, '.env')) ? 'worktree already has .env' : 'no .env in repo' });
  }
  const hasPackage = existsSync(join(worktree, 'package.json'));
  if (hasPackage && !existsSync(join(worktree, 'node_modules'))) {
    log('bootstrap', { phase: 'npm_install_ran' });
    try {
      await execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: worktree, maxBuffer: OUTPUT_CAP, timeout: 600_000 });
      log('bootstrap', { phase: 'npm_install_exit', code: 0 });
    } catch (error) {
      log('bootstrap', { phase: 'npm_install_exit', code: typeof error?.code === 'number' ? error.code : 1 });
    }
  } else {
    log('bootstrap', { phase: 'npm_install_skipped', reason: hasPackage ? 'node_modules present' : 'no package.json' });
  }

  // B2 — fake-mode pi settings: scripted provider, no account, no network
  const tabEnv = {};
  if (fake) {
    const piAgentDir = join(fixtureDir, 'pi-agent');
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'hg-pipe-fixture', defaultModel: 'test', defaultThinkingLevel: 'low',
      extensions: [FIXTURE_PROVIDER],
    }, null, 2) + '\n');
    tabEnv.PI_CODING_AGENT_DIR = piAgentDir;
    tabEnv.HG_PIPE_FIXTURE_DIR = fixtureDir;
    tabEnv.HG_PIPE_WORKTREE = worktree;
    if (process.env.TEST_PI_BIN) tabEnv.PATH = `${dirname(process.env.TEST_PI_BIN)}:${process.env.PATH ?? ''}`;
    log('fake-provider', { piAgentDir, provider: 'hg-pipe-fixture' });
  }
  const piArgs = fake ? ['--offline', '--no-approve', '--no-tools', '--no-skills', '--no-context-files'] : [];

  const worker = spawnAgent({ name: `pipe-${id}`, cwd: worktree, env: tabEnv, extraPiArgs: piArgs });
  log('agent-spawn', { role: 'worker', id: worker.id, pane: worker.paneId, name: worker.name, bound: worker.bound });

  const submit = async (brief, label) => {
    const res = runSafe('agent', 'prompt', worker.paneId, brief);
    log('prompt', { role: label, ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
    return waitSettle(worker.paneId, timeoutMs, label, log);
  };

  await submit(`${marker}\n\n${task}\n`, 'worker');
  let attempt = 1;
  let test = await runTestCmd(testCmd, worktree, timeoutMs);
  log('test', { attempt, exit: test.code });
  let retries = 0;
  while (test.code !== 0 && retries < maxRetry) {
    retries += 1;
    log('retry', { retry: retries });
    await submit(`${marker}\n\nThe test command failed (attempt ${attempt}, exit ${test.code}). Output:\n\n${test.output.slice(-FEEDBACK_CAP)}\n\nFix the issue so the test passes.`, 'worker-retry');
    attempt += 1;
    test = await runTestCmd(testCmd, worktree, timeoutMs);
    log('test', { attempt, exit: test.code });
  }

  // B6 — reviewer: a second one-id agent in the same worktree. The pipeline
  // itself reads the uncommitted diff through the plugin's hardened gitRead
  // (scrubbed env, no ext-diff/textconv, hooks/fsmonitor neutralized) — git is
  // pinned to a safe start dir and re-pointed with -C, the filev pattern — so
  // the brief and report carry a stat that hostile repo config cannot fake.
  let diffStat = '';
  try {
    diffStat = (await gitRead(['-C', worktree, 'diff', '--stat'])).stdout.trim().slice(0, 4096);
    log('review-diff', { phase: 'read', statBytes: Buffer.byteLength(diffStat) });
  } catch (error) {
    // Fail-closed on the read itself, fail-open for the pipeline: the reviewer
    // still inspects the worktree, the report just lacks the pipeline's stat.
    log('review-diff', { phase: 'failed', error: String(error?.message ?? error).slice(0, 200) });
  }
  const reviewer = spawnAgent({ name: `pipe-${id}-rev`, cwd: worktree, env: tabEnv, extraPiArgs: piArgs });
  log('agent-spawn', { role: 'reviewer', id: reviewer.id, pane: reviewer.paneId, name: reviewer.name, bound: reviewer.bound });
  const reviewBrief = `${marker}\n\nYou are the REVIEWER for pipeline ${id}. Your cwd is the worktree ${worktree}.\n`
    + `Inspect the uncommitted changes:\n  git diff --stat\n  git diff\n\n`
    + (diffStat ? `The pipeline's hardened stat read of the worktree:\n${diffStat}\n\n` : '')
    + `The task was:\n${task}\n\nReply with a short review. The FINAL line must be exactly:\nREVIEW: PASS\nor\nREVIEW: FAIL <one-line reason>`;
  {
    const res = runSafe('agent', 'prompt', reviewer.paneId, reviewBrief);
    log('prompt', { role: 'reviewer', ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
  }
  await waitSettle(reviewer.paneId, timeoutMs, 'reviewer', log);
  const review = parseReview(readPaneText(reviewer.paneId));
  log('review', { verdict: review.verdict, reason: review.reason });

  // B7 — report + summary, then STOP: human approval owns everything after this
  const report = {
    v: 1, id, repo, branch, worktree, createdAt: state.createdAt, finishedAt: Date.now(),
    agents: {
      worker: { id: worker.id, name: worker.name, pane: worker.paneId, bound: worker.bound },
      reviewer: { id: reviewer.id, name: reviewer.name, pane: reviewer.paneId, bound: reviewer.bound },
    },
    attempts: attempt, retries, testCmd, testExit: test.code, diffStat, review,
    fixtureDir: fake ? fixtureDir : null,
    nextAction: 'human-approval',
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  log('report', { file: reportFile, testExit: test.code, review: review.verdict });
  console.log([
    `pipeline ${id}`,
    `  worktree : ${worktree} (${branch})`,
    `  worker   : ${report.agents.worker.name} pane=${report.agents.worker.pane} id=${worker.id} bound=${worker.bound}`,
    `  reviewer : ${report.agents.reviewer.name} pane=${report.agents.reviewer.pane} id=${reviewer.id} bound=${reviewer.bound}`,
    `  retries  : ${retries} (attempts ${attempt})`,
    `  testExit : ${test.code}`,
    `  review   : ${review.verdict}${review.reason ? ` — ${review.reason}` : ''}`,
    `  next     : ${report.nextAction} — review, then: node ${process.argv[1]} clean ${id} --cwd ${repo} --approved`,
    `report: ${reportFile}`,
    `state : ${stateFile}`,
  ].join('\n'));
  process.exitCode = test.code === 0 && review.verdict === 'PASS' ? 0 : 1;
}

function cleanPipeline() {
  const id = args[1];
  if (!id || id.startsWith('--')) fail('usage: pipeline.mjs clean <id> [--cwd REPO] --approved');
  if (!has('approved')) fail(`refusing: clean ${id} requires --approved — the teardown belongs to the human who reviewed the report`);
  const repo = resolve(flag('cwd', process.cwd()));
  const reportFile = join(repo, `pipe-${id}.report.json`);
  if (!existsSync(reportFile)) fail(`no report at ${reportFile} — nothing to clean`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const stateFile = join(repo, `pipe-${id}.state.json`);
  const log = (step, detail = {}) => {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.steps.push({ step, ts: Date.now(), ...detail });
      writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    } catch { /* state file is optional for clean */ }
  };
  if (existsSync(report.worktree)) {
    git(report.repo, 'worktree', 'remove', '--force', report.worktree);
    log('clean', { phase: 'worktree_removed', worktree: report.worktree });
  } else {
    log('clean', { phase: 'worktree_missing', worktree: report.worktree });
  }
  git(report.repo, 'branch', '-D', report.branch);
  log('clean', { phase: 'branch_deleted', branch: report.branch });
  if (report.fixtureDir && existsSync(report.fixtureDir)) {
    rmSync(report.fixtureDir, { recursive: true, force: true });
    log('clean', { phase: 'fixture_removed' });
  }
  console.log(JSON.stringify({ id, cleaned: report.worktree, branch: report.branch, report: reportFile }));
}

try {
  if (command === 'run') await runPipeline();
  else if (command === 'clean') cleanPipeline();
  else fail('usage: pipeline.mjs run <task.md> [--cwd REPO] [--fake] [--max-retry 2] [--test-cmd CMD] [--timeout-ms 900000] | clean <id> [--cwd REPO] --approved');
} catch (error) {
  fail(`pipeline ${command ?? ''} failed: ${String(error?.message ?? error).slice(0, 400)}`);
}

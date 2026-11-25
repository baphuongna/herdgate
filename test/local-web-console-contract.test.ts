import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { mirrorViewModel } from '../src/console/web/view-model.ts';

type ContractFixture = {
  upstream: {
    revision: string;
    startup: { normalBoot: string; relayBoot: string; relayNeedsAccountOrPairing: boolean };
    startupReads: string[];
    session: { snapshotRoute: string; paneTranscriptRoute: string; paneTranscriptIsNotMirror: boolean };
    paneTransport: {
      websocketPath: string;
      attachMessage: unknown;
      screenFrameType: string;
      mirrorPath: { server: string; read: string; stream: string; frontendPaint: string };
      mirrorLimitations: string[];
      unsupportedForHerdgateL1: string[];
    };
    assets: { base: string; externalRuntimeAssets: string[]; futureGateSubpath: string };
    unsupported: string[];
  };
  session: Parameters<typeof mirrorViewModel>[0];
  screen: NonNullable<Parameters<typeof mirrorViewModel>[2]> & { cols: number | null; rows: number | null };
};
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/local-web-console-contract.json'), 'utf8')) as ContractFixture;

test('pinned Ovis contract fixture separates normal startup from relay/account boot and upstream endpoints', () => {
  assert.equal(fixture.upstream.revision, 'b0f20e7bcf87f770638c26b8c74e77ef8fd84131');
  assert.match(fixture.upstream.startup.normalBoot, /renderApp/);
  assert.match(fixture.upstream.startup.relayBoot, /bootRelayShell/);
  assert.equal(fixture.upstream.startup.relayNeedsAccountOrPairing, true);
  assert.deepEqual(fixture.upstream.startupReads, ['/api/health', '/api/machines?compact_agents=1']);
  assert.match(fixture.upstream.paneTransport.websocketPath, /^\/ws\?machine_id=local/);
  assert.equal(fixture.upstream.session.snapshotRoute, '/api/session');
  assert.match(fixture.upstream.session.paneTranscriptRoute, /^\/api\/pane\/read\?pane_id=/);
  assert.equal(fixture.upstream.session.paneTranscriptIsNotMirror, true);
  assert.equal(fixture.upstream.paneTransport.screenFrameType, 'pty-data');
  assert.equal(fixture.upstream.paneTransport.mirrorPath.server, 'server/core/terminal-process.ts');
  assert.equal(fixture.upstream.paneTransport.mirrorPath.read, 'pane.read(source=visible, format=ansi)');
  assert.equal(fixture.upstream.paneTransport.mirrorPath.stream, 'full repaint or changed-row delta in pty-data frames');
  assert.match(fixture.upstream.paneTransport.mirrorPath.frontendPaint, /xterm\.write/);
  assert.ok(fixture.upstream.paneTransport.mirrorLimitations.includes('output between screen polls can be missed'));
  assert.equal(fixture.upstream.assets.base, '/');
  assert.equal(fixture.upstream.assets.futureGateSubpath, '/console/ (Gate S4 only)');
  assert.deepEqual(fixture.upstream.assets.externalRuntimeAssets, []);
  assert.ok(fixture.upstream.unsupported.includes('terminal.attach'));
});

test('typed mirror view-model preserves upstream IDs and only paints a matching pane/generation screen', () => {
  const view = mirrorViewModel(fixture.session, 'pane-a', fixture.screen);
  assert.equal(view.state, 'ready');
  if (view.state !== 'ready') return;
  assert.deepEqual(view.selection, { workspaceId: 'workspace-a', tabId: 'tab-a', paneId: 'pane-a' });
  assert.equal(view.mirror.kind, 'ansi-snapshot');
  if (view.mirror.kind === 'ansi-snapshot') assert.equal(view.mirror.ansi, '\u001b[32mfixture output\u001b[0m');
});

test('typed mirror view-model keeps a valid truncated ANSI snapshot and carries its warning and source geometry', () => {
  const screen = { ...fixture.screen, truncated: true, cols: null, rows: 40 };
  const view = mirrorViewModel(fixture.session, 'pane-a', screen);
  assert.equal(view.state, 'ready');
  if (view.state !== 'ready') return;
  assert.deepEqual(view.mirror, {
    kind: 'ansi-snapshot', sequence: 7, capturedAt: fixture.screen.capturedAt,
    cols: null, rows: 40, truncated: true, ansi: fixture.screen.ansi,
  });
});

test('typed mirror view-model reports missing screen without pretending to paint', () => {
  const view = mirrorViewModel(fixture.session, 'pane-a', undefined);
  assert.equal(view.state, 'ready');
  if (view.state === 'ready') assert.deepEqual(view.mirror, { kind: 'unavailable', reason: 'screen-unavailable' });
});

test('typed mirror view-model refuses stale, mismatched, gone-pane and offline data instead of faking success', () => {
  const wrongPane = mirrorViewModel(fixture.session, 'pane-a', { ...fixture.screen, paneId: 'pane-b' });
  assert.equal(wrongPane.state, 'ready');
  if (wrongPane.state === 'ready') assert.deepEqual(wrongPane.mirror, { kind: 'unavailable', reason: 'screen-pane-mismatch' });

  const staleGeneration = mirrorViewModel(fixture.session, 'pane-a', { ...fixture.screen, runtimeGeneration: 'old-generation' });
  assert.equal(staleGeneration.state, 'ready');
  if (staleGeneration.state === 'ready') assert.deepEqual(staleGeneration.mirror, { kind: 'unavailable', reason: 'screen-generation-mismatch' });

  const gonePane = mirrorViewModel(fixture.session, 'pane-gone', fixture.screen);
  assert.deepEqual(gonePane, { state: 'selection-required', reason: 'pane-not-in-snapshot' });

  const offline = mirrorViewModel({ ...fixture.session, runtime: 'unavailable' }, 'pane-a', fixture.screen);
  assert.deepEqual(offline, { state: 'runtime-unavailable' });
});

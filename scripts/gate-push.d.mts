// Types for scripts/gate-push.mjs (off-site encrypted backup push).
export function setRunnerForTests(
  fn: (call: { cmd: string; args: string[]; opts?: Record<string, unknown> }) => { status: number; stdout: unknown; stderr?: unknown },
): void;
export function loadKey(keyFile: string): Buffer;
export function encryptBlob(key: Buffer, plain: Buffer): Buffer;
export function decryptBlob(key: Buffer, blob: Buffer): Buffer;
export function remoteName(backupDir: string): string;
export function pruneKeep(names: string[], keep: number): string[];
export function latestBackup(root?: string): string | null;
export function pushLatest(o: {
  host: string;
  port?: number;
  path: string;
  keep?: number;
  key?: string;
  backup?: string;
  root?: string;
}): { code: number; message: string };
export function decryptArchive(o: { inFile: string; outDir: string; key?: string }): { code: number; message: string };

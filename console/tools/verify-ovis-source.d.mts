export interface OvisSourceReport {
  revision: string;
  fileCount: number;
  bytes: number;
  files: string[];
  localEntrypoint: string | null;
  buildReady: boolean;
  upstreamPwaRegistrationExcluded: boolean;
}

export function verifyOvisSource(rootUrl: URL): Promise<OvisSourceReport>;

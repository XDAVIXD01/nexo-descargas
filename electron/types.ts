export type DownloadStatus =
  | "checking"
  | "queued"
  | "resolving"
  | "recovering"
  | "downloading"
  | "retrying"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

export interface DownloadItem {
  id: string;
  sourceUrl: string;
  directUrl?: string;
  name: string;
  host: string;
  status: DownloadStatus;
  totalBytes?: number;
  downloadedBytes: number;
  speed: number;
  addedAt: number;
  savePath?: string;
  error?: string;
  retryAttempt?: number;
  retryAt?: number;
  resumeOnLaunch?: boolean;
  recoveryBytesRemaining?: number;
}

export interface Settings {
  downloadDirectory: string;
  concurrentDownloads: number;
  speedLimitKbps: number;
  startAutomatically: boolean;
}

export interface ResolvedLink {
  sourceUrl: string;
  directUrl: string;
  fileName: string;
  size?: number;
  host: string;
  headers?: Record<string, string>;
}

export interface AddResult {
  added: number;
  rejected: Array<{ url: string; reason: string }>;
}

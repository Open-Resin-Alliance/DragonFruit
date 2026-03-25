/**
 * Athena network barrel.
 *
 * Re-export client-safe NanoDLP helpers through a plugin-owned surface so app
 * code can depend on Athena's public boundary rather than deep plugin
 * internals.
 *
 * Important:
 * - Do not export `nanodlpHandlers` here; those depend on Node APIs and are
 *   server-only.
 */

export * from './nanodlp';
export * from './nanodlpUploadWithProgress';
export * from './nanodlpMonitoring';

import { uploadToNanoDlpWithProgress } from './nanodlpUploadWithProgress';

export async function uploadPrintJobWithProgress(args: {
	hostUrl: string;
	zipBlob: Blob;
	path: string;
	profileId: string;
	callbacks: {
		onProgress: (event: {
			loaded: number;
			total: number;
			uploadSpeed: string;
			remainingTime: string;
			transferred: string;
			percentComplete: number;
		}) => void;
		onStatusUpdate: (update: {
			stage: 'uploading' | 'processing' | 'complete' | 'error';
			message: string;
			progress?: {
				loaded: number;
				total: number;
				uploadSpeed: string;
				remainingTime: string;
				transferred: string;
				percentComplete: number;
			};
			plateId?: number | null;
			error?: string;
		}) => void;
		onComplete?: (plateId: number | null) => void;
		onError?: (error: string) => void;
	};
}): Promise<{ ok: boolean; plateId: number | null }> {
	return uploadToNanoDlpWithProgress(
		args.hostUrl,
		args.zipBlob,
		args.path,
		args.profileId,
		args.callbacks,
	);
}

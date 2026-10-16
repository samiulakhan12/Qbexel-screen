// The transcript half of a scan, for the browser shim: no ffmpeg, no OCR worker, so
// frames are not read and the scan says so. The real scan lives in `electron/privacy/`.

import { createId } from "../document/ids";
import type { AxcutDocument, AxcutPrivacyScan } from "../schema";
import { carryOverDecisions, transcriptFindings } from "./findings";
import { scannableAssetIds } from "./review";

export function scanDocumentForSensitiveContent(document: AxcutDocument): AxcutPrivacyScan {
	const assetIds = scannableAssetIds(document);
	const findings = document.transcripts
		.filter((transcript) => assetIds.includes(transcript.assetId))
		.flatMap((transcript) => transcriptFindings(transcript, createId));
	return {
		id: createId("scan"),
		at: new Date().toISOString(),
		strategies: ["transcript"],
		ocrAvailable: false,
		sampleEveryMs: 2000,
		framesScanned: 0,
		assetIds,
		findings: carryOverDecisions(document.privacy?.scan, findings, document),
		warnings: [
			"Frames were not read: the browser preview has no OCR. Only the transcript was scanned.",
		],
	};
}

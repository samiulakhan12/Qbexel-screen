// Dashed guides over the preview marking a composition's safe area: the margins a platform's
// own UI covers. Drawn only while the Compositions pane asks for one; never exported.

import { findComposition } from "@/lib/ai-edition/compositions/apply";
import {
	hasSafeArea,
	safeAreaInsetStyle,
	safeAreaOf,
} from "@/lib/ai-edition/compositions/safeArea";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useSafeAreaGuide } from "@/lib/ai-edition/store/safeAreaGuide";
import styles from "./NewEditorShell.module.css";

export function SafeAreaGuides() {
	const compositionId = useSafeAreaGuide((s) => s.compositionId);
	const document = useProjectStore((s) => s.document);
	const composition = findComposition(document, compositionId);
	const area = safeAreaOf(composition);
	if (!composition || !hasSafeArea(area)) return null;
	return (
		<div
			className={styles.safeAreaGuide}
			style={safeAreaInsetStyle(area)}
			data-testid="safe-area-guide"
			aria-hidden="true"
		>
			<span className={styles.safeAreaLabel}>{composition.name}</span>
		</div>
	);
}

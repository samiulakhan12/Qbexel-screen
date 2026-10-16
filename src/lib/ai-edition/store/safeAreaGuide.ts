// Which composition's safe area the preview draws as guides. Renderer state only (not on
// the document): a guide is something you look at while editing, not part of the project.

import { create } from "zustand";

interface SafeAreaGuideState {
	compositionId: string | null;
	show: (compositionId: string | null) => void;
}

export const useSafeAreaGuide = create<SafeAreaGuideState>((set) => ({
	compositionId: null,
	show: (compositionId) => set({ compositionId }),
}));

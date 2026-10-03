import type { MetaReasoningConfig, ReasoningMode, ReasoningModeConfig } from '@cogitator-ai/types';

/** Profile overrides per reasoning mode: a mode or field left out keeps its default. */
export type ModeProfileOverrides = Partial<Record<ReasoningMode, Partial<ReasoningModeConfig>>>;

/** Meta-reasoning settings over the defaults, with `modeProfiles` merged per mode and field. */
export interface MetaReasoningOverrides extends Partial<Omit<MetaReasoningConfig, 'modeProfiles'>> {
  modeProfiles?: ModeProfileOverrides;
}

/** `base` with each mode's profile overridden field by field. */
export function mergeModeProfiles(
  base: Record<ReasoningMode, ReasoningModeConfig>,
  overrides: ModeProfileOverrides = {}
): Record<ReasoningMode, ReasoningModeConfig> {
  return {
    analytical: { ...base.analytical, ...overrides.analytical },
    creative: { ...base.creative, ...overrides.creative },
    systematic: { ...base.systematic, ...overrides.systematic },
    intuitive: { ...base.intuitive, ...overrides.intuitive },
    reflective: { ...base.reflective, ...overrides.reflective },
    exploratory: { ...base.exploratory, ...overrides.exploratory },
  };
}

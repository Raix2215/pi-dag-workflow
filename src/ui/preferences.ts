import type { Feature } from '../workflow/features.ts';

export const VIEW_TYPE = 'pi-dag-workflow.view';
export interface ViewPreferences { version: 1; visible: Partial<Record<Feature, boolean>> }
export const emptyViewPreferences = (): ViewPreferences => ({ version: 1, visible: {} });
export function restoreViewPreferences(branch: readonly { type: string; customType?: string; data?: unknown }[]): ViewPreferences {
  const entry = branch.findLast((item) => item.type === 'custom' && item.customType === VIEW_TYPE);
  if (!entry) return emptyViewPreferences();
  const value = entry.data as ViewPreferences;
  if (value?.version !== 1 || !value.visible || Object.values(value.visible).some((flag) => typeof flag !== 'boolean')) throw new Error('Invalid display preferences');
  return structuredClone(value);
}

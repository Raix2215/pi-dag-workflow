/** Only selected Pi resources start their controller; UI belongs to each selected feature. */
export const FEATURE_NAMES = ['todos', 'plan', 'agents', 'goal', 'retry'] as const;
export type Feature = typeof FEATURE_NAMES[number];
export type Features = Record<Feature, boolean>;
export const noFeatures = (): Features => ({ todos: false, plan: false, agents: false, goal: false, retry: false });

/** Only selected Pi resources start their controller; UI belongs to each selected feature. */
export const FEATURE_NAMES = ['todos', 'plan', 'agents', 'goal', 'retry', 'team'] as const;
export type Feature = typeof FEATURE_NAMES[number];
type Features = Record<Feature, boolean>;
export const noFeatures = (): Features => ({ todos: false, plan: false, agents: false, goal: false, retry: false, team: false });

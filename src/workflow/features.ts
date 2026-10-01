/** Derived only from loaded Pi resources, never from plugin configuration. */
export const FEATURE_NAMES = ['todos', 'plan', 'agents', 'goal', 'ui'] as const;
export type Feature = typeof FEATURE_NAMES[number];
export type Features = Record<Feature, boolean>;
export const noFeatures = (): Features => ({ todos: false, plan: false, agents: false, goal: false, ui: false });

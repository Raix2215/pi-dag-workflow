import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/connect.ts';

/** User-selected main-session recovery, independent of Todo/Goal/Agents. */
export default async function (pi: ExtensionAPI): Promise<void> { await connectFeature(pi, 'retry'); }

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/connect.ts';

/** Public Pi resource, selected independently with pi config. */
export default async function (pi: ExtensionAPI): Promise<void> { await connectFeature(pi, 'plan'); }

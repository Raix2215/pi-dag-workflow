import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/commands/connect.ts';

export default async function (pi: ExtensionAPI): Promise<void> { await connectFeature(pi, 'team'); }

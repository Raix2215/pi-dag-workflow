import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/connect.ts';

/** Public Pi resource, selected independently with pi config. */
export default function (pi: ExtensionAPI): void { connectFeature(pi, 'plan'); }

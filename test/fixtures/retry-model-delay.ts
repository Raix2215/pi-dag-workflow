import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Isolated offline test only: a model-select observer that outlasts user cancellation. */
export default function delayedModelSelect(pi: ExtensionAPI): void {
  pi.on('model_select', async (event, ctx) => {
    if (event.model.provider === 'dag-test' && event.model.id === 'reasoned') {
      ctx.ui.notify('Synthetic slow model selection entered', 'info');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  });
}

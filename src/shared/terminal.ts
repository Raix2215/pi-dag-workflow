import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Untrusted text never contributes terminal controls; keep emoji ZWJ sequences intact. */
export function clean(text: string): string {
  const escaped = text.replace(/\u009b/g, "\x1b[").replace(/\u009d/g, "\x1b]").replace(/\u009c/g, "\x1b\\");
  return stripTerminalSequences(escaped).replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, "").trim();
}
/** Display text keeps intended line breaks while removing terminal controls from each line. */
export function displayText(text: string): string {
  return text.split("\n").map((line) => {
    const indent = (line.match(/^[ \t]*/)![0]).replace(/\t/g, "    ");
    const content = clean(line);
    return content ? indent + content : "";
  }).join("\n");
}
export function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(displayText(text), type);
}

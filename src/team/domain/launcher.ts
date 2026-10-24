/** Launch/takeover rules are pure: adapters are detected, commands are strings, nothing spawns here. */
import { THINKING_LEVELS } from '../../shared/profile-launch.ts';
import type { Translator } from '../../shared/i18n.ts';
export interface LaunchAdapters {
  tmux: boolean; graphical: boolean;
  /** A terminal that was probed on PATH; used when the configuration says `auto`. */
  terminal?: TerminalApp;
  /** `desktopTerminal`: `auto`, `none` or an explicit emulator. */
  desktopTerminal?: TerminalApp | 'auto' | 'none';
  /** `desktopCommand`: a template containing `{command}`. */
  desktopTemplate?: string;
  /** PATH probe, so the platform table can be walked without touching the filesystem in tests. */
  available?: (name: string) => boolean;
  platform?: string;
}
export type LaunchMode = 'split' | 'window' | 'desktop' | 'background' | 'copy';
/** A tmux window and a desktop window are different features: the second needs a terminal emulator. */
export type TerminalApp = 'kitty' | 'gnome-terminal' | 'konsole' | 'alacritty' | 'xfce4-terminal' | 'wezterm' | 'wt';
/**
 * Per-platform terminal tables, in probe order. Only terminals with a "run this argv" entry point are
 * listed: macOS Terminal.app and iTerm are deliberately absent (they need AppleScript or a script file).
 */
export const TERMINALS: Readonly<Record<string, readonly TerminalApp[]>> = {
  linux: ['kitty', 'gnome-terminal', 'konsole', 'alacritty', 'xfce4-terminal', 'wezterm'],
  darwin: ['kitty', 'alacritty', 'wezterm'],
  win32: ['wt'],
};
/** Every terminal name the configuration accepts, whatever this host runs. */
export const TERMINAL_NAMES: readonly TerminalApp[] = ['kitty', 'gnome-terminal', 'konsole', 'alacritty', 'xfce4-terminal', 'wezterm', 'wt'];
/**
 * A command is a list of typed tokens: fixed syntax keeps its literal spelling, everything that comes
 * from a request or a Profile is data and is quoted for the platform. A value that begins with '-' is
 * still data — the first character says nothing about whether the caller meant an option.
 */
interface Token { readonly text: string; readonly flag: boolean }
const flag = (text: string): Token => ({ text, flag: true });
const data = (text: string): Token => ({ text, flag: false });

/** cmd.exe quotes with double quotes (an embedded quote is doubled); a POSIX shell uses single quotes. */
export function quoteToken(value: string, platform: string = process.platform): string {
  return platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : shellQuote(value);
}

/** The argv shape each emulator needs before the program to run. */
const TERMINAL_PREFIX: Readonly<Record<TerminalApp, readonly Token[]>> = {
  kitty: [], 'gnome-terminal': [flag('--')], konsole: [flag('-e')], alacritty: [flag('-e')], 'xfce4-terminal': [flag('-x')], wezterm: [data('start'), flag('--')], wt: [],
};
export interface LaunchRuntime { fifo: string; log: string; pidFile: string }
export interface LaunchRequest {
  /** The interpreter (Node), never the CLI: pi flags must follow the entry below. */
  execPath: string;
  /** The Pi CLI entry (`resolvePiCli()`), passed as the interpreter's first argument. */
  cli?: string;
  cwd: string; teamName: string; sessionId?: string; resume?: boolean;
  /**
   * A fresh Pi session id assigned before the spawn: the native `--session-id` makes the child's record and
   * its mailbox exactly this session, so a same-named or concurrent record can never stand in for it.
   */
  createSessionId?: string;
  /** Initial team member name (`--team-member`), independent from the native session name. */
  memberName?: string;
  /** Native Pi session name (`--name`); omitted leaves the host default. */
  name?: string;
  /** `provider/id`, optionally already carrying a `:thinking` suffix. */
  model?: string;
  thinking?: string;
  profile?: string;
  /** Runtime wiring for a background RPC member. Required for `background`: there is no fallback. */
  runtime?: LaunchRuntime;
  /** The Team extension entry an isolated child must load, so `--team` and the team tools still exist. */
  teamExtension?: string;
}
export interface LaunchPlan {
  mode: LaunchMode; adapter: 'tmux' | 'shell'; command: string; background: boolean;
  /** A mode fell back to copy: no tmux for split/window, no desktop terminal for desktop. */
  degraded?: 'no-tmux' | 'no-terminal';
  /**
   * What the launcher must actually run. A known terminal is spawned directly with the same argv the
   * paste-able command shows; a user template is one shell command, handed to the platform shell whole.
   */
  exec?: { file: string; args: string[] };
}

export const BACKGROUND_ENV = 'PI_TEAM_BACKGROUND';

export function detectAdapters(env: NodeJS.ProcessEnv, platform: string = process.platform): LaunchAdapters {
  const tmux = Boolean(env.TMUX) && !env.TMUX_PANE?.startsWith('no-');
  const graphical = platform === 'darwin' ? true : platform === 'linux' ? Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) : false;
  return { tmux, graphical };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const renderTokens = (tokens: readonly Token[], platform: string): string => tokens.map((token) => token.flag ? token.text : quoteToken(token.text, platform)).join(' ');
/** The shell that runs a user template as one command, never split on spaces by this code. */
export const templateShell = (platform: string = process.platform): { file: string; args: (command: string) => string[] } => platform === 'win32'
  // Documented cmd rule: with /s, cmd strips exactly the first and last quote and runs the rest as written.
  ? { file: 'cmd', args: (command) => ['/d', '/s', '/c', `"${command}"`] }
  : { file: 'sh', args: (command) => ['-c', command] };

/**
 * Windows support is decided by capability, not by which characters a value contains: every launch that
 * needs a shell (a user template, tmux, the clipboard command, the background command) is unsupported
 * there for now, while a known terminal's direct argv keeps any legal value — % and quotes included.
 */
export const WINDOWS_SHELL_UNSUPPORTED = 'Windows 上暂不支持需要 shell 的启动（自定义模板／tmux／后台／复制命令）：只剩已知终端的直接 argv 启动';
/** The same sentence through the caller's dictionary, so the UI and the thrown error never drift. */
export const windowsShellUnsupported = (msg: Translator): string => msg('Windows 上暂不支持需要 shell 的启动（自定义模板／tmux／后台／复制命令）：只剩已知终端的直接 argv 启动');
/** Which launch modes need a shell, so Windows refuses them before any side effect. */
export const needsShell = (mode: LaunchMode): boolean => mode !== 'desktop';
/**
 * The terminal a desktop launch would really use, by the same rule `planLaunch` applies: an explicit name
 * wins, `none` means none, and `auto` has to be probed — an `auto` default is not itself a terminal.
 */
export function resolvedDesktopTerminal(adapters: LaunchAdapters): TerminalApp | undefined {
  const explicit = adapters.desktopTerminal ?? adapters.terminal ?? 'auto';
  if (explicit === 'none') return undefined;
  if (explicit !== 'auto') return TERMINAL_NAMES.includes(explicit) ? explicit : undefined;
  return adapters.available ? detectTerminal(adapters.available, adapters.platform ?? process.platform) : undefined;
}

/**
 * The launch a Windows host can actually perform: a known terminal with its own argv, nothing else.
 * This asks the same question `planLaunch` will ask, so a guard that says "yes" can never be followed by
 * a plan that throws the unsupported-shell error — in particular an unprobed `auto` is not supported.
 */
export function windowsLaunchSupported(mode: LaunchMode, adapters: LaunchAdapters): boolean {
  if (mode !== 'desktop') return false;
  if (adapters.desktopTemplate?.trim()) return false;
  return resolvedDesktopTerminal(adapters) !== undefined;
}

/** `provider/id:thinking` already carries the level, so `--thinking` must not be appended twice. */
/**
 * The level a model id names with a trailing `:level`, or undefined when the last segment is not a level
 * (`provider:namespace/id` keeps its colon and still needs its own `--thinking`).
 */
export function modelLevelSuffix(model: string): string | undefined {
  const at = model.lastIndexOf(':');
  if (at <= 0) return undefined;
  const level = model.slice(at + 1);
  return (THINKING_LEVELS as readonly string[]).includes(level) ? level : undefined;
}

/**
 * A level is a launch setting of its own: it travels even when no model is named, and a model that already
 * names its level with a legal suffix never gets a contradicting `--thinking`.
 */
export function modelArgs(model: string | undefined, thinking: string | undefined): string[] {
  return modelTokens(model, thinking).map((token) => token.text);
}
const modelTokens = (model: string | undefined, thinking: string | undefined): Token[] => {
  const args: Token[] = [];
  if (model) args.push(flag('--model'), data(model));
  if (!thinking) return args;
  if (model && modelLevelSuffix(model)) return args;
  return [...args, flag('--thinking'), data(thinking)];
};

/** `tools: []` is a decision, not an omission: the flag goes out with an empty list. */
export function toolsArgs(tools: readonly string[] | undefined): string[] {
  return toolsTokens(tools).map((token) => token.text);
}
const toolsTokens = (tools: readonly string[] | undefined): Token[] => tools === undefined ? [] : [flag('--tools'), data(tools.join(','))];
/** Isolation is opt-in: without it the member keeps every host extension (and the agent directory). */
/** The launch-relevant slice of a workflow Profile; `src/shared/profile-launch.ts` owns the reader. */
export interface LaunchProfileLike { isolate?: boolean; childExtensions?: readonly string[]; model?: { provider: string; id: string }; tools?: readonly string[]; thinking?: string }

/**
 * `--no-extensions` leaves exactly the entries named here: the Team extension itself (it owns `--team` and
 * the team tools) plus the profile's child extensions. An isolated launch without that entry would start a
 * member whose `--team` is not even registered, so it is refused instead of guessed.
 */
export function profileArgs(profile: LaunchProfileLike | undefined, teamExtension?: string): string[] {
  return profileTokens(profile, teamExtension).map((token) => token.text);
}
const profileTokens = (profile: LaunchProfileLike | undefined, teamExtension?: string): Token[] => {
  if (!profile?.isolate) return [];
  if (!teamExtension) throw new Error('隔离启动必须显式带上 Team 扩展入口，否则 --team 不会被注册');
  return [flag('--no-extensions'), flag('--no-skills'), flag('-e'), data(teamExtension), ...(profile.childExtensions ?? []).flatMap(path => [flag('-e'), data(path)])];
};

/** Request values win over the Profile's; anything the Profile does not define is left to the host default. */
export interface LaunchSettings { model?: string; thinking?: string; tools?: readonly string[] }
export function launchSettings(request: LaunchRequest, profile?: LaunchProfileLike): LaunchSettings {
  const model = request.model ?? (profile?.model ? `${profile.model.provider}/${profile.model.id}` : undefined);
  const thinking = request.thinking ?? profile?.thinking;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(profile?.tools === undefined ? {} : { tools: profile.tools }),
  };
}

/** Interpreter first, CLI entry second; a missing CLI entry is a bug, not a silent Node invocation. */
export function targetArgs(request: LaunchRequest): string[] {
  return targetTokens(request).map((token) => token.text);
}
/** The interpreter and the CLI entry are program paths: always data, never a flag. */
const targetTokens = (request: LaunchRequest): Token[] => request.cli ? [data(request.execPath), data(request.cli)] : [data(request.execPath)];

/**
 * Session continuity: `--session` continues one named session, `--session-id` starts exactly one assigned
 * session, `--continue` reuses the same session. The first two are different launches, never one of both.
 */
export function memberArgs(request: LaunchRequest, profile?: LaunchProfileLike): string[] {
  return memberTokens(request, profile).map((token) => token.text);
}

/**
 * Every value here is data — team name, session ids, member name, model, thinking level, tool list and
 * extension paths — so it is quoted even when it begins with '-'. Only the flags are literal syntax.
 */
const memberTokens = (request: LaunchRequest, profile?: LaunchProfileLike): Token[] => {
  if (request.sessionId && request.createSessionId) throw new Error('一次启动不能同时续接会话和预定新会话 ID');
  // A new terminal must have the Team flag handler even if the user's default resource selection omits
  // this module. Pi deduplicates explicit and auto-discovered extension paths; isolation still loads only
  // its opt-in list below.
  const args = [flag('--team'), data(request.teamName)];
  if (!request.sessionId) args.push(flag('--team-bootstrap'));
  if (!profile?.isolate && request.teamExtension) args.push(flag('-e'), data(request.teamExtension));
  if (request.sessionId) args.push(flag('--session'), data(request.sessionId));
  else if (request.createSessionId) args.push(flag('--session-id'), data(request.createSessionId));
  else if (request.resume) args.push(flag('--continue'));
  if (request.memberName) args.push(flag('--team-member'), data(request.memberName));
  if (request.name) args.push(flag('--name'), data(request.name));
  const settings = launchSettings(request, profile);
  args.push(...profileTokens(profile, request.teamExtension), ...modelTokens(settings.model, settings.thinking), ...toolsTokens(settings.tools));
  return args;
};

/** The paste-able command and the real spawn share `targetArgs` + `memberArgs`; only the join differs. */
export function launchCommand(request: LaunchRequest, profile?: LaunchProfileLike, platform: string = process.platform): string {
  return renderTokens([...targetTokens(request), ...memberTokens(request, profile)], platform);
}

/**
 * Six entry points share one command. tmux adapters are used only when tmux exists; on a bare shell
 * they degrade to the copyable command, which stays valid because it only needs --team.
 */
export function planLaunch(mode: LaunchMode, request: LaunchRequest, adapters: LaunchAdapters, profile?: LaunchProfileLike): LaunchPlan {
  // A detached `pi` with no TTY exits immediately; RPC keeps reading from its FIFO and stays alive.
  if (mode === 'background') {
    // Without a runtime pair there is no trustworthy place for the FIFO or the log: refuse the request
    // instead of inventing one next to the working directory, where one fixed file per display name
    // would collide (and stay behind) across every launch.
    const runtime = request.runtime;
    if (!runtime) throw new Error('后台启动缺少团队运行目录里的运行文件：拒绝启动，不在工作目录里留固定文件');
    if ((adapters.platform ?? process.platform) === 'win32') throw new Error(WINDOWS_SHELL_UNSUPPORTED);
    const command = `env ${BACKGROUND_ENV}=1 ${launchCommand(request, profile)} --mode rpc < ${shellQuote(runtime.fifo)} > ${shellQuote(runtime.log)} 2>&1 &`;
    return { mode, adapter: 'shell', background: true, command };
  }
  const platform = adapters.platform ?? process.platform;
  const command = launchCommand(request, profile, platform);
  // A desktop window is its own feature: it needs a terminal emulator, not a multiplexer.
  if (mode === 'desktop') {
    const template = adapters.desktopTemplate?.trim();
    const explicit = adapters.desktopTerminal ?? adapters.terminal ?? 'auto';
    const resolvedDesktop = resolveDesktop(request, {
      ...(template ? { template } : {}),
      terminal: explicit,
      ...(adapters.available ? { available: adapters.available } : {}),
      platform,
    }, profile);
    if (!resolvedDesktop) {
      // No terminal and no template: the only remaining "desktop" answer is a copyable shell command.
      if (platform === 'win32') throw new Error(WINDOWS_SHELL_UNSUPPORTED);
      return { mode: 'copy', adapter: 'shell', background: false, command, degraded: 'no-terminal' };
    }
    // The template is a shell program the user wrote: run it whole, in one shell invocation.
    if (template) {
      // A template is a shell command, and Windows shell launches are not supported yet: refuse here, before
      // anything is spawned, instead of emitting a command that only looks runnable.
      if (platform === 'win32') throw new Error(WINDOWS_SHELL_UNSUPPORTED);
      return { mode, adapter: 'shell', background: false, command: resolvedDesktop, exec: { file: templateShell(platform).file, args: templateShell(platform).args(resolvedDesktop) } };
    }
    // A probed or configured emulator keeps its direct argv: no shell, nothing to re-quote.
    const terminal = explicit !== 'auto' && explicit !== 'none' ? explicit : (adapters.available ? detectTerminal(adapters.available, platform) : undefined);
    if (!terminal) return { mode, adapter: 'shell', background: false, command: resolvedDesktop };
    return { mode, adapter: 'shell', background: false, command: resolvedDesktop, exec: { file: terminal, args: [...terminalPrefix(terminal), ...targetArgs(request), ...memberArgs(request, profile)] } };
  }
  // A clipboard command and a tmux window are both shell launches: Windows has neither for now, and a
  // degraded "copy" fallback would be exactly the promise this boundary refuses to make.
  if (platform === 'win32') throw new Error(WINDOWS_SHELL_UNSUPPORTED);
  if (mode === 'copy' || !adapters.tmux) {
    const degraded = mode !== 'copy';
    return { mode: 'copy', adapter: 'shell', background: false, command, ...(degraded ? { degraded: 'no-tmux' as const } : {}) };
  }
  if (mode === 'split') return { mode, adapter: 'tmux', background: false, command: `tmux split-window -h ${shellQuote(command)}`, exec: { file: 'tmux', args: ['split-window', '-h', command] } };
  return { mode, adapter: 'tmux', background: false, command: `tmux new-window ${shellQuote(command)}`, exec: { file: 'tmux', args: ['new-window', command] } };
}

/** The first desktop terminal that exists on this platform; `undefined` means the caller must degrade. */
export function detectTerminal(available: (name: string) => boolean, platform: string = process.platform): TerminalApp | undefined {
  return (TERMINALS[platform] ?? []).find(name => available(name));
}

/** Each emulator spells "run this program" differently; the argv itself is the shared construction. */
export const terminalPrefix = (terminal: TerminalApp): readonly string[] => (TERMINAL_PREFIX[terminal] ?? []).map((token) => token.text);

/** A desktop window runs the same argv as `launchCommand`, quoted for a shell prompt. */
export function desktopCommand(request: LaunchRequest, terminal: TerminalApp, profile?: LaunchProfileLike, platform: string = process.platform): string {
  // The emulator and the argv it runs are program names and data; its own "run this" prefix is syntax.
  return renderTokens([data(terminal), ...(TERMINAL_PREFIX[terminal] ?? []), ...targetTokens(request), ...memberTokens(request, profile)], platform);
}

/** A custom template must say where the command goes; without it the row would launch nothing. */
export const DESKTOP_COMMAND_LIMIT = 200;
export function validDesktopCommand(template: string): boolean {
  return template.trim().length <= DESKTOP_COMMAND_LIMIT && template.includes('{command}');
}

/** The program part of the command: the same argv every other mode builds. */
const programArgs = (request: LaunchRequest, profile?: LaunchProfileLike, platform: string = process.platform): string => renderTokens([...targetTokens(request), ...memberTokens(request, profile)], platform);

/**
 * Resolve the desktop window command: a custom template wins, then an explicit terminal, then the
 * platform probe. `undefined` means there is no desktop host, so the caller degrades to copy.
 */
export function resolveDesktop(request: LaunchRequest, options: { template?: string; terminal?: TerminalApp | 'auto' | 'none'; available?: (name: string) => boolean; platform?: string }, profile?: LaunchProfileLike): string | undefined {
  const template = options.template?.trim();
  // The template is also the host: a user who configured one needs no probe to run it.
  if (template) return template.replaceAll('{command}', programArgs(request, profile, options.platform));
  const explicit = options.terminal && options.terminal !== 'auto' && options.terminal !== 'none' ? options.terminal : undefined;
  if (options.terminal === 'none') return undefined;
  const terminal = explicit ?? (options.available ? detectTerminal(options.available, options.platform) : undefined);
  return terminal ? desktopCommand(request, terminal, profile, options.platform) : undefined;
}

/** Clipboard command for `mode: 'copy'`: the first available writer, else `undefined` (write a script). */
export function clipboardCommand(available: (name: string) => boolean, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | undefined {
  if (platform === 'darwin' && available('pbcopy')) return 'pbcopy';
  if (env.WAYLAND_DISPLAY && available('wl-copy')) return 'wl-copy';
  if (available('xclip')) return 'xclip -selection clipboard';
  if (available('xsel')) return 'xsel --clipboard --input';
  if (available('clip.exe')) return 'clip.exe';
  return undefined;
}

/** A background process is the only source of headless; closing a terminal just kills the process. */
export const backgroundProcess = (env: NodeJS.ProcessEnv = process.env): boolean => env[BACKGROUND_ENV] === '1';

export type TakeoverDecision = 'direct' | 'blocked' | 'forced';
export function takeoverDecision(input: { holderAlive: boolean; force?: boolean }): TakeoverDecision {
  if (!input.holderAlive) return 'direct';
  return input.force ? 'forced' : 'blocked';
}

export function ownsMember(member: { holder: { pid: number } } | undefined, pid: number): boolean {
  return !!member && member.holder.pid === pid;
}

/** The same session id keeps the representative swap continuous; only the holder pid changes. */
export function takeoverCommand(request: LaunchRequest): string {
  return launchCommand({ ...request, ...(request.resume ?? !request.sessionId ? { resume: true } : {}) });
}

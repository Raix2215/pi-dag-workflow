#!/usr/bin/env node
/**
 * PTY smoke gate: starts a real Pi TUI inside an isolated tmux server and drives every panel with
 * a fixed key sequence, asserting the few things only a rendered frame can prove.
 *
 * Isolation: `tmux -L <socket>` (a private server, never the user's default), a temporary
 * `PI_CODING_AGENT_DIR`, and this checkout mounted as a package so the shipped extensions load.
 * No model call is made: the offline `dag-test` fixture answers if anything asks.
 *
 * Opt-in only: npm run smoke -- --require [--team]
 * SMOKE_FRAMES=<dir> writes paired plain/ANSI evidence; default checks do not start a TUI.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const socket = `dag-smoke-${process.pid}`;
const session = 'smoke';
const LABELS = ['Todos', 'Plan', 'Goal', 'Agents', 'Team', 'Retry', 'Display'];
const ORDER = LABELS.join(',');
const INPUT_GLYPH = String.fromCodePoint(0xf03eb);
const PLANE_15 = /[\u{f0000}-\u{ffffd}]/u;
const TAB_SEPARATOR = / {2}\/ {2}| \/ /;
const FLIGHT_WARNING = /另一个面板尚未关闭|Another panel is still open/;
const CRASH = /Unhandled|TypeError|SyntaxError|Cannot read|is not a function/;

const tmux = (...args) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 20_000 });
// `--require` is the release chain: a skipped run there would sign off panels nobody verified.
const requireRun = process.argv.includes('--require');
const menusOnly = process.argv.includes('--menus-only');
const teamOnly = process.argv.includes('--team') || menusOnly;
if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
  if (requireRun) {
    console.error('FAIL: --require needs tmux, and tmux is not installed, so the panels were never rendered');
    process.exit(1);
  }
  console.log('SKIP: tmux is not installed, so the PTY smoke gate did not run');
  process.exit(0);
}
const tmuxOk = (...args) => {
  const result = tmux(...args);
  if (result.status !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr?.trim() || result.status}`);
  return result.stdout.replace(/\n$/, '');
};
const trimmed = (line) => line.replace(/\s+$/, '');
const isRule = (line) => /^[─┄╌╭╮╰╯│\s]*$/.test(line) && line.trim() !== '';
/** The tab bar: one line carrying at least three module labels. */
const tabLine = (frame) => frame.split('\n').find((line) => (line.match(/\b(?:Todos|Plan|Goal|Agents|Team|Retry|Display)\b/g) ?? []).length >= 3);
/** Body rows dock, so they start with the cursor cell (`> ` or `  `) and then the row icon. */
const bodyRows = (frame) => frame.split('\n').map(trimmed).filter((line) => /^[> ] {0,6}\S/.test(line) && !isRule(line) && !TAB_SEPARATOR.test(line) && !/Tab (?:换模块|Module)/.test(line) && !/[←→]\/[←→]/.test(line) && !/^ {0,3}\[\d+\//.test(line) && !/^(?:Pi|Press|\[Extensions\]| {2}[a-z-]+, )/.test(line));
const headGlyph = (line) => { const stripped = line.replace(/^[>\s]+/, ''); return stripped ? String.fromCodePoint(stripped.codePointAt(0)) : ''; };

// A panel is identified by a row only its root frame shows; "a tab bar is on screen" is not enough.
const PANELS = [
  { command: '/todos', label: 'todos', marker: '任务树' },
  { command: '/plan', label: 'plan', marker: '只读限制', requiresInput: true },
  { command: '/goal', label: 'goal', marker: '新建目标' },
  { command: '/agents', label: 'agents', marker: '派发新 Job' },
  { command: '/team', label: 'team', marker: '新建团队' },
  { command: '/retry', label: 'retry', marker: '重试间隔', requiresInput: true },
  { command: '/dag-display', label: 'display', marker: '图标风格' },
];

const panels = teamOnly ? PANELS.filter(panel => panel.label === 'team') : PANELS;
const failures = [];
const same = (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
const record = (item, detail, label, frame) => {
  const text = frame ?? current.frame;
  const duplicate = failures.find((failure) => failure.item === item && failure.detail === detail && same(failure.frame, text));
  if (!duplicate) failures.push({ item, detail, label, frame: text });
};
const check = (item, condition, detail) => { if (!condition) record(item, detail, currentLabel); return condition; };

let root, work, agent, pane, snapCount = 0;
const current = { frame: '', label: 'startup' };
const capture = (escape = false) => (pane ? tmux('capture-pane', ...(escape ? ['-e'] : []), '-p', '-t', pane).stdout ?? '' : '');
const snap = async (label) => {
  if (process.env.SMOKE_FRAMES) {
    await mkdir(process.env.SMOKE_FRAMES, { recursive: true });
    await writeFile(join(process.env.SMOKE_FRAMES, `${String(snapCount++).padStart(3, '0')}-${label}.txt`), `${label}\n${capture()}\n`);
  }
};
/** Same pane, same moment, escape sequences kept: the ANSI evidence pairs with the plain frame. */
const snapAnsi = async (label) => {
  if (!process.env.SMOKE_FRAMES) return;
  await mkdir(process.env.SMOKE_FRAMES, { recursive: true });
  await writeFile(join(process.env.SMOKE_FRAMES, `${String(snapCount++).padStart(3, '0')}-${label}.ansi.txt`), `${label}\n${capture(true)}\n`);
};

const poll = async (predicate, timeout) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    current.frame = capture();
    if (predicate(current.frame)) return true;
    if (Date.now() > deadline) return false;
    await delay(120);
  }
};
const sendText = (text) => tmuxOk('send-keys', '-t', pane, '-l', text);
const send = (text) => { sendText(text); tmuxOk('send-keys', '-t', pane, 'Enter'); };
const key = (name) => tmuxOk('send-keys', '-t', pane, name);
const clearLine = async () => { key('C-u'); await delay(120); };

let currentLabel = 'startup';
const openPanel = async (panel) => {
  currentLabel = panel.label;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clearLine();
    send(panel.command);
    const opened = await poll((frame) => Boolean(tabLine(frame)) && frame.includes(panel.marker), 8_000);
    if (opened) { await snap(`open-${panel.label}`); return true; }
    await snap(`open-failed-${panel.label}`);
    await closePanel();
  }
  return false;
};
/** Esc first leaves an inline search or a subpage; a later Esc closes the panel itself. */
const closePanel = async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!tabLine(capture())) return true;
    key('Escape');
    if (await poll((frame) => !tabLine(frame), 1_500)) return true;
  }
  return !tabLine(capture());
};

const cleanupNotes = [];
const cleanup = async () => {
  tmux('kill-server');
  cleanupNotes.push(`tmux server on socket ${socket}: ${tmux('has-session', '-t', session).status === 0 ? 'STILL RUNNING' : 'gone'}`);
  if (tmux('has-session', '-t', session).status === 0) record('cleanup', `tmux -L ${socket} still has a session`, 'cleanup', '');
  if (root) { await rm(root, { recursive: true, force: true }); cleanupNotes.push(`temp dir removed: ${root}`); }
};

try {
  if (tmux('has-session', '-t', session).status === 0) throw new Error(`tmux socket ${socket} already has a session; refusing to touch it`);
  root = await mkdtemp(join(tmpdir(), 'dag-smoke-'));
  work = join(root, 'work');
  agent = join(root, 'agent');
  await mkdir(work, { recursive: true });
  await mkdir(agent, { recursive: true });
  // The plugin is mounted the way an installed package is: through the agent directory, not `-e`.
  await writeFile(join(agent, 'settings.json'), `${JSON.stringify({ packages: [{ source: project }] }, null, 1)}\n`);
  process.env.PI_CODING_AGENT_DIR = agent;
  const registry = await import('../src/team/io/registry.ts');
  const { piLaunchTarget } = await import('../src/shared/pi-cli.ts');
  // A team must exist before `--team` can join one; the panel is pointless without a member row.
  const team = await registry.createTeam({ name: 'Alpha', workspaceRoot: work });
  const { execPath, cli: bundledCli } = piLaunchTarget();
  const cli = process.env.PI_DAG_TEST_CLI?.trim() || bundledCli;
  const args = [cli, '--offline', '--provider', 'dag-test', '--model', 'scripted', '--no-approve', '--no-context-files', '--no-prompt-templates', '--no-themes', '--team', 'Alpha', '--name', 'Probe', '-e', join(project, 'test/fixtures/offline-model.ts'), '--dag-test-context-export'];
  const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const env = { HOME: root, PATH: process.env.PATH ?? '', TERM: 'xterm-256color', LANG: 'zh-CN', LANGUAGE: 'zh-CN', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent };
  const launch = `cd ${quoted(work)} && env -i ${Object.entries(env).map(([name, value]) => `${name}=${quoted(value)}`).join(' ')} ${quoted(execPath)} ${args.map(quoted).join(' ')}`;

  tmuxOk('new-session', '-d', '-s', session, '-x', '140', '-y', '42', '-n', 'panels');
  await delay(300);
  pane = tmuxOk('display-message', '-p', '-t', `${session}:0.0`, '#{pane_id}');
  sendText(launch);
  tmuxOk('send-keys', '-t', pane, 'Enter');

  // Ready means the extensions are loaded, not merely that the banner appeared: early keystrokes
  // become a user prompt instead of a command and then no panel ever opens.
  const loaded = await poll((frame) => /escape interrupt/.test(frame) && ['agents', 'goal', 'plan', 'retry', 'team', 'todos'].every((name) => new RegExp(`\\b${name}\\b`).test(frame.slice(frame.indexOf('[Extensions]')))), 30_000);
  check('startup', loaded, 'Pi did not load all six workflow extensions');
  if (!loaded) throw new Error(`Pi did not start:\n${current.frame}`);
  await delay(1_000);
  await snap('startup');
  const members = await registry.readMembers(team.id);
  check('team-join', members.length > 0, `no member record after --team Alpha (records: ${members.length})`);

  const openOrder = [];
  for (const panel of panels) {
    if (!check(`${panel.label}:opens`, await openPanel(panel), `${panel.command} did not render ${panel.marker} with a tab bar`)) continue;
    openOrder.push(panel.label);
    const frame = capture();
    check(`${panel.label}:frame`, frame.trim().split('\n').filter((line) => line.trim()).length >= 5, 'the frame is empty');
    check(`${panel.label}:no-flight-warning`, !FLIGHT_WARNING.test(frame), 'the registry refused to open: another panel still holds the flight');
    const order = (tabLine(frame)?.match(/\b(?:Todos|Plan|Goal|Agents|Team|Retry|Display)\b/g) ?? []).join(',');
    check(`${panel.label}:tab-order`, order === ORDER, `tab order is ${order || '(none)'}, expected ${ORDER}`);
    const rows = bodyRows(frame);
    check(`${panel.label}:row-icons`, rows.some((line) => PLANE_15.test(headGlyph(line))), `no row starts with a Plane-15 icon (${rows.length} rows)`);
    // The tail marker must never steal the leading icon: that was the "pencil disappears" bug.
    for (const line of rows.filter((row) => row.includes(INPUT_GLYPH))) check(`${panel.label}:input-icon`, PLANE_15.test(headGlyph(line)), `an editable row lost its leading icon: ${line}`);
    if (panel.requiresInput) check(`${panel.label}:input-row`, rows.some((line) => line.includes(INPUT_GLYPH)), 'expected at least one editable row carrying the pencil marker');
    if (panel.label === 'team') await teamPanel(members);
    // Every panel is drivable: navigation and search must neither throw nor close it.
    for (const name of ['j', 'k', 'h', 'l', 'g', 'G']) { key(name); await delay(70); }
    sendText('/'); await delay(250);
    check(`${panel.label}:search`, capture().includes('匹配'), 'the search field did not open');
    key('Escape'); await delay(250);
    check(`${panel.label}:keys`, Boolean(tabLine(capture())) && !CRASH.test(capture()), 'navigation keys closed the panel or threw');
    await snap(`driven-${panel.label}`);
    if (!check(`${panel.label}:closes`, await closePanel(), 'Esc did not close the panel (tab bar still drawn)')) await snap(`open-after-close-${panel.label}`);
  }
  check('panel-order', openOrder.join(',') === panels.map((panel) => panel.label).join(','), `opened ${openOrder.join(',')}`);
  if (!menusOnly) {
  // The member history replaces the panel with native tree selection and a read-only body screen.
  // A prompt first, so the session is really on disk and its SID resolves to a file.
  currentLabel = 'history';
  send('HISTORY-FIXTURE-MARKER'); await delay(3000);
  // The saved file must carry real content: a branch sibling and a long body, not the short offline reply.
  const sessionsRoot = join(agent, 'sessions');
  const sessionFile = (() => {
    for (const space of readdirSync(sessionsRoot)) {
      const files = readdirSync(join(sessionsRoot, space));
      const hit = files.find((file) => file.endsWith(`_${members[0]?.sessionId}.jsonl`));
      if (hit) return join(sessionsRoot, space, hit);
    }
    return undefined;
  })();
  if (check('history:file', Boolean(sessionFile), 'the member session file is not on disk after a prompt')) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(sessionFile);
    const entries = manager.getEntries();
    const requests = entries.filter(entry => entry.type === 'custom' && entry.customType === 'dag-test.context-export');
    check('team:join-no-auto-turn', requests.length === 1, `joining must not start a model request before the one explicit fixture prompt (found ${requests.length})`);
    const identity = requests.flatMap(entry => (entry.data?.context?.messages ?? []).map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')));
    check('team:provider-identity', identity.some(text => text.includes('Team membership') && text.includes('"team":"Alpha"') && text.includes(`"member":${JSON.stringify(members[0]?.name)}`) && text.includes(members[0]?.sessionId)), 'the launched session’s actual provider input lacks its own team/member identity');
    const first = entries[0];
    if (first) {
      manager.branch(first.id);
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'HISTORY-SIBLING-A' }] });
      // Branch from the same root again: the second answer is a sibling, not a child of the first.
      manager.branch(first.id);
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `HISTORY-SIBLING-B ${'X'.repeat(1500)}` }] });
    }
  }
  if (check('history:panel', await openPanel({ command: '/team', label: 'history-team', marker: '新建团队' }), 'the team panel did not reopen for the history step')) {
    const selected = () => capture().split('\n').map(trimmed).find((line) => line.startsWith('> ') || /^[\s│]*> /.test(line));
    const dockOn = async (needle) => { for (const direction of ['j', 'k']) for (let step = 0; step < 40; step += 1) { if (selected()?.includes(needle)) return true; key(direction); await delay(90); } return false; };
    const memberName = members[0]?.name;
    if (check('history:member', await dockOn(memberName), 'the cursor never reached the member row')) {
      key('l'); await delay(400);
      let onRow = false;
      for (let step = 0; step < 20 && !onRow; step += 1) { onRow = Boolean(selected()?.includes('会话历史')); if (!onRow) { key('j'); await delay(140); } }
      if (check('history:row', onRow, 'the cursor never reached the history row')) {
        /** The row the native tree has selected: it carries the cursor marker. */
        const selectedLine = (frame) => frame.split('\n').map(trimmed).find((line) => line.includes('›')) ?? '';
        // One capture per step: the ANSI text is the source, the plain frame is derived from it, and the
        // assertions use that same text — no second look at the pane.
        const shot = async (label) => {
          const ansi = capture(true);
          const plain = ansi.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
          if (process.env.SMOKE_FRAMES) {
            await mkdir(process.env.SMOKE_FRAMES, { recursive: true });
            await writeFile(join(process.env.SMOKE_FRAMES, `${String(snapCount++).padStart(3, '0')}-${label}.txt`), `${label}\n${plain}\n`);
            await writeFile(join(process.env.SMOKE_FRAMES, `${String(snapCount++).padStart(3, '0')}-${label}.ansi.txt`), `${label}\n${ansi}\n`);
          }
          return plain;
        };
        key('Enter'); await delay(2500);
        const opened = await shot('team-history-open');
        check('history:open', /Session Tree/.test(opened), 'the native history screen did not open');
        check('history:tree', /Type to search:/.test(opened), 'native tree chrome did not render');
        if (/Session Tree/.test(opened)) {
          // A plain letter reaches the native search; no plugin reload key intercepts it.
          sendText('R'); await delay(500);
          const searched = await shot('team-history-search');
          check('history:search-letter', /Type to search:\s*R/.test(searched), 'typing R did not reach the native search box');
          key('Escape'); await delay(600);   // Esc clears the native search first, then the screen closes
          const cleared = await shot('team-history-search-cleared');
          check('history:search-cleared', /Session Tree/.test(cleared) && !/Type to search: R/.test(cleared), 'Esc did not clear the search');
          key('Enter'); await delay(900);
          const leafBody = await shot('team-history-body');
          check('history:body', /Session Tree/.test(leafBody) && /Esc/.test(leafBody) && !/Type to search:/.test(leafBody), 'Enter lost the history heading or return controls instead of opening a readable body');
          check('history:body-leaf', /HISTORY-SIBLING-B/.test(leafBody), 'the leaf body is not the expected sibling');
          key('Escape'); await delay(600);
          // Walk with the arrow key until the sibling's own row is the one on screen; the tree also lists the
          // session-info and label records, so a fixed number of presses would be a guess.
          let onSibling = false;
          for (let step = 0; step < 8 && !onSibling; step += 1) {
            key('Up'); await delay(320);
            onSibling = selectedLine(await shot(`team-history-walk-${step}`)).includes('HISTORY-SIBLING-A');
          }
          check('history:cursor-on-sibling', onSibling, 'the cursor never reached the sibling row');
          key('Enter'); await delay(900);
          const siblingBody = await shot('team-history-sibling');
          check('history:body-sibling', /HISTORY-SIBLING-A/.test(siblingBody), 'ArrowUp did not open the other sibling');
          check('history:sibling-not-leaf', !/HISTORY-SIBLING-B/.test(siblingBody), 'the sibling view still shows the leaf body');
          key('Escape'); await delay(600);
          let backOnLeaf = false;
          for (let step = 0; step < 8 && !backOnLeaf; step += 1) {
            key('Down'); await delay(320);
            backOnLeaf = selectedLine(await shot(`team-history-walk-back-${step}`)).includes('HISTORY-SIBLING-B');
          }
          check('history:cursor-on-leaf', backOnLeaf, 'the cursor never returned to the leaf row');
          key('Enter'); await delay(900);
          const backLeaf = await shot('team-history-leaf-again');
          check('history:body-leaf-again', /HISTORY-SIBLING-B/.test(backLeaf), 'ArrowDown did not return to the leaf sibling');
          key('Escape'); await delay(600);
          const backTree = await shot('team-history-back-tree');
          check('history:back-tree', /Session Tree/.test(backTree), 'Esc from a body did not return to the tree');
          // Still verified before the cleanup closes the panel.
          key('Escape'); await delay(1400);
          const backPanel = await shot('team-history-back-panel');
          check('history:back-panel', !/Session Tree/.test(backPanel) && /会话历史/.test(backPanel) && Boolean(tabLine(backPanel)), 'Esc did not leave the panel on the member rows');
          // "Usable" means the parent really changed, not that a tab bar exists: the selected row must differ.
          const rowOf = (frame) => (frame.split('\n').map(trimmed).find((line) => line.startsWith('> ') || /^[\s│]*> /.test(line)) ?? '');
          const beforeRow = rowOf(backPanel);
          key('j'); await delay(500);
          const usable = await shot('team-history-usable');
          check('history:usable', Boolean(tabLine(usable)) && !/Session Tree/.test(usable) && rowOf(usable) !== '' && rowOf(usable) !== beforeRow, 'the parent panel did not move to another row after returning');
        }
      }
    }
    await closePanel();
  }

  }
  // The flight must be released: a different command still opens a panel after the previous one closed.
  currentLabel = 'reopen';
  const reopened = await openPanel(teamOnly ? { command: '/team', label: 'reopen', marker: '新建团队' } : { command: '/dag-display', label: 'reopen', marker: '图标风格' });
  check('flight-released', reopened, 'a second command cannot open a panel after the first was closed');
  check('flight-released:no-warning', !FLIGHT_WARNING.test(capture()), 'the re-open was refused with the occupied-flight warning');
  check('reopen:closes', await closePanel(), 'Esc did not close the re-opened panel');

  const summary = `${JSON.stringify({ socket, session, cli, menusOnly, historyChecked: !menusOnly, teamId: team.id, members: members.map((member) => member.name), openOrder, failures }, null, 1)}\n`;
  if (process.env.SMOKE_FRAMES) await writeFile(join(process.env.SMOKE_FRAMES, 'summary.json'), summary);
} catch (error) {
  record('crash', String(error?.stack ?? error), currentLabel, current.frame);
} finally {
  await cleanup();
}

/** /team extras: dock on the member row, expand it, then expand the launch entity in place. */
async function teamPanel(teamMembers) {
  const name = teamMembers[0]?.name;
  if (!check('team:member-row', Boolean(name) && capture().includes(name), `the upper zone never shows the member row (${name ?? 'no member'})`)) return;
  // A child row carries the cursor after the tree lead ('  │  > …'), so a line-start test is not enough.
  const selectedRow = () => capture().split('\n').map(trimmed).find((line) => line.startsWith('> ') || /^[\s│]*> /.test(line));
  const dock = async (needle) => {
    for (const direction of ['j', 'k']) {
      for (let step = 0; step < 40; step += 1) {
        if (selectedRow()?.includes(needle)) return true;
        key(direction);
        await delay(90);
      }
    }
    return false;
  };
  if (!check('team:member-dock', await dock(name), `the cursor never reaches the member row ${name}`)) return;
  // Reachability means the cursor stood on the row, not that the text showed up in some frame, and it is
  // found by walking the real selection: a fixed press budget rots every time a row is added above the target.
  const reveal = async (patterns) => {
    const seen = new Set();
    const stand = () => {
      const row = selectedRow() ?? '';
      for (const pattern of patterns) if (pattern.test(row)) seen.add(pattern.source);
    };
    stand();
    for (const direction of ['j', 'k']) {
      for (let step = 0; step < 60 && seen.size < patterns.length; step += 1) {
        key(direction);
        await delay(110);
        stand();
      }
    }
    return seen.size === patterns.length;
  };
  key('l'); await delay(350);
  check('team:member-expanded', /󰅀.*(?:Probe|Alpha)/.test(capture()) && /│/.test(capture()), 'expanding the member row drew no child rows');
  await snap('team-member-expanded');
  if (!check('team:management-group', await dock('成员管理'), 'the member management group is missing')) return;
  key('l'); await delay(200);
  check('team:member-actions', await reveal([/重命名成员/]), 'member management actions are not reachable');
  key('h'); key('h'); await delay(250);
  if (!check('team:target-team', await dock('Alpha .'), 'the target team entity is missing')) return;
  key('l'); await delay(200);
  if (check('team:leave-row', await dock('退出团队'), 'the team entity has no leave action')) {
    key('Enter'); await delay(250);
    const confirmation = capture();
    check('team:leave-confirmation', /退出团队 Alpha/.test(confirmation) && /会话、信箱和其他成员保留/.test(confirmation) && /再次 Enter 退出/.test(confirmation), 'leave confirmation must name the team, effect and action');
    check('team:no-false-delete', !/确认删除|此操作不可撤销/.test(confirmation), 'leaving is not a deletion');
    await snap('team-leave-confirmation'); await snapAnsi('team-leave-confirmation');
    key('Escape'); await delay(200);
  }
  if (!check('team:launch-row', await dock('新建会话'), 'the team entity has no new-session entry')) return;
  key('l'); await delay(350);
  check('team:launch-expanded', /󰅀 *󰐕? *新建会话/.test(capture()) && /│/.test(capture()), 'expanding 新建会话 drew no child rows');
  if (!check('team:launch-modes', await dock('启动方式'), 'the expandable start modes row is missing')) return;
  key('l'); await delay(350);
  await snap('team-launch-expanded'); await snapAnsi('team-launch-expanded');
  const expandedLines = capture().split('\n');
  const first = expandedLines.findIndex(line => /Todos.*Plan.*Goal/.test(line));
  const last = expandedLines.findLastIndex(line => /Tab.*Esc/.test(line));
  check('team:adaptive-height', first >= 0 && last - first + 1 > 17 && last - first + 1 <= 36, 'a tall expanded panel must use available height rather than the old 17-row cap');
  // Ticket 09 replaced the launch subscreen with rows in place: they must be walkable here.
  check('team:launch-actions', await reveal([/后台启动/, /复制启动命令/]), 'the launch actions are not reachable inside the expanded entity');
  await snap('team-launch-walked');
}

for (const failure of failures) {
  console.error(`\nFAIL [${failure.item}] ${failure.detail}`);
  if (failure.frame) console.error(`--- frame at ${failure.label} ---\n${failure.frame}\n--- end frame ---`);
}
for (const note of cleanupNotes) console.error(`cleanup: ${note}`);
if (failures.length) { console.error(`\nSMOKE FAILED: ${failures.length} item(s)`); process.exitCode = 1; } else console.log(`PASS: ${panels.length} panel(s), ${menusOnly ? 'menu navigation, confirmation and adaptive height' : 'native history body/return and input navigation'} verified (socket ${socket}); no residue.`);
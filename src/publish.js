// Publish live data captured from THIS machine to the hosted phone dashboard.
//
// The problem this solves: Frontier serves GoWild availability fine to a normal
// residential connection, but blocks GitHub's datacenter IPs - so a sync run by
// the Pages workflow can never see live GoWild seats. Running the sync here, on
// your own connection, does see them. This command captures that result into
// site/live-snapshot.json and pushes it, so the phone dashboard shows real
// GoWild fares and seat counts without any bookmarklet.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readSnapshot, saveJSON, loadJSON } from './util.js';
import { syncAll } from './sync.js';

const REL = 'site/live-snapshot.json';

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).toString().trim()}`);
  }
}

export function readPublished() {
  const abs = path.join(ROOT, REL);
  if (!existsSync(abs)) return null;
  try {
    return loadJSON(REL);
  } catch {
    return null;
  }
}

export async function publish({ date, push = true, sections } = {}) {
  const results = await syncAll({ sections, date });
  const snap = readSnapshot();

  // Merge over the last publish rather than replacing it. A run where Frontier
  // blocked produces an all-seed snapshot; writing that would wipe good seats
  // off the phone dashboard - and with `publish --install` running unattended
  // every 30 minutes, the first blocked run after a good one would do it
  // silently. Live always wins; non-live never overwrites live.
  const previous = readPublished();
  const merged = { ...(previous?.sections ?? {}) };
  for (const [name, sec] of Object.entries(snap.sections ?? {})) {
    const wouldDowngrade = merged[name]?.status === 'live' && sec?.status !== 'live';
    if (!wouldDowngrade) merged[name] = sec;
  }

  const live = Object.entries(merged)
    .filter(([, s]) => s?.status === 'live')
    .map(([name]) => name);
  const captured = Object.entries(snap.sections ?? {})
    .filter(([, s]) => s?.status === 'live')
    .map(([name]) => name);

  // Only publishedAt would differ - don't churn a commit (and a Pages deploy)
  // for a run that learned nothing.
  if (previous && JSON.stringify(previous.sections ?? {}) === JSON.stringify(merged)) {
    return { results, live, captured, pushed: false, reason: 'nothing new came back live', path: REL };
  }

  saveJSON(REL, {
    publishedAt: new Date().toISOString(),
    publishedFrom: 'local machine (residential IP)',
    sections: merged,
  });

  if (!push) return { results, live, captured, pushed: false, path: REL };

  const changed = git(['status', '--porcelain', REL]);
  if (!changed) return { results, live, captured, pushed: false, reason: 'no change since last publish', path: REL };

  git(['add', REL]);
  git(['commit', '-m', `live snapshot: ${live.length ? live.join(', ') : 'seed'}`]);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  git(['push', 'origin', branch]);
  return { results, live, captured, pushed: true, branch, path: REL };
}

// Keep publishing on an interval, so the phone dashboard stays fresh without
// anyone typing a command. Network hiccups are logged, never fatal - this is
// meant to survive a laptop lid closing and a Wi-Fi network changing.
export async function watch({ everyMinutes = 30, date, sections, once = false } = {}) {
  const ms = Math.max(5, Number(everyMinutes) || 30) * 60000;
  for (;;) {
    const started = new Date().toISOString();
    try {
      const r = await publish({ date, sections });
      console.log(`[${started}] captured ${r.captured.length ? r.captured.join(', ') : 'nothing live'}`
        + (r.pushed ? ` -> pushed to ${r.branch} (published: ${r.live.join(', ') || 'seed'})` : ` (${r.reason ?? 'not pushed'})`));
    } catch (err) {
      console.error(`[${started}] publish failed: ${err.message}`);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ---- run it in the background, forever, without a terminal window open ----

const LABEL = 'com.gowild.trip-agent.publish';

export function unitFile(platform = process.platform) {
  const node = process.execPath;
  const script = path.join(ROOT, 'src', 'cli.js');
  if (platform === 'darwin') {
    return {
      kind: 'launchd',
      path: path.join(process.env.HOME ?? '~', 'Library', 'LaunchAgents', `${LABEL}.plist`),
      load: `launchctl load -w ~/Library/LaunchAgents/${LABEL}.plist`,
      unload: `launchctl unload -w ~/Library/LaunchAgents/${LABEL}.plist`,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${script}</string><string>publish</string><string>--watch</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(ROOT, 'cache', 'publish.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, 'cache', 'publish.log')}</string>
</dict></plist>
`,
    };
  }
  if (platform === 'linux') {
    return {
      kind: 'systemd',
      path: path.join(process.env.HOME ?? '~', '.config', 'systemd', 'user', 'gowild-publish.service'),
      load: 'systemctl --user daemon-reload && systemctl --user enable --now gowild-publish',
      unload: 'systemctl --user disable --now gowild-publish',
      body: `[Unit]
Description=GoWild trip agent - publish live Frontier data from this connection
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${node} ${script} publish --watch
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
`,
    };
  }
  return { kind: 'unsupported', platform };
}

// Writes the service file and prints the one command that activates it. It
// deliberately does not run launchctl/systemctl itself: registering a
// background job on someone's machine is theirs to confirm.
export function installAgent({ platform = process.platform } = {}) {
  const unit = unitFile(platform);
  if (unit.kind === 'unsupported') {
    return {
      ok: false,
      message: `No installer for ${platform}. On Windows, use Task Scheduler: create a task that runs\n`
        + `  "${process.execPath}" "${path.join(ROOT, 'src', 'cli.js')}" publish --watch\n`
        + `  starting at logon, in ${ROOT}.`,
    };
  }
  mkdirSync(path.dirname(unit.path), { recursive: true });
  writeFileSync(unit.path, unit.body);
  return { ok: true, kind: unit.kind, path: unit.path, load: unit.load, unload: unit.unload };
}

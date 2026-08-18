// Publish live data captured from THIS machine to the hosted phone dashboard.
//
// The problem this solves: Frontier serves GoWild availability fine to a normal
// residential connection, but blocks GitHub's datacenter IPs - so a sync run by
// the Pages workflow can never see live GoWild seats. Running the sync here, on
// your own connection, does see them. This command captures that result into
// site/live-snapshot.json and pushes it, so the phone dashboard shows real
// GoWild fares and seat counts without any bookmarklet.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  const payload = {
    publishedAt: new Date().toISOString(),
    publishedFrom: 'local machine (residential IP)',
    sections: snap.sections ?? {},
  };
  saveJSON(REL, payload);

  const live = Object.entries(payload.sections)
    .filter(([, s]) => s?.status === 'live')
    .map(([name]) => name);

  if (!push) return { results, live, pushed: false, path: REL };

  const changed = git(['status', '--porcelain', REL]);
  if (!changed) return { results, live, pushed: false, reason: 'no change since last publish', path: REL };

  git(['add', REL]);
  git(['commit', '-m', `live snapshot: ${live.length ? live.join(', ') : 'seed'} (${payload.publishedAt})`]);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  git(['push', 'origin', branch]);
  return { results, live, pushed: true, branch, path: REL };
}

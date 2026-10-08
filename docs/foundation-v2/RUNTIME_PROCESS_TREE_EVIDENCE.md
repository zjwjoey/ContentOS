# Runtime process-tree focused evidence

2026-10-08. Compared baseline `27d43854f0571d127bb1ed4ac01334ff294409b2` and feature `7d0c35dd91114aec96259b10b54f8136e0ed0ae1` in the same cloud container. Baseline was materialized with git archive in `/tmp/fv2-runtime-baseline`; shared installed dependencies via a node_modules symlink, leaving feature checkout unchanged. SHA256 hashes of process-manager.ts, port.ts and process-manager.test.ts match between both trees; git diff for runtime-core and the test is empty.

## Results and diagnosis

Exact test: `ProcessManager force termination handles a child process tree`, final assertion `tests/unit/process-manager.test.ts:35` checks isProcessAlive(grandchildPid) is false.

| Source / runner | Tests | Result |
| --- | --- | --- |
| Current, normal cloud process ancestry | 1 | FAIL: true !== false, about 681 ms |
| Baseline, normal cloud process ancestry | 1 | FAIL: true !== false, about 675 ms |
| Baseline, temporary Linux subreaper | 1 | PASS, about 195 ms |
| Current, temporary Linux subreaper | 1 | PASS, about 166 ms |
| Current full process-manager.test.ts, subreaper, no observer | 3 | PASS 3/3 |

Normal current run: parent PID 2036 absent; grandchild PID 2043 is state Z, PPID 1, process group 2036, observed kernel exit code 9. Baseline: parent PID 2105 absent; grandchild PID 2112 state Z, PPID 1, process group 2105, observed kernel exit code 9. `/proc/1/comm` is `tail`. The grandchild was terminated, not running, but the container's PID 1 did not reap it. kill(pid,0), used by isProcessAlive, returns success for the zombie; the existing 20 × 25 ms wait cannot make a non-reaping PID1 reap it.

Subreaper comparison changes only process ancestry/reaping outside the repository. Observed orphan wait status 9 (SIGKILL); Z transitions to absent after waitpid. Original SIGKILL behavior, test timing and assertions are unchanged. This isolates this failure to container zombie reaping plus the test's PID-existence criterion. It does not establish a running-descendant product failure or a Phase0 regression. Do not extend waits, skip the assertion, alter runtime liveness semantics or add a CI exception on this evidence. Ordinary runner CI remains required; subreaper PASS does not replace six-job remote acceptance.

## Reproduction

Create a baseline archive and reuse the exact frozen-installed dependency tree:

```bash
mkdir -p /tmp/fv2-runtime-baseline
git archive 27d43854f0571d127bb1ed4ac01334ff294409b2 | tar -x -C /tmp/fv2-runtime-baseline
ln -s /workspace/ContentOS/node_modules /tmp/fv2-runtime-baseline/node_modules
```

Save the following diagnostic as `/tmp/fv2-reaper.py`. It adopts and reaps orphan descendants; it does not change test source or results.

```python
import ctypes
import os
import subprocess
import sys
import time

# Linux PR_SET_CHILD_SUBREAPER: reap orphan descendants without changing tests.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
child = subprocess.Popen(sys.argv[1:])
result = None
while result is None:
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            break
        if pid == child.pid:
            result = os.waitstatus_to_exitcode(status)
            child.returncode = result
        else:
            print(f'SUBREAPER reaped orphan pid={pid} wait_status={status}', flush=True)
    if result is None:
        time.sleep(0.01)
sys.exit(result)
```

From each tree run the original test normally, then through the reaper:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='ProcessManager force termination handles a child process tree' tests/unit/process-manager.test.ts
python /tmp/fv2-reaper.py ./node_modules/.bin/tsx --test --test-name-pattern='ProcessManager force termination handles a child process tree' tests/unit/process-manager.test.ts
```

The separate module verification used:

```bash
python /tmp/fv2-reaper.py ./node_modules/.bin/tsx --test tests/unit/process-manager.test.ts
```

For the focused four-way comparison, the following optional observer was loaded through NODE_OPTIONS=--require=/tmp/fv2-proc-observer.cjs. It delegates kill unchanged and reads proc state after signal-0 probes; only PID/state transitions are emitted, never environment values or command lines. The three-test module run omitted the observer.

```javascript
const fs = require('node:fs');
const kill = process.kill;
const seen = new Map();
process.kill = function(pid, signal) {
  try { return kill.call(process, pid, signal); }
  finally {
    if (signal === 0 && pid > 0) {
      let snapshot;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        snapshot = {pid, state:fields[0], ppid:Number(fields[1]), processGroup:Number(fields[2]), kernelExitCode:Number(fields[49])};
      } catch { snapshot = {pid, state:'absent'}; }
      const key = JSON.stringify(snapshot);
      if (seen.get(pid) !== key) { seen.set(pid, key); process.stderr.write(`PROC_OBSERVER ${key}\n`); }
    }
  }
};
```

Raw logs remain in `/tmp/fv2-runtime-evidence/{current,baseline,baseline-reaped,current-reaped,current-module-reaped}.log` in this session. The committed results and diagnostic code above preserve reproducibility after temporary logs expire.

## GitHub API refusal metadata

No PR/issue/Actions refusal was retried in this investigation. Previously captured CLI errors were `Post "https://api.github.com/graphql": Forbidden` (PR and Issue) and `Get "https://api.github.com/repos/zjwjoey/ContentOS/actions/runs?...": Forbidden` (exact-head CI). Exit status was 1. The captured error exposes no HTTP response status, response body, scope headers or GitHub request ID; Forbidden alone is insufficient to claim a confirmed GitHub-origin HTTP 403 or a specific missing permission.

One diagnostic `gh auth status` reports an active github.com account using GH_TOKEN, login failure and “The token in GH_TOKEN is invalid.” It does not expose scopes. gh is 2.46.0. Presence-only inspection confirms GH_TOKEN, HTTP_PROXY and HTTPS_PROXY are set; GITHUB_TOKEN, GH_HOST and ALL_PROXY are unset. No values, tokens, proxy addresses or credentials were printed. Because transport/proxy refusal can also prevent validation, the CLI diagnosis does not independently prove a revoked/invalid token.

Confirmed capability: Git reads and branch pushes work. Confirmed blocked operations: this cloud gh route cannot create PR/Issue or read Actions metadata. Exact token scope/installation grants and whether the refusal originates at egress/proxy or GitHub remain unknown; restore authorized API access without swapping credentials or connector routes. User authorization is present; execution capability is the blocker.

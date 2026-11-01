# Kiro provider and fork maintenance

`mushikingh/oh-my-pi` is a fork of `can1357/oh-my-pi` that adds a Kiro provider. This file is the fork's own guide and upstream does not have it. Keep it current: when you learn something about Kiro's wire or the merge process, add it here. The root `AGENTS.md` still applies; user-facing behaviour is documented in `docs/kiro.md`.

## Branches

- `main` is a pure mirror of upstream. Never commit to it, because that breaks the fast-forward sync.
- `feat/kiro-provider` is `main` plus Kiro, and is what the `omp` shortcut runs from `~/git-mushi/oh-my-pi`.
- Bring upstream in by merging. Do not rebase or force-push this branch.

## Keeping up with upstream

`scripts/fork-sync.sh` does the whole job, every 6 hours through `oh-my-pi-fork-sync.timer`:

1. Syncs the fork's `main` from upstream.
2. Merges `main` into a separate worktree, `~/git-mushi/oh-my-pi-sync`, so a running `omp` is not disturbed.
3. Regenerates the compat files, then runs the typecheck and Kiro tests.
4. Pushes only if all of that passed, then updates the main checkout if it is clean and no `omp` is running.

Check on it with `systemctl --user list-timers oh-my-pi-fork-sync.timer` and `journalctl --user -u oh-my-pi-fork-sync.service -n 50`. A failed run pushes nothing and leaves the fork as it was.

### When the sync stops on a conflict

The log names the files. Resolve it in the sync worktree, keeping upstream's newer code and adding Kiro back on top:

```sh
cd ~/git-mushi/oh-my-pi-sync
git fetch origin
git checkout --detach origin/feat/kiro-provider
git merge origin/main   # resolve the files, but leave the generated ones below
bun run gen:compat
git add -A && git commit --no-edit
git push origin HEAD:feat/kiro-provider
```

`rerere` is on for this repository, so git reapplies a resolution it has already seen.

Never merge these by hand, because they are generated. Take upstream's copy and run `bun run gen:compat`:

- `packages/catalog/src/compat/rules.json`, which upstream changes about 9 times a day
- `packages/catalog/src/compat/auth-ids.ts`
- `packages/catalog/src/compat/provider-ids.ts`

### Keeping conflicts rare

- Put new behaviour in files under `packages/ai/src/providers/kiro/`, which upstream does not touch.
- Keep edits to upstream files as small as possible, ideally one line. `git diff origin/main...HEAD -- . ':!*kiro*'` lists them.
- Do not edit `CHANGELOG.md` files. They change constantly, and this fork is not released.
- `"kiro"` has its own line in `rules/auth/_order.kdl` so that edits to neighbouring providers do not collide with it.

### Native addon

Upstream's Rust addon is not built here, because that needs a pinned nightly toolchain outside mise. The sync script installs the official prebuilt `@oh-my-pi/pi-natives-linux-x64` matching `packages/natives/package.json`, cached in `~/.cache/oh-my-pi-natives`. It is gitignored. If upstream adds a native function before publishing it, calling that function reports a missing native export until the next release.

## Where the code came from

- `packages/ai/src/providers/kiro/`, the login and the catalog discovery came from upstream PR can1357/oh-my-pi#14215 by @ajdiyassin. If that PR lands, drop this fork's copy and keep only what upstream lacks.
- Wire behaviour was ported from `lidge-jun/opencodex`, in `src/adapters/kiro*` and `structure/providers/kiro.md`. It is a good reference, but check its numbers live: several were out of date.
- Not ported: multiple accounts with failover, Google and GitHub login, `kiro-cli` import, credits in `omp usage`, the Builder ID service profile ARN, and shrinking oversized images.
- Left out on purpose: opencodex's private completion and structured-output tools and its emulated thinking. They exist for the Responses format, and omp reads reasoning support from Kiro's live schemas.

## What was measured on the live wire

Measured 2026-11-01. Re-measure before relying on these.

| Behaviour | Result |
|---|---|
| Tool name outside `^[a-zA-Z0-9_-]{1,64}$` | Rejected with `Invalid tool use format`, so names are aliased |
| Tool catalog | 500 tools and 600 KB pass on Claude and GPT, 1,389 small tools pass on Haiku 5.5, and 1.2 MB is rejected |
| Tool description | 40 KB passes on Claude and GPT, so descriptions are not cut |
| Tool result | 500 KB passes whole |
| `pattern`, `format`, `additionalProperties` and similar in schemas | Accepted, but still stripped because opencodex saw them rejected and a rejection fails the whole turn |
| `reasoning.mode` | Accepted, but not needed, because `standard` is the default |
| GPT-5.6 reasoning | Luna and Sol returned `redactedContent` here, though opencodex recorded `signature` |
| Claude reasoning | Comes back on `signature`, and replay is accepted |
| Empty content beside tool results | Accepted on Sonnet, Haiku, Luna and Sol |

## Mistakes worth not repeating

- **A silent reply is a valid advisor review.** Claude returns reasoning with no text, and GPT returns nothing or only encrypted reasoning. Both must complete when `acceptEmptyResponse` is set, and `session-advisors.ts` must keep `kiro-api` in its list. Both bugs passed unit tests and only showed up in live advisor runs.
- **Text added to a user turn is read as the user speaking.** A filler sentence beside tool results made a model tell the user that no attachment had arrived. Send nothing unless the wire demands it.
- **Forcing an advisor note is not a test of silence.** Test both a reviewer that speaks and one that stays quiet, on both Claude and GPT.

## Testing against real Kiro

Fake responses cannot catch wire or advisor bugs, so run a live check after changing the transport or merging a large upstream change. It needs a Kiro login and spends credits.

```sh
omp models kiro
omp -p --model kiro/claude-haiku-5.5 "Reply with exactly: OK" </dev/null
omp -p --advisor --model kiro/claude-haiku-5.5 "Create a.txt, then count its lines." </dev/null
```

- `omp -p` can wait forever on an open stdin, so close it with `</dev/null` in scripts.
- Each session's advisor transcript is in `__advisor.jsonl` under `~/.omp/agent/sessions`. Check that its assistant turns have no `errorMessage`.
- For direct wire tests use `omp token kiro --raw`. Without `--raw` the profile ARN is lost and every request fails. Never print the token.
- Only `blocker` notes interrupt work in progress. `nit` and `concern` notes wait for a stopping point, by design.

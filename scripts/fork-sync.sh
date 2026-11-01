#!/bin/sh
# Mirrors upstream to this fork's main, then merges main into the Kiro branch.
# Pushes only when the merge and checks pass, so a failure leaves the fork untouched.
# Guide: packages/ai/src/providers/kiro/AGENTS.md
set -eu

repo="$HOME/git-mushi/oh-my-pi"
tree="$HOME/git-mushi/oh-my-pi-sync"
cache="$HOME/.cache/oh-my-pi-natives"
branch=feat/kiro-provider
generated="packages/catalog/src/compat/rules.json packages/catalog/src/compat/auth-ids.ts packages/catalog/src/compat/provider-ids.ts"
# For testing the merge: use another ref in place of main, and never push.
test_ref="${SYNC_TEST_REF:-}"

# Links the official prebuilt addon for this tree's version into the current directory's tree.
install_natives() {
	version=$(jq -r .version packages/natives/package.json)
	dir="$cache/$version"
	if [ ! -d "$dir" ]; then
		tmp=$(mktemp -d)
		if (cd "$tmp" && npm pack --silent "@oh-my-pi/pi-natives-linux-x64@$version" >/dev/null && tar xzf ./*.tgz); then
			mkdir -p "$cache"
			mv "$tmp/package" "$dir"
		else
			echo "natives $version are not published yet, using the newest cached ones"
		fi
		rm -rf "$tmp"
	fi
	[ -d "$dir" ] || dir=$(find "$cache" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
	cp -lf "$dir"/*.node packages/natives/native/ 2>/dev/null || cp -f "$dir"/*.node packages/natives/native/
}

cd "$repo"
git config rerere.enabled true
git config rerere.autoupdate true
if [ -n "$test_ref" ]; then
	source="$test_ref"
	git fetch --quiet origin
else
	"$HOME/.local/bin/gh" repo sync mushikingh/oh-my-pi --branch main
	git fetch --quiet --prune origin
	git fetch --quiet upstream main
	if [ "$(git symbolic-ref --short HEAD)" = main ]; then
		git merge --quiet --ff-only origin/main
	else
		git fetch --quiet origin main:main
	fi
	source=origin/main
fi

if git merge-base --is-ancestor "$source" "origin/$branch"; then
	echo "$branch already has $(git rev-parse --short "$source")"
	exit 0
fi

[ -e "$tree/.git" ] || git worktree add --quiet --detach "$tree" "origin/$branch"
cd "$tree"
git merge --abort 2>/dev/null || true
git reset --quiet --hard
git checkout --quiet --detach "origin/$branch"

if ! git merge --quiet --no-commit --no-ff "$source"; then
	for file in $generated; do
		if git diff --name-only --diff-filter=U | grep -qx "$file"; then
			git checkout --quiet --theirs -- "$file"
			git add -- "$file"
		fi
	done
	unresolved=$(git diff --name-only --diff-filter=U)
	if [ -n "$unresolved" ]; then
		echo "merge needs a person, nothing was pushed. Conflicts:"
		echo "$unresolved"
		git merge --abort
		exit 1
	fi
fi

bun install --silent
install_natives
bun run gen:compat
# shellcheck disable=SC2086 # the list is meant to split into paths
git add -- $generated
for package in ai catalog coding-agent; do
	(cd "packages/$package" && bun run check:types)
done
(cd packages/ai && bun test test/kiro-*.test.ts)
(cd packages/catalog && bun test test/kiro-provider.test.ts)
(cd packages/coding-agent && bun test test/model-registry-kiro-cache.test.ts test/selector-controller-kiro-login.test.ts)

git commit --quiet -m "chore: merge upstream main into $branch"
if [ -n "$test_ref" ]; then
	echo "test merge passed at $(git rev-parse --short HEAD), nothing was pushed"
	exit 0
fi
git push --quiet origin "HEAD:$branch"
echo "$branch now at $(git rev-parse --short HEAD), with main at $(git rev-parse --short "$source")"

cd "$repo"
if [ "$(git symbolic-ref --short HEAD)" != "$branch" ] || [ -n "$(git status --porcelain)" ]; then
	echo "main checkout left as it is: it is not a clean checkout of $branch"
elif pgrep -f 'coding-agent/src/cli.ts' >/dev/null; then
	echo "main checkout left as it is: omp is running"
else
	git merge --quiet --ff-only "origin/$branch"
	bun install --silent
	install_natives
fi

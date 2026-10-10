# Protecting `main`: settings only the owner can apply

The checks in `.github/workflows/ci.yml` only *report* a problem. These settings make GitHub
*refuse to merge* while a check is failing. They are repository settings, so they are applied on
the GitHub website by the owner, not by a pull request. It takes about five minutes, once.

Do this **after** the pull requests for #337, #351 and #354 are merged, so that GitHub already
knows the four checks by name.

## Part 1 — Nothing reaches `main` without passing the checks

1. Open <https://github.com/hannykumar/Invoice-Product/settings/branches> (sign in if asked).
2. Click **Add classic branch protection rule**. (If you only see **Add branch ruleset**, click
   the small arrow beside it and choose the classic rule.)
3. In the box **Branch name pattern**, type: `main`
4. Tick **Require a pull request before merging**.
   - A smaller box, **Require approvals**, appears under it and is ticked. **Untick it.**
     Everything here is done from one account, and GitHub does not let an account approve its
     own pull request, so leaving it ticked would block every merge.
5. Tick **Require status checks to pass before merging**.
   - A search box appears. Type each of these four names, and click it when it shows up below:
     `secrets`, `verify`, `coverage`, `container`
   - Leave **Require branches to be up to date before merging** unticked.
6. Tick **Do not allow bypassing the above settings**. Without this, the rules would not apply
   to the owner's own account, which is the account every agent works through.
7. Scroll to the bottom. Make sure **Allow force pushes** and **Allow deletions** are both
   **unticked** (they are unticked to begin with).
8. Click the green **Create** button. GitHub may ask for your password once more.

What changes for you: the **Merge** button on a pull request stays grey until all four checks
show a green tick. Nothing else about how you merge changes.

## Part 2 — Be told about unsafe dependencies

1. Open <https://github.com/hannykumar/Invoice-Product/settings/security_analysis>
   (the page is called **Advanced Security**, or **Code security** on some accounts).
2. Find **Dependabot alerts** and click **Enable**, if it is not already on.
3. Find **Dependabot security updates** and click **Enable**.

After this, when a library the product uses is found to be unsafe, GitHub opens a pull request
that updates it. Ordinary weekly updates are already switched on by `.github/dependabot.yml`.

## What each check is

| Check | What it stops |
| --- | --- |
| `secrets` | A password or key being committed (#351) |
| `verify` | A type error, a failing test, a failing database test, or a failed financial release gate |
| `coverage` | The share of `packages/*` exercised by its own tests falling below the floor |
| `container` | The production image failing to build (it builds nothing until #356 adds it) |

## How to check it worked

Ask an agent to "open a pull request with a deliberately failing test". Its page should show a
red cross beside `verify` and a grey **Merge** button. Close that pull request without merging.

## Undoing it

Same page as Part 1: click **Edit** beside the `main` rule, then **Delete rule** at the bottom.

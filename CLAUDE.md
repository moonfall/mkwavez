# Instructions for Claude

## Git

- Never force-push (`--force`, `--force-with-lease`, or any other history rewrite of a pushed branch).
- Keep history linear: no merge commits. When the remote has moved, rebase your local,
  unpushed commits onto it (`git pull --rebase`) and push as a fast-forward.
- Only rebase commits that have not been pushed yet. If pushed commits would need
  rewriting, stop and ask instead.

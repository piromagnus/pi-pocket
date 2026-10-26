# Published update for PR #126

Published to https://github.com/TannerMidd/pi-pocket/pull/126 as commit
`7db8ce2f71d05f233f3509890d5be5337af5572a`. The PR title and description now
describe the standalone extension. The final diff contains the package and two
team learnings; there are no core changes.

`update.patch` applies to commit `137e66eb3e837bed06c897364a03506efae17822`
on `piromagnus/pi-pocket:feat/web-access-search`. It removes the original core
integration and adds only the standalone `extensions/web-search` package and its
team learning. The final core files match upstream base
`d2a3280b10c3f51610eacb13cdfa6e1ea4577b5b`.

The earlier GitHub write restriction was resolved after session permissions
changed. Publication used the GitHub CLI from an isolated temporary checkout,
without modifying the running checkout. The patch is retained as a reference for
the previous PR head; it does not need to be applied again. The published commit
also includes a team note explaining scoped trail-check keyword false positives.

`PR.md` contains the published title and body. The branch should remain an
author-hosted distribution of the standalone extension; installation does not
depend on a core merge. No gallery submission or PR closure is included.

`web-search-install.tar.gz` contains the installable entry, module directory,
README and license. The editable package is at `../../extensions/web-search`.
Its README contains installation and test instructions. This work has not been
installed or enabled on the running server.

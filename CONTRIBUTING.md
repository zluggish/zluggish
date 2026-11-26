# Contributing to Zluggish

Use the [development guide](docs/development.md) to run Zluggish and reproduce CI checks locally.

## Propose a change

Open an issue before starting a large change. Explain the problem and what you want to change. Use [Discussions](https://github.com/zluggish/zluggish/discussions) for open-ended ideas and questions. For a typo, broken link or clear bug, open a pull request directly.

Zluggish is for riding on your own server. Keep play separate from the official Zwift multiplayer world. Contributions must respect the licenses of the Zwift client and assets and must not enable cheating on the official service.

## Open a pull request

- Keep the pull request focused on one change. Run `mise run check`.
- Use a [Conventional Commits](https://www.conventionalcommits.org/) title such as `fix: keep ghost order after a regroup`. CI accepts `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `perf`, `chore` and `revert`.
- Explain what changed, why and how you tested it. Include screenshots for UI changes and the client platform for game changes.
- Update the relevant pages in `docs/` and the tests for changed behavior. If you edit `server/proto/`, run `mise run server-codegen` and commit the generated files.

If you use an AI tool, review and test its changes, remove unrelated edits and say how you used it. Write or edit the pull request title and description yourself. Ask the agent for a compare link if it prepares a branch for a new pull request. Write issues and review comments in your own words. Translation tools are fine.

Maintainers may push small fixes to your branch. Say so in the pull request if you prefer to make those edits yourself.

## Report a bug

Search the open issues first. Include the Zluggish version or image tag, server operating system, install method, Zwift client platform, steps to reproduce, expected and actual behavior, and relevant logs. Remove passwords and tokens before sharing logs or configuration.

Report security issues through [private vulnerability reporting](https://github.com/zluggish/zluggish/security/advisories/new).

Contributions are licensed under the [GNU Affero General Public License, version 3](LICENSE).

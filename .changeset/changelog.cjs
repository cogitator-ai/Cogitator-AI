/**
 * Changelog generator: `@changesets/changelog-github` (links to the pull request and commit, and
 * "Thanks @author!" for contributors) without thanking the project's own maintainers, whose
 * GitHub logins are listed in the `maintainers` option.
 */
const github = require('@changesets/changelog-github').default;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @type {import('@changesets/types').ChangelogFunctions} */
module.exports = {
  getDependencyReleaseLine: github.getDependencyReleaseLine,
  async getReleaseLine(changeset, type, options) {
    const { maintainers = [], ...githubOptions } = options ?? {};
    const line = await github.getReleaseLine(changeset, type, githubOptions);
    return maintainers.reduce(
      (text, login) =>
        text.replace(
          new RegExp(
            ` Thanks \\[@${escape(login)}\\]\\(https://github\\.com/${escape(login)}\\)!`,
            'gi'
          ),
          ''
        ),
      line
    );
  },
};

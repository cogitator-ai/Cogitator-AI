const PACKAGE_SOURCE = /[\\/]packages[\\/][^\\/]+[\\/]src[\\/].+\.tsx?$/;

const quote = (files) => files.map((file) => JSON.stringify(file)).join(' ');

/**
 * Runs on the staged version of each file and leaves unstaged changes alone.
 * Package sources lose their line comments and are linted before formatting.
 */
export default {
  '*.{ts,tsx,md,json}': (files) => {
    const sources = files.filter((file) => PACKAGE_SOURCE.test(file));
    return [
      ...(sources.length > 0
        ? [`tsx scripts/remove-comments.ts ${quote(sources)}`, `eslint --fix ${quote(sources)}`]
        : []),
      `prettier --write ${quote(files)}`,
    ];
  },
};

/**
 * Decides whether a URL may be fetched under the site's robots.txt. Loaders and browser
 * sessions take one to stay polite; `RobotsPolicy` in `@cogitator-ai/core` is the standard one.
 */
export interface RobotsChecker {
  allows(url: string): Promise<boolean>;
}

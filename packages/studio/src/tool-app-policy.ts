/**
 * What the studio lets an MCP App do: the Content Security Policy and the Permissions Policy its
 * page is served with, and the `allow` attribute of its frame. The file imports types only, so the
 * server and the UI share it.
 */

import type { ToolAppCsp, ToolAppPermissions } from '@cogitator-ai/types';

/** The sandbox of an app's frame and page: scripts only, so it never gets the studio's origin */
export const TOOL_APP_SANDBOX = 'allow-scripts';

/**
 * A source an app may declare: a scheme and a host (a leading `*.` for subdomains), an optional
 * port and path. Anything else, such as a keyword or a value that would end the directive, is left
 * out of the policy
 */
const SOURCE =
  /^(https?|wss?):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:(\d{1,5}|\*))?(\/[^\s;,'"]*)?$/i;

/** The sources of `domains` the policy may name, each once */
export function appSources(domains: readonly string[] | undefined): string[] {
  return [...new Set((domains ?? []).filter((domain) => SOURCE.test(domain)))];
}

function directive(name: string, base: readonly string[], domains: readonly string[]): string {
  const sources = [...base, ...domains];
  return `${name} ${sources.length > 0 ? sources.join(' ') : "'none'"}`;
}

/**
 * The Content Security Policy of an app's page, from the origins it declares (`_meta.ui.csp`), as
 * MCP Apps asks of a host: inline scripts and styles, `data:` images, fonts and media, and only the
 * declared origins beyond that. Without declarations it reaches nothing, nests no frames and keeps
 * its base URI. The page is sandboxed with scripts only whoever opens it, may post no forms and is
 * framed by the studio alone
 */
export function appContentSecurityPolicy(csp: ToolAppCsp | undefined): string {
  const resources = appSources(csp?.resourceDomains);
  return [
    "default-src 'none'",
    directive('script-src', ["'unsafe-inline'"], resources),
    directive('style-src', ["'unsafe-inline'"], resources),
    directive('img-src', ['data:', 'blob:'], resources),
    directive('font-src', ['data:'], resources),
    directive('media-src', ['data:', 'blob:'], resources),
    directive('connect-src', [], appSources(csp?.connectDomains)),
    directive('frame-src', [], appSources(csp?.frameDomains)),
    directive('base-uri', [], appSources(csp?.baseUriDomains)),
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    `sandbox ${TOOL_APP_SANDBOX}`,
  ].join('; ');
}

/** The browser features an app may ask for, by their name in a Permissions Policy */
const ASKABLE: Record<keyof ToolAppPermissions, string> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write',
};

/** Features an app never gets, asked or not */
const NEVER = [
  'accelerometer',
  'autoplay',
  'clipboard-read',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gyroscope',
  'hid',
  'idle-detection',
  'magnetometer',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
];

function asked(permissions: ToolAppPermissions | undefined): string[] {
  const features: string[] = [];
  for (const [key, feature] of Object.entries(ASKABLE)) {
    if (permissions && Object.hasOwn(permissions, key)) features.push(feature);
  }
  return features;
}

/**
 * The `allow` attribute of an app's frame: the features it asked for (`_meta.ui.permissions`),
 * which the browser may still ask the person for
 */
export function appAllowAttribute(permissions: ToolAppPermissions | undefined): string {
  return asked(permissions).join('; ');
}

/**
 * The Permissions Policy of an app's page: the features it asked for to the frame, every other one
 * to nobody
 */
export function appPermissionsPolicy(permissions: ToolAppPermissions | undefined): string {
  const granted = new Set(asked(permissions));
  const denied = [...Object.values(ASKABLE).filter((feature) => !granted.has(feature)), ...NEVER];
  return [
    ...[...granted].map((feature) => `${feature}=(self)`),
    ...denied.map((feature) => `${feature}=()`),
  ].join(', ');
}

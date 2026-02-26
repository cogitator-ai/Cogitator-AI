export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export type WaitUntilState = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export type MouseButton = 'left' | 'right' | 'middle';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type ResourceType = 'image' | 'stylesheet' | 'font' | 'media' | 'script';

export type InterceptAction = 'block' | 'modify' | 'continue';

export type SelectorState = 'visible' | 'hidden' | 'attached' | 'detached';

export type BrowserToolModule = 'navigation' | 'interaction' | 'extraction' | 'vision' | 'network';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface StealthConfig {
  humanLikeTyping?: boolean;
  humanLikeMouse?: boolean;
  fingerprintRandomization?: boolean;
  blockWebDriver?: boolean;
  evasionScripts?: string[];
}

export interface BrowserSessionConfig {
  headless?: boolean;
  browser?: BrowserType;
  stealth?: boolean | StealthConfig;
  proxy?: string | ProxyConfig;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number };
  persistentContext?: string;
  cookies?: BrowserCookie[];
  timeout?: number;
  actionTimeout?: number;
  pool?: { maxPages: number };
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ElementInfo {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface LinkInfo {
  text: string;
  href: string;
  title?: string;
}

export interface HarEntry {
  url: string;
  method: string;
  status: number;
  timing: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

export interface BrowserToolsOptions {
  modules?: BrowserToolModule[];
}

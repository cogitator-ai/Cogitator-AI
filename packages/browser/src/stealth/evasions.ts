export interface EvasionScriptsOptions {
  blockWebDriver?: boolean;
  fingerprintRandomization?: boolean;
}

const WEBDRIVER_EVASION = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

const PLUGINS_EVASION = `Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    const pluginArray = typeof PluginArray !== 'undefined' ? Object.create(PluginArray.prototype) : {};
    for (let i = 0; i < pluginData.length; i++) {
      const plugin = typeof Plugin !== 'undefined' ? Object.create(Plugin.prototype) : {};
      Object.defineProperties(plugin, {
        name: { value: pluginData[i].name },
        filename: { value: pluginData[i].filename },
        description: { value: pluginData[i].description },
        length: { value: 0 },
      });
      pluginArray[i] = plugin;
    }
    Object.defineProperty(pluginArray, 'length', { value: pluginData.length });
    return pluginArray;
  }
});`;

const LANGUAGES_EVASION = `Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });`;

const WEBGL_EVASION = `{
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };
  }
}`;

const CHROME_EVASION = `if (!window.chrome) {
  window.chrome = {
    runtime: { connect: () => {}, sendMessage: () => {} },
    loadTimes: () => ({}),
    csi: () => ({}),
  };
}`;

const PERMISSIONS_EVASION = `if (typeof Permissions !== 'undefined') {
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') {
      const status = typeof PermissionStatus !== 'undefined'
        ? Object.create(PermissionStatus.prototype)
        : {};
      Object.defineProperties(status, {
        state: { value: 'denied', enumerable: true },
        onchange: { value: null, enumerable: true },
      });
      return Promise.resolve(status);
    }
    return origQuery.call(this, desc);
  };
}`;

function createCanvasEvasion(): string {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  return `{
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const canvasNoiseSeed = ${seed};
  const createNoise = (seed) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const jitterChannel = (value, noise) => {
    const jitter = Math.floor(noise() * 3) - 1;
    return Math.min(255, Math.max(0, value + jitter));
  };
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    try {
      if (this.width > 0 && this.height > 0) {
        const context = this.getContext('2d');
        if (context) {
          const temp = document.createElement('canvas');
          temp.width = this.width;
          temp.height = this.height;
          const tempCtx = temp.getContext('2d');
          if (tempCtx) {
            tempCtx.drawImage(this, 0, 0);
            const imageData = tempCtx.getImageData(0, 0, temp.width, temp.height);
            const noise = createNoise(
              canvasNoiseSeed ^ Math.imul(this.width, 0x9e3779b9) ^ Math.imul(this.height, 0x85ebca6b)
            );
            for (let i = 0; i < imageData.data.length; i += 4) {
              imageData.data[i] = jitterChannel(imageData.data[i], noise);
              imageData.data[i + 1] = jitterChannel(imageData.data[i + 1], noise);
              imageData.data[i + 2] = jitterChannel(imageData.data[i + 2], noise);
            }
            tempCtx.putImageData(imageData, 0, 0);
            return origToDataURL.apply(temp, args);
          }
        }
      }
    } catch {
    }
    return origToDataURL.apply(this, args);
  };
}`;
}

type EvasionKind = 'webdriver' | 'fingerprint';

export function getEvasionScripts(options: EvasionScriptsOptions = {}): string[] {
  const includeWebdriver = options.blockWebDriver !== false;
  const includeFingerprint = options.fingerprintRandomization !== false;

  const evasions: Array<{ kind: EvasionKind; script: string }> = [
    { kind: 'webdriver', script: WEBDRIVER_EVASION },
    { kind: 'fingerprint', script: PLUGINS_EVASION },
    { kind: 'fingerprint', script: LANGUAGES_EVASION },
    { kind: 'fingerprint', script: createCanvasEvasion() },
    { kind: 'fingerprint', script: WEBGL_EVASION },
    { kind: 'fingerprint', script: CHROME_EVASION },
    { kind: 'webdriver', script: PERMISSIONS_EVASION },
  ];

  return evasions
    .filter((evasion) => (evasion.kind === 'webdriver' ? includeWebdriver : includeFingerprint))
    .map((evasion) => evasion.script);
}

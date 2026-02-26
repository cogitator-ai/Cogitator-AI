export function getEvasionScripts(): string[] {
  return [
    `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,

    `Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        const pluginArray = Object.create(PluginArray.prototype);
        for (let i = 0; i < plugins.length; i++) {
          const p = Object.create(Plugin.prototype);
          Object.defineProperties(p, {
            name: { value: plugins[i].name },
            filename: { value: plugins[i].filename },
            description: { value: plugins[i].description },
            length: { value: 0 },
          });
          pluginArray[i] = p;
        }
        Object.defineProperty(pluginArray, 'length', { value: plugins.length });
        return pluginArray;
      }
    });`,

    `Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });`,

    `{
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(type) {
        const context = this.getContext('2d');
        if (context) {
          const imageData = context.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] ^= 1;
          }
          context.putImageData(imageData, 0, 0);
        }
        return origToDataURL.apply(this, arguments);
      };
    }`,

    `{
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, param);
      };
    }`,

    `if (!window.chrome) {
      window.chrome = {
        runtime: { connect: () => {}, sendMessage: () => {} },
        loadTimes: () => ({}),
        csi: () => ({}),
      };
    }`,

    `{
      const origQuery = Permissions.prototype.query;
      Permissions.prototype.query = function(desc) {
        if (desc.name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null });
        }
        return origQuery.call(this, desc);
      };
    }`,
  ];
}

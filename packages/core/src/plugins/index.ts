export { experimental_definePlugin } from './define';
export { experimental_PluginHost, type PluginHostOptions, type PluginReloadResult } from './host';
export type { PluginHookSet, PluginPanelEntry, PluginSnapshot } from './contributions';
export {
  experimental_validatePlugin,
  readPluginLayout,
  pluginNameProblem,
  marketplaceNameProblem,
  dependencyOf,
  CLAUDE_MANIFEST,
  COGITATOR_MANIFEST,
  OFFICIAL_MARKETPLACES,
  RESERVED_MARKETPLACES,
  type PluginLayout,
  type PluginValidation,
  type ReadPluginOptions,
} from './manifest';
export {
  experimental_keychainSecretStore,
  experimental_memorySecretStore,
  secretServiceOf,
  type KeychainSecretStoreOptions,
  type SecretCommandResult,
  type SecretCommandRunner,
} from './secrets';
export {
  loadPluginSettings,
  pluginSettingsFile,
  writeEnabledPlugin,
  writePluginOptions,
  type PluginSettings,
  type PluginSettingsScope,
} from './settings';
export {
  defaultPluginsRoot,
  pluginDataDir,
  pluginIdFolder,
  readInstalledPlugins,
  writeInstalledPlugins,
  readKnownMarketplaces,
  writeKnownMarketplaces,
} from './store';
export { satisfies, maxSatisfying, parseVersion, compareVersions, isValidRange } from './semver';
export { PluginPermissions, type CapabilityRequest } from './capabilities';
export {
  experimental_PluginInstaller,
  type PluginInstallerOptions,
  type PluginInstallOptions,
  type PluginInstallQuestion,
  type PluginInstallResult,
  type PluginUpdateResult,
} from './install/installer';
export {
  parseMarketplace,
  marketplaceSourceOf,
  fetchMarketplace,
  MARKETPLACE_FILE,
  type ReadMarketplace,
  type FetchedMarketplace,
} from './install/marketplace';
export { unzip } from './install/zip';

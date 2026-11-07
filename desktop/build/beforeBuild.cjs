// electron-builder hook. The app ships no node_modules: the main process only
// uses Electron and Node built-ins, and the vault sync engine is bundled into
// vaultSyncEngine.mjs. Returning false tells electron-builder not to install,
// rebuild or collect any dependencies.
//
// Without it, electron-builder 26 finds the repository's root package.json
// (it has "workspaces"), treats it as this app's workspace and looks for the
// web app's dependencies, which the Desktop release workflow never installs:
// "Production dependency @anthropic-ai/sdk not found for package margin-chat".
exports.default = async function beforeBuild() {
  return false;
};

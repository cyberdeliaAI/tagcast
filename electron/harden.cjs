"use strict";

const path = require("node:path");

module.exports = async function harden(context) {
  const {flipFuses, FuseVersion, FuseV1Options} = await import("@electron/fuses");
  const executable = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app")
    : path.join(context.appOutDir, context.packager.appInfo.productFilename + (context.electronPlatformName === "win32" ? ".exe" : ""));
  await flipFuses(executable, {version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.OnlyLoadAppFromAsar]: true});
};

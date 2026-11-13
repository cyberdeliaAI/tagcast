"use strict";

// Keep the portable ZIP; this additional per-user installer enables native updates.
const {build} = require("../electron/package.json");
module.exports = {
  ...build,
  directories: {...build.directories, output: "out-nsis"},
  win: {...build.win, target: ["nsis"]},
  nsis: {
    artifactName: "tagcast-${version}-windows-x64-setup.${ext}",
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false
  }
};

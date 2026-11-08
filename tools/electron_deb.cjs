"use strict";

// Repackage the already hardened Linux app; keep electron-builder's sandbox/AppArmor hooks.
const path = require("node:path");
const {build} = require("../electron/package.json");

module.exports = {
  ...build,
  directories: {...build.directories, output: "out-deb"},
  extraMetadata: {homepage: "https://tagcast.app/"},
  linux: {...build.linux, target: ["deb"], category: "AudioVideo;Audio;Music"},
  deb: {
    packageName: "tagcast",
    maintainer: "Cyberdelia <cyberdeliaAI@users.noreply.github.com>",
    artifactName: "tagcast-${version}-linux-amd64.${ext}",
    fpm: [path.join(__dirname, "tagcast-cli") + "=/usr/bin/tagcast-cli"],
  },
};

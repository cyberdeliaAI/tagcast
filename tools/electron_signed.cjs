"use strict";

// Explicitly selected by --sign-macos; ordinary/PR builds keep package.json's ad-hoc identity.
const path = require("node:path");
const {build} = require("../electron/package.json");
const mac = {...build.mac};
delete mac.identity; // Select the Developer ID imported from CSC_LINK, never the ad-hoc identity.

module.exports = {
  ...build,
  forceCodeSigning: true,
  mac: {
    ...mac,
    type: "distribution",
    hardenedRuntime: true,
    entitlements: path.join(__dirname, "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "entitlements.mac.plist"),
    notarize: true,
  },
};

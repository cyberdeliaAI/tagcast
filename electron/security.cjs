"use strict";

const {createHash} = require("node:crypto");
const {existsSync, readFileSync} = require("node:fs");
const path = require("node:path");
const sourceRules = path.join(__dirname, "../src/tagcast/static/content-security-policy.json");
const rules = JSON.parse(readFileSync(existsSync(sourceRules) ? sourceRules
  : path.join(process.resourcesPath, "content-security-policy.json"), "utf8"));

function applicationUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && ["/", "/index.html"].includes(url.pathname) && !url.search;
  } catch { return false; }
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return value.length <= 8192 && url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function permissionAllowed(contents, permission, requestingUrl, details, origin) {
  return !!contents && applicationUrl(contents.getURL(), origin)
    && applicationUrl(requestingUrl, origin) && details?.isMainFrame !== false
    && ["fullscreen", "speaker-selection", "clipboard-sanitized-write"].includes(permission);
}

function contentPolicy(page) {
  // Hash trusted early restoration scripts; never permit arbitrary inline JS.
  const hashes = [...new Set([...page.replace(/\r\n?/g, "\n").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim()).map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`))];
  return Object.entries(rules).map(([name, values]) => name + " " + [...values, ...(name === "script-src" ? hashes : [])].join(" ")).join("; ");
}

module.exports = {applicationUrl, externalUrl, permissionAllowed, contentPolicy};

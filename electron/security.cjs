"use strict";

const {createHash} = require("node:crypto");

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
  // Hash the existing early theme restoration scripts; never permit arbitrary inline JS.
  const hashes = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(match => match[1].trim()).map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  return `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'`;
}

module.exports = {applicationUrl, externalUrl, permissionAllowed, contentPolicy};

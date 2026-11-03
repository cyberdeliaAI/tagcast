"use strict";

const {ENGLISH} = require("./desktop-text.cjs");

function helpMenu(openExternal, {text = name => ENGLISH[name], english = true} = {}) {
  return {role: "help", ...(english ? {} : {label: text("menu.help")}), submenu: [
    ["menu.helpDocs", "https://github.com/cyberdeliaAI/tagcast/wiki"],
    ["menu.website", "https://tagcast.app/"],
    ["menu.reddit", "https://www.reddit.com/r/Tagcast/"],
    ["menu.github", "https://github.com/cyberdeliaAI/tagcast"]
  ].map(([name, url]) => ({label: text(name), click: () => openExternal(url)}))};
}

module.exports = {helpMenu};

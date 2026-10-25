"use strict";

function helpMenu(openExternal) {
  return {role: "help", submenu: [
    ["Tagcast Help", "https://github.com/cyberdeliaAI/tagcast/wiki"],
    ["Tagcast Website", "https://tagcast.app/"],
    ["Tagcast on Reddit", "https://www.reddit.com/r/Tagcast/"],
    ["Tagcast on GitHub", "https://github.com/cyberdeliaAI/tagcast"]
  ].map(([label, url]) => ({label, click: () => openExternal(url)}))};
}

module.exports = {helpMenu};

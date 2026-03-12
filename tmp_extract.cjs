const fs = require("fs");
const html = fs.readFileSync("c:/Users/domin/projects/pilot-sync-mobile/tmp_page.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log("no script"); process.exit(); }
fs.writeFileSync("c:/Users/domin/projects/pilot-sync-mobile/tmp_check.js", m[1]);
console.log("extracted", m[1].length, "chars");

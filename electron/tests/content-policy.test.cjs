"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {readFileSync}=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {contentPolicy}=require("../security.cjs");
const root=path.resolve(__dirname,"../.."),python=process.env.TAGCAST_PYTHON||(process.platform==="win32"?"python":"python3");

test("Electron and Python derive the same policy and exact inline hashes from one bundled rule file",()=>{
  const pages=["",'<script>const x = "é";</script>',"<SCRIPT>\r\nconst x = 1;\r</SCRIPT>",'<script src="a.js"></script><script> </script>',readFileSync(path.join(root,"src/tagcast/static/index.html"),"utf8")];
  const result=spawnSync(python,["-c","import json,sys; from tagcast.content_security import content_policy; print(json.dumps([content_policy(p) for p in json.load(sys.stdin)]))"],
    {cwd:root,env:{...process.env,PYTHONPATH:path.join(root,"src")},input:JSON.stringify(pages),encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),pages.map(contentPolicy));
  const resources=require("../package.json").build.extraResources;
  assert.ok(resources.some(r=>r.from==="../src/tagcast/static/content-security-policy.json"&&r.to==="content-security-policy.json"));
});

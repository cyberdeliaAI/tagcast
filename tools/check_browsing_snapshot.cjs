"use strict";
// Optional real Chromium regression against benchmark_browsing.py --serve.
// The supplied server owns a synthetic library and a loopback-only iBroadcast mock.
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const origin = new URL(process.argv[2]).origin;
assert.equal(new URL(origin).hostname, "127.0.0.1");
const output = path.resolve(process.argv[3] || "build/browsing-browser");
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch(process.env.TAGCAST_BROWSE_CHROMIUM ? {executablePath:process.env.TAGCAST_BROWSE_CHROMIUM} : {});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:960}});
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {if(request.url().startsWith(origin+"/api/"))requests.push(request.url());});
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const control = async action => (await page.request.get(origin+"/_benchmark/"+action)).json();
    await page.goto(origin+"/");
    await page.waitForFunction(() => state.mode === "live" && !state.loading && state.albums.length > 10000);
    const initial = await control("state");
    await control("outage-on");
    await page.evaluate(() => {browseGroupContinuous.get("track-artists").setEnabled(true);showBrowse("track-artists");});
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.rows.length >= 60);
    await page.evaluate(async () => {while(browseView.rows.length < 2400)await browseContinuous().more();});
    assert.equal(await page.evaluate(() => browseView.rows.length),2400);
    await page.evaluate(() => {window.scrollTo(0,10000);rememberNavigationScroll();});
    const overview = await page.evaluate(() => ({keys:browseView.rows.map(row=>row.key),scroll:window.scrollY,sort:browseView.sort,
      domChunks:document.querySelectorAll('#browse-list [data-continuous-chunk]:not([aria-hidden="true"])').length}));
    assert.ok(overview.scroll>0);
    const start = requests.length;
    await page.evaluate(() => showBrowse("track-artists",browseView.rows[0].key));
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.key !== null);
    const restoring = performance.now();
    await page.goBack();
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.key === null && browseView.rows.length === 2400);
    await page.waitForFunction(scroll => Math.abs(window.scrollY-scroll)<2,overview.scroll);
    const restored = await page.evaluate(() => ({keys:browseView.rows.map(row=>row.key),scroll:window.scrollY,sort:browseView.sort,
      domChunks:document.querySelectorAll('#browse-list [data-continuous-chunk]:not([aria-hidden="true"])').length}));
    assert.deepEqual(restored.keys,overview.keys);
    assert.equal(restored.sort,overview.sort);
    assert.ok(restored.domChunks<=6,"Only a bounded portion of the prefix is mounted");
    const restoreMs = performance.now()-restoring;
    const restoreRequests = requests.slice(start).filter(url=>new URL(url).searchParams.get("key")===null && url.includes("/api/browse?"));
    assert.equal(restoreRequests.length,40);
    assert.ok(restoreRequests.every(url=>new URL(url).searchParams.get("limit")==="60"));
    await page.selectOption("#browse-sort","count");
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.sort === "count" && browseView.rows.length === 60);
    await page.fill("#browse-search","Synthetic Artist 01");
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.membershipQuery === "Synthetic Artist 01");
    await page.evaluate(() => showBrowse("genres"));
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.kind === "genres");
    await page.evaluate(() => showFavourites());
    await page.waitForFunction(() => !favourites.loading && favourites.rows.length > 0);
    const tagData = await page.evaluate(async () => ({catalogue:await api("/api/tags"),selection:await api("/api/tags/selection?albums=1")}));
    assert.ok(tagData.catalogue.total>0);
    assert.ok(tagData.selection.tracks>0);
    const cached = await control("state");
    assert.deepEqual(cached.counts,initial.counts,"Ordinary browsing is independent of the failed upstream service");
    const refresh = await page.evaluate(async () => {try {await api("/api/library?refresh=1");return true;}catch{return false;}});
    assert.equal(refresh,false,"Explicit refresh still reaches the unavailable service");
    const afterRefresh = await control("state");
    assert.equal(afterRefresh.counts.status-initial.counts.status,3,"The existing bounded read retry policy is unchanged");
    await page.evaluate(() => showBrowse("tags"));
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.kind === "tags" && !browseView.error);
    assert.deepEqual((await control("state")).counts,afterRefresh.counts,"Failed refresh retains the usable snapshot");
    assert.deepEqual(errors,[]);
    const report = {browser:browser.version(),synthetic:true,externalRequestsBlocked:true,albums:await page.evaluate(()=>state.albums.length),
      initialCounts:initial.counts,cachedOutageCounts:cached.counts,afterExplicitRefresh:afterRefresh.counts,
      restoredGroups:restored.keys.length,restoreApiRequests:restoreRequests.length,restoreMs,scrollBefore:overview.scroll,scrollAfter:restored.scroll,
      mountedChunks:restored.domChunks,pageErrors:errors};
    fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
    await page.screenshot({path:path.join(output,"cached-tags-outage.png")});
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

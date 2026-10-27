"use strict";
const fs=require('node:fs'),path=require('node:path'),{verifyResults}=require('./contract.cjs');
try{
 const directories=process.argv.slice(2);if(!directories.length)throw Error('Supply measurement output directories');
 for(const dir of directories)verifyResults(JSON.parse(fs.readFileSync(path.join(dir,'results.json'))),dir);
}catch(error){console.error(error.message);process.exitCode=1;}

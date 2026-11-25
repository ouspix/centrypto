// Export only decision-time OHLCV versions from the recorder via its indexed history.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const [database, output] = process.argv.slice(2);
const stamp = Date.parse("2026-11-22T21:25:00Z");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../three-month-replay/candles.json"))).symbols;
const source = new DatabaseSync(database, {readOnly:true});
source.exec("PRAGMA busy_timeout=15000");
source.exec("PRAGMA mmap_size=4000000000");
const earliest = source.prepare("SELECT min(open_at) AS first FROM candle_observation WHERE symbol=?");
const begin = Math.floor(Math.min(...catalog.map(s => earliest.get(s).first).filter(v => v !== null)) / 300000) * 300000;
// Bound each read transaction and scan in physical insertion order on the recorder drive.
const maxId=source.prepare("SELECT max(id) AS n FROM candle_observation").get().n;
const query=source.prepare(`SELECT symbol,open_at,received_at,recorded_at,o,h,l,c,v
  FROM candle_observation WHERE id>? AND id<=? AND open_at>=? AND open_at<=?
  AND received_at <= (open_at/300000+1)*300000+5000
  AND recorded_at <= (open_at/300000+1)*300000+5000 ORDER BY id`);
query.setReturnArrays(true);
const assets=new Map(catalog.map((s,j)=>[s,j]));
const minutes=Math.floor((stamp-begin)/60000)+1;
const values=new Float64Array(catalog.length*minutes*7);
for(let lo=0;lo<maxId;lo+=50000) {
  for(const r of query.iterate(lo,Math.min(maxId,lo+50000),begin,stamp)) {
    const j=assets.get(r[0]);
    if(j===undefined)continue;
    const offset=(j*minutes+(r[1]-begin)/60000)*7;
    const newAt=Math.max(r[2],r[3]),oldAt=Math.max(values[offset],values[offset+1]);
    if(newAt<oldAt || (newAt===oldAt && r[2]<values[offset]))continue;
    for(let k=0;k<7;k++) values[offset+k]=r[k+2];
  }
  if(lo%1000000===0)console.log("Read",Math.min(lo+50000,maxId),"of",maxId,"recorder rows");
}
source.close();
const tmp=output+".partial";
const fd=fs.openSync(tmp,"w");
const block=Buffer.alloc(72*8192);
let count=0, used=0;
function emit(asset,r) {
  const record=[asset,...r];
  for(let k=0;k<9;k++) block.writeDoubleLE(record[k],used*72+8*k);
  used++; count++;
  if(used===8192) { fs.writeFileSync(fd,block); used=0; }
}
for (let asset=0;asset<catalog.length;asset++) {
  for(let i=0;i<minutes;i++){
    const offset=(asset*minutes+i)*7;
    if(values[offset])emit(asset,[begin+i*60000,...values.subarray(offset,offset+7)]);
  }
  if((asset+1)%40===0) console.log("Receipt partitions",asset+1,"of",catalog.length,count);
}
if(used) fs.writeFileSync(fd,block.subarray(0,72*used));
fs.closeSync(fd);
fs.renameSync(tmp,output);
fs.writeFileSync(output+".json",JSON.stringify({begin,count,symbols:catalog}));
console.log("Captured",count,"observed minute versions");

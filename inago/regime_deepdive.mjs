import { getStock, listStocks, CFG } from "./compare_backtest.mjs";

global.window = global.window || {};
const stocks = listStocks().map(getStock).filter(Boolean);

// scoreAt を再利用せず、compare_backtest.mjs の compute() 相当をここで手動再現し、
// 個別fwdリターンを配列として保持して中央値・分布・年別内訳を見る。
import fs from "node:fs";
const src = fs.readFileSync(new URL("./compare_backtest.mjs", import.meta.url), "utf-8");
// scoreAt と market を直接importできないので compute内部と同じロジックをコピーして使う
const mod = await import("./compare_backtest.mjs");

// market() を単独公開していないので、簡易に複製（date-based breadth）
function smaAt(arr,p,i){ if(i+1<p) return null; let s=0; for(let k=i-p+1;k<=i;k++) s+=arr[k]; return s/p; }
function marketBreadth(stocks){
  const agg=new Map();
  stocks.forEach(st=>{const cl=st.candles.map(x=>x.close);st.candles.forEach((c,i)=>{const ma=smaAt(cl,25,i);if(ma==null)return;const e=agg.get(c.date)||{a:0,t:0};e.t++;if(c.close>=ma)e.a++;agg.set(c.date,e);});});
  const pct=new Map([...agg.keys()].map(d=>{const e=agg.get(d);return [d,e.t?e.a/e.t*100:null];}));
  return { regimeAtDate:d=>{if(!pct.has(d))return null;const b=pct.get(d);return b==null?null: b>=55?"on": b<=45?"off":"neu";}, pct };
}
const M = marketBreadth(stocks);

// 地合いの日数分布（全期間中、on/off/neuがそれぞれ何日あるか）
const dist = { on:0, off:0, neu:0, null:0 };
[...M.pct.values()].forEach(b=>{ const r = b==null?null: b>=55?"on": b<=45?"off":"neu"; dist[r===null?"null":r]++; });
console.log("地合いの日数分布(全銘柄の25日線ブレッドス集計日):", dist);

// scoreAt をコピー（compare_backtest.mjsからexportされていないため再定義）
function ramp(x,a,b,max=100){ const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,x)); return b===a?(x>=b?max:0):clamp(((x-a)/(b-a))*max,0,max); }
function clamp(x,lo=0,hi=100){ return Math.max(lo,Math.min(hi,x)); }
function rsiAt(c,p,i){ if(i<p) return 50; let g=0,l=0; for(let k=i-p+1;k<=i;k++){const d=c[k]-c[k-1]; if(d>=0)g+=d; else l-=d;} if(l===0) return 100; const rs=(g/p)/(l/p); return 100-100/(1+rs); }
function scoreAt(candles,i){
  const need=Math.max(CFG.volSma,CFG.range,CFG.ma)+2; if(i<need) return null;
  const closes=candles.map(c=>c.close),vols=candles.map(c=>c.volume),c=candles[i];
  const volSma=smaAt(vols,CFG.volSma,i),rvol=volSma?c.volume/volSma:1;
  let pr=0,n=0; for(let k=i-CFG.quiet;k<i;k++){const vs=smaAt(vols,CFG.volSma,k); if(vs){pr+=vols[k]/vs;n++;}}
  const priorRvol=n?pr/n:rvol;
  let hi=-Infinity,lo=Infinity; for(let k=i-CFG.range+1;k<=i;k++){if(candles[k].high>hi)hi=candles[k].high; if(candles[k].low<lo)lo=candles[k].low;}
  const rangePos=hi>lo?(c.close-lo)/(hi-lo):0.5;
  const ma=smaAt(closes,CFG.ma,i),deviation=ma?((c.close-ma)/ma)*100:0;
  const tr=(c.high-c.low)||1e-9,body=Math.abs(c.close-c.open);
  const bodyRatio=body/tr,upperWick=(c.high-Math.max(c.open,c.close))/tr,closePos=(c.close-c.low)/tr,isBull=c.close>=c.open;
  let consecUp=0; for(let k=i;k>=0;k--){if(candles[k].close>=candles[k].open)consecUp++; else break;}
  const rsi=rsiAt(closes,CFG.rsiP,i);
  let v=ramp(rvol,1.2,3.0,60); const ignited=rvol>=CFG.rvolIgnite&&priorRvol<CFG.quietRvolMax;
  if(ignited)v+=40; else if(priorRvol>=2.0)v-=15; v=clamp(v);
  let p=ramp(rangePos,0.45,CFG.breakoutPos,100); if(deviation>CFG.devHot)p-=ramp(deviation,CFG.devHot,CFG.devExtreme,60); p=clamp(p);
  let cs=(isBull?35:0)+ramp(bodyRatio,0.3,0.7,35)+ramp(closePos,0.5,0.9,30)-ramp(upperWick,0.3,0.6,40); cs=clamp(cs);
  const entryScore=clamp(v*0.45+p*0.30+cs*0.25);
  let heat=ramp(deviation,CFG.devHot,CFG.devExtreme,40)+ramp(rsi,CFG.rsiHot,CFG.rsiExtreme,30)+ramp(consecUp,CFG.consecUpHot,CFG.consecUpHot+4,15);
  const distribution=rangePos>0.8&&rvol>2&&upperWick>CFG.upperWickHot&&bodyRatio<0.4; if(distribution)heat+=30;
  const heatScore=clamp(heat);
  let state; if(heatScore>=70)state="出口"; else if(heatScore>=45)state="過熱"; else if(entryScore>=65&&heatScore<35)state="初動候補"; else if(entryScore>=45)state="継続"; else state="様子見";
  return { entryScore:Math.round(entryScore), heatScore:Math.round(heatScore), state };
}

const N=5, basis="nextOpen", cost=0.2, gapSkip=8;
const need=Math.max(CFG.volSma,CFG.range,CFG.ma)+2;
const byRegime = { on:[], off:[], neu:[] };
const byRegimeYear = {}; // year -> regime -> [fwd]
stocks.forEach(st=>{ const c=st.candles;
  let prevState=null;
  for(let i=need;i<c.length-N;i++){ const r=scoreAt(c,i); if(!r){ prevState=null; continue; }
    const isNew = r.state!==prevState; prevState=r.state;
    if(!isNew) continue;
    if(r.state!=="初動候補") continue;
    let base=c[i+1].open; if(!isFinite(base)||base<=0) continue;
    const gap=(base/c[i].close-1)*100; if(gap>=gapSkip) continue;
    let fwd=(c[i+N].close/base-1)*100 - cost;
    const reg = c[i].date ? M.regimeAtDate(c[i].date) : null;
    if(!reg) continue;
    byRegime[reg].push(fwd);
    const year = c[i].date.slice(0,4);
    byRegimeYear[year] = byRegimeYear[year] || {on:[],off:[],neu:[]};
    byRegimeYear[year][reg].push(fwd);
  }
});

function stats(arr){
  if(!arr.length) return {n:0};
  const sorted=[...arr].sort((a,b)=>a-b);
  const mean = arr.reduce((s,x)=>s+x,0)/arr.length;
  const median = sorted[Math.floor(sorted.length/2)];
  const winRate = arr.filter(x=>x>0).length/arr.length*100;
  const sd = Math.sqrt(arr.reduce((s,x)=>s+(x-mean)**2,0)/arr.length);
  const se = sd/Math.sqrt(arr.length);
  return { n:arr.length, mean:+mean.toFixed(3), median:+median.toFixed(3), winRate:+winRate.toFixed(1), sd:+sd.toFixed(2), se:+se.toFixed(3), tstat:+(mean/se).toFixed(2) };
}

console.log("\n=== 初動候補(N=5, 新仕様) 地合い別: 平均vs中央値、標準誤差、t値 ===");
["on","off","neu"].forEach(k=>console.log(k, stats(byRegime[k])));

console.log("\n=== 年別内訳 ===");
Object.keys(byRegimeYear).sort().forEach(year=>{
  const row = byRegimeYear[year];
  const line = ["on","off","neu"].map(k=>{ const s=stats(row[k]); return `${k}:n${s.n||0}${s.n?" avg"+s.mean+"%":""}`; }).join("  ");
  console.log(year, line);
});

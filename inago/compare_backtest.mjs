// P-1〜P-9監査修正の「新旧比較」をNodeで実行するための抽出ロジック。
// inago_offline.html のスコアリング/集計コードと同一（DOM依存部分のみ除去）。
import fs from "node:fs";

// ---------- data.js 読み込み ----------
global.window = {};
await import("./data.js");
const RAW = global.window.INAGO_DATA;

// ---------- スコアリング（inago_offline.html と同一） ----------
const CFG = { volSma:20, range:60, ma:25, rsiP:14, quiet:3, rvolIgnite:1.8, quietRvolMax:1.3, breakoutPos:0.65,
  devHot:20, devExtreme:30, rsiHot:72, rsiExtreme:80, consecUpHot:5, upperWickHot:0.45, cost:0.2, gapSkip:8 };
const clamp = (x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,x));
const ramp = (x,a,b,max=100)=> b===a?(x>=b?max:0):clamp(((x-a)/(b-a))*max,0,max);
const smaAt = (arr,p,i)=>{ if(i+1<p) return null; let s=0; for(let k=i-p+1;k<=i;k++) s+=arr[k]; return s/p; };
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
  return { entryScore:Math.round(entryScore), heatScore:Math.round(heatScore), state, rvol, ignited, distribution };
}

// ---------- 実データ・ブリッジ ----------
function normCandles(arr){
  return (arr||[]).map(c=>({ date:String(c.date??c.t??c.time??c.Date??""), open:+(c.open??c.o??c.Open), high:+(c.high??c.h??c.High),
    low:+(c.low??c.l??c.Low), close:+(c.close??c.c??c.Close), volume:+(c.volume??c.v??c.Volume??0) })).filter(c=>isFinite(c.close)&&isFinite(c.open));
}
function getStock(code){ if(!RAW||!RAW.stocks||!RAW.stocks[code])return null; const s=RAW.stocks[code]; const cs=normCandles(s.candles||s); return cs.length?{code,name:s.name||code,candles:cs,since:s.since||null}:null; }
function listStocks(){ return (RAW&&RAW.stocks)?Object.keys(RAW.stocks):[]; }
function sinceIndex(candles,since){
  if(!since)return 0;
  const ts=Date.parse(since);
  if(!isNaN(ts)){const idx=candles.findIndex(c=>{const t=Date.parse(c.date);return !isNaN(t)&&t>=ts;});return idx<0?candles.length:idx;}
  const idx=candles.findIndex(c=>c.date===since); return idx<0?0:idx;
}
function dataSanity(stocks){
  const warns=[];
  stocks.forEach(st=>{const c=st.candles;const seen=new Set();let dup=0,jump=0;
    for(let i=0;i<c.length;i++){if(c[i].date){if(seen.has(c[i].date))dup++;else seen.add(c[i].date);}
      if(i>0&&c[i-1].close>0){const chg=Math.abs(c[i].close/c[i-1].close-1); if(chg>0.3)jump++;}}
    if(dup)warns.push(st.code+": 日付重複"+dup+"件");
    if(jump)warns.push(st.code+": 1日±30%超の異常足"+jump+"件（分割未調整の疑い）");
  });
  return warns;
}

// ---------- 市場レジーム（日付キー整合・P-5/P-9修正済み） ----------
let _MARKET=null;
function market(stocks){
  if(_MARKET) return _MARKET;
  const agg=new Map();
  stocks.forEach(st=>{const cl=st.candles.map(x=>x.close);st.candles.forEach((c,i)=>{const ma=smaAt(cl,25,i);if(ma==null)return;const e=agg.get(c.date)||{a:0,t:0};e.t++;if(c.close>=ma)e.a++;agg.set(c.date,e);});});
  const pct=new Map([...agg.keys()].map(d=>{const e=agg.get(d);return [d,e.t?e.a/e.t*100:null];}));
  const regimeAtDate=d=>{if(!pct.has(d))return null;const b=pct.get(d);return b==null?null: b>=55?"on": b<=45?"off":"neu";};
  _MARKET={regimeAtDate};
  return _MARKET;
}

// ---------- 集計（basis/episodeOnly/cost/gapSkip/since をパラメータ化） ----------
const STS=["初動候補","継続","過熱","出口","様子見"];
function compute(stocks, {N, basis, episodeOnly, cost, gapSkip, useSince}){
  const acc={}; STS.forEach(s=>acc[s]={n:0,hit:0,sum:0,mfe:0,mae:0,on:{n:0,hit:0,sum:0},off:{n:0,hit:0,sum:0},neu:{n:0,hit:0,sum:0}});
  const M = market(stocks);
  const need=Math.max(CFG.volSma,CFG.range,CFG.ma)+2;
  let skippedGap=0, episodesSkipped=0, totalBars=0;
  stocks.forEach(st=>{ const c=st.candles;
    const startAt = useSince ? Math.max(need, sinceIndex(c, st.since)) : need;
    let prevState=null;
    for(let i=startAt;i<c.length-N;i++){ const r=scoreAt(c,i); if(!r){ prevState=null; continue; }
      const isNew = r.state!==prevState; prevState=r.state;
      if(episodeOnly && !isNew){ episodesSkipped++; continue; }
      totalBars++;
      let base;
      if(basis==="nextOpen"){
        base=c[i+1].open;
        if(!isFinite(base)||base<=0) continue;
        const gap=(base/c[i].close-1)*100;
        if(gap>=gapSkip){ skippedGap++; continue; }
      } else { base=c[i].close; }
      let fwd=(c[i+N].close/base-1)*100;
      fwd-=cost;
      let mx=-1e9,mn=1e9; for(let k=i+1;k<=i+N;k++){ const hp=(c[k].high/base-1)*100,lp=(c[k].low/base-1)*100; if(hp>mx)mx=hp; if(lp<mn)mn=lp; }
      const a=acc[r.state]; a.n++; if(fwd>0)a.hit++; a.sum+=fwd; a.mfe+=mx; a.mae+=mn;
      const reg = c[i].date ? M.regimeAtDate(c[i].date) : null;
      if(reg){ const rb=a[reg]; rb.n++; rb.sum+=fwd; if(fwd>0)rb.hit++; }
    }
  });
  return {acc, skippedGap, episodesSkipped, totalBars};
}

function fmtTable(res){
  const exp=a=>a.n?a.sum/a.n:0;
  return STS.filter(s=>res.acc[s].n>0).map(s=>{ const a=res.acc[s]; const e=exp(a);
    return { state:s, n:a.n, winRate:+(a.hit/a.n*100).toFixed(1), exp:+e.toFixed(3), mfe:+(a.mfe/a.n).toFixed(2), mae:+(a.mae/a.n).toFixed(2) };
  });
}

// ============================================================
export { getStock, listStocks, dataSanity, compute, fmtTable, scoreAt, STS, CFG };

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g,"/") || process.argv[1].endsWith("compare_backtest.mjs")) {
  const stocks = listStocks().map(getStock).filter(Boolean);
  console.log(`\n=== ユニバース: ${stocks.length}銘柄 ===`);
  const sanity = dataSanity(stocks);
  console.log(`データ品質警告: ${sanity.length}件` + (sanity.length ? "（先頭5件: " + sanity.slice(0,5).join(" / ") + "）" : ""));

  const OLD = { basis:"sameClose", episodeOnly:false, cost:0, gapSkip:Infinity, useSince:false };
  const NEW = { basis:"nextOpen",  episodeOnly:true,  cost:0.2, gapSkip:8,      useSince:true  };

  for (const N of [3,5,10]) {
    console.log(`\n\n########## N=${N}日 ##########`);
    const oldRes = compute(stocks, {N, ...OLD});
    const newRes = compute(stocks, {N, ...NEW});
    console.log("--- 旧仕様（当日終値・エピソード非圧縮・コスト0・ギャップ除外なし） ---");
    console.table(fmtTable(oldRes));
    console.log("--- 新仕様（翌寄付・エピソード圧縮・コスト0.2%・ギャップ8%除外） ---");
    console.table(fmtTable(newRes));
    console.log(`ギャップ除外件数: ${newRes.skippedGap} / エピソード圧縮で除外: ${newRes.episodesSkipped}`);

    // 帰属分析: OLDから1つずつON
    console.log("--- 帰属分析（初動候補の期待値。OLDから1修正ずつON） ---");
    const base = compute(stocks, {N, ...OLD}).acc["初動候補"];
    const baseExp = base.n ? base.sum/base.n : 0;
    const variants = [
      ["P-1 翌寄化のみ", {...OLD, basis:"nextOpen"}],
      ["P-3 エピソード圧縮のみ", {...OLD, episodeOnly:true}],
      ["P-4 コスト0.2%のみ", {...OLD, cost:0.2}],
      ["P-6 ギャップ8%除外のみ", {...OLD, gapSkip:8, basis:"nextOpen"}], // ギャップ判定はnextOpen前提のため翌寄と併用
    ];
    const rows=[{ label:"OLD(基準)", n:base.n, exp:+baseExp.toFixed(3), delta:0 }];
    for (const [label, cfg] of variants) {
      const r = compute(stocks, {N, ...cfg}).acc["初動候補"];
      const e = r.n ? r.sum/r.n : 0;
      rows.push({ label, n:r.n, exp:+e.toFixed(3), delta:+(e-baseExp).toFixed(3) });
    }
    console.table(rows);
  }
}

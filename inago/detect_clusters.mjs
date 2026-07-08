// detect_clusters.mjs
// data.js（罫線アナライザーが書き出した window.INAGO_DATA）を読み、
// inago_daily.html と同一ロジックで「新テーマ候補（点火クラスタ）」を検知し clusters.json を出力。
// 実行: node detect_clusters.mjs [data.js]
import fs from "node:fs";
import vm from "node:vm";

const dataPath = process.argv[2] || "data.js";
if (!fs.existsSync(dataPath)) { console.error(`${dataPath} がありません`); process.exit(1); }

// data.js を window シム上で評価して INAGO_DATA を取り出す
const sandbox = { window: {}, console };
vm.createContext(sandbox);
try { vm.runInContext(fs.readFileSync(dataPath, "utf8"), sandbox); }
catch (e) { console.error("data.js の評価に失敗:", e.message); process.exit(1); }
const RAW = sandbox.window.INAGO_DATA;
if (!RAW || !RAW.stocks || !Object.keys(RAW.stocks).length) { console.error("INAGO_DATA.stocks が空です"); process.exit(1); }

/* ===== HTMLと同一の設定・スコアリング ===== */
const CFG = { volSma:20, range:60, ma:25, rsiP:14, quiet:3, rvolIgnite:1.8, quietRvolMax:1.3, breakoutPos:0.65, devHot:20, devExtreme:30, rsiHot:72, rsiExtreme:80, consecUpHot:5, upperWickHot:0.45 };
const K = 8, WIN = 20, TH = 0.55;          // 点火の遡及日数 / 相関窓 / 相関しきい値（HTMLと一致）
// 既知テーマ/セグメントのコード（inago_daily.html の THEMES/SEGMENTS と同期させること）
const KNOWN = new Set(["285A","4062","6857","8035","6146","6920","5801","5803","5802","6504","6508","6503","9501","9503","6367","1969",
  "1942","1944","1959","1812","7203","7267","7201","8306","8316","8411","8058","8031","8001","9432","9434","4307","2802","4502","2503","3382","8267","9983"]);

const clamp = (x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,x));
const ramp = (x,a,b,max=100)=> b===a?(x>=b?max:0):clamp(((x-a)/(b-a))*max,0,max);
const smaAt = (arr,p,i)=>{ if(i+1<p) return null; let s=0; for(let k=i-p+1;k<=i;k++) s+=arr[k]; return s/p; };
function rsiAt(c,p,i){ if(i<p) return 50; let g=0,l=0; for(let k=i-p+1;k<=i;k++){const d=c[k]-c[k-1]; if(d>=0)g+=d; else l-=d;} if(l===0) return 100; const rs=(g/p)/(l/p); return 100-100/(1+rs); }
function scoreAt(c,i){
  const need=Math.max(CFG.volSma,CFG.range,CFG.ma)+2; if(i<need) return null;
  const closes=c.map(x=>x.close),vols=c.map(x=>x.volume),cur=c[i];
  const volSma=smaAt(vols,CFG.volSma,i),rvol=volSma?cur.volume/volSma:1;
  let pr=0,n=0; for(let k=i-CFG.quiet;k<i;k++){const vs=smaAt(vols,CFG.volSma,k); if(vs){pr+=vols[k]/vs;n++;}}
  const priorRvol=n?pr/n:rvol;
  let hi=-Infinity,lo=Infinity; for(let k=i-CFG.range+1;k<=i;k++){if(c[k].high>hi)hi=c[k].high; if(c[k].low<lo)lo=c[k].low;}
  const rangePos=hi>lo?(cur.close-lo)/(hi-lo):0.5;
  const ma=smaAt(closes,CFG.ma,i),deviation=ma?((cur.close-ma)/ma)*100:0;
  const tr=(cur.high-cur.low)||1e-9,body=Math.abs(cur.close-cur.open);
  const bodyRatio=body/tr,upperWick=(cur.high-Math.max(cur.open,cur.close))/tr,closePos=(cur.close-cur.low)/tr,isBull=cur.close>=cur.open;
  let consecUp=0; for(let k=i;k>=0;k--){if(c[k].close>=c[k].open)consecUp++; else break;}
  const rsi=rsiAt(closes,CFG.rsiP,i);
  let v=ramp(rvol,1.2,3.0,60); const ignited=rvol>=CFG.rvolIgnite&&priorRvol<CFG.quietRvolMax; if(ignited)v+=40; else if(priorRvol>=2.0)v-=15; v=clamp(v);
  let p=ramp(rangePos,0.45,CFG.breakoutPos,100); if(deviation>CFG.devHot)p-=ramp(deviation,CFG.devHot,CFG.devExtreme,60); p=clamp(p);
  let cs=(isBull?35:0)+ramp(bodyRatio,0.3,0.7,35)+ramp(closePos,0.5,0.9,30)-ramp(upperWick,0.3,0.6,40); cs=clamp(cs);
  const entryScore=clamp(v*0.45+p*0.30+cs*0.25);
  let heat=ramp(deviation,CFG.devHot,CFG.devExtreme,40)+ramp(rsi,CFG.rsiHot,CFG.rsiExtreme,30)+ramp(consecUp,CFG.consecUpHot,CFG.consecUpHot+4,15);
  const distribution=rangePos>0.8&&rvol>2&&upperWick>CFG.upperWickHot&&bodyRatio<0.4; if(distribution)heat+=30;
  const heatScore=clamp(heat);
  let state; if(heatScore>=70)state="出口"; else if(heatScore>=45)state="過熱"; else if(entryScore>=65&&heatScore<35)state="初動候補"; else if(entryScore>=45)state="継続"; else state="様子見";
  return { entryScore:Math.round(entryScore), state, ignited };
}
const norm = arr => (arr||[]).map(c=>({
  open:+(c.open??c.o??c.Open), high:+(c.high??c.h??c.High), low:+(c.low??c.l??c.Low), close:+(c.close??c.c??c.Close), volume:+(c.volume??c.v??c.Volume??0)
})).filter(c=>isFinite(c.close)&&isFinite(c.open));
function retSeries(c,win){const s=c.slice(-(win+1));const o=[];for(let i=1;i<s.length;i++)o.push(s[i].close/s[i-1].close-1);return o;}
function pearson(a,b){const n=Math.min(a.length,b.length);if(n<5)return 0;let sa=0,sb=0;for(let i=0;i<n;i++){sa+=a[a.length-n+i];sb+=b[b.length-n+i];}sa/=n;sb/=n;let num=0,da=0,db=0;for(let i=0;i<n;i++){const x=a[a.length-n+i]-sa,y=b[b.length-n+i]-sb;num+=x*y;da+=x*x;db+=y*y;}const d=Math.sqrt(da*db);return d===0?0:num/d;}

/* ===== 検知 ===== */
const stocks = Object.entries(RAW.stocks).map(([code,s])=>({ code, name:s.name||code, candles:norm(s.candles||s) })).filter(s=>s.candles.length>=WIN+2);

const igniters=[];
for(const st of stocks){const c=st.candles;const i=c.length-1;const r=scoreAt(c,i);if(!r)continue;
  let recency=99; for(let d=0;d<=K;d++){const rr=scoreAt(c,i-d); if(rr&&rr.ignited){recency=d;break;}}
  const fresh=(r.state==="初動候補")||(recency<=K&&r.state!=="出口"&&r.state!=="過熱");
  if(fresh) igniters.push({code:st.code,name:st.name,entry:r.entryScore,recency:Math.min(recency,K+1),ret:retSeries(c,WIN)});
}
igniters.sort((a,b)=>b.entry-a.entry);

const used=new Set(),clusters=[];
for(const seed of igniters){ if(used.has(seed.code))continue; used.add(seed.code); const cl=[seed];
  for(const o of igniters){ if(used.has(o.code))continue; let s=0,cnt=0; cl.forEach(m=>{const r=pearson(m.ret,o.ret); if(isFinite(r)){s+=r;cnt++;}}); if(cnt&&s/cnt>=TH){cl.push(o);used.add(o.code);} }
  clusters.push(cl);
}
const newClusters=clusters.filter(cl=>cl.length>=2 && (cl.filter(m=>!KNOWN.has(m.code)).length/cl.length)>=0.5)
  .map(cl=>({members:cl.map(m=>({code:m.code,name:m.name}))}));

fs.writeFileSync("clusters.json", JSON.stringify(newClusters, null, 2));
console.log(`点火 ${igniters.length} 銘柄 / 新テーマ候補 ${newClusters.length} クラスタ → clusters.json`);
newClusters.forEach((c,i)=>console.log(`  [${String.fromCharCode(65+i)}] ${c.members.map(m=>m.name+"("+m.code+")").join("、")}`));

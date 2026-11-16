(()=>{(()=>{if(window.hatchrDesktop)return;try{if(localStorage.getItem("hatchr.splashSeen"))return;localStorage.setItem("hatchr.splashSeen","1")}catch{return}let d={en:["Setting up Hatchr\u2026","Loading your settings\u2026","Connecting to Solana\u2026","Warming up the AI\u2026","Getting your feed ready\u2026","All set!"],nl:["Hatchr wordt klaargezet\u2026","Je instellingen laden\u2026","Verbinden met Solana\u2026","De AI opwarmen\u2026","Je feed klaarmaken\u2026","Klaar!"],de:["Hatchr wird eingerichtet\u2026","Deine Einstellungen werden geladen\u2026","Verbindung zu Solana\u2026","Die KI wird vorbereitet\u2026","Dein Feed wird vorbereitet\u2026","Fertig!"],es:["Preparando Hatchr\u2026","Cargando tus ajustes\u2026","Conectando con Solana\u2026","Calentando la IA\u2026","Preparando tu feed\u2026","\xA1Listo!"]},a=d[(navigator.language||"en").slice(0,2).toLowerCase()]||d.en,s=5e3,m=`
#hxSplash { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(120% 80% at 50% 38%, #142019 0%, #0e0f12 62%); color: #f4f4f5;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
#hxSplash.out { animation: hxOut .6s ease forwards; pointer-events: none; }
.hx-stage { display: flex; flex-direction: column; align-items: center; }
.hx-eggwrap { width: 150px; height: 158px; transform-origin: 50% 88%; will-change: transform;
  animation: hxWob 1.6s .2s ease-in-out 2 both; }
#hxSplash.hatched .hx-eggwrap { animation: hxFloat 2.6s ease-in-out infinite; }
.hx-egg { width: 100%; height: 100%; overflow: visible; display: block; }
.hx-egg * { transform-box: view-box; }
.hx-lid { transform-origin: 58px 40px; }
.hx-glow { transform-origin: 64px 66px; opacity: 0; }
.hx-spark { opacity: 0; transform-box: fill-box; transform-origin: center; }
.hx-crack { stroke: #0e0f12; transition: stroke .25s; }
#hxSplash.hatched .hx-lid { animation: hxLid .9s cubic-bezier(.2,.9,.25,1.15) forwards; }
#hxSplash.hatched .hx-glow { animation: hxGlow 1s ease-out forwards; }
#hxSplash.hatched .hx-spark { animation: hxSpark 1.1s ease-out forwards; }
#hxSplash.hatched .hx-crack { stroke: #bbf7d0; }
.hx-name { font-weight: 800; font-size: 24px; letter-spacing: -.5px; margin-top: 6px; }
.hx-step { position: relative; height: 18px; width: 260px; margin-top: 6px; }
.hx-step span { position: absolute; inset: 0; text-align: center; font-weight: 600; font-size: 12.5px; color: #8e909b;
  transition: opacity .3s ease; white-space: nowrap; }
.hx-bar { width: 170px; height: 4px; border-radius: 99px; background: #23252b; overflow: hidden; margin-top: 12px; }
.hx-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #4ade80, #86efac);
  transform-origin: left center; transform: scaleX(0); will-change: transform;
  animation: hxFill ${s}ms cubic-bezier(.35,.55,.4,1) .15s forwards; }
@keyframes hxWob { 0%,55%,100% { transform: rotate(0) } 10% { transform: rotate(-8deg) } 20% { transform: rotate(7deg) }
  30% { transform: rotate(-5deg) } 40% { transform: rotate(3deg) } }
@keyframes hxFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes hxFill { to { transform: scaleX(1) } }
@keyframes hxOut { to { opacity: 0 } }
@keyframes hxLid { 0% { translate: 0 0; rotate: 0deg } 45% { translate: 8px -42px; rotate: 22deg } 70%,100% { translate: 6px -34px; rotate: 16deg } }
@keyframes hxGlow { 0% { opacity: 0; scale: .5 } 50% { opacity: 1; scale: 1.08 } 100% { opacity: .85; scale: 1 } }
@keyframes hxSpark { 0% { opacity: 0; translate: 0 0; scale: .3 } 18% { opacity: 1 } 80% { opacity: 0; translate: var(--dx) var(--dy); scale: 1.5 }
  100% { opacity: 0; translate: var(--dx) var(--dy) } }
@media (prefers-reduced-motion: reduce) { .hx-eggwrap, #hxSplash.hatched .hx-eggwrap, .hx-spark { animation: none !important; } }`,u=`<svg class="hx-egg" viewBox="-20 -40 168 176" aria-hidden="true"><defs>
<clipPath id="hxShell"><path d="M64 8C41 8 22 44 22 74c0 27 18 46 42 46s42-19 42-46C106 44 87 8 64 8z"/></clipPath>
<clipPath id="hxTop"><path d="M-40 -40H168V66L106 74 92 60 78 76 64 62 50 76 36 62 22 74-40 66z"/></clipPath>
<clipPath id="hxBot"><path d="M-40 66 22 74 36 62 50 76 64 62 78 76 92 60 106 74 168 66V168H-40z"/></clipPath>
<linearGradient id="hxGr" x1="30" y1="60" x2="100" y2="124" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86EFAC"/><stop offset="1" stop-color="#4ADE80"/></linearGradient>
<linearGradient id="hxWh" x1="40" y1="8" x2="90" y2="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9ECEF"/></linearGradient>
<radialGradient id="hxGl" cx="64" cy="66" r="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86EFAC" stop-opacity=".55"/><stop offset=".45" stop-color="#4ADE80" stop-opacity=".18"/><stop offset="1" stop-color="#4ADE80" stop-opacity="0"/></radialGradient>
<path id="hxStar" d="M0-8C.8-2.2 2.2-.8 8 0 2.2.8.8 2.2 0 8-.8 2.2-2.2.8-8 0-2.2-.8-.8-2.2 0-8z"/>
<path id="hxO" d="M64 8C41 8 22 44 22 74c0 27 18 46 42 46s42-19 42-46C106 44 87 8 64 8z"/>
<path id="hxZ" d="M14 70 22 74 36 62 50 76 64 62 78 76 92 60 106 74 114 70"/></defs>
<circle class="hx-glow" cx="64" cy="66" r="72" fill="url(#hxGl)"/>
<ellipse cx="64" cy="128" rx="30" ry="4.5" fill="#000" opacity=".45"/>
<g transform="rotate(-28 64 66)"><g clip-path="url(#hxBot)"><g clip-path="url(#hxShell)"><rect x="-40" y="-40" width="208" height="208" fill="url(#hxGr)"/>
<use class="hx-crack" href="#hxZ" fill="none" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></g>
<use href="#hxO" fill="none" stroke="#0e0f12" stroke-width="7"/></g></g>
<g class="hx-lid"><g transform="rotate(-28 64 66)"><g clip-path="url(#hxTop)"><g clip-path="url(#hxShell)"><rect x="-40" y="-40" width="208" height="208" fill="url(#hxWh)"/>
<ellipse cx="48" cy="34" rx="7" ry="13" fill="#fff" opacity=".9" transform="rotate(20 48 34)"/>
<use class="hx-crack" href="#hxZ" fill="none" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></g>
<use href="#hxO" fill="none" stroke="#0e0f12" stroke-width="7"/></g></g></g>
<g transform="translate(64 62)">
<use class="hx-spark" href="#hxStar" fill="#bbf7d0" style="--dx:-46px;--dy:-30px"/>
<use class="hx-spark" href="#hxStar" fill="#fff" style="--dx:44px;--dy:-40px;animation-delay:.04s"/>
<use class="hx-spark" href="#hxStar" fill="#86efac" style="--dx:-12px;--dy:-58px;animation-delay:.02s"/>
<use class="hx-spark" href="#hxStar" fill="#86efac" style="--dx:56px;--dy:-6px;animation-delay:.06s"/>
<use class="hx-spark" href="#hxStar" fill="#fff" style="--dx:-58px;--dy:2px;animation-delay:.03s"/>
<use class="hx-spark" href="#hxStar" fill="#bbf7d0" style="--dx:20px;--dy:-62px;animation-delay:.05s"/></g></svg>`,o=document.createElement("style");o.textContent=m,(document.head||document.documentElement).appendChild(o);let t=document.createElement("div");t.id="hxSplash",t.setAttribute("role","status"),t.setAttribute("aria-live","polite"),t.innerHTML=`<div class="hx-stage"><div class="hx-eggwrap">${u}</div><div class="hx-name">Hatchr</div><div class="hx-step"><span>${a[0]}</span><span style="opacity:0"></span></div><div class="hx-bar"><i></i></div></div>`,document.body.prepend(t);let i=t.querySelectorAll(".hx-step span"),n=0,p=e=>{let r=1-n;i[r].textContent=e,i[r].style.opacity="1",i[n].style.opacity="0",n=r},y=performance.now(),w=s/(a.length-1);for(let e=1;e<a.length-1;e++)setTimeout(()=>p(a[e]),w*e);let l=!1,x=!1,f=()=>{x||(x=!0,t.classList.add("hatched"))},h=()=>{let e=performance.now()-y;e>=1600&&(l||e>=3400)&&f()};addEventListener("hatchr-ready",()=>{l=!0,h()},{once:!0}),setTimeout(h,1600),setTimeout(h,3400);let g=!1,c=()=>{g||(g=!0,f(),p(a[a.length-1]),setTimeout(()=>{t.classList.add("out");let e=()=>{t.remove(),o.remove()};t.addEventListener("animationend",r=>{r.target===t&&e()}),setTimeout(e,900)},450))};setTimeout(()=>{l?c():(addEventListener("hatchr-ready",c,{once:!0}),setTimeout(c,8e3-s))},s+150)})();})();

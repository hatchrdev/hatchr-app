// First-run splash for the side panel. sidepanel.html loads this first thing in <body>, so it covers
// the panel before anything else paints. It plays once, the very first time the panel opens, for about
// five seconds: the egg wobbles, hatches once the panel has finished loading underneath, a bar fills up
// and a line of text says what's being set up. Everything that moves while the panel is still loading
// runs on the compositor (transform and opacity only), so it can't freeze while the panel does its work.
// The desktop app shows its own splash window, so it skips this one.
(() => {
  if (window.hatchrDesktop) return;
  try {
    if (localStorage.getItem("hatchr.splashSeen")) return;
    localStorage.setItem("hatchr.splashSeen", "1");
  } catch { return; }

  const STEPS = {
    en: ["Setting up Hatchr…", "Loading your settings…", "Connecting to Solana…", "Warming up the AI…", "Getting your feed ready…", "All set!"],
    nl: ["Hatchr wordt klaargezet…", "Je instellingen laden…", "Verbinden met Solana…", "De AI opwarmen…", "Je feed klaarmaken…", "Klaar!"],
    de: ["Hatchr wird eingerichtet…", "Deine Einstellungen werden geladen…", "Verbindung zu Solana…", "Die KI wird vorbereitet…", "Dein Feed wird vorbereitet…", "Fertig!"],
    es: ["Preparando Hatchr…", "Cargando tus ajustes…", "Conectando con Solana…", "Calentando la IA…", "Preparando tu feed…", "¡Listo!"],
  };
  const steps = STEPS[(navigator.language || "en").slice(0, 2).toLowerCase()] || STEPS.en;
  const DUR = 5000; // the bar takes this long to fill

  const css = `
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
  animation: hxFill ${DUR}ms cubic-bezier(.35,.55,.4,1) .15s forwards; }
@keyframes hxWob { 0%,55%,100% { transform: rotate(0) } 10% { transform: rotate(-8deg) } 20% { transform: rotate(7deg) }
  30% { transform: rotate(-5deg) } 40% { transform: rotate(3deg) } }
@keyframes hxFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes hxFill { to { transform: scaleX(1) } }
@keyframes hxOut { to { opacity: 0 } }
@keyframes hxLid { 0% { translate: 0 0; rotate: 0deg } 45% { translate: 8px -42px; rotate: 22deg } 70%,100% { translate: 6px -34px; rotate: 16deg } }
@keyframes hxGlow { 0% { opacity: 0; scale: .5 } 50% { opacity: 1; scale: 1.08 } 100% { opacity: .85; scale: 1 } }
@keyframes hxSpark { 0% { opacity: 0; translate: 0 0; scale: .3 } 18% { opacity: 1 } 80% { opacity: 0; translate: var(--dx) var(--dy); scale: 1.5 }
  100% { opacity: 0; translate: var(--dx) var(--dy) } }
@media (prefers-reduced-motion: reduce) { .hx-eggwrap, #hxSplash.hatched .hx-eggwrap, .hx-spark { animation: none !important; } }`;

  const egg = `<svg class="hx-egg" viewBox="-20 -40 168 176" aria-hidden="true"><defs>
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
<use class="hx-spark" href="#hxStar" fill="#bbf7d0" style="--dx:20px;--dy:-62px;animation-delay:.05s"/></g></svg>`;

  const style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  const el = document.createElement("div");
  el.id = "hxSplash";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<div class="hx-stage"><div class="hx-eggwrap">${egg}</div><div class="hx-name">Hatchr</div>`
    + `<div class="hx-step"><span>${steps[0]}</span><span style="opacity:0"></span></div><div class="hx-bar"><i></i></div></div>`;
  document.body.prepend(el);

  // the step line crossfades between two spans
  const spans = el.querySelectorAll(".hx-step span");
  let front = 0;
  const setStep = (text) => {
    const next = 1 - front;
    spans[next].textContent = text;
    spans[next].style.opacity = "1";
    spans[front].style.opacity = "0";
    front = next;
  };
  const start = performance.now();
  const per = DUR / (steps.length - 1);
  for (let i = 1; i < steps.length - 1; i++) setTimeout(() => setStep(steps[i]), per * i);

  // hatch once the panel underneath has loaded (so the main thread is free), but not before ~1.6s
  // and no later than ~3.4s
  let ready = false, hatched = false;
  const hatch = () => { if (!hatched) { hatched = true; el.classList.add("hatched"); } };
  const tryHatch = () => { const t = performance.now() - start; if (t >= 1600 && (ready || t >= 3400)) hatch(); };
  addEventListener("hatchr-ready", () => { ready = true; tryHatch(); }, { once: true });
  setTimeout(tryHatch, 1600);
  setTimeout(tryHatch, 3400);

  // when the bar is full: "All set!", then fade out and reveal the panel
  let gone = false;
  const finish = () => {
    if (gone) return;
    gone = true;
    hatch();
    setStep(steps[steps.length - 1]);
    setTimeout(() => {
      el.classList.add("out");
      const remove = () => { el.remove(); style.remove(); };
      el.addEventListener("animationend", (e) => { if (e.target === el) remove(); });
      setTimeout(remove, 900);
    }, 450);
  };
  // wait for the panel too if it's slow, but never longer than 8 seconds in total
  setTimeout(() => { if (ready) finish(); else { addEventListener("hatchr-ready", finish, { once: true }); setTimeout(finish, 8000 - DUR); } }, DUR + 150);
})();

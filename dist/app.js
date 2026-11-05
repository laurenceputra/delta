import { APP_VERSION, BUILD_ID } from './version.js';
import { Tracker, sampleAt, roadLengthM } from './engine.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['clock','appVersion','updateNotice','updateButton','themeSelect','wakeButton','settingsButton','safetyGate','parkedButton','demoSettings','speedWarning','deltaLabel','infoDrawer','closeInfoButton','drawerBackdrop','modeBadge','signalText','signalDot','setupPanel','liveButton','demoButton','drivePanel','changeModeButton','roadRef','roadDirection','instrumentGrid','speedStatus','speedValue','speedTrackFill','limitValue','limitContext','limitHeading','deltaValue','deltaDescription','exitList','elapsedValue','accuracyValue','updatedValue','roadNote','trackingDiagnostics','completedSummary','completedSummaryText','exitsTitle','demoControls','demoRoad','demoDirection','demoSpeed','demoSpeedOutput','demoPlayButton','networkText','coverageText','sourceText'].map(id => [id,$(id)]));
const STALE_MS = 15000;
const colorScheme=matchMedia('(prefers-color-scheme: dark)');
function applyTheme(choice){const resolved=choice==='system'?(colorScheme.matches?'dark':'light'):choice;document.documentElement.dataset.theme=resolved;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',resolved==='light'?'#e8efe5':'#101411');ui.themeSelect.value=choice;}
function initTheme(){let choice='system';try{choice=localStorage.getItem('delta-theme')||'system';}catch{}if(!['system','light','dark'].includes(choice))choice='system';applyTheme(choice);ui.themeSelect.addEventListener('change',()=>{try{localStorage.setItem('delta-theme',ui.themeSelect.value);}catch{}applyTheme(ui.themeSelect.value);});colorScheme.addEventListener('change',()=>{if(ui.themeSelect.value==='system')applyTheme('system');});}
let parkedConfirmed=false, dataReady=false;
let lastKnownEntryTime=null;
let roadsData, combinedData, tracker, mode = 'ready', watchId = null, staleTimer = null, demoTimer = null, demoRoad = null, demoChain = [], demoDistance = 0, demoClock = 0, lastDelta = null, demoPaused = false, lastFixTime = 0, wakeLock = null, lastFocus = null, lastRenderedFix = null;
const roadList = () => roadsData?.roads || [];
const fmtTime = seconds => { const n=Math.max(0,Math.floor(seconds || 0)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; };
const fmtDistance = m => m >= 1000 ? `${(m/1000).toFixed(m < 10000 ? 1 : 0)} km` : `${Math.max(0,Math.round(m/10)*10)} m`;
const fmtSigned = n => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}`;

function setSignal(message, tone='') { ui.signalText.textContent=message; ui.signalDot.className=`signal-dot ${tone}`; }
function setMode(next) { mode=next; ui.setupPanel.hidden=next!=='ready'; ui.drivePanel.hidden=next==='ready'; ui.demoControls.hidden=next!=='demo';ui.demoSettings.hidden=next!=='demo'; ui.modeBadge.textContent=next==='demo'?'DEMO · SIMULATED':next==='live'?'LIVE LOCATION':'READY'; ui.modeBadge.classList.toggle('demo',next==='demo'); }
function clearSession() { if(watchId!==null){navigator.geolocation?.clearWatch(watchId);watchId=null;} clearInterval(staleTimer);clearInterval(demoTimer);staleTimer=demoTimer=null; lastFixTime=0;lastDelta=null;lastKnownEntryTime=null;lastRenderedFix=null; tracker?.reset(); demoPaused=false; ui.demoPlayButton.textContent='Pause demo'; }
function resetDashboard() { ui.trackingDiagnostics.textContent='Waiting for a reliable road match.';ui.completedSummary.hidden=true;ui.roadRef.parentElement.classList.remove('transition-heading');ui.roadRef.textContent='—';ui.roadDirection.textContent='Locating road';ui.speedValue.textContent='—';ui.speedStatus.textContent='—';ui.speedTrackFill.style.width='0%';ui.limitHeading.textContent='CURRENT LIMIT';ui.limitValue.textContent='UNKNOWN';ui.limitContext.textContent='MAP DATA UNAVAILABLE';ui.deltaValue.textContent='—';ui.deltaValue.classList.remove('behind','held');ui.deltaLabel.textContent='REFERENCE INACTIVE';ui.speedWarning.classList.remove('is-visible');ui.speedWarning.setAttribute('aria-hidden','true');ui.speedValue.classList.remove('overspeed');ui.deltaDescription.textContent='Waiting for a known road limit';ui.exitsTitle.textContent='Next exits';ui.exitList.innerHTML='<li class="empty-exits">Upcoming exits will appear when the road is identified.</li>';ui.elapsedValue.textContent='00:00';ui.accuracyValue.textContent='—';ui.updatedValue.textContent='—';ui.completedSummary.hidden=true;ui.completedSummaryText.textContent='';ui.roadNote.textContent='Road and speed data may be incomplete. Follow signs and road conditions.'; }
function refreshHeldAge(state){
  if(!['held','recovering','unresolved'].includes(state?.deltaStatus)||!Number.isFinite(state?.lastValidDeltaSeconds))return;
  const seconds=Number.isFinite(state.lastValidDeltaAt)?Math.max(0,Math.floor((Date.now()-state.lastValidDeltaAt)/1000)):null;
  const age=seconds===null?'':` · ${seconds}s ago`;
  ui.deltaLabel.textContent=`LAST KNOWN${age}`;
  ui.deltaDescription.textContent=`${state.deltaStatus==='recovering'?'Checking GPS route':state.deltaStatus==='unresolved'?'Route unresolved':'GPS unavailable'} · frozen pace${age}`;
}
function formatCompletedSession(session){
  const elapsed=Number.isFinite(session.elapsedSeconds)?fmtTime(session.elapsedSeconds):'—';
  const final=Number.isFinite(session.finalDeltaSeconds)?`${fmtSigned(session.finalDeltaSeconds)} seconds final estimated pace`:
    Number.isFinite(session.lastValidDeltaSeconds)?`${fmtSigned(session.lastValidDeltaSeconds)} seconds last known`:'pace unavailable';
  const boundary=session.finalTimingStatus==='estimated-boundary'&&Number.isFinite(session.exitTime)?
    ` Mapped exit crossing estimated at ${new Date(session.exitTime).toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}; not an official enforcement boundary.`:
    ' Exit crossing time unavailable; session timing is incomplete.';
  const assumed=session.cumulativeReferenceAssumed?' Some reference sections used an assumed 50 km/h limit.':'';
  return `Session ${session.sessionId||'completed'} · ${elapsed} since estimated entry · ${final}.${boundary}${assumed}`;
}
function rampLabel(transition){
  if(!transition)return null;
  const from=transition.originRef||transition.fromRef;
  const to=transition.destinationRef||transition.toRef;
  const pending=transition.confidence!=='confirmed';
  if(transition.classification==='joining')return `${pending?'Possible entry to':'Joining'} ${to||'expressway'}`;
  if(transition.classification==='leaving')return `${pending?'Possible exit from':'Leaving'} ${from||'expressway'}`;
  if(transition.classification==='transfer'){
    if(from&&to&&from===to)return `${from} connector`;
    return `${pending?'Possible transfer to':'Transfer to'} ${to||'expressway'}`;
  }
  return 'Ramp — direction unconfirmed';
}
function render(state, fix) {
  if(fix)lastRenderedFix=fix;
  lastKnownEntryTime=state?.entryTime??null;const road=state?.visualRoad||state?.road;const visualAway=!!state?.visualRoad&&(!road.isExpressway||road.id!==state?.road?.id);const freshCurrentDelta=state?.status==='tracking'&&Number.isFinite(state?.deltaSeconds)&&!visualAway;const retained=freshCurrentDelta?null:state?.previousDelta;const held=['held','recovering','unresolved'].includes(state?.deltaStatus);const heldValue=held&&!visualAway&&Number.isFinite(state?.lastValidDeltaSeconds)&&!retained;
  const transitionText=freshCurrentDelta?null:rampLabel(state?.rampTransition);ui.roadRef.textContent=transitionText||road?.ref||(road?.kind==='ramp'&&road?.name==='Unnamed road'?'Ramp':road?.name)||'Road unidentified';ui.roadRef.title=ui.roadRef.textContent;ui.roadRef.parentElement.classList.toggle('transition-heading',!!transitionText);
  ui.roadRef.parentElement.classList.toggle('local-road',!road?.isExpressway);
  ui.roadDirection.textContent=state?.provisional?'Provisional · awaiting confirmation':road ? [road.ref?road.name:null,road.travelDirection||road.direction,road.kind==='ramp'?'Ramp':null,state?.candidateRoad?`Checking ${state.candidateRoad.name||'new road'}`:null].filter(Boolean).join(' · ') : (state?.status==='gap'?'Outside mapped coverage':'Locating road');
  ui.roadDirection.title=ui.roadDirection.textContent;const currentSpeed=state?.visualSpeedKmh??state?.speedKmh;ui.speedValue.textContent=Number.isFinite(currentSpeed)?Math.round(currentSpeed):'—';
  ui.speedStatus.textContent=road?.kind==='ramp'?'RAMP':road?.kind==='local'?'LOCAL ROAD':state?.status==='tracking'?`MAINLINE · ${(state.confidence||'unknown').toUpperCase()}`:(state?.status||'IDENTIFYING').toUpperCase();
  ui.speedTrackFill.style.width=Number.isFinite(currentSpeed)?`${Math.min(100,Math.max(0,currentSpeed/120*100))}%`:'0%';
  const delta=state?.deltaSeconds;
  const displayDelta=Number.isFinite(retained?.value)?retained.value:freshCurrentDelta?delta:heldValue?state.lastValidDeltaSeconds:null;
  ui.deltaValue.textContent=Number.isFinite(displayDelta)?fmtSigned(displayDelta):'—';
  ui.deltaValue.style.setProperty('--delta-scale', String(Math.min(1,4/ui.deltaValue.textContent.length)));
  ui.deltaValue.classList.toggle('behind',freshCurrentDelta&&!held&&delta<-.05);
  ui.deltaValue.classList.toggle('held',heldValue||!!retained);
  ui.deltaLabel.textContent=retained?`PREVIOUS ${retained.sourceRef||'ROAD'} DELTA`:heldValue?'LAST KNOWN':state?.provisional?'ENTRY RECORDED':freshCurrentDelta?`${delta<-.05?'DELTA NEGATIVE':delta>.05?'DELTA POSITIVE':'ON REFERENCE'}${state.cumulativeReferenceAssumed?' · ASSUMED':''}`:'REFERENCE INACTIVE';
  ui.deltaLabel.title=state?.cumulativeReferenceAssumed?'Timing includes an assumed 50 km/h reference on a traveled section':'';
  const currentLimit=state?.visualLimitKmh??state?.limitKmh;const overspeed=Number.isFinite(currentSpeed)&&Number.isFinite(currentLimit)&&currentSpeed>currentLimit;ui.speedWarning.classList.toggle('is-visible',overspeed);ui.speedWarning.setAttribute('aria-hidden',String(!overspeed));ui.speedValue.classList.toggle('overspeed',overspeed);
  const displayedLimit=state?.visualRoad?currentLimit:held?(Number.isFinite(state?.lastKnownLimitKmh)?state.lastKnownLimitKmh:null):currentLimit;
  ui.limitHeading.textContent=held&&!state?.visualRoad&&Number.isFinite(displayedLimit)?'LAST KNOWN LIMIT':'CURRENT LIMIT';
  ui.limitValue.textContent=Number.isFinite(displayedLimit)?`${Math.round(displayedLimit)} KM/H`:'UNKNOWN';
  ui.limitContext.textContent=Number.isFinite(displayedLimit)?`${held&&!state?.visualRoad?'LAST KNOWN · ':''}${(state?.visualRoad?state.visualLimitAssumed:held?state.lastKnownLimitAssumed:state.limitAssumed)?'ASSUMED REFERENCE':'MAPPED LIMIT'}${!held&&!state?.visualRoad&&state.limitUncertain?' · UNCERTAIN':''}`:'MAP DATA UNAVAILABLE';
  ui.speedWarning.textContent=(state?.visualRoad?state.visualLimitAssumed:state?.limitAssumed)?'ABOVE ASSUMED REFERENCE · CHECK SIGNS':'ABOVE MAPPED LIMIT · CHECK ROAD SIGNS';
  ui.deltaDescription.textContent=retained?`Retained for recovery · ${Math.max(0,Math.min(30,Math.ceil((retained.expiresAt-Date.now())/1000)))}s left`:heldValue?'GPS unavailable · last valid pace held':state?.provisional?'Entry recorded — awaiting GPS':freshCurrentDelta?`${delta<0?'Ahead of reference pace · ease off if needed':delta>0?'Behind reference pace':'At reference pace'}${state.cumulativeReferenceAssumed?' · includes assumed limits':''}`:state?.reconstructionStatus==='pending'?'Checking route · pace paused':state?.reconstructionStatus==='unresolved'?'Full-session pace unavailable':state?.status==='local'||road?.kind==='ramp'?'Expressway only':'Identifying road';
  if(!retained)refreshHeldAge(state);
  ui.elapsedValue.textContent=fmtTime(state?.elapsedClockSeconds??state?.elapsedSeconds);
  ui.accuracyValue.textContent=Number.isFinite(fix?.accuracy)?`±${Math.round(fix.accuracy)} m`:'—';
  ui.updatedValue.textContent=fix?.timestamp?new Date(fix.timestamp).toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
  const exits=(held?(state?.heldExits||[]):(state?.exits||[])).slice(0,3);ui.exitsTitle.textContent=held&&exits.length?'Last known exits':'Next exits';
  ui.exitList.replaceChildren();
  if(!exits.length){const li=document.createElement('li');li.className='empty-exits';li.textContent=road?'Exits available on confirmed expressway mainlines.':'Upcoming exits will appear when the road is identified.';ui.exitList.append(li);}
  for(const exit of exits){const li=document.createElement('li');const name=document.createElement('span');name.className='exit-name';name.textContent=exit.name||exit.ref||'Exit';const dist=document.createElement('span');dist.className='exit-distance';dist.textContent=Number.isFinite(exit.distanceM)?`${fmtDistance(exit.distanceM)}${held?' · stale':''}`:'—';const deltaEl=document.createElement('span');deltaEl.className='exit-delta';deltaEl.textContent=!held&&Number.isFinite(exit.projectedDeltaSeconds)?`${fmtSigned(exit.projectedDeltaSeconds)}s est.`:'—';deltaEl.classList.toggle('ahead',!held&&exit.projectedDeltaSeconds<0);deltaEl.title=exit.referenceAssumed?'Forecast includes an assumed 50 km/h reference':'Estimated pace at exit';li.append(name,dist,deltaEl);ui.exitList.append(li);}
  ui.completedSummary.hidden=!state?.completedSession;ui.completedSummaryText.textContent=state?.completedSession?formatCompletedSession(state.completedSession):'';
  ui.roadNote.textContent=retained?`Current ${road?.kind==='ramp'?'ramp':'road'} shown · previous ${retained.sourceRef||'expressway'} pace retained briefly for route recovery.`:state?.provisional?'Provisional mainline detection · GPS confirmation pending.':state?.reconstructionStatus==='pending'?'Checking route through GPS gap · pace paused.':state?.reconstructionStatus==='unresolved'?'Route through GPS gap unresolved · full-session pace unavailable.':state?.reconstructionStatus==='reconstructed'?'Mapped route across GPS gap reconstructed · estimated pace.':state?.reason||(state?.status==='tracking'?state.fullSessionAvailable===false?'Session clock from first detection · pace segment since reacquisition.':state.entrySource==='mapped-ramp-boundary-estimate'?'Tracking since estimated mapped ramp entry. Follow current signs.':'Tracking since estimated first mainline fix. Follow current signs.':state?.candidateRoad?'Checking road change · timing paused.':state?.status==='stale'?'Location lost · last known road shown. Pace unavailable; session clock continues.':road?.kind==='ramp'?'Ramp detected · expressway timing inactive.':state?.status==='local'?'Local road · speed only. Expressway timing inactive.':'Identifying road · expressway timing inactive.');ui.trackingDiagnostics.textContent=state?.entryTime?`${state.provisional?'Provisional first mainline detection':state.entrySource==='mapped-ramp-boundary-estimate'?'Estimated mapped ramp entry':'Estimated first mainline detection'}: ${new Date(state.entryTime).toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}. ${state.entrySource==='mapped-ramp-boundary-estimate'?'Source: mapped ramp boundary bracketed by GPS fixes; not an official enforcement boundary.':'Source: first reliable mainline fix, not a physical ramp crossing.'} ${state?.provisional?'No physical entrance boundary is proven. Elapsed clock is provisional from first credible fix; pace and exits remain unavailable until confirmation.':state?.reconstructionStatus==='pending'?'Reconstructing mapped route across a GPS gap; pace and exits withheld until confirmed.':state?.reconstructionStatus==='unresolved'?'Route across GPS gap unresolved; first entry clock retained but full-session pace unavailable.':state?.reconstructionStatus==='reconstructed'?'Unique mapped route across GPS gap reconstructed; full-session pace remains estimated.':state?.status==='stale'?'GPS signal lost; current speed and pace unavailable while the session clock continues.':state.fullSessionAvailable===false?'Full-session pace comparison unavailable after GPS gap; current pace is since reacquisition.':'Full-session pace comparison continues on a uniquely connected route.'} ${state.cumulativeReferenceAssumed?'Some traveled sections use an assumed 50 km/h timing reference.':''} ${state.entryUncertaintyMs?`Entry uncertainty about ${Math.round(state.entryUncertaintyMs/1000)} seconds.`:''}`:state?.candidateRoad?`Checking ${state.candidateRoad.name||'new road'}; time and exits paused until confirmed.`:state?.status==='stale'?'GPS signal lost. Last known road retained; speed and pace unavailable. Elapsed session time continues from first detection.':'Waiting for a reliable road match.';
  if(state?.rampTransition){const transition=state.rampTransition;const boundary=transition.boundary;const crossing=boundary?.timing==='estimated'&&Number.isFinite(boundary.estimatedTime)?`Mapped crossing estimated at ${new Date(boundary.estimatedTime).toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}${Number.isFinite(boundary.uncertaintyMs)?` (about ±${Math.ceil(boundary.uncertaintyMs/1000)}s)`:''}; this is not an official enforcement boundary.`:'Mapped boundary location is unobserved; no crossing time is inferred.';const details=`${transitionText}. Map-derived ramp direction is ${transition.confidence==='confirmed'?'confirmed from observed travel':'provisional until travel confirms it'}. ${crossing}`;ui.trackingDiagnostics.textContent=`${details} ${ui.trackingDiagnostics.textContent}`;}
  if(mode==='live') setSignal(state?.status==='tracking'?`Live location · ${state.timingBasis||'since detection'} · estimated`:state?.status==='local'?'Live location · local road':state?.status==='entering'?'Live location · confirming expressway':state?.status==='exiting'?'Live location · leaving expressway':'Live location · identifying road',state?.status==='tracking'?'good':'warn');
}
function onFix(position){ if(mode!=='live')return; const c=position.coords;const fix={latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,heading:c.heading,speed:c.speed,timestamp:position.timestamp};try{const state=tracker.update(fix);if(state?.acceptedFix)lastFixTime=Date.now();render(state,fix);}catch(err){setSignal('Road data unavailable','warn');console.error(err);} }
function invalidateLocation(message){const state=tracker?.invalidate(message,true);if(state)render(state,null);else resetDashboard();ui.speedStatus.textContent='NO SIGNAL';setSignal(`${message} · ${state?.provisional?'provisional road':'last known road'}`, 'warn');}
function onLocationError(err){ if(mode!=='live')return;const text=err.code===1?'Location permission denied':err.code===2?'Location temporarily unavailable':'Location timed out';invalidateLocation(text); }
function startLive(){if(!parkedConfirmed)return;closeInfoIfOpen();clearSession();resetDashboard();setMode('live');setSignal('Requesting precise location…','warn');if(!roadsData||!tracker){setSignal('Road data unavailable · reload to retry','warn');return;}if(!navigator.geolocation){setSignal('Location unavailable in this browser','warn');return;}watchId=navigator.geolocation.watchPosition(onFix,onLocationError,{enableHighAccuracy:true,maximumAge:0,timeout:12000});staleTimer=setInterval(()=>{if(mode!=='live')return;const before=tracker?.state?.previousDelta;const state=tracker?.tick(Date.now());if(before||state?.previousDelta)render(state,lastRenderedFix);if(lastKnownEntryTime)ui.elapsedValue.textContent=fmtTime((Date.now()-lastKnownEntryTime)/1000);refreshHeldAge(state);if(lastFixTime&&Date.now()-lastFixTime>STALE_MS){lastFixTime=0;invalidateLocation('Location stale · waiting for signal');ui.speedStatus.textContent='STALE';}},1000);requestWake();}
function roadKey(road){return road.id||`${road.ref}|${road.direction}|${road.name}`;}
function buildDemoChains(ref){const byId=new Map(roadList().map(r=>[r.id,r]));return (roadsData.chains||[]).filter(c=>c.ref===ref).sort((a,b)=>b.lengthM-a.lengthM).slice(0,2).map(meta=>{const chain=[],seen=new Set();let road=byId.get(meta.firstRoadId);while(road&&!seen.has(road.id)&&road.chainId===meta.id){chain.push(road);seen.add(road.id);road=byId.get(road.nextRoadIds?.[0]);}chain.demoDirection=meta.travelDirection;return chain;});}
function populateDemo(){const refs=[...new Set(roadList().map(r=>r.ref).filter(Boolean))].sort();ui.demoRoad.replaceChildren(...refs.map(ref=>new Option(ref,ref)));if(refs.includes('BKE'))ui.demoRoad.value='BKE';updateDemoDirections();}
function updateDemoDirections(){const chains=buildDemoChains(ui.demoRoad.value);ui.demoDirection.replaceChildren(...chains.map((chain,i)=>new Option(`${{N:'Northbound',S:'Southbound',E:'Eastbound',W:'Westbound'}[chain.demoDirection]||'Direction'} · ${Math.round(chain.reduce((n,r)=>n+roadLengthM(r),0)/1000)} km`,String(i))));ui.demoDirection._chains=chains;selectDemoRoad();}
function selectDemoRoad(){demoChain=ui.demoDirection._chains?.[Number(ui.demoDirection.value)]||[];demoRoad=demoChain[0]||null;demoDistance=0;demoClock=Date.now();tracker?.reset();lastDelta=null;tickDemo(0);}
function tickDemo(seconds=1){if(mode!=='demo'||!demoRoad||demoPaused)return;const speed=Number(ui.demoSpeed.value);ui.demoSpeedOutput.value=`${speed} km/h`;const length=demoChain.reduce((n,r)=>n+roadLengthM(r),0);if(Number.isFinite(length)&&length>0)demoDistance=(demoDistance+speed/3.6*seconds)%length;let remaining=demoDistance,segment=demoChain[0];for(const road of demoChain){const n=roadLengthM(road);if(remaining<=n){segment=road;break;}remaining-=n;}const point=sampleAt(segment,remaining);if(!point)return;if(seconds>0)demoClock+=seconds*1000;const fix={...point,accuracy:5,speed:speed/3.6,timestamp:demoClock};try{render(tracker.update(fix),fix);}catch(err){setSignal('Demo road unavailable','warn');console.error(err);}setSignal('DEMO · simulated location','good');}
function startDemo(){if(!parkedConfirmed)return;closeInfoIfOpen();clearSession();resetDashboard();setMode('demo');if(!roadsData||!tracker){setSignal('Road data unavailable · reload to retry','warn');return;}populateDemo();demoTimer=setInterval(()=>tickDemo(1),1000);}
function showReady(){closeInfoIfOpen();clearSession();setMode('ready');setSignal('Choose a mode to begin');resetDashboard();}
async function requestWake(){if(!('wakeLock'in navigator)||document.visibilityState!=='visible'||mode==='ready')return;try{wakeLock=await navigator.wakeLock.request('screen');ui.wakeButton.setAttribute('aria-pressed','true');ui.wakeButton.textContent='Screen awake: on';wakeLock.addEventListener('release',()=>{wakeLock=null;ui.wakeButton.setAttribute('aria-pressed','false');ui.wakeButton.textContent='Screen awake: off';});}catch{ui.wakeButton.setAttribute('aria-pressed','false');ui.wakeButton.textContent='Screen awake unavailable';}}
async function toggleWake(){if(wakeLock){await wakeLock.release();wakeLock=null;}else await requestWake();}
function openInfo(){lastFocus=document.activeElement;ui.drawerBackdrop.hidden=false;ui.infoDrawer.hidden=false;ui.infoDrawer.scrollTop=0;ui.settingsButton.setAttribute('aria-expanded','true');ui.infoDrawer.focus();}
function closeInfoIfOpen(){if(!ui.infoDrawer.hidden)closeInfo();}
function closeInfo(){ui.drawerBackdrop.hidden=true;ui.infoDrawer.hidden=true;ui.settingsButton.setAttribute('aria-expanded','false');lastFocus?.focus();}
function syncVisibleHeight(){const height=window.visualViewport?.height||window.innerHeight;document.documentElement.style.setProperty('--visible-height',`${Math.round(height)}px`);}
function initEvents(){initTheme();syncVisibleHeight();window.visualViewport?.addEventListener('resize',syncVisibleHeight);window.addEventListener('resize',syncVisibleHeight);ui.parkedButton.addEventListener('click',()=>{parkedConfirmed=true;ui.safetyGate.hidden=true;if(dataReady)startLive();else setSignal('Loading Singapore road names…','warn');});if(!('wakeLock'in navigator)){ui.wakeButton.disabled=true;ui.wakeButton.textContent='Screen awake unavailable';}ui.liveButton.addEventListener('click',startLive);ui.demoButton.addEventListener('click',startDemo);ui.changeModeButton.addEventListener('click',showReady);ui.demoRoad.addEventListener('change',updateDemoDirections);ui.demoDirection.addEventListener('change',selectDemoRoad);ui.demoSpeed.addEventListener('input',()=>{ui.demoSpeedOutput.value=`${ui.demoSpeed.value} km/h`;});ui.demoPlayButton.addEventListener('click',()=>{demoPaused=!demoPaused;ui.demoPlayButton.textContent=demoPaused?'Resume demo':'Pause demo';setSignal(demoPaused?'DEMO · paused':'DEMO · simulated location',demoPaused?'warn':'good');});ui.wakeButton.addEventListener('click',toggleWake);ui.settingsButton.addEventListener('click',openInfo);ui.closeInfoButton.addEventListener('click',closeInfo);ui.drawerBackdrop.addEventListener('click',closeInfo);document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!ui.infoDrawer.hidden)closeInfo();if(e.key==='Tab'&&!ui.infoDrawer.hidden){const focusable=[...ui.infoDrawer.querySelectorAll('button,a,[tabindex]:not([tabindex="-1"])')];if(e.shiftKey&&document.activeElement===focusable[0]){e.preventDefault();focusable.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===focusable.at(-1)){e.preventDefault();focusable[0]?.focus();}}});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&mode!=='ready'&&!wakeLock)requestWake();});window.addEventListener('pagehide',()=>{clearSession();wakeLock?.release();});window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);}
function updateNetwork(){ui.networkText.textContent=navigator.onLine?'LOCAL SESSION':'OFFLINE · LOCAL SESSION';}
function updateClock(){ui.clock.textContent=new Date().toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit',hour12:false});}
let updateRequested=false, updateRegistration=null, lastUpdateCheck=0, updateReloaded=false;
function showWaitingUpdate(registration){
  if(!navigator.serviceWorker.controller||!registration.waiting)return;
  updateRegistration=registration;
  ui.updateNotice.hidden=false;
  ui.settingsButton.setAttribute('aria-label','Settings and information · update ready');
  ui.settingsButton.classList.add('has-update');
}
async function checkForAppUpdate(force=false){
  if(!updateRegistration||!navigator.onLine)return;
  const now=Date.now();if(!force&&now-lastUpdateCheck<15*60*1000)return;
  lastUpdateCheck=now;
  try{await updateRegistration.update();showWaitingUpdate(updateRegistration);}catch{} // Stay on the installed version offline.
}
function reloadAfterApprovedUpdate(){if(updateRequested&&!updateReloaded){updateReloaded=true;location.reload();}}
function setupServiceWorker(){
  if(!('serviceWorker'in navigator))return;
  navigator.serviceWorker.addEventListener('controllerchange',reloadAfterApprovedUpdate);
  ui.updateButton.addEventListener('click',()=>{
    const waiting=updateRegistration?.waiting;
    if(!waiting)return;
    updateRequested=true;ui.updateButton.disabled=true;ui.updateButton.textContent='Updating…';
    waiting.addEventListener('statechange',()=>{if(waiting.state==='activated')reloadAfterApprovedUpdate();});
    waiting.postMessage({type:'SKIP_WAITING'});
  });
  navigator.serviceWorker.register('./sw.js').then(registration=>{
    updateRegistration=registration;
    showWaitingUpdate(registration);
    registration.addEventListener('updatefound',()=>{
      const installing=registration.installing;
      installing?.addEventListener('statechange',()=>{
        if(installing.state==='installed')showWaitingUpdate(registration);
      });
    });
    checkForAppUpdate(true);
  }).catch(()=>{});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkForAppUpdate();});
  window.addEventListener('online',()=>checkForAppUpdate(true));
}
async function init(){initEvents();ui.appVersion.textContent=`v${APP_VERSION} · build ${BUILD_ID}`;setupServiceWorker();updateClock();setInterval(updateClock,15000);updateNetwork();try{setSignal('Loading Singapore road names…','warn');const response=await fetch('./data/roads.json');if(!response.ok)throw new Error(`Road data ${response.status}`);roadsData=await response.json();let localData={roads:[]};try{if('DecompressionStream'in window){const compressed=await fetch('./data/local-roads.json.gz');if(!compressed.ok)throw new Error('Compressed road data unavailable');localData=await new Response(compressed.body.pipeThrough(new DecompressionStream('gzip'))).json();}else{const plain=await fetch('./data/local-roads.json');if(!plain.ok)throw new Error('Local road data unavailable');localData=await plain.json();}}catch(error){const plain=await fetch('./data/local-roads.json');if(!plain.ok)throw new Error('Local road data unavailable');localData=await plain.json();}combinedData={...roadsData,localRoads:localData.roads||[]};tracker=new Tracker(combinedData);const meta=roadsData.metadata||{};ui.coverageText.textContent=`Coverage includes ${new Set(roadList().map(r=>r.ref)).size} expressway references and ${(localData.roads||[]).length.toLocaleString()} additional road and ramp segments. Road names and speed are available beyond expressways; delta activates only on confirmed mainlines. Speed limits and exit locations may be missing or outdated. Missing or implausible speed tags use a clearly marked assumed 50 km/h reference. Pace delta starts only after confirmed mainline tracking.`;ui.sourceText.textContent=`Road data: ${meta.sourceAttribution||'© OpenStreetMap contributors'} · ${meta.license||'ODbL-1.0'}. ${meta.note||'Map data may be incomplete.'}`;dataReady=true;if(parkedConfirmed)startLive();else setSignal('Ready · confirm while parked to continue');}catch(err){console.error(err);setSignal('Road data unavailable','warn');}}
init();

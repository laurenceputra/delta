import { MotionSmoothness } from './motion.js';

const vector = value => value && ['x','y','z'].every(key => Number.isFinite(value[key])) ? [value.x,value.y,value.z] : null;
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const compact = value => Array.isArray(value) ? value.map(n => Math.round(n * 1000) / 1000) : null;
export function motionPauseDetails(reason) {
  const details={
    'sensor-gap':['Sensor readings interrupted. Feedback resumes automatically after two valid readings.','automatic'],
    'background':['App was in the background. Feedback resumes automatically when the app is visible and sensor readings return.','automatic'],
    'sensor-outlier':['An extreme sensor reading was rejected. Feedback resumes automatically after two clean readings.','automatic'],
    'checking-stability':['Checking stability. Feedback resumes automatically after stable readings.','automatic'],
    'needs-calibration':['Setup required when parked. Restart setup while parked.','recalibrate']
  };
  const [message,recovery]=details[reason]||['Sensor data is unavailable. Recalibrate while parked if readings do not return.','unknown'];
  return {reason,message,recovery};
}
export class SmoothDrivingController {
  constructor({ui,getContext,getDiagnostics}) {
    Object.assign(this,{ui,getContext,getDiagnostics});
    this.model=new MotionSmoothness();this.enabled=false;this.busy=false;this.generation=0;
    this.setupComplete=false;
    this.counts={abrupt:0,bumps:0,braking:0};this.latest=null;this.message='Ready for the next live drive.';
    this.onMotion=this.onMotion.bind(this);this.onVisibility=this.onVisibility.bind(this);
  }
  init() {
    try{this.ui.motionBorderToggle.checked=localStorage.getItem('delta-motion-border')!=='off';}catch{}
    this.ui.motionEnableButton.addEventListener('click',()=>{this.preparePermission();void this.enable();});
    this.ui.motionCalibrateButton.addEventListener('click',()=>this.recalibrate());
    this.ui.motionBorderToggle.addEventListener('change',()=>{
      try{localStorage.setItem('delta-motion-border',this.ui.motionBorderToggle.checked?'on':'off');}catch{}
      if(this.ui.motionBorderToggle.checked){
        if(this.getContext().mode==='live'){this.preparePermission();void this.enable();}
        else {this.message='Ready for the next live drive.';this.render();}
      }else this.disable('Smooth Driving is off.');
    });
    document.addEventListener('visibilitychange',this.onVisibility);
    this.render();
  }
  configuration(){return {enabled:this.enabled,border:this.ui.motionBorderToggle.checked,sampleHz:10,labels:['abrupt-motion','vertical-bump'],vehicleAxis:'gps-assisted'};}
  parkedSetupAllowed() {
    const context=this.getContext();
    if(!context.parked||context.mode!=='live')throw new Error('Start a live session and set up Smooth Driving while parked.');
    if(context.gpsFresh&&Number.isFinite(context.speedKmh)&&context.speedKmh>5)throw new Error('Park and wait for GPS speed to settle before setup.');
  }
  preparePermission() {
    if (!this.ui.motionBorderToggle.checked || this.enabled || this.busy) return;
    try {
      const context = this.getContext();
      if (context.mode === 'live') this.parkedSetupAllowed();
      this.permission = Promise.resolve(globalThis.DeviceMotionEvent?.requestPermission?.() ??
        (globalThis.DeviceMotionEvent ? 'granted' : 'unavailable')).catch(() => 'denied');
    } catch (error) {
      this.permission = null;
      this.message = error.message;
      this.render();
    }
  }
  async enable() {
    if (!this.ui.motionBorderToggle.checked || this.enabled || this.busy) return;
    if (!this.permission) {
      this.message = 'Allow motion access while parked to use Smooth Driving.';
      this.render();
      return;
    }
    const token = ++this.generation;
    this.busy = true;
    try {
      this.parkedSetupAllowed();
      const permission = await this.permission;
      if (token !== this.generation) return;
      if (permission !== 'granted') {
        this.message = permission === 'unavailable' ? 'Motion sensors are unavailable in this browser.' : 'Motion permission was not granted.';
        return;
      }
      this.enabled = true;
      this.counts = {abrupt:0,bumps:0,braking:0};
      this.recalibrate();
      this.lastPaintAt = this.lastDiagnosticAt = -Infinity;
      window.addEventListener('devicemotion', this.onMotion);
      this.watchdog = setInterval(() => this.checkSensors(), 300);
    } catch (error) {
      this.message = error.message;
    } finally {
      this.busy = false;
      this.render();
    }
  }
  recalibrate() {
    if (!this.enabled) return;
    try { this.parkedSetupAllowed(); }
    catch (error) { this.message = error.message; this.render(); return; }
    this.model.calibrate();
    this.latest = null;
    this.setupComplete = this.receivedSensor = this.sensorStale = this.backgroundPaused = false;
    this.lastSensorAt = performance.now();
    this.lastTransitionKey = this.lastFeedbackReason = this.lastEventKey = null;
    this.message = 'Learning sensor orientation. Keep the phone mounted.';
    this.captureEvent('calibration-started');
    this.render();
  }
  onMotion(event) {
    if(!this.enabled||document.visibilityState!=='visible')return;
    const time=performance.now();
    if(time-this.lastSensorAt<12&&this.latest)return;
    const sample={time,acceleration:vector(event.acceleration),gravity:vector(event.accelerationIncludingGravity),
      rotation:event.rotationRate&&['alpha','beta','gamma'].every(k=>Number.isFinite(event.rotationRate[k]))?
        [event.rotationRate.alpha,event.rotationRate.beta,event.rotationRate.gamma]:null,
      orientation:null,screenAngle:screen.orientation?.angle??window.orientation??0,...this.getContext()};
    if(!sample.acceleration&&!sample.gravity){
      this.latest=this.model.update(sample);
      this.sensorStale=true;
      if(time-this.lastPaintAt>=50){this.lastPaintAt=time;this.render();}
      return;
    }
    this.lastSensorAt=time;this.sensorStale=false;this.receivedSensor=true;
    this.latest=this.model.update(sample);
    if(this.latest.status==='ready')this.backgroundPaused=false;
    if(this.latest.status==='ready'&&!this.setupComplete){
      this.setupComplete=true;this.captureEvent('warmup-complete');
    }
    const transition=this.latest.diagnostic?.transition;
    const transitionKey=transition?`${transition.kind}:${transition.at}`:null;
    const newTransition=!!transitionKey&&transitionKey!==this.lastTransitionKey;
    if(newTransition)this.lastTransitionKey=transitionKey;
    const motion={atMs:Math.round(time),acceleration:compact(sample.acceleration),
        includingGravity:compact(sample.gravity),rotation:compact(sample.rotation),screenAngle:sample.screenAngle,
        filtered:compact(this.latest.filteredAcceleration),jerk:compact(this.latest.jerk),
        spillLevel:this.latest.spillLevel,severity:Math.round(this.latest.severity*1000)/1000,status:this.latest.status,reason:this.feedbackReason(),confidence:this.latest.confidence,
        tiltRateDegS:this.latest.diagnostic?.tiltRateDegS??null,transition:newTransition?transition:null,
        horizontalMps2:this.latest.diagnostic?.horizontalMps2, verticalMps2:this.latest.diagnostic?.verticalMps2,
        longitudinalMps2:this.latest.diagnostic?.longitudinalMps2, lateralMps2:this.latest.diagnostic?.lateralMps2,
        axisConfidence:this.latest.diagnostic?.axisConfidence, trigger:this.latest.diagnostic?.trigger};
    if(this.getDiagnostics()?.active&&(newTransition||time-this.lastDiagnosticAt>=100)){
      this.lastDiagnosticAt=time;
      this.getDiagnostics().capture('motion',{motion});
    }
    const detected=this.latest.event;
    if(detected&&this.latest.status==='ready'){
      const key=String(detected.startedAt);
      if(this.lastEventKey!==key){
        this.lastEventKey=key;
        if(detected.kind==='vertical-bump')this.counts.bumps++;else if(detected.kind==='sharp-braking')this.counts.braking++;else this.counts.abrupt++;
        this.captureEvent('estimated-event',{kind:detected.kind,atMs:detected.startedAt,peakSeverity:detected.peakSeverity});
      }
    }
    if(time-this.lastPaintAt>=50){this.lastPaintAt=time;this.render();}
  }
  captureEvent(phase,extra={}){this.getDiagnostics()?.capture('motion-event',{motion:{phase,...extra,counts:{...this.counts}}});}
  checkSensors() {
    if(!this.enabled)return;
    const age=performance.now()-this.lastSensorAt;
    if(!this.receivedSensor&&age>8000){void this.disable('No sensor readings arrived. Check browser permissions and try again while parked.');return;}
    if(this.receivedSensor&&age>1500&&!this.sensorStale){
      this.sensorStale=true;this.latest=this.model.update({time:performance.now()});
      this.render();
    }
  }
  onVisibility() {
    if(!this.enabled)return;
    if(document.visibilityState!=='visible'){
      this.backgroundPaused=true;
      this.latest=this.model.update({time:performance.now()});this.sensorStale=true;
      this.render();this.getDiagnostics()?.checkpoint();
    }
  }
  disable(message = 'Ready for the next live drive.') {
    ++this.generation;
    this.enabled = false;
    window.removeEventListener('devicemotion', this.onMotion);
    clearInterval(this.watchdog);
    this.model.reset();
    this.latest = null;
    this.message = message;
    this.render();
  }
  feedbackReason() {
    if(this.backgroundPaused&&(!this.latest?.reason||this.latest.reason==='sensor-gap'))return 'background';
    return this.latest?.reason||(this.sensorStale?'sensor-gap':null);
  }
  render() {
    const {ui}=this;
    const feedbackActive = this.enabled && this.latest?.status === 'ready' &&
      !this.latest.reason && !this.sensorStale && !this.backgroundPaused;
    ui.motionEnableButton.hidden = this.enabled || !ui.motionBorderToggle.checked || this.getContext().mode !== 'live';
    ui.motionEnableButton.disabled = this.busy;
    ui.motionCalibrateButton.hidden = !this.enabled;
    let message = ui.motionBorderToggle.checked ? this.message : 'Smooth Driving is off.';
    let feedbackReason = null;
    if (feedbackActive) message = this.model.gravityBaseline ? 'Motion feedback active.' : 'Sensor orientation unavailable. Restart setup while parked.';
    else if (this.enabled && this.latest?.status !== 'calibration') {
      feedbackReason = this.feedbackReason();
      if (feedbackReason) message = motionPauseDetails(feedbackReason).message;
    }
    if(this.enabled&&this.receivedSensor&&feedbackReason&&feedbackReason!==this.lastFeedbackReason){
      this.lastFeedbackReason=feedbackReason;
      const details=motionPauseDetails(feedbackReason);this.captureEvent('feedback-paused',{reason:feedbackReason,recovery:details.recovery});
    }else if(this.enabled&&feedbackActive&&this.lastFeedbackReason){
      const previousReason=this.lastFeedbackReason;this.lastFeedbackReason=null;
      this.captureEvent('feedback-resumed',{previousReason});
    }
    if(ui.motionStatus.textContent!==message)ui.motionStatus.textContent=message;
    setText(ui.motionSummary,`Estimated events this drive: ${this.counts.abrupt} abrupt motion, ${this.counts.bumps} vertical bumps.${!this.enabled && this.counts.braking ? ` ${this.counts.braking} estimated sharp braking events.` : ''} These are not a driving safety score.`);
    const reliable = feedbackActive && !!this.model.gravityBaseline && document.visibilityState === 'visible';
    ui.motionBorder.hidden=!this.enabled||!ui.motionBorderToggle.checked;
    ui.motionBorder.classList.toggle('neutral',!reliable);
    if (reliable) {
      const colours = [[120,.35],[60,.5],[40,.65],[0,.8]];
      const [hue, opacity] = colours[this.latest.spillLevel];
      ui.motionBorder.style.setProperty('--motion-hue', String(hue));
      ui.motionBorder.style.setProperty('--motion-opacity', String(opacity));
    } else ui.motionBorder.style.setProperty('--motion-opacity','.24');
  }
}

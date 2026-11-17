import { MotionSmoothness } from './motion.js';

const vector = value => value && ['x','y','z'].every(key => Number.isFinite(value[key])) ? [value.x,value.y,value.z] : null;
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const compact = value => Array.isArray(value) ? value.map(n => Math.round(n * 1000) / 1000) : null;
export class MotionBetaController {
  constructor({ui,getContext,getDiagnostics,onRecordingStart}) {
    Object.assign(this,{ui,getContext,getDiagnostics,onRecordingStart});
    this.model=new MotionSmoothness();this.enabled=false;this.busy=false;this.generation=0;
    this.setupComplete=false;this.recordingReady=false;this.ownedRecordingId=null;
    this.counts={abrupt:0,bumps:0};this.latest=null;this.message='Off. Enable while parked for this drive.';
    this.onMotion=this.onMotion.bind(this);this.onVisibility=this.onVisibility.bind(this);
  }
  init() {
    try{this.ui.motionBorderToggle.checked=localStorage.getItem('delta-motion-border')!=='off';}catch{}
    this.ui.motionEnableButton.addEventListener('click',()=>this.enabled?void this.disable():void this.enable());
    this.ui.motionCalibrateButton.addEventListener('click',()=>this.recalibrate());
    this.ui.motionBorderToggle.addEventListener('change',()=>{
      try{localStorage.setItem('delta-motion-border',this.ui.motionBorderToggle.checked?'on':'off');}catch{}
      this.render();
    });
    document.addEventListener('visibilitychange',this.onVisibility);
    this.render();
  }
  configuration(){return {enabled:this.enabled,border:this.ui.motionBorderToggle.checked,sampleHz:10,labels:['abrupt-motion','vertical-bump'],vehicleAxesEstablished:false};}
  parkedSetupAllowed() {
    const context=this.getContext();
    if(!context.parked||context.mode!=='live')throw new Error('Start a live session and set up Beta while parked.');
    if(context.gpsFresh&&Number.isFinite(context.speedKmh)&&context.speedKmh>5)throw new Error('Park and wait for GPS speed to settle before setup.');
  }
  async enable() {
    if(this.busy)return;
    const token=++this.generation;this.busy=true;this.render();
    try {
      this.parkedSetupAllowed();
      if(typeof DeviceMotionEvent==='undefined')throw new Error('Motion sensors are unavailable in this browser.');
      if(!this.getDiagnostics()?.db)throw new Error('Local diagnostics are not ready; try again shortly.');
      // Must be called directly from the tap, before any asynchronous work.
      const permission=typeof DeviceMotionEvent.requestPermission==='function'?DeviceMotionEvent.requestPermission():Promise.resolve('granted');
      if(await permission!=='granted')throw new Error('Motion permission was not granted. Beta remains off.');
      if(token!==this.generation||document.visibilityState!=='visible')return;
      this.parkedSetupAllowed();
      this.enabled=true;this.setupComplete=false;this.recordingReady=false;this.ownedRecordingId=null;
      this.counts={abrupt:0,bumps:0};this.lastEventKey=null;this.latest=null;
      this.lastSensorAt=performance.now();this.lastDiagnosticAt=-Infinity;this.lastPaintAt=-Infinity;
      this.sensorStale=false;this.receivedSensor=false;this.model.calibrate();
      this.calibrationScreenAngle=screen.orientation?.angle??window.orientation??0;
      this.message='Keep the mounted phone still for calibration. Diagnostics start after setup succeeds.';
      window.addEventListener('devicemotion',this.onMotion);
      this.watchdog=setInterval(()=>this.checkSensors(),300);
      this.armSetupTimeout();
    } catch(error){this.message=error.message||'Motion setup failed. Beta remains off.';}
    finally{this.busy=false;this.render();}
  }
  armSetupTimeout(){clearTimeout(this.setupTimer);this.setupTimer=setTimeout(()=>{if(this.enabled&&!this.setupComplete)void this.disable('Calibration did not complete. Mount the phone, park, and try again.');},20000);}
  recalibrate() {
    if(!this.enabled||this.busy)return;
    try{this.parkedSetupAllowed();}catch(error){this.message=error.message;this.render();return;}
    this.model.calibrate();this.latest=null;this.setupComplete=false;this.recordingReady=false;
    this.receivedSensor=false;this.sensorStale=false;this.lastSensorAt=performance.now();
    this.calibrationScreenAngle=screen.orientation?.angle??window.orientation??0;this.armSetupTimeout();
    this.message='Keep the mounted phone still for recalibration.';
    this.captureEvent('calibration-started');this.render();
  }
  async startRecording() {
    if(this.recordingStart)return this.recordingStart;
    const token=this.generation;
    this.recordingStart=(async()=>{
      const diagnostics=this.getDiagnostics();
      if(!diagnostics)throw new Error('Local diagnostics are unavailable.');
      if(diagnostics.stopPromise)await diagnostics.stopPromise;
      if(token!==this.generation||!this.enabled)return;
      if(!diagnostics.active){
        await diagnostics.start();
        const startedId=diagnostics.active?.id;
        if(token!==this.generation||!this.enabled){if(startedId)await diagnostics.stop();return;}
        this.ownedRecordingId=startedId;this.onRecordingStart?.();
      }
      if(token!==this.generation||!this.enabled)return;
      this.recordingReady=!!diagnostics.active&&!diagnostics.stopping;
      this.captureEvent('calibrated');
    })().catch(error=>{
      if(token!==this.generation)return;
      this.recordingReady=false;this.message=`Diagnostics could not start: ${error.message} Feedback is paused; free space and recalibrate while parked.`;
    }).finally(()=>{this.recordingStart=null;this.render();});
    return this.recordingStart;
  }
  onDiagnostics(data) {
    this.diagnosticsStatus=data.status;
    if(this.enabled&&this.setupComplete){
      this.recordingReady=!!data.active&&!this.getDiagnostics()?.stopping;
      if(!this.recordingReady)this.message=`Diagnostics stopped. Feedback is paused. ${data.status}`;
    }
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
      if(!this.sensorStale)this.captureEvent('sensor-paused');
      this.sensorStale=true;
      if(time-this.lastPaintAt>=50){this.lastPaintAt=time;this.render();}
      return;
    }
    this.lastSensorAt=time;this.sensorStale=false;this.receivedSensor=true;
    if(sample.screenAngle!==this.calibrationScreenAngle)this.model.pause('mount-moved');
    this.latest=this.model.update(sample);
    if(this.latest.status==='ready'&&!this.setupComplete){
      this.setupComplete=true;clearTimeout(this.setupTimer);void this.startRecording();
    }
    if(this.getDiagnostics()?.active&&time-this.lastDiagnosticAt>=100){
      this.lastDiagnosticAt=time;
      this.getDiagnostics().capture('motion',{motion:{atMs:Math.round(time),acceleration:compact(sample.acceleration),
        includingGravity:compact(sample.gravity),rotation:compact(sample.rotation),screenAngle:sample.screenAngle,
        filtered:compact(this.latest.filteredAcceleration),jerk:compact(this.latest.jerk),
        severity:Math.round(this.latest.severity*1000)/1000,status:this.latest.status,confidence:this.latest.confidence}});
    }
    const detected=this.latest.event;
    if(detected&&this.recordingReady&&this.latest.status==='ready'){
      const key=String(detected.startedAt);
      if(this.lastEventKey!==key){
        this.lastEventKey=key;
        if(detected.kind==='vertical-bump')this.counts.bumps++;else this.counts.abrupt++;
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
      this.captureEvent('sensor-paused');this.render();
    }
  }
  onVisibility() {
    if(!this.enabled)return;
    if(document.visibilityState!=='visible'){
      this.latest=this.model.update({time:performance.now()});this.sensorStale=true;
      this.captureEvent('background-paused');this.getDiagnostics()?.checkpoint();this.render();
    }
  }
  async disable(message='Beta off. Saved diagnostics remain on this device.') {
    ++this.generation;this.enabled=false;this.recordingReady=false;
    window.removeEventListener('devicemotion',this.onMotion);clearInterval(this.watchdog);clearTimeout(this.setupTimer);
    this.captureEvent('beta-stopped');this.model.reset();this.latest=null;this.message=message;this.render();
    const diagnostics=this.getDiagnostics();
    if(this.ownedRecordingId&&diagnostics?.active?.id===this.ownedRecordingId)await diagnostics.stop();
    this.ownedRecordingId=null;this.render();
  }
  render() {
    const {ui}=this, diagnostics=this.getDiagnostics();
    const recording=!!diagnostics?.active&&!diagnostics?.stopping;
    ui.motionEnableButton.disabled=this.busy;
    setText(ui.motionEnableButton,this.enabled?'Disable beta':'Enable beta for this drive');
    ui.motionEnableButton.setAttribute('aria-pressed',String(this.enabled));
    ui.motionCalibrateButton.disabled=!this.enabled||this.busy;
    ui.motionBetaIndicator.hidden=!this.enabled;
    setText(ui.motionBetaIndicator,!this.setupComplete?'BETA · SETUP':this.recordingReady&&recording?'BETA · REC':'BETA · REC OFF');
    ui.motionBetaIndicator.classList.toggle('recording-off',this.setupComplete&&!recording);
    ui.diagnosticsIndicator.hidden=this.enabled||!recording;
    let message=this.message;
    if(this.enabled&&this.recordingReady&&this.latest){
      message=this.latest.status==='ready'?
        `Motion feedback active · ${this.latest.confidence} confidence. Diagnostics recording locally.`:
        this.latest.status==='calibration'?'Keep the mounted phone still for calibration.':
        'Motion feedback paused. Check the mount and recalibrate while parked if needed.';
    }
    if(ui.motionStatus.textContent!==message)ui.motionStatus.textContent=message;
    setText(ui.motionSummary,`Estimated events this beta session: ${this.counts.abrupt} abrupt motion, ${this.counts.bumps} vertical bumps. These are not a driving safety score.`);
    const reliable=this.enabled&&this.recordingReady&&recording&&this.latest?.status==='ready'&&!this.sensorStale&&document.visibilityState==='visible';
    ui.motionBorder.hidden=!this.enabled||!ui.motionBorderToggle.checked;
    ui.motionBorder.classList.toggle('neutral',!reliable);
    if(reliable){const severity=Math.min(1,Math.max(0,this.latest.severity));ui.motionBorder.style.setProperty('--motion-hue',String(Math.round(120*(1-severity))));ui.motionBorder.style.setProperty('--motion-opacity',String(.35+.45*severity));}else ui.motionBorder.style.setProperty('--motion-opacity','.24');
  }
}

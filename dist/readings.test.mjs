import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDelta, speedTone, deltaTone, SpeedWarning } from './readings.js';

test('delta display caps do not change exact values used by forecasts', () => {
  for (const [value, display] of [[null,'—'],[NaN,'—'],[0,'+0.0'],[12.3,'+12.3'],[60,'+60.0'],[60.01,'>60'],[-60,'−60.0'],[-60.01,'<−60'],[12345,'>60']])
    assert.equal(formatDelta(value), display);
});
test('speed bands have strict limit boundaries and unavailable data stays neutral', () => {
  assert.equal(speedTone(80,80),'good');
  assert.equal(speedTone(80.1,80),'caution');
  assert.equal(speedTone(88,80),'caution');
  assert.equal(speedTone(88.01,80),'danger');
  assert.equal(speedTone(0,80),'good');
  for (const args of [[80,null],[80,0],[null,80],[80,80,false]]) assert.equal(speedTone(...args),'neutral');
});
test('positive delta never makes an overspeed or stale reading green', () => {
  assert.equal(deltaTone(100,'danger'),'danger');
  assert.equal(deltaTone(100,'caution'),'caution');
  assert.equal(deltaTone(100,'good'),'good');
  assert.equal(deltaTone(-10,'good'),'caution');
  assert.equal(deltaTone(0,'good'),'good');
  assert.equal(deltaTone(100,'neutral'),'neutral');
  assert.equal(deltaTone(100,'good',false),'neutral');
});
test('warnings rise immediately and clear only after continuous lower severity; stale/limit changes reset', () => {
  const warning = new SpeedWarning();
  assert.equal(warning.update('good',0,80),'good');
  assert.equal(warning.update('danger',100,80),'danger');
  assert.equal(warning.update('good',200,80),'danger');
  assert.equal(warning.update('good',2199,80),'danger');
  assert.equal(warning.update('good',2200,80),'good');
  assert.equal(warning.update('caution',2300,80),'caution');
  warning.update('good',2400,80);
  warning.update('caution',2500,80);
  assert.equal(warning.update('good',4400,80),'caution');
  assert.equal(warning.update('neutral',4500,80),'neutral');
  assert.equal(warning.update('danger',4600,80),'danger');
  assert.equal(warning.update('good',4700,90),'good');
  warning.reset();assert.equal(warning.update('good',0,80),'good');
});

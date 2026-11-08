import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChangeNotifications} from '../src/change_notifications.js';

test('notification waits time out, cancel, survive stale cursors and isolate accounts', async () => {
  const events = new ChangeNotifications();
  const abort = new AbortController();
  const cursor = events.cursor('a');
  await events.wait('a',cursor,5,abort.signal);
  assert.equal(events.cursor('a'),cursor);
  let woke = false;
  const pending = events.wait('a',cursor,1000,abort.signal).then(() => {woke=true;});
  events.publish('b');
  await Promise.resolve();
  assert.equal(woke,false);
  events.publish('a');
  await pending;
  assert.notEqual(events.cursor('a'),cursor);
  await events.wait('a',cursor,1000,abort.signal);
  const cancelled = events.wait('a',events.cursor('a'),1000,abort.signal);
  abort.abort();
  await cancelled;
  const closing = events.wait('a',events.cursor('a'),1000,new AbortController().signal);
  events.close();
  await closing;
  const restarted = new ChangeNotifications();
  assert.notEqual(restarted.cursor('a'),events.cursor('a'));
});

test('notification listener limits release capacity after disconnect', async () => {
  const events = new ChangeNotifications();
  const abort = new AbortController();
  const waits = Array.from({length:32}, () => events.wait('a',events.cursor('a'),1000,abort.signal));
  await assert.rejects(events.wait('a',events.cursor('a'),1000,abort.signal), /Too many/);
  abort.abort();
  await Promise.all(waits);
  events.close();
});

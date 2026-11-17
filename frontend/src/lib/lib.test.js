import { describe, expect, it } from 'vitest';
import { matchPath } from './router';
import { buildHeaders, qs, readCookie } from './api';
import { bytes, deviceLabel, duration, relativeDate, totalDuration } from './format';
import { aura, hexToRgb, inkOn } from './mood';
import { queueOps } from './player';

describe('router', () => {
  it('matches static and parameter paths', () => {
    expect(matchPath('/discover', '/discover')).toEqual({});
    expect(matchPath('/playlist/:id', '/playlist/42')).toEqual({ id: '42' });
    expect(matchPath('/admin/:section', '/admin/users')).toEqual({ section: 'users' });
    expect(matchPath('/discover', '/discover/')).toEqual({});
  });
  it('does not match different or longer paths', () => {
    expect(matchPath('/playlist/:id', '/playlist')).toBe(null);
    expect(matchPath('/studio', '/studio/upload')).toBe(null);
    expect(matchPath('/admin', '/administrator')).toBe(null);
  });
  it('treats * as a catch-all and rejects malformed escapes', () => {
    expect(matchPath('*', '/anything/here')).toEqual({ '*': 'anything/here' });
    expect(matchPath('/song/:id', '/song/%E0%A4%A')).toBe(null);
  });
});

describe('api helpers', () => {
  it('sends the CSRF token only on state-changing requests', () => {
    const cookies = 'a=1; muse_csrf=tok%3D1; b=2';
    expect(readCookie('muse_csrf', cookies)).toBe('tok=1');
    expect(buildHeaders('GET', false, cookies)['X-CSRF-Token']).toBeUndefined();
    expect(buildHeaders('POST', true, cookies)['X-CSRF-Token']).toBe('tok=1');
    expect(buildHeaders('POST', true, cookies)['Content-Type']).toBe('application/json');
  });
  it('builds query strings without empty values', () => {
    expect(qs({ q: 'rain day', page: 2, empty: '', none: null })).toBe('?q=rain+day&page=2');
    expect(qs({})).toBe('');
  });
});

describe('format', () => {
  it('formats durations', () => {
    expect(duration(0)).toBe('0:00');
    expect(duration(185)).toBe('3:05');
    expect(duration(3725)).toBe('1:02:05');
    expect(totalDuration(5400)).toBe('1 h 30 min');
  });
  it('formats relative dates and sizes', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(relativeDate('2026-11-16T11:59:30Z', now)).toBe('just now');
    expect(relativeDate('2026-11-16T10:00:00Z', now)).toBe('2 h ago');
    expect(bytes(52428800)).toBe('50.0 MB');
  });
  it('names devices from user agents', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/17 Safari/605')).toBe('Safari on macOS');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537')).toBe('Chrome on Android');
    expect(deviceLabel('')).toBe('Unknown device');
  });
});

describe('mood colours', () => {
  it('parses hex and picks readable ink', () => {
    expect(hexToRgb('#7FB7BE')).toEqual([127, 183, 190]);
    expect(hexToRgb('nope')).toBe(null);
    expect(inkOn('#FFFFFF')).toBe('#1A1C2C');
    expect(inkOn('#191B2B')).toBe('#FFFFFF');
  });
  it('builds one aura field per mood, at most four', () => {
    expect(aura([])).toBe('none');
    const a = aura(['#F2B544', '#7FB7BE', '#C98BB9', '#5D6DA8', '#E4572E']);
    expect(a.split('radial-gradient').length - 1).toBe(4);
  });
});

describe('play queue', () => {
  const song = (id, playable = true) => ({ id, title: `S${id}`, playback: { playable } });
  const item = (id) => ({ key: String(id), song: song(id) });
  const ids = (l) => l.map((x) => x.song.id);
  it('keeps only playable songs and starts at the chosen one', () => {
    const { items, at } = queueOps.fromSongs([song(1), song(2, false), song(3), song(4)], 2);
    expect(ids(items)).toEqual([1, 3, 4]);
    expect(at).toBe(1);
  });
  it('starts at the next playable song when the chosen one has no recording', () => {
    const { items, at } = queueOps.fromSongs([song(1), song(2, false), song(3)], 1);
    expect(items[at].song.id).toBe(3);
  });
  it('inserts, removes and reorders while tracking the playing position', () => {
    let list = [item(1), item(2), item(3)];
    list = queueOps.insert(list, 1, item(9));
    expect(ids(list)).toEqual([1, 9, 2, 3]);
    let r = queueOps.remove(list, 2, 0);
    expect(ids(r.list)).toEqual([9, 2, 3]);
    expect(r.index).toBe(1);
    expect(queueOps.remove(r.list, 1, 1).list).toBe(r.list);   // the playing song cannot be removed
    r = queueOps.move(r.list, 1, 1, -1);
    expect(ids(r.list)).toEqual([2, 9, 3]);
    expect(r.index).toBe(0);
    expect(queueOps.move(r.list, 0, 2, 1).list).toBe(r.list);  // no move past the end
  });
});

describe('admin routes', () => {
  it('matches section and item paths', () => {
    expect(matchPath('/admin/:section/:id', '/admin/uploads/abc')).toEqual({ section: 'uploads', id: 'abc' });
  });
});

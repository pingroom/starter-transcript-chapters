import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportChapters } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, partitionTranscript, boundariesFor, timestamp, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/transcript.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-transcript-chapters-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later chapter boundaries; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'continue'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a chapter boundary', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'continue'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'continue'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.chapters, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across chapter boundaries', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'continue'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).chapters, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'continue');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'continue'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'continue'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing expert before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'continue');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'continue'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).chapters, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});


function manifest(count = 8) {
  let position = 0;
  const segments = Array.from({ length: count }, (_, i) => {
    const segment = { id: `segment-${i}`, startMs: position, endMs: position + 1 + i * 1007, text: `Segment ${i}: useful content.` };
    position = segment.endMs; return segment;
  });
  return { transcriptId: 'partition-test', title: 'A fixed transcript', durationMs: position, segments };
}
const decisionsFor = (input, value = 'continue') => Object.fromEntries(boundariesFor(input).map(boundary => [boundary.id, value]));
function reference(input, answers) {
  const source = [...input.segments].sort((a, b) => a.startMs - b.startMs);
  const starts = source.flatMap((segment, i) => i === 0 || answers[segment.id] === 'start' ? [i] : []);
  return starts.map((start, i) => {
    const group = source.slice(start, starts[i + 1] ?? source.length);
    return { startMs: group[0].startMs, endMs: group.at(-1).endMs, segmentIds: group.map(segment => segment.id) };
  });
}
const unescape = text => text.replace(/&(amp|lt|gt);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>' }[entity]));
function parseWebVtt(text) {
  const [header, ...cues] = text.trimEnd().split('\n\n'); assert.equal(header, 'WEBVTT');
  return cues.map(cue => {
    const lines = cue.split('\n'); assert.equal(lines.length, 3);
    assert.match(lines[0], /^chapter-[1-8]$/);
    const timing = lines[1].match(/^(\d{2}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d)\.(\d{3})$/);
    assert.ok(timing, lines[1]); assert.ok(!/[<>]/.test(lines[2])); assert.ok(!/&(?!amp;|lt;|gt;)/.test(lines[2]));
    const ms = part => Number(part[0]) * 3600000 + Number(part[1]) * 60000 + Number(part[2]) * 1000 + Number(part[3]);
    return { id: lines[0], startMs: ms(timing.slice(1, 5)), endMs: ms(timing.slice(5, 9)), title: unescape(lines[2]) };
  });
}

test('all 128 maximum-size boundary patterns match an independent partition oracle and valid WebVTT', () => {
  const input = manifest(), boundaries = boundariesFor(input);
  for (let pattern = 0; pattern < 128; pattern++) {
    const answers = Object.fromEntries(boundaries.map((boundary, i) => [boundary.id, pattern & (1 << i) ? 'start' : 'continue']));
    const result = partitionTranscript(input, answers), expected = reference(input, answers);
    assert.deepEqual(result.chapters.map(({ startMs, endMs, segmentIds }) => ({ startMs, endMs, segmentIds })), expected);
    assert.deepEqual(result.chapters.flatMap(chapter => chapter.segmentIds), input.segments.map(segment => segment.id));
    assert.equal(result.chapters[0].startMs, 0); assert.equal(result.chapters.at(-1).endMs, input.durationMs);
    assert.ok(result.chapters.every((chapter, i) => chapter.startMs < chapter.endMs && (i === 0 || chapter.startMs === result.chapters[i - 1].endMs)));
    assert.deepEqual(parseWebVtt(result.webvtt), result.chapters.map(({ id, startMs, endMs, title }) => ({ id, startMs, endMs, title })));
  }
});

test('all Continue gives one chapter and all Start preserves every source segment as a chapter', () => {
  const input = manifest();
  const joined = partitionTranscript(input, decisionsFor(input));
  assert.equal(joined.chapters.length, 1); assert.equal(joined.chapters[0].endMs, input.durationMs);
  assert.deepEqual(joined.chapters[0].segmentIds, input.segments.map(s => s.id));
  const split = partitionTranscript(input, decisionsFor(input, 'start'));
  assert.equal(split.chapters.length, 8);
  assert.deepEqual(split.chapters.map(c => c.startMs), input.segments.map(s => s.startMs));
});

test('Unicode is preserved, titles truncate by code point, and payload syntax is escaped exactly once', () => {
  const input = manifest(2);
  input.segments[0].text = '😀'.repeat(60);
  input.segments[1].text = 'NOTE <b>Résumé & café</b> --> &lt; مرحبا';
  const { chapters, webvtt } = partitionTranscript(input, decisionsFor(input, 'start'));
  assert.equal(chapters[0].title, `Chapter 1: ${'😀'.repeat(48)}…`); assert.ok(chapters[0].title.isWellFormed());
  assert.equal(chapters[1].title, `Chapter 2: ${input.segments[1].text}`);
  assert.ok(webvtt.includes('NOTE &lt;b&gt;Résumé &amp; café&lt;/b&gt; --&gt; &amp;lt; مرحبا'));
  assert.deepEqual(parseWebVtt(webvtt).map(c => c.title), chapters.map(c => c.title));
  const unchanged = structuredClone(input); unchanged.segments[0].text = 'e\u0301'.repeat(24);
  assert.equal(partitionTranscript(unchanged, decisionsFor(unchanged)).chapters[0].title, `Chapter 1: ${unchanged.segments[0].text}`);
});

test('integer timestamps preserve millisecond precision through 24 hours without wrapping', () => {
  for (const [ms, expected] of [[0,'00:00:00.000'],[1,'00:00:00.001'],[59999,'00:00:59.999'],[60000,'00:01:00.000'],[3600000,'01:00:00.000'],[86399999,'23:59:59.999'],[86400000,'24:00:00.000']]) assert.equal(timestamp(ms), expected);
  for (const bad of [-1, 86400001, 1.1, NaN, Infinity, '1000']) assert.throws(() => timestamp(bad));
  const input = manifest(2); input.durationMs = 86400000; input.segments[1].endMs = input.durationMs;
  assert.equal(parseWebVtt(partitionTranscript(input, decisionsFor(input)).webvtt)[0].endMs, 86400000);
});

test('chronological permutations have identical source hashes, requests and chapters', () => {
  const input = manifest(), reversed = structuredClone(input); reversed.segments.reverse();
  assert.deepEqual(validateInput(reversed), validateInput(input));
  assert.equal(hash(validateInput(reversed)), hash(validateInput(input)));
  assert.deepEqual(partitionTranscript(reversed, decisionsFor(input)), partitionTranscript(input, decisionsFor(input)));
  assert.deepEqual(requestFor(reversed, CONFIG, input.segments[1].id, id(99)), requestFor(input, CONFIG, input.segments[1].id, id(99)));
});

test('maximum Unicode prompts preserve both source excerpts, the timestamp and SDK size limits', () => {
  const input = manifest(); input.title = '😀'.repeat(20);
  input.segments.forEach((segment, i) => { segment.id = String.fromCharCode(97 + i).repeat(24); segment.text = '😀'.repeat(60); });
  const boundaries = boundariesFor(input); assert.equal(boundaries.length, 7);
  for (const boundary of boundaries) {
    const request = requestFor(input, CONFIG, boundary.id, id(99));
    assert.ok(request.prompt.length <= 500); assert.equal(request.context.length, 39); assert.equal(request.options.length, 3);
    assert.ok(request.prompt.includes(boundary.previous.text)); assert.ok(request.prompt.includes(boundary.current.text));
    assert.ok(request.prompt.includes(timestamp(boundary.current.startMs))); assert.equal(request.ttl, 900);
  }
});

test('timing gaps, overlaps, partial duration, unknown shapes and unsafe text fail before network', async t => {
  for (const mutate of [
    x => { x.segments = [x.segments[0]]; }, x => { x.segments.push(...x.segments, ...x.segments); },
    x => { x.durationMs = 86400001; }, x => { x.durationMs = 0; }, x => { x.durationMs = '120000'; },
    x => { x.segments[0].startMs = 1; }, x => { x.segments.at(-1).endMs--; }, x => { x.segments[1].startMs++; },
    x => { x.segments[1].startMs--; }, x => { x.segments[1].startMs = x.segments[0].startMs; },
    x => { x.segments[1].endMs = x.segments[1].startMs; }, x => { x.segments[0].startMs = -1; },
    x => { x.segments[0].endMs = 0.5; }, x => { x.segments[0].endMs = NaN; }, x => { x.segments[0].endMs = '30000'; },
    x => { x.segments[0].id = x.segments[1].id; }, x => { x.segments[0].id = 'constructor'; },
    x => { x.segments[0].id = 'a'.repeat(25); }, x => { x.segments[0].text = 'a'.repeat(121); },
    x => { x.title = 'x'.repeat(41); }, x => { x.segments[0].extra = true; }, x => { x.extra = true; },
    ...['', ' leading', 'trailing ', 'line\nline', 'line\rline', 'tab\ttext', 'null\0text', 'del\x7ftext', 'c1\u0085text',
      'line\u2028text', 'paragraph\u2029text', 'format\u202etext', 'join\u200dtext', 'nonjoin\u200ctext', 'bom\ufefftext', '\ud83d', '\ude00'].map(text => x => { x.segments[0].text = text; }),
  ]) { const s = await setup(t); mutate(s.options.input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
  for (const value of ['unknown', null, false, 'yes', 1]) {
    const answers = decisionsFor(example); answers[example.segments[1].id] = value; assert.throws(() => partitionTranscript(example, answers));
  }
  const missing = decisionsFor(example); delete missing[example.segments[1].id]; assert.throws(() => partitionTranscript(example, missing));
  assert.throws(() => partitionTranscript(example, { ...decisionsFor(example), extra: 'continue' }));
  assert.throws(() => validateConfig({ participant: { id: OTHER, label: ' ' } }));
});

test('seven attributable answers produce replayable chapters, report and private offline WebVTT export', async t => {
  const input = manifest(), s = await setup(t, input), result = await decide(s, ['continue','start','continue','continue','start','continue','start']);
  assert.equal(result.status, 'complete'); assert.equal(result.chapters.length, 4); assert.equal(result.mediaModified, false);
  assert.ok(result.answers.every(a => a.responderId === CONFIG.participant.id && a.askerId === ASKER));
  assert.equal(sends(s.api), 7); const before = s.api.calls.length;
  assert.deepEqual((await s.run()).chapters, result.chapters); assert.equal(s.api.calls.length, before);
  const saved = await localReport(s.directory, input, { save: true }); assert.deepEqual(saved.chapters, result.chapters);
  const exported = await exportChapters(s.directory, input); assert.equal(exported.sourceHash, hash(validateInput(input)));
  assert.equal(exported.chapterCount, 4); assert.equal(await readText(exported.path), result.webvtt);
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal((await stat(s.directory)).mode & 0o777, 0o700);
  await exportChapters(s.directory, input); assert.equal(s.api.calls.length, before);
  for (const file of ['state.json','report.json']) assert.ok((await stat(join(s.directory, file))).size < 1024 * 1024);
});

test('Unknown and terminal failures withhold the whole output after remaining boundaries are assessed', async t => {
  const input = manifest(), s = await setup(t, input), result = await decide(s, ['unknown', ...Array(6).fill('continue')]);
  assert.equal(result.status, 'incomplete'); assert.equal(result.chapters, null); assert.equal(result.webvtt, null);
  assert.deepEqual(result.unknownSegmentIds, [input.segments[1].id]); assert.equal(sends(s.api), 7);
  const before = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, before);
  await assert.rejects(exportChapters(s.directory, input), /Complete every/); assert.equal(await readText(join(s.directory, 'chapters.vtt')), null);
  for (const terminal of ['expired','cancelled','invalid_answer']) {
    const other = await setup(t); await other.run();
    if (terminal === 'invalid_answer') { other.api.answer(id(1), 'continue'); other.api.questions.get(id(1)).answer.responder.id = OTHER; }
    else { if (terminal === 'expired') other.clock.value = '2026-01-01T09:16:00.000Z'; other.api.terminal(id(1), terminal); }
    assert.equal((await other.run()).observedStatus, terminal);
    const done = await decide(other, Array(example.segments.length - 2).fill('continue'));
    assert.equal(done.status, 'incomplete'); assert.equal(done.chapters, null); assert.equal(done.webvtt, null);
    await assert.rejects(exportChapters(other.directory, other.options.input)); assert.equal(sends(other.api), example.segments.length - 1);
  }
});

test('export refuses missing, pending, corrupt and changed state; lock and failures preserve existing output', async t => {
  const s = await setup(t); await assert.rejects(exportChapters(s.directory, s.options.input), /No chapter session/);
  await s.run(); await assert.rejects(exportChapters(s.directory, s.options.input), /Complete every/);
  await atomicText(s.directory, 'chapters.vtt', 'previous artifact\n');
  await assert.rejects(exportChapters(s.directory, s.options.input)); assert.equal(await readText(join(s.directory, 'chapters.vtt')), 'previous artifact\n');
  const release = await acquireLock(s.directory); await assert.rejects(exportChapters(s.directory, s.options.input), /lock exists/); await release();
  const changed = structuredClone(s.options.input); changed.segments[0].text = 'Changed content';
  await assert.rejects(exportChapters(s.directory, changed), /changed transcript manifest/);
  const saved = await s.saved(); saved.attempts[0].request.prompt = 'Changed question'; await atomicJson(s.directory, 'state.json', saved);
  await assert.rejects(exportChapters(s.directory, s.options.input)); assert.equal(await readText(join(s.directory, 'chapters.vtt')), 'previous artifact\n');
});

test('atomic text writes are bounded, private, Unicode-safe and never follow a destination symlink', async t => {
  const s = await setup(t); await atomicText(s.directory, 'chapters.vtt', 'WEBVTT\n\n');
  await assert.rejects(atomicText(s.directory, 'chapters.vtt', 'a'.repeat(10), 9), /size limit/);
  assert.equal(await readText(join(s.directory, 'chapters.vtt')), 'WEBVTT\n\n');
  await assert.rejects(atomicText(s.directory, 'chapters.vtt', '\ud800'));
  await assert.rejects(atomicText(s.directory, '../escape.vtt', 'text'));
  const target = join(s.directory, 'target.txt'); await writeFile(target, 'untouched');
  await symlink(target, join(s.directory, 'linked.vtt')); await atomicText(s.directory, 'linked.vtt', 'replacement');
  assert.equal(await readFile(target, 'utf8'), 'untouched'); assert.equal(await readText(join(s.directory, 'linked.vtt')), 'replacement');
  assert.equal((await stat(join(s.directory, 'linked.vtt'))).mode & 0o777, 0o600);
});

test('fixed timestamps, source content and participant refuse drift; reordered segments resume', async t => {
  const s = await setup(t); await s.run(); const before = s.api.calls.length;
  for (const mutate of [x => { x.segments[0].text = 'Changed'; }, x => { x.segments[0].endMs++; x.segments[1].startMs++; }, x => { x.transcriptId = 'other'; }]) {
    const input = structuredClone(example); mutate(input); await assert.rejects(s.run({ input }));
  }
  for (const extra of [{ token: 'other' },{ room: 'OTHER1234567' },{ config: { participant: { id: OTHER, label: 'Other' } } }]) await assert.rejects(s.run(extra));
  assert.equal(s.api.calls.length, before);
  const input = structuredClone(example); input.segments.reverse(); assert.equal((await s.run({ input })).status, 'pending');
});

test('the pinned SDK transports maximum Unicode prompts and preserves source text through export', async t => {
  const input = manifest(2); input.title = '😀'.repeat(20);
  input.segments[0].id = 'a'.repeat(24); input.segments[1].id = 'b'.repeat(24);
  input.segments[0].text = '😀'.repeat(60); input.segments[1].text = '<&>'.repeat(40);
  const s = await setup(t, input), result = await decide(s, ['start']);
  assert.equal(sends(s.api), 1); assert.equal(result.status, 'complete');
  assert.deepEqual(result.segments, input.segments);
  const post = s.api.calls.find(call => call.method === 'POST');
  assert.ok(post.body.prompt.includes(input.segments[0].text)); assert.ok(post.body.prompt.includes(input.segments[1].text));
  assert.ok(post.body.prompt.length <= 500);
  const exported = await exportChapters(s.directory, input);
  assert.deepEqual(parseWebVtt(await readText(exported.path)).map(c => c.title), result.chapters.map(c => c.title));
});

test('combined comma-delimited keys cannot masquerade as complete boundary answers', () => {
  const combined = boundariesFor(example).map(boundary => boundary.id).sort().join(',');
  assert.throws(() => partitionTranscript(example, { [combined]: 'continue' }), /Every boundary requires/);
  const extraCombined = { ...decisionsFor(example), [combined]: 'continue' };
  assert.throws(() => partitionTranscript(example, extraCombined), /Every boundary requires/);
});

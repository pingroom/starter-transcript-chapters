import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readText } from './storage.js';
import { step, exportChapters } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input = await readJson(new URL('../examples/transcript.json', import.meta.url), 65536);
for (const scenario of ['every boundary starts a chapter', 'one continuous chapter', 'unknown boundary']) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-chapters-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const decisions = Array(input.segments.length - 1).fill(scenario === 'every boundary starts a chapter' ? 'start' : 'continue');
    if (scenario === 'unknown boundary') decisions[0] = 'unknown';
    let result;
    for (const decision of decisions) {
      const pending = await step(options);
      api.answer(pending.answers.find(answer => answer.status === 'pending').questionId, decision);
      result = await step(options);
    }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 3);
    if (scenario === 'unknown boundary') {
      assert.equal(result.status, 'incomplete'); assert.equal(result.chapters, null); assert.equal(result.webvtt, null);
      await assert.rejects(exportChapters(directory, input));
    } else {
      assert.equal(result.status, 'complete'); assert.equal(result.chapters.length, scenario === 'one continuous chapter' ? 1 : 4);
      const exported = await exportChapters(directory, input); assert.equal(await readText(exported.path), result.webvtt);
    }
    const calls = api.calls.length;
    assert.equal((await step(options)).status, result.status); assert.equal(api.calls.length, calls);
    console.log(JSON.stringify({ scenario, status: result.status, chapters: result.chapters,
      webvtt: result.webvtt, unknownSegmentIds: result.unknownSegmentIds }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

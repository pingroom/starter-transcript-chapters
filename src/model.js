import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_DURATION_MS = 86400000;
export const TITLE_EXCERPT_CODEPOINTS = 48;

export function validateInput(input) {
  if (!keys(input, ['transcriptId', 'title', 'durationMs', 'segments']) || !word(input.transcriptId)
    || !line(input.title, 40) || !Number.isSafeInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_DURATION_MS
    || !Array.isArray(input.segments) || input.segments.length < 2 || input.segments.length > 8) throw new Error('Provide a transcript ID, title, duration up to 24 hours, and two to eight segments.');
  const ids = new Set();
  for (const segment of input.segments) {
    if (!keys(segment, ['id', 'startMs', 'endMs', 'text']) || !word(segment.id) || segment.id.length > 24 || ids.has(segment.id)
      || ['constructor', 'prototype', '__proto__'].includes(segment.id) || !line(segment.text, 120)
      || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
      || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > input.durationMs) throw new Error('Segments need unique IDs, valid single-line Unicode text up to 120 UTF-16 units, and positive integer-millisecond intervals.');
    ids.add(segment.id);
  }
  const segments = structuredClone(input.segments).sort((a, b) => a.startMs - b.startMs);
  if (segments[0].startMs !== 0 || segments.at(-1).endMs !== input.durationMs
    || segments.some((segment, i) => i > 0 && segment.startMs !== segments[i - 1].endMs)) throw new Error('Segments must cover the full declared duration contiguously, without gaps or overlaps.');
  return { transcriptId: input.transcriptId, title: input.title, durationMs: input.durationMs, segments };
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact editor UUID and label.');
  return structuredClone(config);
}

export function boundariesFor(rawInput) {
  const { segments } = validateInput(rawInput);
  return segments.slice(1).map((current, i) => ({ id: current.id, previous: segments[i], current }));
}

export function timestamp(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_DURATION_MS) throw new Error('Timestamp must be integer milliseconds from zero through 24 hours.');
  const hours = Math.floor(milliseconds / 3600000), minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60, remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), boundary = boundariesFor(input).find(item => item.id === itemId);
  validateConfig(config);
  if (!boundary || !isId(attemptId)) throw new Error('Invalid chapter boundary or attempt.');
  const key = `chapters-${attemptId}`;
  const prompt = `${input.title}\nPrevious [${boundary.previous.id}]: ${boundary.previous.text}\nAt ${timestamp(boundary.current.startMs)} [${boundary.current.id}]: ${boundary.current.text}\nShould this segment start a new chapter, or continue the current chapter? Unknown if unsure.`;
  if (prompt.length > 500) throw new Error('Boundary prompt exceeds 500 characters.');
  return { prompt, context: `To ${config.participant.id}`,
    options: [['start', 'Start chapter'], ['continue', 'Continue chapter'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}

const escapePayload = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const excerpt = text => {
  const points = [...text];
  return points.length > TITLE_EXCERPT_CODEPOINTS ? `${points.slice(0, TITLE_EXCERPT_CODEPOINTS).join('')}…` : text;
};

/** Every segment belongs to exactly one chapter; no source content or time is inferred. */
export function partitionTranscript(rawInput, answers) {
  const input = validateInput(rawInput), boundaries = boundariesFor(input);
  if (!keys(answers, boundaries.map(boundary => boundary.id)) || Object.values(answers).some(value => !['start', 'continue'].includes(value))) throw new Error('Every boundary requires a known decision. Unknown is not Continue chapter.');
  const chapters = [];
  for (const [index, segment] of input.segments.entries()) {
    if (index === 0 || answers[segment.id] === 'start') {
      chapters.push({ id: `chapter-${chapters.length + 1}`, title: `Chapter ${chapters.length + 1}: ${excerpt(segment.text)}`,
        startMs: segment.startMs, endMs: segment.endMs, segmentIds: [segment.id] });
    } else {
      const chapter = chapters.at(-1);
      chapter.endMs = segment.endMs; chapter.segmentIds.push(segment.id);
    }
  }
  const webvtt = `WEBVTT\n\n${chapters.map(chapter => `${chapter.id}\n${timestamp(chapter.startMs)} --> ${timestamp(chapter.endMs)}\n${escapePayload(chapter.title)}\n`).join('\n')}`;
  return { chapters, webvtt };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > input.segments.length - 1 || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed transcript manifest. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = boundariesFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved chapter boundary or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last boundary may have an active Question.');
  }
  return state;
}


export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = boundariesFor(input).map(boundary => {
    const attempt = state.attempts.find(attempt => attempt.itemId === boundary.id), answer = attempt?.observation?.answer;
    return { segmentId: boundary.id, previousSegmentId: boundary.previous.id, startMs: boundary.current.startMs,
      status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = answers.find(item => ['create_unknown', 'pending'].includes(item.status));
  const complete = answers.every(item => item.status === 'answered' && ['start', 'continue'].includes(item.choice));
  const partition = complete ? partitionTranscript(input, Object.fromEntries(answers.map(item => [item.segmentId, item.choice]))) : null;
  const status = active?.status ?? (answers.some(item => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  return { transcriptId: input.transcriptId, title: input.title, durationMs: input.durationMs, sourceHash: hash(input), status,
    participant: state.config.participant, segments: input.segments, answers, firstChapterStartsAtMs: 0,
    unknownSegmentIds: answers.filter(item => item.choice === 'unknown').map(item => item.segmentId),
    unansweredBoundaries: answers.filter(item => item.status !== 'answered').map(({ segmentId, status }) => ({ segmentId, status })),
    chapters: partition?.chapters ?? null, webvtt: partition?.webvtt ?? null,
    titleSource: 'chapter_number_and_first_segment_excerpt', mediaModified: false,
    assumptions: ['Segment timestamps and transcript text are supplied by the user and must match the intended media.',
      'Titles use the first 48 Unicode code points of each first segment, with an ellipsis when truncated; they are not generated summaries.',
      'The first chapter starts at zero. Chapters cover the entire declared duration with no gaps or overlaps.'] };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved chapter boundary evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered chapter boundaries must not contain chapter boundary evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved boundary, room, or editor.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}

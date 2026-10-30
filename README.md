# PingRoom transcript chapters

Turn a fixed, timestamped transcript into chapter boundaries. A named editor answers **Start chapter**, **Continue chapter**, or **Unknown** in PingRoom. Application code partitions the transcript and exports a JSON report plus a WebVTT chapter track. It does not transcribe, edit, play, or upload media.

Use it with a transcript export containing two to eight contiguous segments. Connect the chapter structure to your publishing workflow or media player; it does not authorize publication.

## Try it offline

Use Node.js 22 or newer and private persistent storage on macOS or Linux. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo uses published `@pingroom/sdk` 0.7.1 with an in-memory transport. It covers a chapter at every boundary, one continuous chapter, and an Unknown answer that prevents export. Tests and demo need no credentials or network after installation. The lockfile pins dependencies; `.npmrc` requires releases to be at least 14 days old.

## Connect and prepare

```sh
cp examples/transcript.json transcript.json
cp config.example.json config.json
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and grant a **standard private room** containing the editor. The registration needs room-read and question-ask access plus that room grant. Verify the intended person in the app, then copy their exact member UUID from `inspect` into `config.json`. A display name alone does not establish identity.

Pairing saves private `.pingroom/credentials.json`. To reuse an existing registration instead, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`, or set both in the process environment. Do not create a placeholder `.env` for pairing: blank or partial credential pairs fail rather than falling back to saved credentials. Retain the original asking registration for later Question reads.

Adapt `transcript.json` before starting. Supply a stable session ID, title, declared media duration in milliseconds, and two to eight segments. Each segment has `id`, `startMs`, `endMs`, and `text`. Intervals must be positive and contiguous, spanning zero through the full duration. Code sorts segments chronologically and rejects gaps and overlaps. Verify the text and timestamps against your media; the starter cannot check that relationship.

```sh
npm run preview
npm start
```

`preview` validates and prints the canonical manifest without credentials or network.

## Collect boundaries

The first chapter starts at zero. Each later segment gets one Question showing the previous and current excerpts and the current start timestamp. The editor chooses whether that segment starts a new chapter. At most seven Questions target the configured editor, each expiring after 15 minutes.

Each `npm start` creates one Question or reads the current Question once, then exits. After answering, run it again to record the answer; another invocation asks the next boundary. There is no background Question polling or automatic retry of failed assessments.

```sh
npm run status
npm run report
npm run export
```

These commands use local evidence without contacting PingRoom. `report` writes `.chapters/report.json`; `export` writes private `.chapters/chapters.vtt` only when every boundary has a known answer. Paths resolve from the project directory, even when launched elsewhere.

Unknown, missing, expired, cancelled, or invalid answers keep `chapters` and `webvtt` null. Remaining boundaries can be assessed, but incomplete sessions cannot export. Export errors leave any existing file unchanged.

## Use the output

The report includes the canonical source hash, source segments, raw boundary choices, responder and Question IDs, asking registration IDs, and observation timestamps. Chapters preserve every segment exactly once and cover the full declared duration. A chapter closes at the next selected boundary; the last ends at the declared duration.

Titles are `Chapter N: ` followed by the first segment's first 48 Unicode code points, adding an ellipsis when truncated. They are excerpts, not generated summaries. Truncation never splits a surrogate pair, but may split a multi-code-point grapheme. WebVTT titles escape `&`, `<`, and `>`; cue times retain integer-millisecond precision through `24:00:00.000`. The format follows the [WebVTT chapter cue and title rules](https://www.w3.org/TR/webvtt1/#webvtt-chapter-cues).

For a player that supports chapter tracks, copy the reviewed export beside your media and adapt:

```html
<video controls src="media.mp4">
  <track kind="chapters" src="chapters.vtt" srclang="en" label="Chapters">
</video>
```

Choose a player and serve the files through your application; the starter performs no upload or deployment. You can also import `step` from `src/engine.js` into a serialized workflow runner or consume the JSON chapters. Validation, partitioning, and export remain in application code. No AI service is required.

## Resume and recover

Keep `transcript.json`, `config.json`, the original connection, and `.chapters/`. Changed text, timing, session identity, or editor cannot reuse saved answers. Equivalent segment reorderings can resume.

Creation intent is saved before each POST. A lost response leaves `create_unknown` and blocks a replacement Question:

```sh
npm run find-id
npm run recover -- QUESTION_UUID
```

Recovery verifies the original request, room, target, asker, answer, and lifetime. An empty recent search does not prove creation failed; inspect the original registration's history and preserve uncertain state. Reconnecting does not grant a new registration access to old Questions.

Pending pairing reuses its saved link. For uncertain or expired pairing, inspect Connected Agents and resolve or revoke any created registration before archiving `.pingroom/pairing.json` for new setup.

Writes use private files, atomic rename, sync, and a lock. After a crash, inspect `.chapters/.lock/owner.json` or `.pingroom/.lock/owner.json`, confirm that process stopped, then remove only the stale lock directory. Restore corrupt state from a valid backup. Resolve active or uncertain work before archiving a session and its exports. Local evidence is not tamper-proof.

## Limits and checks

Session IDs allow 40 lowercase slug characters; segment IDs allow 24. Titles allow 40 UTF-16 units, segment text 120. Text must be well-formed Unicode, single-line, and trimmed. Control characters, line/paragraph separators, and Unicode format characters—including ZWJ and ZWNJ—are unsupported. Duration is a positive integer up to 86,400,000 ms.

Input/configuration limits are 64/16 KiB; state/report 1 MiB; WebVTT 64 KiB; HTTP bodies 512 KiB. Requests reject redirects and have a five-second deadline through body consumption. Files use `0600`, directories `0700`; credentials, real inputs, state, and exports are ignored by Git.

Run/recovery exit codes: `0` complete, `2` incomplete or a newly failed assessment, `3` ready/pending/interrupted, `4` uncertain creation, `1` error. Successful preview/status/report/export commands return `0`; refused export returns `1`.

GitHub Actions runs installation, tests, and demo on Node 22 and 24. Tests cover all 128 possible seven-boundary patterns, timing, Unicode escaping, export, recovery, identity, clocks, storage, transport, and actual CLI subprocesses with mocks. Live phone delivery is not tested.

MIT licensed. See [LICENSE](LICENSE).

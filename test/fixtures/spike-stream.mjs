// test/fixtures/spike-stream.mjs — in-process object-level ACP stream for Spike.
//
// apply() consumes `config.stream` as an NDJSON *object* stream, matching what
// the SDK's `ndJsonStream(output, input)` returns: `{ readable, writable }`
// where the two raw ends encode/decode JSON-RPC message objects.
//   - stream.writable = OUTBOUND WritableStream: the agent WRITES response /
//                       notification OBJECTS here (⇔ stdout).
//   - stream.readable = INBOUND ReadableStream: the agent READS request OBJECTS
//                       from here (⇔ stdin).
//
// So we hand apply() a pair of object-level TransformStreams (the same pattern
// the SDK's internal `memoryStreamPair()` uses). Chunk types are plain JS
// objects — no byte encoding, no splitter/parser, because apply()/connect()
// already operate at the message-object layer (ndJsonStream does the byte I/O
// only when we DON'T inject config.stream; here we inject object streams).
//
// Per user reminder #4: every frame received is mirrored into `frames` for
// raw-frame dump on test failure.

import { TransformStream } from "node:stream/web";

/**
 * @returns {{
 *   writable: WritableStream<object>,   // apply.stream.writable — OUTBOUND (agent writes response objects)
 *   readable: ReadableStream<object>,   // apply.stream.readable — INBOUND (agent reads request objects)
 *   sink: (msg: object) => void,        // test → apply: enqueue an inbound request object
 *   inbox: AsyncIterable<object>,       // apply → test: drain outbound response objects
 *   frames: object[],                   // every received frame, append-only
 *   close: () => void,
 * }}
 */
export function makeStreamPair() {
  // test → apply:  test enqueues request objects on toApply.writable;
  //                apply reads them from toApply.readable (stream.readable).
  // apply → test:  apply writes response objects on fromApply.writable
  //                (stream.writable); test drains from fromApply.readable.
  const toApply = new TransformStream();
  const fromApply = new TransformStream();

  const frames = [];
  const toApplyWriter = toApply.writable.getWriter();
  const fromApplyReader = fromApply.readable.getReader();

  async function* drain() {
    while (true) {
      const { value, done } = await fromApplyReader.read();
      if (done) return;
      if (value === undefined) continue;
      frames.push(value);
      yield value;
    }
  }

  return {
    // shape apply() wants — matches `ndJsonStream(Writable.toWeb(stdout),
    // Readable.toWeb(stdin))`:
    //   writable = OUTBOUND: apply() writes response objects here (⇔ stdout).
    //   readable = INBOUND:  apply() reads request objects from here (⇔ stdin).
    writable: fromApply.writable,
    readable: toApply.readable,

    sink(obj) {
      toApplyWriter.write(obj).catch(() => {});
    },
    inbox: drain(),
    frames,
    close() {
      toApplyWriter.close().catch(() => {});
      fromApply.writable.close().catch(() => {});
    },
  };
}

/**
 * Drain the inbox for the next JSON-RPC response with matching id.
 * Notifications seen along the way are pushed onto `notifications`.
 *
 * @param {AsyncIterable<object>} inbox
 * @param {string|number} id
 * @param {object[]} notifications
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
export async function awaitResponse(inbox, id, notifications, timeoutMs = 8000) {
  const start = Date.now();
  // inbox is already an async generator / iterator — do NOT call
  // [Symbol.asyncIterator]() again (would create a second reader on the stream).
  const iter = inbox;
  while (true) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      iter.return?.();
      throw new Error(`awaitResponse(id=${String(id)}) timed out after ${timeoutMs}ms; saw ${notifications.length} notifications`);
    }
    const next = await Promise.race([
      iter.next(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), remaining)),
    ]).catch((e) => {
      iter.return?.();
      throw e;
    });
    if (next.done) {
      throw new Error(`awaitResponse(id=${String(id)}): inbox closed before response`);
    }
    const msg = next.value;
    if (msg?.__parse_error) continue;
    // response = has id AND (result or error)
    if (msg?.id === id && (msg.result !== undefined || msg.error !== undefined)) {
      return msg;
    }
    notifications.push(msg);
  }
}

// Taking server-sent events apart, a chunk at a time.
//
// Hand-written because this end cannot use EventSource: that API sends no
// headers, and reaching the api's `/internal/*` surface means presenting the
// service token. The browser, which *can* use EventSource, gets framing for
// free — so there is exactly one implementation of this in the repo rather than
// two that have to agree, which is why it lives here and not in @3d/shared.
//
// The parts of the format that actually bite, and are all covered by the test
// beside this file: a chunk may end mid-line or between the \r and the \n of one
// terminator, `data:` may appear several times in one event and is joined with
// newlines, a line starting with `:` is a comment (which is what a keep-alive
// is), and it is the blank line that dispatches.

export interface SseFrame {
  /** The `event:` field, when the sender set one. */
  event?: string;
  /** Every `data:` line, joined with newlines. */
  data: string;
  id?: string;
}

export interface SseParser {
  /** The frames completed by this chunk. A chunk may complete none, or several. */
  push(chunk: string): SseFrame[];
}

export function createSseParser(): SseParser {
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const take = (line: string, frames: SseFrame[]): void => {
    if (line === "") {
      // The blank line is the dispatch. An event with no data is not one.
      if (data.length > 0) {
        frames.push({ ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }), data: data.join("\n") });
      }

      data = [];
      event = undefined;
      id = undefined;
      return;
    }

    if (line.startsWith(":")) {
      return; // a comment, which is what a keep-alive is
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);

    // One optional space after the colon belongs to the format, not the value.
    let value = colon === -1 ? "" : line.slice(colon + 1);

    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
    // `retry` and anything unknown are ignored: reconnection is this reader's own.
  };

  return {
    push(chunk) {
      buffer += chunk;
      const frames: SseFrame[] = [];

      // A trailing "\r" is held back: it may yet turn out to be half of a "\r\n".
      const holdBack = buffer.endsWith("\r") ? 1 : 0;
      const usable = buffer.slice(0, buffer.length - holdBack);
      const lines = usable.split(/\r\n|\r|\n/);

      // The last piece has no terminator yet, so it is not a line.
      buffer = (lines.pop() ?? "") + (holdBack ? "\r" : "");

      for (const line of lines) {
        take(line, frames);
      }

      return frames;
    },
  };
}

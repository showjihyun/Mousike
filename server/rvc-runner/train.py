#!/usr/bin/env python3
"""RVC training wrapper.

Loads /app/infer-web.py *without* launching its Gradio app, then runs
train1key(...) to completion, streaming yielded status strings to stdout.
Caller (server/rvc.ts) waits for the `__TRAIN_DONE__` sentinel.

Usage:
    python /runner/train.py '<json-array-of-18-args>'

The 18 args must match train1key's signature — see server/rvc.ts'
trainArgs comment block for the position/type contract.
"""
import json
import sys


def load_infer_web():
    """Read /app/infer-web.py, strip the Gradio app.launch() tail, and
    exec the rest in an isolated namespace. Returns the namespace dict
    with all module-level definitions (including train1key) bound."""
    # infer-web.py runs argparse at module top — that would consume our
    # CLI args (the JSON blob) and crash. Save+restore sys.argv around
    # the exec so the module sees only its own name.
    real_argv = sys.argv
    sys.argv = [sys.argv[0]]
    src = open("/app/infer-web.py").read()
    # Drop the entire `with gr.Blocks(...) as app:` UI-construction block
    # so the import doesn't try to materialize the Gradio app (which then
    # tries to .launch() at the bottom). All function defs we need
    # (train1key + helpers) live ABOVE this block.
    for sentinel in ("with gr.Blocks(", "with gradio.Blocks(", "app.queue(", "app.launch("):
        idx = src.find(sentinel)
        if idx > 0:
            # Walk back to the start of that line so we don't leave a
            # half-line dangling.
            line_start = src.rfind("\n", 0, idx) + 1
            src = src[:line_start]
            break
    ns = {"__file__": "/app/infer-web.py", "__name__": "infer_web_runner"}
    try:
        exec(compile(src, "/app/infer-web.py", "exec"), ns)
    finally:
        sys.argv = real_argv
    return ns


def main():
    if len(sys.argv) != 2:
        print(f"USAGE: {sys.argv[0]} '<json-array-of-18-args>'", file=sys.stderr)
        sys.exit(2)
    args = json.loads(sys.argv[1])
    if not isinstance(args, list) or len(args) != 18:
        print(f"expected 18 args, got {len(args)}", file=sys.stderr)
        sys.exit(2)

    ns = load_infer_web()
    train1key = ns["train1key"]
    for status in train1key(*args):
        # status is the accumulated newline-joined string — we only need
        # to print SOMETHING per yield so the caller sees progress.
        last_line = str(status).splitlines()[-1] if status else ""
        print(f"[step] {last_line}", flush=True)

    print("__TRAIN_DONE__", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""RVC inference runner — calls VC.get_vc + VC.vc_single directly.

Gradio 3.34's queue swallows handler exceptions into an empty error over
the WS, and vc_single itself catches everything and *returns* the
traceback as its first element. Running it here surfaces that string
verbatim, so we can see why infer_convert dies at "Loading rmvpe model".

NB: this file must NOT be named infer.py — /runner is on sys.path and a
module named `infer` shadows RVC's /app/infer package.

Usage:  python /runner/vc_infer.py '<json>'
  keys: weight_rel, index_path, input_path, output_path,
        transpose?, f0_method?, index_rate?, filter_radius?,
        resample_sr?, rms_mix_rate?, protect?
"""
import json
import os
import sys
import traceback

os.chdir("/app")
sys.path.insert(0, "/app")

# RVC reads these roots from /app/.env via load_dotenv() in infer-web.py.
# We don't go through infer-web.py and load_dotenv() searches from THIS
# file's dir (/runner), missing /app/.env — so get_vc would resolve
# "None/<sid>" and FileNotFound. Set them explicitly to /app/.env's values.
os.environ.setdefault("weight_root", "assets/weights")
os.environ.setdefault("weight_uvr5_root", "assets/uvr5_weights")
os.environ.setdefault("index_root", "logs")
os.environ.setdefault("outside_index_root", "assets/indices")
os.environ.setdefault("rmvpe_root", "assets/rmvpe")


def main():
    a = json.loads(sys.argv[1])
    # configs.config.Config() runs argparse at import — it would consume our
    # JSON arg and crash. Hide it behind just the program name (same trick
    # train.py uses around the infer-web.py exec).
    sys.argv = [sys.argv[0]]
    from configs.config import Config
    from infer.modules.vc.modules import VC

    config = Config()
    vc = VC(config)
    vc.get_vc(a["weight_rel"])

    info, audio = vc.vc_single(
        0,
        a["input_path"],
        a.get("transpose", 0),
        None,
        a.get("f0_method", "rmvpe"),
        a["index_path"],
        "",
        a.get("index_rate", 0.75),
        a.get("filter_radius", 3),
        a.get("resample_sr", 0),
        a.get("rms_mix_rate", 0.25),
        a.get("protect", 0.33),
    )
    print("=== vc_single info ===", flush=True)
    print(info, flush=True)

    sr, wav = audio if isinstance(audio, tuple) else (None, None)
    if wav is None:
        print("__INFER_FAIL__", flush=True)
        sys.exit(1)

    import numpy as np
    from scipy.io import wavfile

    out = a["output_path"]
    wavfile.write(out, sr, wav.astype(np.int16) if wav.dtype != np.int16 else wav)
    print(f"__INFER_DONE__ {out} sr={sr} samples={len(wav)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)

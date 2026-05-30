# Auto-loaded by Python at startup (anything on sys.path/site-packages
# named `sitecustomize` runs before user imports).
#
# Why: PyTorch 2.6 changed torch.load's default to weights_only=True for
# security. RVC's bundled hubert_base.pt + pretrained weights need
# weights_only=False to deserialize (fairseq.data.dictionary.Dictionary
# isn't in PyTorch's allowed-global set). Without this patch, both
# training (extract_feature_print.py) and inference (vc/utils.py
# load_hubert) blow up on first torch.load.
#
# Bind-mounted via docker-compose.yml into
# /usr/local/lib/python3.9/dist-packages/sitecustomize.py so it survives
# container recreate.
import torch as _t
_orig_load = _t.load
def _safe_load(*args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return _orig_load(*args, **kwargs)
_t.load = _safe_load

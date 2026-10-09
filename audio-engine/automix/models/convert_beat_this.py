"""Development-only export and parity gate. Never imported by the application."""
import argparse
import hashlib
import inspect
import json
from pathlib import Path
import sys

import numpy as np
import onnx
import onnxruntime as ort
import torch

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True, help="Pinned Beat This source checkout")
parser.add_argument("--checkpoint", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
expected = "6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b"
if digest(args.checkpoint) != expected:
    raise ValueError("small0 checkpoint SHA-256 does not match the pinned original")
sys.path.insert(0, str(args.source))
from beat_this.model.beat_tracker import BeatThis
from beat_this.model.postprocessor import Postprocessor
from beat_this.preprocessing import LogMelSpect

torch.set_num_threads(1)
torch.manual_seed(0x41554D58)
checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
parameters = inspect.signature(BeatThis).parameters
model = BeatThis(**{k: v for k, v in checkpoint["hyper_parameters"].items() if k in parameters})
model.load_state_dict({k.removeprefix("model.").replace("_orig_mod.", ""): v for k, v in checkpoint["state_dict"].items()})
model.eval()

class Export(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = model
    def forward(self, logmel):
        values = self.model(logmel)
        return values["beat"], values["downbeat"]

args.output.parent.mkdir(parents=True, exist_ok=True)
# Fixed 1500-frame chunks match the upstream inference contract. Do not export
# a dynamic rotary cache whose traced constants may depend on the first input.
example = torch.zeros((1, 1500, 128), dtype=torch.float32)
export_model = Export().eval()
with torch.inference_mode():
    torch.onnx.export(export_model, example, str(args.output), input_names=["logmel"],
                      output_names=["beat", "downbeat"], opset_version=17, dynamo=False)
onnx.checker.check_model(str(args.output))
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(args.output), options, providers=["CPUExecutionProvider"])
postprocess = Postprocessor("minimal", fps=50)
cases = []
with torch.inference_mode():
    for name, waveform in [("silence", torch.zeros(22050 * 30)),
                            ("noise", torch.randn(22050 * 30) * .1),
                            ("tone", torch.sin(torch.arange(22050 * 30) * (2 * torch.pi * 440 / 22050)) * .2)]:
        mel = LogMelSpect()(waveform)[:1500].unsqueeze(0)
        reference = export_model(mel)
        converted = session.run(None, {"logmel": mel.numpy()})
        errors = [float(np.max(np.abs(a.numpy() - b))) for a, b in zip(reference, converted)]
        for a, b in zip(reference, converted):
            np.testing.assert_allclose(a.numpy(), b, rtol=2e-4, atol=2e-4)
        ref_events = postprocess(*reference)
        onnx_events = postprocess(*(torch.from_numpy(x) for x in converted))
        for a, b in zip(ref_events, onnx_events):
            if len(a[0]) != len(b[0]) or (len(a[0]) and np.max(np.abs(a[0] - b[0])) > 1 / 50):
                raise AssertionError("Converted events differ by more than one model frame")
        # Front-end fixtures are consumed by the native feature test, separately
        # from ONNX parity. Little-endian float32, dimensions in validation JSON.
        waveform.numpy().astype("<f4").tofile(args.output.parent / f"{name}-pcm.f32")
        mel.numpy().astype("<f4").tofile(args.output.parent / f"{name}-mel.f32")
        reference[0].numpy().astype("<f4").tofile(args.output.parent / f"{name}-beat.f32")
        reference[1].numpy().astype("<f4").tofile(args.output.parent / f"{name}-downbeat.f32")
        np.asarray(ref_events[0][0],dtype="<f8").tofile(args.output.parent / f"{name}-beats.f64")
        np.asarray(ref_events[1][0],dtype="<f8").tofile(args.output.parent / f"{name}-downbeats.f64")
        cases.append({"name": name, "max_abs_logit_error": errors, "samples": len(waveform), "frames": 1500})
report = {"schema": 1, "model": "beat-this-small0", "source_commit": "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c",
          "checkpoint_sha256": expected, "onnx_sha256": digest(args.output), "opset": 17,
          "torch": torch.__version__, "onnxruntime": ort.__version__, "cases": cases,
          "onnx_parity_passed": True, "native_frontend_parity_passed": False,
          "music_corpus_gate_passed": False}
args.output.with_suffix(".validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))

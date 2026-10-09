"""YAMNet patch network export; native STFT is validated separately."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
os.environ["TF_USE_LEGACY_KERAS"] = "1"
os.environ["TF_NUM_INTRAOP_THREADS"] = "1"
os.environ["TF_NUM_INTEROP_THREADS"] = "1"
import numpy as np
import tensorflow as tf
import tf_keras
import tf2onnx
import onnxruntime as ort

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--weights", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
expected = "13c3308955bbfaef262f175ac9c40e47b134573a93984f009220dd7cc12a1744"
if digest(args.weights) != expected:
    raise ValueError("YAMNet weights differ from pinned official weights")
sys.path.insert(0, str(args.source))
import yamnet
import params
import features
config = params.Params()
reference = yamnet.yamnet_frames_model(config)
reference.load_weights(str(args.weights))
patch_input = tf_keras.layers.Input(shape=(96, 64), name="logmel_patches")
scores, embeddings = yamnet.yamnet(patch_input, config)
patch_model = tf_keras.Model(patch_input, scores)
patch_model.load_weights(str(args.weights))

signature = [tf.TensorSpec((None, 96, 64), tf.float32, name="logmel_patches")]
@tf.function(input_signature=signature)
def export(patches):
    return {"scores": patch_model(patches, training=False)}

args.output.parent.mkdir(parents=True, exist_ok=True)
tf2onnx.convert.from_function(export, input_signature=signature, opset=17, output_path=str(args.output))
options = ort.SessionOptions()
options.intra_op_num_threads = options.inter_op_num_threads = 1
session = ort.InferenceSession(str(args.output), options, providers=["CPUExecutionProvider"])
cases = []
random = np.random.default_rng(0x41554D58)
for name, waveform in [("silence", np.zeros(16000, np.float32)),
                       ("noise", (random.normal(size=43680) * .1).astype(np.float32)),
                       ("tone", (np.sin(np.arange(48000) * (2*np.pi*440/16000)) * .2).astype(np.float32))]:
    original_scores, _, mel = reference(waveform, training=False)
    _, patches = features.waveform_to_log_mel_spectrogram_patches(features.pad_waveform(waveform, config), config)
    patch_scores = patch_model(patches, training=False).numpy()
    np.testing.assert_allclose(original_scores.numpy(), patch_scores, atol=2e-6, rtol=2e-5)
    converted = session.run(None, {session.get_inputs()[0].name: patches.numpy()})[0]
    np.testing.assert_allclose(original_scores.numpy(), converted, atol=2e-5, rtol=2e-4)
    waveform.astype("<f4").tofile(args.output.parent / f"{name}-pcm.f32")
    mel.numpy().astype("<f4").tofile(args.output.parent / f"{name}-mel.f32")
    original_scores.numpy().astype("<f4").tofile(args.output.parent / f"{name}-scores.f32")
    cases.append({"name": name, "max_abs_score_error": float(np.max(np.abs(original_scores.numpy()-converted))),
                  "samples": len(waveform), "frames": len(mel)})
report = {"schema": 1, "model": "yamnet", "source_commit": "34a21326906b9574fa11c4d6d0a5c534ff039267",
          "weights_sha256": expected, "onnx_sha256": digest(args.output), "opset": 17,
          "tensorflow": tf.__version__, "onnxruntime": ort.__version__, "cases": cases,
          "onnx_parity_passed": True, "native_frontend_parity_passed": False,
          "music_corpus_gate_passed": False}
args.output.with_suffix(".validation.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
print(json.dumps(report, indent=2))

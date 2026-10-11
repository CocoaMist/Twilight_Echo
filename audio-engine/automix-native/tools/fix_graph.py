"""Development-only fixed-shape ONNX preparation; no ORT runtime is shipped.

Use the pinned public source exporters to create the input ONNX first. This
step freezes only public models, retaining their semantics and float32 weights.
"""
import argparse
import collections
import json
from pathlib import Path
import onnx
import onnxruntime as ort

p = argparse.ArgumentParser()
p.add_argument("model", choices=["beat-this", "yamnet"])
p.add_argument("source", type=Path)
p.add_argument("destination", type=Path)
a = p.parse_args()
m = onnx.load(a.source)
shape = [1, 1500, 128] if a.model == "beat-this" else [1, 96, 64]
assert len(m.graph.input) == 1
for d, size in zip(m.graph.input[0].type.tensor_type.shape.dim, shape, strict=True):
    d.ClearField("dim_param")
    d.dim_value = size
for v in m.graph.value_info:
    for d in v.type.tensor_type.shape.dim:
        if d.dim_param:
            d.ClearField("dim_param")
m = onnx.shape_inference.infer_shapes(m, strict_mode=True, data_prop=True)
a.destination.parent.mkdir(parents=True, exist_ok=True)
tmp = a.destination.with_suffix(".input.onnx")
onnx.save(m, tmp)
options = ort.SessionOptions()
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
options.optimized_model_filepath = str(a.destination)
ort.InferenceSession(str(tmp), options, providers=["CPUExecutionProvider"])
tmp.unlink()
m = onnx.shape_inference.infer_shapes(onnx.load(a.destination), strict_mode=True, data_prop=True)
onnx.save(m, a.destination)
print(json.dumps({"operators": dict(collections.Counter(n.op_type for n in m.graph.node)),
                  "inputs": [str(v) for v in m.graph.input],
                  "outputs": [str(v) for v in m.graph.output]}, indent=2))

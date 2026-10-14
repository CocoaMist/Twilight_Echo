"""Development oracle: compares every available native CPU path with public ONNX.

Generated fixtures/reports stay in the external validation directory. A passing
test is numerical evidence only; it does not satisfy the listening/device gates.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
import numpy as np
import onnxruntime as ort

p=argparse.ArgumentParser()
p.add_argument("model", choices=["beat-this", "yamnet"])
p.add_argument("asset_dir", type=Path)
p.add_argument("probe", type=Path)
p.add_argument("--fixtures", type=Path)
p.add_argument("--paths", nargs="+", default=["c", "sse2", "avx2"])
a=p.parse_args()
session=ort.InferenceSession(str(a.asset_dir/f"{a.model}-fixed.onnx"), providers=["CPUExecutionProvider"])
shape=session.get_inputs()[0].shape
rng=np.random.default_rng(20261010)
fixtures={"random": rng.normal(0,0.3,shape).astype(np.float32),
          "silence": np.full(shape,0 if a.model=="beat-this" else np.log(0.001),np.float32)}
if a.fixtures and a.model=="beat-this":
    fixtures.update({name: np.fromfile(a.fixtures/f"{name}-mel.f32", dtype=np.float32).reshape(shape)
                     for name in ["silence","tone","noise"]})
report={"model":a.model, "graphSha256":hashlib.sha256((a.asset_dir/f"{a.model}.tamg").read_bytes()).hexdigest(), "results":[]}
for name,x in fixtures.items():
    input_path=a.asset_dir/f"{a.model}-{name}-input.f32"
    x.tofile(input_path)
    expected=np.concatenate([s.flatten() for s in session.run(None,{session.get_inputs()[0].name:x})])
    for cpu in a.paths:
        output_path=a.asset_dir/f"{a.model}-{name}-{cpu}.f32"
        result=subprocess.run([str(a.probe),str(a.asset_dir/f"{a.model}.tamg"),str(input_path),str(output_path),cpu],capture_output=True,text=True)
        print(result.stdout.strip(),result.stderr.strip(),flush=True)
        if result.returncode==3:
            report["results"].append({"fixture":name,"cpu":cpu,"status":"unavailable"})
            continue
        result.check_returncode()
        actual=np.fromfile(output_path,dtype=np.float32)
        assert actual.shape==expected.shape
        difference=np.abs(expected-actual)
        maximum=float(difference.max())
        # Logits have different accumulation order; event decisions must also agree.
        tolerance=0.002 if a.model=="beat-this" else 0.0001
        passed=bool(maximum<=tolerance and np.isfinite(actual).all())
        entry={"fixture":name,"cpu":cpu,"maxAbsError":maximum,"rmsError":float(np.sqrt(np.mean(difference**2))),"passed":passed,"runtime":result.stdout.strip()}
        report["results"].append(entry)
        print(json.dumps(entry),flush=True)
        if not passed:
            (a.asset_dir/f"{a.model}.validation.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
            raise AssertionError("public model output parity failed")
(a.asset_dir/f"{a.model}.validation.json").write_text(json.dumps(report,indent=2),encoding="utf-8")

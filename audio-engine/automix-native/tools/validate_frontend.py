"""Compare the native waveform frontend to exported upstream fixtures."""
import argparse
import json
import subprocess
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser()
p.add_argument("fixtures",type=Path)
p.add_argument("probe",type=Path)
p.add_argument("output",type=Path)
p.add_argument("graph_probe",type=Path)
a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
results=[]
for model,folder,bands in [("beat-this",a.fixtures,128),("yamnet",a.fixtures/"yamnet",64)]:
    for name in ["silence","tone","noise"]:
        expected=np.fromfile(folder/f"{name}-mel.f32",dtype=np.float32)
        for cpu in ["c","sse2","avx2"]:
            path=a.output/f"{model}-{name}-frontend-{cpu}.f32"
            result=subprocess.run([str(a.probe),model,str(folder/f"{name}-pcm.f32"),str(path),str(len(expected)//bands),cpu],capture_output=True,text=True)
            if result.returncode==3:
                results.append({"model":model,"fixture":name,"cpu":cpu,"status":"unavailable"})
                continue
            result.check_returncode()
            actual=np.fromfile(path,dtype=np.float32)
            assert actual.shape==expected.shape
            error=np.abs(expected-actual)
            # Public float frontend weights/window generation can differ slightly.
            # Near the YAMNet log floor, distinct float FFT implementations
            # amplify tiny cancellation errors. Also require inference parity.
            tolerance=0.0002 if model=="beat-this" else 0.002
            passed=bool(error.max()<tolerance and np.isfinite(actual).all())
            entry={"model":model,"fixture":name,"cpu":cpu,"maxAbsError":float(error.max()),"rmsError":float(np.sqrt(np.mean(error**2))),"passed":passed}
            if model=="yamnet":
                all_mel=actual.reshape(-1,64)
                scores=[]
                for start in range(0,len(all_mel)-95,48):
                    patch=a.output/f"yamnet-{name}-patch.f32"
                    out=a.output/f"yamnet-{name}-patch-score.f32"
                    all_mel[start:start+96].tofile(patch)
                    subprocess.run([str(a.graph_probe),str(a.output/"yamnet.tamg"),str(patch),str(out),cpu],check=True,capture_output=True)
                    scores.extend(np.fromfile(out,dtype=np.float32))
                expected_scores=np.fromfile(folder/f"{name}-scores.f32",dtype=np.float32)
                assert len(scores)==len(expected_scores)
                score_error=float(np.max(np.abs(np.array(scores)-expected_scores)))
                entry["inferenceMaxAbsError"]=score_error
                passed=passed and score_error<0.0001
                entry["passed"]=bool(passed)
            print(json.dumps(entry),flush=True);results.append(entry)
            if not passed:
                (a.output/"frontend.validation.json").write_text(json.dumps(results,indent=2),encoding="utf-8")
                raise AssertionError("waveform frontend parity failed")
(a.output/"frontend.validation.json").write_text(json.dumps(results,indent=2),encoding="utf-8")

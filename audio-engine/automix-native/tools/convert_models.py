"""Public-only development export. Verify the lock before release staging."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('model',choices=['beat-this','yamnet'])
p.add_argument('reference',type=Path)
p.add_argument('weights',type=Path)
p.add_argument('output',type=Path)
a=p.parse_args()
lock=json.loads((Path(__file__).parents[1]/'dependencies.lock.json').read_text())
asset=lock['models']['beat-this-small0' if a.model=='beat-this' else 'yamnet']
sha=lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(a.weights)==asset['weightsSha256'], 'public checkpoint integrity mismatch'
sys.path.insert(0,str(a.reference))
a.output.parent.mkdir(parents=True,exist_ok=True)
if a.model=='beat-this':
    import torch
    from beat_this.inference import load_model
    commit=subprocess.check_output(['git','-C',str(a.reference),'rev-parse','HEAD'],text=True).strip()
    assert commit==asset['commit'] and torch.__version__=='2.6.0+cpu'
    torch.set_num_threads(4)
    class Export(torch.nn.Module):
        def __init__(self):
            super().__init__(); self.model=load_model(str(a.weights))
        def forward(self,logmel):
            result=self.model(logmel)
            return result['beat'],result['downbeat']
    with torch.inference_mode():
        torch.onnx.export(Export().eval(),torch.zeros(1,1500,128),str(a.output),
            input_names=['logmel'],output_names=['beat','downbeat'],opset_version=17,
            do_constant_folding=True,dynamo=False)
else:
    os.environ['TF_USE_LEGACY_KERAS']='1'
    import tensorflow as tf
    import tf2onnx
    import params, yamnet
    assert tf.__version__=='2.18.0' and tf2onnx.__version__=='1.16.1'
    for name,digest in asset['sourceFiles'].items():
        assert sha(a.reference/name)==digest, f'public source mismatch: {name}'
    param=params.Params()
    full=yamnet.yamnet_frames_model(param)
    full.load_weights(str(a.weights))
    weights=full.get_weights()
    tf.keras.backend.clear_session()
    patches=tf.keras.layers.Input(shape=(96,64),batch_size=1,dtype=tf.float32,name='logmel_patches')
    scores,_=yamnet.yamnet(patches,param)
    model=tf.keras.Model(patches,scores)
    model.set_weights(weights)
    signature=[tf.TensorSpec([1,96,64],tf.float32,name='logmel_patches')]
    @tf.function(input_signature=signature)
    def inference(logmel_patches):
        return {'scores':model(logmel_patches,training=False)}
    tf2onnx.convert.from_function(inference,input_signature=signature,opset=17,output_path=str(a.output))
fixed=a.output.with_name(a.model+'-fixed.onnx')
native=a.output.with_name(asset['graphFile'])
for tool,args in [('fix_graph.py',[a.model,a.output,fixed]),('export_graph.py',[fixed,native])]:
    result=subprocess.run([sys.executable,str(Path(__file__).with_name(tool)),*map(str,args)],
                          check=True,capture_output=True,text=True)
    (a.output.parent/(a.model+'-'+tool+'.log')).write_text(result.stdout+result.stderr,encoding='utf-8')
report={'sourceCommit':asset['commit'],'weightsSha256':sha(a.weights),
        'onnxSha256':sha(a.output),'matchesLockedDevelopmentGraph':sha(a.output)==asset['developmentOnnxSha256']}
report['nativeGraphSha256']=sha(native)
report['matchesLockedReleaseGraph']=sha(native)==asset['graphSha256']
print(json.dumps(report,indent=2))
(a.output.with_suffix('.export.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
if not report['matchesLockedReleaseGraph']:
    raise RuntimeError('native graph differs from lock; preserve and validate evidence before changing release assets')

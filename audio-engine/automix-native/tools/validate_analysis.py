"""Exercises the production FFmpeg analysis C ABI without opening a device."""
import argparse
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('dll',type=Path)
p.add_argument('assets',type=Path)
p.add_argument('output',type=Path)
p.add_argument('--song',type=Path,action='append',required=True)
a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
directory=os.add_dll_directory(str(a.dll.parent))
engine=c.CDLL(str(a.dll))
engine.TAE_CreateEngine.argtypes=[c.POINTER(c.c_void_p)]
engine.TAE_DestroyEngine.argtypes=[c.c_void_p]
engine.TAE_GetAnalysisExecutionCount.argtypes=[c.c_char_p]
engine.TAE_GetAnalysisExecutionCount.restype=c.c_uint64
engine.TAE_AnalyzeAutoMix.argtypes=[c.c_void_p,c.c_char_p,c.c_char_p,c.c_void_p,c.c_size_t,c.POINTER(c.c_size_t)]
handle=c.c_void_p()
assert engine.TAE_CreateEngine(c.byref(handle))==0
report={'schemaVersion':1,'kind':'production-analysis-abi','dllSha256':hashlib.sha256(a.dll.read_bytes()).hexdigest(),'results':[]}
def analyse(song,options):
    required=c.c_size_t()
    source=str(song).encode('utf-8'); body=json.dumps(options).encode('utf-8')
    before=engine.TAE_GetAnalysisExecutionCount(b'automix')
    result=engine.TAE_AnalyzeAutoMix(handle,source,body,None,0,c.byref(required))
    assert required.value and required.value<=512*1024
    buffer=c.create_string_buffer(required.value)
    assert engine.TAE_AnalyzeAutoMix(handle,source,body,buffer,len(buffer),c.byref(required))==0
    assert engine.TAE_GetAnalysisExecutionCount(b'automix')==before+1, 'size probe must not infer twice'
    return json.loads(buffer.value)
def verify(f):
    assert f['ok'],f
    cov=f['coverage']; start,end=cov['startSeconds'],cov['endSeconds']
    assert 0<=start<end<=cov['durationSeconds']+0.0001
    assert not cov['complete'] or (start==0 and abs(end-cov['durationSeconds'])<=0.0001)
    assert abs(len(f['frameDb'])-(end-start)*50)<=1.001
    for name in ['beats','downbeats']:
        assert all(start<=t<=end for t in f[name])
        assert all(y>x for x,y in zip(f[name],f[name][1:]))
    assert all(start<=v['startSeconds']<v['endSeconds']<=end+0.0001 and
               0<=v['probability']<=1 and 0<=v['music']<=1 for v in f['voice'])
    assert -1<=f['key']<=23 and 0<=f['tempoConfidence']<=1
try:
    for index,song in enumerate(a.song):
        identity=hashlib.sha256(song.read_bytes()).hexdigest()
        for boundary in ['head','tail']:
            options={'assetDirectory':str(a.assets),'sourceIdentity':identity,'boundary':boundary}
            f=analyse(song,options); verify(f)
            (a.output/f'{index}-{boundary}.json').write_text(json.dumps(f),encoding='utf-8')
            entry={'fixture':index,'boundary':boundary,'sourceIdentity':identity,'coverage':f['coverage'],
                   'bpm':f['bpm'],'confidence':f['tempoConfidence'],'beatCount':len(f['beats']),
                   'voicePatches':len(f['voice']),'passed':True}
            report['results'].append(entry); print(json.dumps(entry),flush=True)
        # Bounded short CUE range in the actual compressed file.
        options={'assetDirectory':str(a.assets),'sourceIdentity':identity,'sourceStartSeconds':5,'sourceEndSeconds':12.137}
        f=analyse(song,options); verify(f)
        assert f['coverage']['complete'] and abs(f['coverage']['durationSeconds']-7.137)<0.0001
        report['results'].append({'fixture':index,'boundary':'short-cue','coverage':f['coverage'],'passed':True})
    report['passed']=True
finally:
    engine.TAE_DestroyEngine(handle)
    (a.output/'analysis.validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')

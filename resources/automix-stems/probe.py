"""Bounded host-launched capability probe. Never load the separation model."""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker import CHECKPOINT_SHA256, sha, validate_runtime


def probe(directory):
    if sha(directory / 'models' / '955717e8-8726e21a.th') != CHECKPOINT_SHA256:
        raise RuntimeError('model_digest_mismatch')
    import numpy as np
    import torch
    import torchaudio
    from demucs.pretrained import get_model  # Verify dependencies without loading a model.
    validate_runtime(torch)
    torch.set_num_threads(1)
    audio = torch.from_numpy(np.zeros((1, 128), dtype=np.float32))
    torchaudio.functional.resample(audio, 48000, 44100)
    result = {'cpu': True, 'gpu': False}
    try:
        if torch.cuda.is_available():
            value = torch.ones((2, 2), device='cuda')
            (value @ value).cpu()
            result.update(gpu=True, gpuName=torch.cuda.get_device_name(0))
    except Exception:
        pass  # CPU remains usable if the driver or CUDA runtime is unavailable.
    return result


if __name__ == '__main__':
    print('TWILIGHT_STEM_CAPABILITIES=' + json.dumps(probe(Path(sys.argv[1]).resolve())))

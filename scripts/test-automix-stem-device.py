"""Device-policy regressions without requiring installed Torch or CUDA."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'resources' / 'automix-stems'))
import worker


class DevicePolicyTests(unittest.TestCase):
    def torch(self, available=False):
        class OutOfMemoryError(Exception):
            pass
        return SimpleNamespace(cuda=SimpleNamespace(is_available=Mock(return_value=available),
            OutOfMemoryError=OutOfMemoryError, empty_cache=Mock()))

    def test_cpu_never_queries_cuda(self):
        torch = self.torch(True)
        self.assertEqual(worker.choose_device(torch, 'cpu'), 'cpu')
        torch.cuda.is_available.assert_not_called()

    def test_auto_chooses_available_device(self):
        self.assertEqual(worker.choose_device(self.torch(True), 'auto'), 'cuda')
        self.assertEqual(worker.choose_device(self.torch(False), 'auto'), 'cpu')

    def test_explicit_gpu_requires_cuda(self):
        self.assertEqual(worker.choose_device(self.torch(True), 'gpu'), 'cuda')
        with self.assertRaisesRegex(RuntimeError, 'gpu_unavailable'):
            worker.choose_device(self.torch(False), 'gpu')

    def test_invalid_policy_is_rejected(self):
        for policy in ('cuda', '', None):
            with self.assertRaisesRegex(RuntimeError, 'invalid_device_policy'):
                worker.choose_device(self.torch(), policy)

    def test_auto_recovers_from_cuda_oom_on_cpu(self):
        torch, model, result, resources = self.torch(True), Mock(), Mock(), {'device': 'cuda'}
        with patch.object(worker, 'streaming_apply', side_effect=[torch.cuda.OutOfMemoryError(), [result]]) as apply:
            output, device = worker.separate_with_device_policy(model, 'audio', 'cuda', 'auto', torch, resources)
            self.assertEqual(device, 'cpu')
            self.assertEqual(output, result.cpu.return_value)
            self.assertEqual([call.args[2] for call in apply.call_args_list], ['cuda', 'cpu'])
        model.cpu.assert_called_once()
        torch.cuda.empty_cache.assert_called_once()
        self.assertEqual(resources['device'], 'cpu-oom-fallback')

    def test_explicit_gpu_does_not_run_cpu_on_oom(self):
        torch, model = self.torch(True), Mock()
        with patch.object(worker, 'streaming_apply', side_effect=torch.cuda.OutOfMemoryError()) as apply:
            with self.assertRaisesRegex(RuntimeError, 'gpu_memory_exhausted'):
                worker.separate_with_device_policy(model, 'audio', 'cuda', 'gpu', torch, {})
            apply.assert_called_once()
        model.cpu.assert_not_called()
        torch.cuda.empty_cache.assert_not_called()


if __name__ == '__main__':
    unittest.main()

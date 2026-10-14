"""Build the pinned Windows inference package without compiler/test payloads.

This is a packaging-only transformation: every inference DLL, extension,
executable, checkpoint and worker is copied byte-for-byte. CUDA architectures,
precision and Demucs processing parameters are left intact.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import zipfile


PACKAGE_VERSION = '2.2'
ROOT_ITEMS = ('runtime', 'models', 'worker.py', 'model.lock.json',
              'manifest.json', 'Demucs-LICENSE.txt')
PROTECTED_SUFFIXES = {'.dll', '.pyd', '.exe', '.th'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def exclusion(relative):
    parts = tuple(part.lower() for part in relative.parts)
    name = parts[-1]
    # Preserve distribution metadata and legal notices even under removed trees.
    if any(part.endswith('.dist-info') for part in parts) or any(
        token in name for token in ('license', 'licence', 'copyright', 'copying', 'notice', 'authors')
    ):
        return None
    if '__pycache__' in parts or relative.suffix.lower() == '.pyc':
        return 'bytecode-cache'
    if relative.suffix.lower() in PROTECTED_SUFFIXES:
        return None
    if relative.suffix.lower() in {'.lib', '.a', '.pdb', '.exp', '.obj'}:
        return 'compiler-libraries-and-symbols'
    posix = '/'.join(parts)
    if posix.startswith(('runtime/lib/site-packages/torch/include/',
                         'runtime/lib/site-packages/torch/share/cmake/',
                         'runtime/lib/site-packages/numpy/core/include/',
                         'runtime/lib/site-packages/numpy/_core/include/')):
        return 'compiler-headers-and-cmake'
    if 'tests' in parts or 'test' in parts:
        return 'dependency-tests'
    if relative.suffix.lower() == '.pyi' or name == 'py.typed':
        return 'type-checker-stubs'
    if posix.startswith('runtime/lib/site-packages/pip/') or (
        posix.startswith('runtime/scripts/') and name.startswith('pip')
    ):
        return 'package-installer'
    return None


def stage(source, parent, report_path):
    source = source.resolve(strict=True)
    pack = parent.resolve() / 'automix-enhancement'
    if pack.exists() or source == pack or source in pack.parents or pack in source.parents:
        raise ValueError('Use a new staging directory outside the source package')
    pack.mkdir(parents=True)
    excluded, files, groups = [], {}, collections.defaultdict(lambda: {'files': 0, 'bytes': 0})
    original_bytes = protected = licenses = 0
    started = time.monotonic()
    for item in ROOT_ITEMS:
        path = source / item
        candidates = sorted(path.rglob('*')) if path.is_dir() else [path]
        for file in candidates:
            if not file.is_file():
                continue
            if file.is_symlink():
                raise ValueError('Package source must not contain symlinks')
            relative = file.relative_to(source)
            size = file.stat().st_size
            # Baseline 2.0 did not distribute generated Python bytecode.
            if '__pycache__' not in relative.parts and file.suffix != '.pyc':
                original_bytes += size
            reason = exclusion(relative)
            if reason:
                excluded.append({'path': relative.as_posix(), 'bytes': size, 'reason': reason})
                groups[reason]['files'] += 1
                groups[reason]['bytes'] += size
                continue
            target = pack / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            original_digest = digest(file)
            if digest(target) != original_digest:
                raise ValueError('Copy digest mismatch: ' + str(relative))
            files[relative.as_posix()] = {'bytes': size, 'sha256': original_digest}
            if file.suffix.lower() in PROTECTED_SUFFIXES:
                protected += 1
            if any(token in file.name.lower() for token in ('license', 'licence', 'copyright', 'copying', 'notice', 'authors')):
                licenses += 1
    manifest_path = pack / 'manifest.json'
    # Runtime and checkpoint come from the verified baseline; ship this worker.
    shutil.copy2(Path(__file__).with_name('worker.py'), pack / 'worker.py')
    files['worker.py'] = {'bytes': (pack / 'worker.py').stat().st_size,
                         'sha256': digest(pack / 'worker.py')}
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest.update(packageVersion=PACKAGE_VERSION, distribution='windows-x64-inference',
                    compilerSdkIncluded=False, defaultCacheBudgetBytes=512 * 1024 ** 2,
                    cacheFormatVersion=2, bytecodeCacheEnabled=False)
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    files['manifest.json'] = {'bytes': manifest_path.stat().st_size, 'sha256': digest(manifest_path)}
    inventory = pack / 'package-files.json'
    inventory.write_text(json.dumps({'version': PACKAGE_VERSION, 'files': files}, indent=2) + '\n', encoding='utf-8')
    report = {
        'version': PACKAGE_VERSION, 'source': str(source), 'stagedPack': str(pack),
        'baselineUnpackedBytes': original_bytes,
        'unpackedBytes': sum(entry['bytes'] for entry in files.values()) + inventory.stat().st_size,
        'protectedBinaryFilesCopiedExactly': protected, 'legalNoticeFilesRetained': licenses,
        'workerSha256': files['worker.py']['sha256'],
        'checkpointSha256': files['models/955717e8-8726e21a.th']['sha256'],
        'processing': {key: manifest[key] for key in ('segmentSeconds', 'overlap', 'shifts', 'torchVersion', 'pythonVersion')},
        'removedGroups': dict(groups), 'excludedFiles': excluded,
        'retainedFiles': len(files), 'elapsedSeconds': time.monotonic() - started
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'excludedFiles'}), flush=True)


def archive(parent, destination, kind, seven_zip, report_path):
    parent = parent.resolve(strict=True)
    destination = destination.resolve()
    pack = parent / 'automix-enhancement'
    if not (pack / 'package-files.json').is_file() or destination.exists():
        raise ValueError('Require a staged package and a new archive path')
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + '.partial')
    if partial.exists():
        raise ValueError('Remove or inspect the previous partial archive before retrying')
    started = time.monotonic()
    if kind == 'zip':
        with zipfile.ZipFile(partial, 'w', zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as zipped:
            for file in sorted(pack.rglob('*')):
                if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc':
                    zipped.write(file, file.relative_to(parent).as_posix())
        with zipfile.ZipFile(partial) as zipped:
            if zipped.testzip() is not None:
                raise ValueError('Archive CRC check failed')
    else:
        subprocess.run([str(seven_zip), 'a', '-t7z', '-mx=7', '-m0=LZMA2', '-md=64m',
                        '-mmt=4', '-ms=512m', '-bsp0', '-bso1', str(partial), 'automix-enhancement',
                        '-xr!__pycache__', '-xr!*.pyc'], cwd=parent, check=True)
        subprocess.run([str(seven_zip), 't', '-bsp0', str(partial)], check=True)
    partial.replace(destination)
    report = {'version': PACKAGE_VERSION, 'archive': destination.name, 'format': kind,
              'bytes': destination.stat().st_size, 'sha256': digest(destination),
              'lossless': True, 'archiveIntegrityPassed': True,
              'elapsedSeconds': time.monotonic() - started}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stage', 'zip', '7z'))
    parser.add_argument('--source', type=Path)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--seven-zip', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'stage':
        if args.source is None:
            parser.error('stage requires --source')
        stage(args.source, args.stage, args.report)
    else:
        if args.output is None or (args.action == '7z' and args.seven_zip is None):
            parser.error('archive requires --output and 7z requires --seven-zip')
        archive(args.stage, args.output, args.action, args.seven_zip, args.report)


if __name__ == '__main__':
    main()

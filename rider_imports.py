"""Staged rider imports with a durable rollback journal; no server dependencies."""
import json
import os
from pathlib import Path
import secrets
import shutil


def write_bytes(path, content):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name != 'nt':
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def write_manifest(stage, metadata):
    write_bytes(stage / 'manifest.json', json.dumps(metadata).encode())


def stage_import(folder, files, metadata):
    stage = Path(folder) / ('.import-' + secrets.token_hex(16))
    stage.mkdir(mode=0o700)
    try:
        for name, content in files.items():
            write_bytes(stage / name, content)
        metadata['files'] = list(files)
        metadata['state'] = 'staged'
        write_manifest(stage, metadata)
    except Exception:
        shutil.rmtree(stage)
        raise
    return stage


def rollback(stage, metadata):
    folder = stage.parent
    for name in metadata['files']:
        old = stage / ('old-' + name)
        if old.exists():
            write_bytes(folder / name, old.read_bytes())
        else:
            (folder / name).unlink(missing_ok=True)


def publish(stage, metadata, commit):
    """commit updates DB metadata; caller must roll back its DB session on failure."""
    folder = stage.parent
    for name in metadata['files']:
        target = folder / name
        if target.exists():
            write_bytes(stage / ('old-' + name), target.read_bytes())
            # Keep a human-recoverable backup after successful replacement too.
            shutil.copyfile(target, folder / (name + '.' + stage.name[8:] + '.bak'))
    metadata['state'] = 'publishing'
    write_manifest(stage, metadata)
    try:
        for name in metadata['files']:
            write_bytes(folder / name, (stage / name).read_bytes())
        commit()
        metadata['state'] = 'committed'
        write_manifest(stage, metadata)
    except Exception:
        rollback(stage, metadata)
        raise
    else:
        shutil.rmtree(stage)

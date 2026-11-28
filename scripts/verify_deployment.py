"""Check the public data matches this successful deployment, allowing CDN delay."""
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

base = 'https://gonngo.github.io/Leaning-Chinese/'
query = '?run=' + os.environ['GITHUB_RUN_ID']
data = Path('daily-materials.json').read_bytes()
expected = hashlib.sha256(data).hexdigest()
audio_dir = Path('_site/audio')
manifest_path = audio_dir / 'manifest.json'


def fetch(path, length=None):
    headers = {'Cache-Control': 'no-cache'}
    if length is not None:
        headers['Range'] = f'bytes=0-{length-1}'
    request = urllib.request.Request(base + path + query, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read(length)


def check_audio():
    if not manifest_path.exists():
        return True
    manifest = manifest_path.read_bytes()
    if fetch('audio/manifest.json') != manifest:
        return False
    embedded = b'<script id="initialAudioData" type="application/json">' + manifest.strip() + b'</script>'
    if embedded not in fetch('index.html'):
        return False
    tracks = json.loads(manifest)
    batch = max(json.loads(data)['batches'], key=lambda lesson: lesson['date'])
    lesson_id = batch.get('id', 'daily-' + batch['date'])
    for filename in [tracks['lessons'][lesson_id]['bilingual'], tracks['vocabulary']['examples']]:
        with (audio_dir / filename).open('rb') as expected_audio:
            if fetch('audio/' + filename, 16) != expected_audio.read(16):
                return False
    for pack in [tracks['packs']['lessons'][lesson_id], *tracks['packs']['vocabulary'].values()]:
        filename = pack['file']
        with (audio_dir / filename).open('rb') as expected_audio:
            if fetch('audio/' + filename, 1024) != expected_audio.read(1024):
                return False
    print('Published screen-off manifest and representative MP3s verified')
    return True


for attempt in range(8):
    try:
        received = hashlib.sha256(fetch('daily-materials.json')).hexdigest()
        if received == expected and check_audio():
            print('Published HSK5 materials verified: ' + expected)
            break
    except OSError as error:
        print('Waiting for public deployment: ' + type(error).__name__)
    if attempt == 7:
        raise RuntimeError('Published materials did not match the deployed data')
    time.sleep(5)

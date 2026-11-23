"""Check the public data matches this successful deployment, allowing CDN delay."""
import hashlib
import os
from pathlib import Path
import time
import urllib.request

expected = hashlib.sha256(Path('daily-materials.json').read_bytes()).hexdigest()
url = 'https://gonngo.github.io/Leaning-Chinese/daily-materials.json?run=' + os.environ['GITHUB_RUN_ID']
for attempt in range(8):
    try:
        request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            received = hashlib.sha256(response.read(50_000_000)).hexdigest()
        if received == expected:
            print('Published HSK5 materials verified: ' + expected)
            break
    except OSError as error:
        print('Waiting for public deployment: ' + type(error).__name__)
    if attempt == 7:
        raise RuntimeError('Published materials did not match the deployed data')
    time.sleep(5)

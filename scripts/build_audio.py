"""Build one seekable MP3 per public listening mode for background playback."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import subprocess


SAMPLE_RATE = 22050
VOICES = {'zh': 'zh_CN-huayan-medium', 'ja': 'ja_JP-hi_fi_captain-medium'}
RENDER_VERSION = 'piper-1.8.0-v1'


def digest(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return sha256(payload.encode('utf-8')).hexdigest()


def reading(rows, bilingual=False):
    for row in rows:
        zh = row['zh'].strip()
        ja = row.get('ja', '').strip() if bilingual else ''
        if zh:
            yield 'zh', zh, 270 if ja else 550
        if ja:
            yield 'ja', ja, 550


class AudioBuilder:
    def __init__(self, models, cache, output):
        self.models = models
        self.cache = cache / RENDER_VERSION
        self.output = output
        self.voices = {}
        self.cache.mkdir(parents=True, exist_ok=True)
        output.mkdir(parents=True, exist_ok=True)

    def clip(self, lang, text):
        path = self.cache / (digest([VOICES[lang], text]) + '.pcm')
        if path.is_file() and path.stat().st_size:
            return path
        import numpy as np
        from piper import PiperVoice

        if lang not in self.voices:
            self.voices[lang] = PiperVoice.load(self.models / (VOICES[lang] + '.onnx'))
        audio = []
        for chunk in self.voices[lang].synthesize(text):
            samples = chunk.audio_float_array
            if chunk.sample_rate != SAMPLE_RATE and len(samples):
                positions = np.arange(round(len(samples) * SAMPLE_RATE / chunk.sample_rate))
                samples = np.interp(positions * chunk.sample_rate / SAMPLE_RATE, np.arange(len(samples)), samples)
            audio.append((np.clip(samples, -1, 1) * 30000).astype('<i2').tobytes())
        if not any(audio):
            raise ValueError(f'Piper returned no {lang} audio for: {text[:80]}')
        temporary = path.with_suffix('.tmp')
        temporary.write_bytes(b''.join(audio))
        os.replace(temporary, path)
        return path

    def track(self, segments):
        segments = list(segments)
        if not segments:
            return None
        filename = f'{digest([RENDER_VERSION, segments])[:24]}.mp3'
        cached = self.cache / filename
        if not cached.is_file() or not cached.stat().st_size:
            from imageio_ffmpeg import get_ffmpeg_exe

            temporary = cached.with_suffix('.tmp.mp3')
            command = [get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                       '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
                       '-c:a', 'libmp3lame', '-b:a', '48k', str(temporary)]
            with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
                try:
                    with encoder.stdin as stream:
                        for lang, text, gap_ms in segments:
                            stream.write(self.clip(lang, text).read_bytes())
                            stream.write(bytes(2 * round(SAMPLE_RATE * gap_ms / 1000)))
                except BaseException:
                    encoder.kill()
                    raise
                if encoder.wait():
                    raise RuntimeError('FFmpeg failed to encode ' + filename)
            os.replace(temporary, cached)
        shutil.copyfile(cached, self.output / filename)
        return filename


def build(materials, builder):
    manifest = {'version': 1, 'lessons': {}, 'vocabulary': {}}
    for batch in materials['batches']:
        lesson_id = batch.get('id', 'daily-' + batch['date'])
        sentences = batch['sentences']
        terms = batch.get('lessonVocabulary', batch['vocabulary'])
        manifest['lessons'][lesson_id] = {
            'chinese': builder.track(reading(sentences)),
            'bilingual': builder.track(reading(sentences, bilingual=True)),
            'important': builder.track(reading(terms, bilingual=True)),
        }
        print(f'Audio ready: {lesson_id}', flush=True)

    words = [word for batch in sorted(materials['batches'], key=lambda b: b['date'], reverse=True)
             for word in batch['vocabulary']]
    manifest['vocabulary'] = {
        'words': builder.track(reading(words, bilingual=True)),
        'examples': builder.track(reading((word['example'] for word in words), bilingual=True)),
    }
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=Path('daily-materials.json'))
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    materials = json.loads(args.data.read_text(encoding='utf-8'))
    builder = AudioBuilder(args.models, args.cache, args.output)
    manifest = build(materials, builder)
    (args.output / 'manifest.json').write_text(json.dumps(manifest) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()

"""Build one seekable MP3 per public listening mode for background playback."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess


SAMPLE_RATE = 22050
FRAME_SAMPLES = 576
PACK_VERSION = 'mp3-pack-v1'
STREAM_VERSION = 'aac-id3-v1'
REPEATS = (1, 2, 3, 5)
GAPS = (400, 1000, 2000, 3000)


def syncsafe(value):
    return bytes((value >> shift) & 0x7f for shift in (21, 14, 7, 0))


def packed_audio_timestamp():
    # Each standalone AAC segment starts a new timestamp sequence. HLS packed
    # audio requires the first sample's 90 kHz MPEG timestamp in this ID3 frame.
    body = b'com.apple.streaming.transportStreamTimestamp\0' + bytes(8)
    frame = b'PRIV' + syncsafe(len(body)) + bytes(2) + body
    return b'ID3\x04\x00\x00' + syncsafe(len(frame)) + frame


PACKED_AUDIO_ID3 = packed_audio_timestamp()


def aac_duration(audio):
    cursor = samples = 0
    while cursor < len(audio):
        header = audio[cursor:cursor+7]
        if len(header) != 7 or header[0] != 0xff or header[1] & 0xf6 != 0xf0:
            raise ValueError('Invalid ADTS frame in a streaming audio segment')
        length = ((header[3] & 3) << 11) | (header[4] << 3) | (header[5] >> 5)
        if length < 7 or cursor + length > len(audio):
            raise ValueError('Invalid ADTS frame length')
        samples += 1024 * ((header[6] & 3) + 1)
        cursor += length
    if not samples:
        raise ValueError('Empty audio segment')
    return samples / SAMPLE_RATE
VOICES = {'zh': 'zh_CN-huayan-medium', 'ja': 'ja_JP-hi_fi_captain-medium'}
RENDER_VERSION = 'piper-1.8.0-v1'


def digest(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return sha256(payload.encode('utf-8')).hexdigest()


def reading(rows, bilingual=False):
    for index, row in enumerate(rows):
        zh = row['zh'].strip()
        ja = row.get('ja', '').strip() if bilingual else ''
        if zh:
            yield 'zh', zh, 270 if ja else 1000, index
        if ja:
            yield 'ja', ja, 1000, index


def signature(rows):
    """Match the browser's signature for the ordered texts a track reads."""
    payload = json.dumps([[row['zh'], row.get('ja', '')] for row in rows], ensure_ascii=False, separators=(',', ':'))
    value = 2166136261
    for byte in payload.encode('utf-8'):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return format(value, '08x')


def mp3_frames(audio):
    """Get byte boundaries for the MPEG-2, mono, 48 kbps output of LAME."""
    offsets = [0]
    while offsets[-1] < len(audio):
        position = offsets[-1]
        header = int.from_bytes(audio[position:position + 4], 'big')
        if header & 0xfffe0000 != 0xfff20000 or (header >> 10) & 0x3f != 24:
            raise ValueError(f'Unexpected MP3 frame at byte {position}')
        size = 72000 * 48 // SAMPLE_RATE + ((header >> 9) & 1)
        offsets.append(position + size)
    if offsets[-1] != len(audio):
        raise ValueError('Incomplete MP3 frame at end of pack')
    return offsets


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
        filename = f'{digest([RENDER_VERSION, [item[:3] for item in segments]])[:24]}.mp3'
        cached = self.cache / filename
        elapsed = 0
        offsets = []
        translations = []
        clips = []
        previous = None
        for lang, text, gap_ms, index in segments:
            clip = self.clip(lang, text)
            if index != previous:
                offsets.append(round(elapsed / SAMPLE_RATE, 3))
                translations.append(None)
                previous = index
            if lang == 'ja':
                translations[-1] = round(elapsed / SAMPLE_RATE, 3)
            gap = round(SAMPLE_RATE * gap_ms / 1000)
            elapsed += clip.stat().st_size // 2 + gap
            clips.append((clip, gap))
        if not cached.is_file() or not cached.stat().st_size:
            from imageio_ffmpeg import get_ffmpeg_exe

            temporary = cached.with_suffix('.tmp.mp3')
            command = [get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                       '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
                       '-c:a', 'libmp3lame', '-b:a', '48k', str(temporary)]
            with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
                try:
                    with encoder.stdin as stream:
                        for clip, gap in clips:
                            stream.write(clip.read_bytes())
                            stream.write(bytes(2 * gap))
                except BaseException:
                    encoder.kill()
                    raise
                if encoder.wait():
                    raise RuntimeError('FFmpeg failed to encode ' + filename)
            os.replace(temporary, cached)
        shutil.copyfile(cached, self.output / filename)
        return filename, offsets, translations

    def progressive_audio(self, mp3):
        """Make a seekable AAC alternative with its index at the start."""
        from imageio_ffmpeg import get_ffmpeg_exe

        filename = mp3.removesuffix('.mp3') + '.m4a'
        cached = self.cache / filename
        if not cached.is_file() or not cached.stat().st_size:
            temporary = cached.with_suffix('.tmp.m4a')
            subprocess.run([get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                            '-i', str(self.output / mp3), '-c:a', 'aac', '-b:a', '48k',
                            '-movflags', '+faststart', str(temporary)], check=True)
            os.replace(temporary, cached)
        shutil.copyfile(cached, self.output / filename)
        return filename

    def pack(self, groups):
        """Encode all unique speech clips in one frame-aligned audio file."""
        clips = dict.fromkeys((language, row[language].strip())
                              for rows in groups.values() for row in rows
                              for language in ('zh', 'ja') if row.get(language, '').strip())
        filename = digest([RENDER_VERSION, PACK_VERSION, list(clips)])[:24] + '.mp3'
        cached = self.cache / filename
        index_file = cached.with_suffix('.json')
        if cached.is_file() and index_file.is_file():
            spans, silence = json.loads(index_file.read_text(encoding='utf-8'))
        else:
            from imageio_ffmpeg import get_ffmpeg_exe

            # Silence around each clip absorbs codec delay and filter overlap.
            # With the bit reservoir disabled, later frames do not need bytes
            # from a preceding clip when the browser moves or repeats them.
            frame = bytes(2 * FRAME_SAMPLES)
            pad = frame * 4
            ranges = []
            cursor = 12
            temporary = cached.with_suffix('.tmp.mp3')
            command = [get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                       '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
                       '-c:a', 'libmp3lame', '-b:a', '48k', '-reservoir', '0', '-write_xing', '0',
                       '-id3v2_version', '0', '-map_metadata', '-1', str(temporary)]
            with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
                try:
                    with encoder.stdin as stream:
                        stream.write(frame * cursor)
                        for language, text in clips:
                            pcm = self.clip(language, text).read_bytes()
                            remainder = (-len(pcm)) % len(frame)
                            length = 8 + (len(pcm) + remainder) // len(frame)
                            stream.write(pad + pcm + bytes(remainder) + pad)
                            ranges.append((cursor, cursor + length))
                            cursor += length
                except BaseException:
                    encoder.kill()
                    raise
                if encoder.wait():
                    raise RuntimeError('FFmpeg failed to build ' + filename)
            boundaries = mp3_frames(temporary.read_bytes())
            spans = [[boundaries[start], boundaries[end], end-start] for start, end in ranges]
            # Use a middle frame from the initial silent region for gaps.
            silence = [boundaries[5], boundaries[6]]
            os.replace(temporary, cached)
            index_file.write_text(json.dumps([spans, silence]), encoding='utf-8')
        clips = dict(zip(clips, spans, strict=True))
        tracks = {}
        for key, rows in groups.items():
            tracks[key] = {signature([row]): [clips.get(('zh', row['zh'].strip())),
                                              clips.get(('ja', row.get('ja', '').strip()))]
                           for row in rows}
        shutil.copyfile(cached, self.output / filename)
        return {'file': filename, 'silence': silence, 'tracks': tracks}

    def stream_segment(self, segments):
        """Package a row or a gap as a self-contained Safari audio segment."""
        name = digest([RENDER_VERSION, STREAM_VERSION, segments])[:24] + '.aac'
        cached = self.cache / name
        duration_file = cached.with_suffix('.seconds')
        if not cached.is_file() or not duration_file.is_file():
            from imageio_ffmpeg import get_ffmpeg_exe

            pcm = b''.join(self.clip(lang, text).read_bytes() if lang else bytes(2 * round(SAMPLE_RATE * gap / 1000))
                           for lang, text, gap in segments)
            temporary = cached.with_suffix('.tmp.aac')
            aac = subprocess.run([get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error',
                            '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
                            '-c:a', 'aac', '-b:a', '48k', '-threads', '1', '-f', 'adts', 'pipe:1'],
                           input=pcm, capture_output=True, check=True).stdout
            duration = aac_duration(aac)
            temporary.write_bytes(PACKED_AUDIO_ID3 + aac)
            os.replace(temporary, cached)
            duration_file.write_text(str(duration), encoding='ascii')
        target = self.output / 'streams' / name
        if not target.exists():
            shutil.copyfile(cached, target)
        return (name, float(duration_file.read_text(encoding='ascii')))

    def stream(self, rows, bilingual, singles=False):
        rows = list(rows)
        if not rows:
            return None
        target = self.output / 'streams'
        target.mkdir(exist_ok=True)
        payloads = []
        translations = []
        for row in rows:
            zh, ja = row['zh'].strip(), row.get('ja', '').strip() if bilingual else ''
            segments = [('zh', zh, 0)]
            translations.append(round(self.clip('zh', zh).stat().st_size / (2*SAMPLE_RATE) + .270, 4) if ja else None)
            if ja:
                segments += [('', '', 270), ('ja', ja, 0)]
            payloads.append(segments)
        # Previous track builds populate the PCM cache before parallel encoding.
        with ThreadPoolExecutor(max_workers=4) as pool:
            payloads += [[('', '', gap)] for gap in GAPS]
            unique = {tuple(item): item for item in payloads}
            encoded = dict(zip(unique, pool.map(self.stream_segment, unique.values()), strict=True))
        clips = [encoded[tuple(item)] for item in payloads[:-len(GAPS)]]
        gaps = dict(zip(GAPS, (encoded[tuple(item)] for item in payloads[-len(GAPS):]), strict=True))
        prefix = digest([STREAM_VERSION, clips, list(gaps.values())])[:24]
        for repeat in REPEATS:
            for gap, gap_clip in gaps.items():
                playlist = []
                for clip in clips:
                    for _ in range(repeat):
                        playlist.extend((clip, gap_clip))
                write_playlist(target / f'{prefix}-{repeat}-{gap}.m3u8', playlist[:-1])
        items = {}
        if singles:
            for row, clip, translation in zip(rows, clips, translations, strict=True):
                name = clip[0].removesuffix('.aac') + '.m3u8'
                write_playlist(target / name, [clip])
                items[signature([row])] = [name, clip[1], translation]
        return {'prefix': prefix, 'rows': [[clip[1], translation] for clip, translation in zip(clips, translations, strict=True)],
                'gaps': {gap: item[1] for gap, item in gaps.items()}, 'items': items}


def write_playlist(path, segments):
    max_duration = math.ceil(max(duration for _, duration in segments))
    lines = ['#EXTM3U', '#EXT-X-VERSION:3', f'#EXT-X-TARGETDURATION:{max_duration}',
             '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    for index, (filename, duration) in enumerate(segments):
        if index:
            lines.append('#EXT-X-DISCONTINUITY')
        lines.extend((f'#EXTINF:{duration:.6f},', filename))
    lines.append('#EXT-X-ENDLIST')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def verify_stream(path):
    from imageio_ffmpeg import get_ffmpeg_exe

    clips = []
    duration = 0
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.endswith('.aac'):
            continue
        clip = (path.parent / line).read_bytes()
        if not clip.startswith(PACKED_AUDIO_ID3):
            raise ValueError('Missing HLS timestamp in ' + line)
        clip = clip[len(PACKED_AUDIO_ID3):]
        clips.append(clip)
        duration += aac_duration(clip)
        if duration >= 10:
            break
    audio = subprocess.run([get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error',
                            '-f', 'aac', '-i', 'pipe:0', '-t', '10', '-ar', str(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1'],
                           input=b''.join(clips), capture_output=True, check=True).stdout
    if len(audio) < SAMPLE_RATE * 2 * 9:
        raise ValueError('Stream ended early during decoding: ' + str(path))


def build(materials, builder):
    manifest = {'version': 1, 'lessons': {}, 'vocabulary': {}, 'timings': {}, 'translations': {},
                'packs': {'lessons': {}, 'vocabulary': {}}, 'streams': {}}

    def add_track(tracks, mode, rows, bilingual=False):
        rows = list(rows)
        track = builder.track(reading(rows, bilingual=bilingual))
        if track is None:
            return
        filename, offsets, translations = track
        tracks[mode] = filename
        tracks[mode + 'Signature'] = signature(rows)
        manifest['timings'][filename] = offsets
        if bilingual:
            manifest['translations'][filename] = translations

    for batch in materials['batches']:
        lesson_id = batch.get('id', 'daily-' + batch['date'])
        sentences = batch['sentences']
        terms = batch.get('lessonVocabulary', batch['vocabulary'])
        tracks = manifest['lessons'][lesson_id] = {}
        add_track(tracks, 'chinese', sentences)
        add_track(tracks, 'bilingual', sentences, bilingual=True)
        add_track(tracks, 'important', terms, bilingual=True)
        manifest['packs']['lessons'][lesson_id] = builder.pack({'sentences': sentences, 'important': terms})
        manifest['streams'][tracks['chinese']] = builder.stream(sentences, bilingual=False)
        print(f'Audio ready: {lesson_id}', flush=True)

    words = [word for batch in sorted(materials['batches'], key=lambda b: b['date'], reverse=True)
             for word in batch['vocabulary']]
    add_track(manifest['vocabulary'], 'words', words, bilingual=True)
    add_track(manifest['vocabulary'], 'examples', (word['example'] for word in words), bilingual=True)
    for key in ('words', 'examples'):
        tracks = manifest['vocabulary']
        tracks[key + 'Progressive'] = builder.progressive_audio(tracks[key])
    manifest['packs']['vocabulary']['words'] = builder.pack({'words': words})
    manifest['packs']['vocabulary']['examples'] = builder.pack({'examples': [word['example'] for word in words]})
    manifest['streams'][manifest['vocabulary']['words']] = builder.stream(words, bilingual=True, singles=True)
    manifest['streams'][manifest['vocabulary']['examples']] = builder.stream([word['example'] for word in words], bilingual=True, singles=True)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=Path('daily-materials.json'))
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--index', type=Path)
    args = parser.parse_args()
    materials = json.loads(args.data.read_text(encoding='utf-8'))
    builder = AudioBuilder(args.models, args.cache, args.output)
    manifest = build(materials, builder)
    latest = max(materials['batches'], key=lambda item: item['date'])
    latest_id = latest.get('id', 'daily-' + latest['date'])
    for name in [manifest['lessons'][latest_id]['chinese'], *[manifest['vocabulary'][key] for key in ('words', 'examples')]]:
        prefix = manifest['streams'][name]['prefix']
        verify_stream(args.output / 'streams' / f'{prefix}-3-2000.m3u8')
    payload = json.dumps(manifest, separators=(',', ':'))
    (args.output / 'manifest.json').write_text(payload + '\n', encoding='utf-8')
    if args.index:
        placeholder = '<script id="initialAudioData" type="application/json">null</script>'
        html = args.index.read_text(encoding='utf-8')
        if placeholder not in html:
            raise ValueError('Audio manifest placeholder not found in ' + str(args.index))
        embedded = placeholder.replace('>null<', '>' + payload.replace('<', '\\u003c') + '<')
        daily_payload = json.dumps(materials, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
        daily = '<script id="initialDailyData" type="application/json">' + daily_payload + '</script>'
        html, matches = re.subn(r'<script id="initialDailyData" type="application/json">.*?</script>',
                                lambda _: daily, html, count=1, flags=re.DOTALL)
        if matches != 1:
            raise ValueError('Daily materials placeholder not found in ' + str(args.index))
        args.index.write_text(html.replace(placeholder, embedded, 1), encoding='utf-8')


if __name__ == '__main__':
    main()

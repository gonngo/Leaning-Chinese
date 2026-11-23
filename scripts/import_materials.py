"""Import rendered shared lessons; validate everything before an atomic write."""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import re
import unicodedata

SOURCE_ID = '6ae7a9a1-1458-83ec-8b1f-9cd502359f90'
SOURCE_URL = 'https://chatgpt.com/share/6b03eff6-6970-83ec-851b-4e539558a317'
SENTENCE_HEADING = '② 一文ずつ：ピンイン・日本語訳'


def word_key(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).lower()


def require_text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value.encode('utf-16-le')) // 2 > limit:
        raise ValueError('Missing or oversized text field')


def validate_sentence(sentence):
    for field, limit in [('zh', 5000), ('pinyin', 10000), ('ja', 10000)]:
        require_text(sentence.get(field), limit)


def validate_lesson_vocabulary(words):
    if not isinstance(words, list) or len(words) > 1000:
        raise ValueError('Invalid lesson vocabulary list')
    for word in words:
        if not isinstance(word, dict):
            raise ValueError('Invalid lesson vocabulary entry')
        for field, limit in [('zh', 100), ('pinyin', 300), ('ja', 1000)]:
            require_text(word.get(field), limit)


def batch_id(batch):
    return batch.get('id', 'daily-' + batch['date'])


def validate_data(data):
    if data.get('version') != 1 or not isinstance(data.get('batches'), list) or not data['batches']:
        raise ValueError('Invalid daily materials document')
    ids, words = set(), set()
    for batch in data['batches']:
        dt.date.fromisoformat(batch['date'])
        identity = batch_id(batch)
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,160}', identity) or identity in ids:
            raise ValueError('Duplicate or invalid batch ID')
        ids.add(identity)
        require_text(batch.get('title'), 80)
        if not isinstance(batch.get('sentences'), list) or not 1 <= len(batch['sentences']) <= 1000:
            raise ValueError('Invalid sentence count')
        if not isinstance(batch.get('vocabulary'), list) or len(batch['vocabulary']) > 1000:
            raise ValueError('Invalid vocabulary count')
        for sentence in batch['sentences']:
            validate_sentence(sentence)
        if 'lessonVocabulary' in batch:
            validate_lesson_vocabulary(batch['lessonVocabulary'])
        for word in batch['vocabulary']:
            for field, limit in [('zh', 100), ('pinyin', 300), ('ja', 1000)]:
                require_text(word.get(field), limit)
            validate_sentence(word.get('example') or {})
            key = word_key(word['zh'])
            if key in words:
                raise ValueError('Duplicate vocabulary across history: ' + word['zh'])
            words.add(key)
    if data.get('updatedAt') != max(b['date'] for b in data['batches']):
        raise ValueError('updatedAt does not match the latest lesson')


def parse_sources(texts, today=None):
    today = today or dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    previous = None
    batches = []
    for text in texts:
        if SENTENCE_HEADING not in text or '③ 重要単語' not in text:
            continue
        match = re.search(r'(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日', text)
        if not match:
            raise ValueError('Missing lesson date')
        year = int(match[1]) if match[1] else (previous.year if previous else today.year)
        date = dt.date(year, int(match[2]), int(match[3]))
        if not match[1] and previous and (previous - date).days > 180:
            date = date.replace(year=year + 1)
        if not match[1] and previous is None and (date - today).days > 31:
            date = date.replace(year=year - 1)
        if date > today:
            raise ValueError('Lesson date is in the future: ' + date.isoformat())
        if previous and date <= previous:
            raise ValueError('Source lesson dates are duplicated or out of order')
        previous = date
        theme = re.search(r'今日のテーマは\s*「([^」]+)」', text)
        if theme:
            title = theme[1]
        else:
            intro = [line.strip() for line in text.split('① 中国語全文')[0].splitlines() if line.strip()]
            header = next(i for i, line in enumerate(intro) if line.startswith('今日のテーマ'))
            title = intro[header + 1]
        title = 'ChatGPT · ' + title
        while len(title.encode('utf-16-le')) // 2 > 80:
            title = title[:-1]
        section = text.split(SENTENCE_HEADING, 1)[1].split('③ 重要単語', 1)[0]
        lines = [line.strip() for line in section.splitlines() if line.strip()]
        sentences, expected = [], None
        for i in range(0, len(lines), 4):
            group = re.fullmatch(r'(\d+)\s*/\s*(\d+)', lines[i])
            if not group or int(group[1]) != len(sentences) + 1 or i + 3 >= len(lines):
                raise ValueError('Malformed sentence group: ' + date.isoformat())
            if expected is not None and expected != int(group[2]):
                raise ValueError('Inconsistent sentence count')
            expected = int(group[2])
            sentence = dict(zip(['zh', 'pinyin', 'ja'], lines[i + 1:i + 4]))
            validate_sentence(sentence)
            sentences.append(sentence)
        if not sentences or len(sentences) != expected:
            raise ValueError('Incomplete sentence section')
        word_heading = re.search(r'③ 重要単語\s*(\d+)語', text)
        if not word_heading:
            raise ValueError('Missing vocabulary count')
        table = text.split('③ 重要単語', 1)[1].split('④ 今日の重要文法', 1)[0]
        lines = [line.strip() for line in table.splitlines() if line.strip()]
        start = next(i for i, line in enumerate(lines) if line == '1')
        vocabulary = []
        for i in range(start, len(lines), 3):
            if not lines[i].isdigit() or int(lines[i]) != len(vocabulary) + 1 or i + 2 >= len(lines):
                raise ValueError('Malformed vocabulary row')
            parts = lines[i + 1].split(maxsplit=1)
            if len(parts) != 2:
                raise ValueError('Missing vocabulary pinyin')
            zh, pinyin = parts
            example = next((s.copy() for s in sentences if word_key(zh) in word_key(s['zh'])), None)
            vocabulary.append({'zh': zh, 'pinyin': pinyin, 'ja': lines[i + 2], 'example': example})
        if len(vocabulary) != int(word_heading[1]):
            raise ValueError('Incomplete vocabulary section')
        batches.append({'id': f'daily-chatgpt-{SOURCE_ID}-{date.isoformat()}', 'date': date.isoformat(),
                        'title': title, 'sourceUrl': SOURCE_URL, 'sentences': sentences, 'vocabulary': vocabulary,
                        'lessonVocabulary': [{field: word[field] for field in ['zh', 'pinyin', 'ja']} for word in vocabulary]})
    if not batches:
        raise ValueError('No complete source lessons found')
    return batches


def merge_materials(existing, incoming):
    validate_data(existing)
    result = copy.deepcopy(existing)
    ids = {batch_id(b) for b in result['batches']}
    by_id = {batch_id(b): b for b in result['batches']}
    words = {word_key(w['zh']) for b in result['batches'] for w in b['vocabulary']}
    stats = {'addedLessons': 0, 'addedSentences': 0, 'addedWords': 0, 'updatedLessons': 0}
    for original in sorted(incoming, key=lambda b: b['date']):
        if batch_id(original) in ids:
            if 'lessonVocabulary' in original:
                validate_lesson_vocabulary(original['lessonVocabulary'])
                previous = by_id[batch_id(original)]
                if previous.get('lessonVocabulary') != original['lessonVocabulary']:
                    previous['lessonVocabulary'] = copy.deepcopy(original['lessonVocabulary'])
                    stats['updatedLessons'] += 1
            continue
        batch = copy.deepcopy(original)
        unique = []
        for word in batch['vocabulary']:
            key = word_key(word['zh'])
            if key in words:
                continue
            if word['example'] is None:
                raise ValueError('New word has no source example: ' + word['zh'])
            words.add(key)
            unique.append(word)
        batch['vocabulary'] = unique
        result['batches'].append(batch)
        by_id[batch_id(batch)] = batch
        ids.add(batch_id(batch))
        stats['addedLessons'] += 1
        stats['addedSentences'] += len(batch['sentences'])
        stats['addedWords'] += len(unique)
    result['updatedAt'] = max(b['date'] for b in result['batches'])
    validate_data(result)
    stats['latestDate'] = result['updatedAt']
    stats['sourceLatestDate'] = max(b['date'] for b in incoming)
    return result, stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--data', default='daily-materials.json')
    args = parser.parse_args()
    target = Path(args.data)
    existing = json.loads(target.read_text(encoding='utf-8-sig'))
    incoming = parse_sources(json.loads(Path(args.source).read_text(encoding='utf-8-sig')))
    result, stats = merge_materials(existing, incoming)
    changed = bool(stats['addedLessons'] or stats['updatedLessons'])
    if changed:
        temporary = target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temporary, target)
    print(json.dumps(stats, ensure_ascii=True))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f"## HSK5 shared lesson import\n\nSource latest: {stats['sourceLatestDate']}\n\n"
                          f"Added {stats['addedLessons']} lessons, {stats['addedSentences']} sentences, "
                          f"{stats['addedWords']} new words.\n\nUpdated source vocabulary lists for {stats['updatedLessons']} existing lessons.\n\nOnly material visible in the shared chat is available.\n")
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write(f"changed={'true' if changed else 'false'}\n")


if __name__ == '__main__':
    main()

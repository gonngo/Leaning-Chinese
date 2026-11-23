import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('import_materials', Path(__file__).resolve().parents[1] / 'scripts/import_materials.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SENTENCE = {'zh': '我们提高效率。', 'pinyin': 'Wǒmen tígāo xiàolǜ.', 'ja': '私たちは効率を高める。'}


def batch(day, word='效率'):
    return {'id': 'test-' + day, 'date': day, 'title': 'Test', 'sentences': [SENTENCE.copy()],
            'vocabulary': [{'zh': word, 'pinyin': 'xiàolǜ', 'ja': '効率', 'example': SENTENCE.copy()}]}


def document():
    return {'version': 1, 'updatedAt': '2026-11-22', 'batches': [batch('2026-11-22')]}


def source(date):
    return f'''HSK5級 中国語練習｜{date}
今日のテーマ：学習
提高效率
① 中国語全文
我们提高效率。
② 一文ずつ：ピンイン・日本語訳
1 / 1
我们提高效率。
Wǒmen tígāo xiàolǜ.
私たちは効率を高める。
③ 重要単語2語
番号
中国語・ピンイン
日本語
1
效率 xiàolǜ
効率
2
提高 tígāo
高める
④ 今日の重要文法
⑤ 復習：中国語全文
⑥ 復習：日本語全文'''


class CloudImportTests(unittest.TestCase):
    def test_source_parse_and_history_merge(self):
        incoming = module.parse_sources([source('2026年11月23日')], today=dt.date(2026, 11, 23))
        original = document()
        result, stats = module.merge_materials(original, incoming)
        self.assertEqual(stats['addedWords'], 1)
        self.assertEqual(stats['addedSentences'], 1)
        self.assertEqual(result['batches'][:1], original['batches'])
        self.assertEqual(result['batches'][1]['vocabulary'][0]['zh'], '提高')
        self.assertEqual([w['zh'] for w in result['batches'][1]['lessonVocabulary']], ['效率', '提高'])
        self.assertEqual(result['batches'][1]['sentences'], [SENTENCE])
        again, repeated = module.merge_materials(result, incoming)
        self.assertEqual(again, result)
        self.assertEqual(repeated['addedLessons'], 0)
        self.assertEqual(repeated['updatedLessons'], 0)

    def test_existing_source_list_backfills_without_changing_saved_material(self):
        incoming = module.parse_sources([source('2026年11月23日')])
        original, _ = module.merge_materials(document(), incoming)
        original['batches'][1].pop('lessonVocabulary')
        original['batches'][1]['title'] = 'Saved title'
        before = copy.deepcopy(original)
        result, stats = module.merge_materials(original, incoming)
        expected = copy.deepcopy(before)
        expected['batches'][1]['lessonVocabulary'] = incoming[0]['lessonVocabulary']
        self.assertEqual(result, expected)
        self.assertEqual(original, before)
        self.assertEqual(stats['addedWords'], 0)
        self.assertEqual(stats['addedLessons'], 0)
        self.assertEqual(stats['updatedLessons'], 1)

    def test_metadata_only_import_is_saved_and_marks_deployment_changed(self):
        incoming = module.parse_sources([source('2026年11月23日')])
        original, _ = module.merge_materials(document(), incoming)
        original['batches'][1].pop('lessonVocabulary')
        with tempfile.TemporaryDirectory() as directory:
            data, raw, output = [Path(directory) / name for name in ['data.json', 'source.json', 'output.txt']]
            data.write_text(json.dumps(original), encoding='utf-8')
            raw.write_text(json.dumps([source('2026年11月23日')]), encoding='utf-8')
            with patch('sys.argv', ['import_materials.py', '--data', str(data), '--source', str(raw)]), patch.dict(os.environ, {'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': ''}):
                module.main()
            saved = json.loads(data.read_text(encoding='utf-8'))
            self.assertEqual(saved['batches'][1]['lessonVocabulary'], incoming[0]['lessonVocabulary'])
            self.assertEqual(output.read_text(encoding='utf-8'), 'changed=true\n')

    def test_incomplete_source_vocabulary_rejects_backfill_atomically(self):
        incoming = module.parse_sources([source('2026年11月23日')])
        original, _ = module.merge_materials(document(), incoming)
        before = copy.deepcopy(original)
        incoming[0]['lessonVocabulary'][0]['pinyin'] = ''
        with self.assertRaises(ValueError):
            module.merge_materials(original, incoming)
        self.assertEqual(original, before)

    def test_nfkc_and_whitespace_duplicates(self):
        original = document()
        incoming = batch('2026-11-23', '效 率')
        result, stats = module.merge_materials(original, [incoming])
        self.assertEqual(stats['addedWords'], 0)
        self.assertEqual(len(result['batches'][1]['sentences']), 1)
        self.assertEqual(module.word_key('Ａ B'), module.word_key('ab'))

    def test_missing_example_rejects_entire_update(self):
        original = document()
        before = copy.deepcopy(original)
        incoming = batch('2026-11-23', '新词')
        incoming['vocabulary'][0]['example'] = None
        with self.assertRaises(ValueError):
            module.merge_materials(original, [incoming])
        self.assertEqual(original, before)

    def test_incomplete_source_rejected(self):
        with self.assertRaises(ValueError):
            module.parse_sources([source('2026年11月23日').replace('1 / 1', '1 / 20')])

    def test_duplicate_history_rejected(self):
        original = document()
        original['batches'].append(batch('2026-11-22'))
        with self.assertRaises(ValueError):
            module.merge_materials(original, [])

    def test_year_rollover_retains_source_year(self):
        result = module.parse_sources([source('2026年12月31日'), source('1月1日')], today=dt.date(2027, 1, 1))
        self.assertEqual([b['date'] for b in result], ['2026-12-31', '2027-01-01'])


if __name__ == '__main__':
    unittest.main()

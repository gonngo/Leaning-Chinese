import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const sourceUrl = 'https://chatgpt.com/share/6b03eff6-6970-83ec-851b-4e539558a317';
const output = process.env.IMPORT_OUTPUT || '_cloud-import';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ja-JP', viewport: { width: 1000, height: 850 } });
let report = { sourceUrl, checkedAt: new Date().toISOString(), status: 'failed' };
try {
  const response = await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  report.httpStatus = response?.status();
  // Read only public rendered content. Never sign in or bypass access challenges.
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('② 一文ずつ：ピンイン・日本語訳') && text.includes('③ 重要単語');
  }, null, { timeout: 60000 });
  let texts = [];
  let previous = '';
  for (let attempt = 0; attempt < 15; attempt++) {
    const regions = page.getByRole('region', { name: 'DIL content', exact: true });
    texts = await regions.count() ? await regions.allInnerTexts() : await page.locator('article').allInnerTexts();
    const complete = texts.filter(t => t.includes('② 一文ずつ：ピンイン・日本語訳') && t.includes('③ 重要単語') && t.includes('⑥ 復習：日本語全文'));
    const signature = JSON.stringify(texts.map(t => t.length));
    if (signature === previous && complete.length && texts.every(t => t.trim())) {
      texts = complete;
      break;
    }
    previous = signature;
    await page.waitForTimeout(1500);
    if (attempt === 14) throw new Error('Shared lesson rendering did not finish; no materials were changed.');
  }
  if (!texts.length) throw new Error('No complete lessons were readable in the public shared chat.');
  await writeFile(`${output}/source-lessons.json`, JSON.stringify(texts, null, 2));
  report = { ...report, status: 'readable', lessonCount: texts.length, title: await page.title(), finalUrl: page.url() };
  console.log(JSON.stringify(report));
} catch (error) {
  report = { ...report, title: await page.title(), finalUrl: page.url(), error: String(error.message), visibleText: (await page.locator('body').innerText()).slice(0,500) };
  console.error(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  await page.screenshot({ path: `${output}/source.png` }).catch(() => {});
  await writeFile(`${output}/source-status.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
